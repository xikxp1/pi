import test from "node:test";
import assert from "node:assert/strict";
import {
  EXECUTION_POLICY,
  LEGACY_EXECUTION_POLICY,
  V2_EXECUTION_POLICY,
  ROLES,
  newGoal,
  askQuestion,
  answerQuestion,
  propose,
  approve,
  approvalToken,
  isApproved,
  hash,
  validateReview,
} from "../core.mjs";
import {
  ContinuationPause,
  executionSchedule,
  runBoundedExecution,
} from "../execution.mjs";

const step = (file) => ({
  title: file,
  instructions: "Implement only approved scope",
  files: [file],
});
const check = (command, afterStep, repeatable = true) => ({
  command,
  afterStep,
  repeatable,
  timeout: 10,
});
const report = (status = "completed", files = ["a.mjs"]) => ({
  status,
  summary: `${status} approved work`,
  files,
  artifact: "memory:worker",
});
const output = (code = 0) => ({
  code,
  killed: false,
  stdout: code ? "regression failed" : "ok",
  stderr: "",
});

function harness({
  steps = [step("a.mjs")],
  checks = [check("verify", 1)],
  execution = EXECUTION_POLICY,
  ...hooks
} = {}) {
  const goal = newGoal(
    "Bounded implementation",
    "/memory/project",
    Object.fromEntries(
      ROLES.map((role) => [
        role,
        { model: `test/${role}`, thinking: "low", maxTurns: 8 },
      ]),
    ),
  );
  const question = askQuestion(goal, {
    question: "Allow bounded continuation?",
    context: "Approved files only",
    options: ["Yes"],
  });
  answerQuestion(
    goal,
    "Yes, including bounded repairs and checkpoints, without new scope",
    question.id,
  );
  goal.research.push({
    summary: "Existing behavior inspected",
    artifact: "memory:research",
  });
  goal.phase = "planning";
  const files = Object.fromEntries(
    steps.flatMap((s) => s.files).map((file) => [file, null]),
  );
  propose(
    goal,
    {
      title: "Approved changes",
      summary: "Implement and verify",
      acceptance: ["Approved behavior works"],
      constraints: ["No scope changes"],
      risks: [],
      steps,
      checks,
      execution,
    },
    structuredClone(files),
  );
  approve(goal, approvalToken(goal));
  goal.phase = "executing";
  const token = goal.approval;
  const baseline = structuredClone(goal.baseline);
  const events = [],
    feedback = [],
    records = [],
    saves = [],
    notices = [];
  const h = {
    goal,
    files,
    token,
    baseline,
    events,
    feedback,
    records,
    saves,
    notices,
    put(file, content) {
      files[file] = { hash: hash(content), bytes: Buffer.byteLength(content) };
    },
    assessment(verdict = "pass") {
      return {
        ...validateReview(
          {
            verdict,
            summary: "Independent assessment",
            criteria: [
              {
                criterion: goal.plan.acceptance[0],
                evidence: "Inspected implementation and checks",
              },
            ],
            issues: verdict === "pass" ? [] : ["Fix approved behavior"],
          },
          goal.plan.acceptance,
        ),
        artifact: "memory:review",
      };
    },
    run() {
      return runBoundedExecution(callbacks);
    },
    assertAuthority() {
      assert.equal(goal.approval, token);
      assert.equal(approvalToken(goal), token);
      assert.deepEqual(goal.baseline, baseline);
      assert.equal(
        goal.phase,
        "executing",
        "only the controller finalizes the phase",
      );
    },
  };
  const callbacks = {
    goal,
    snapshot: async () => {
      if (hooks.snapshot) await hooks.snapshot(h);
      return structuredClone(files);
    },
    work: async (s, f, metadata) => {
      events.push(`work:${s.id}`);
      feedback.push(f);
      if (hooks.work) return hooks.work(s, f, h, metadata);
      h.put(s.files[0], `implemented ${events.length}`);
      return report("completed", s.files);
    },
    review: async (evidence, initial) => {
      events.push("review");
      assert.deepEqual(initial, baseline);
      assert.ok(Array.isArray(JSON.parse(evidence).checks));
      return hooks.review ? hooks.review(evidence, initial, h) : h.assessment();
    },
    exec: async (c) => {
      events.push(`check:${c.command}`);
      assert.ok(
        goal.plan.checks.includes(c),
        "execute only the exact approved check",
      );
      return hooks.exec ? hooks.exec(c, h) : output();
    },
    record: async (label, data) => {
      records.push({ label, data: structuredClone(data) });
      return `memory:${label}`;
    },
    persist: () => {
      saves.push(structuredClone(goal));
      if (hooks.persist) hooks.persist(h);
    },
    checkApproval: () => {
      if (!isApproved(goal)) throw new Error("Approval invalid");
    },
    notify: (message) => {
      notices.push(message);
      if (hooks.notify) hooks.notify(h);
    },
  };
  return h;
}

async function pauses(h, pattern) {
  await assert.rejects(h.run(), (error) => {
    assert.ok(error instanceof ContinuationPause);
    assert.match(error.message, pattern);
    assert.match(error.message, /Approval retained/);
    return true;
  });
  h.assertAuthority();
  assert.ok(h.saves.length);
  assert.ok(h.goal.execution.cursor < executionSchedule(h.goal.plan).length);
}

test("partial continuation completes within the same approval and preserves evidence", async () => {
  let attempts = 0;
  const h = harness({
    work(s, feedback, h) {
      h.put("a.mjs", `revision ${++attempts}`);
      if (attempts === 2) assert.match(feedback, /continue approved work/);
      return report(attempts === 1 ? "continue" : "completed");
    },
  });
  const result = await h.run();
  assert.deepEqual(h.events, ["work:1", "work:1", "check:verify", "review"]);
  assert.equal(h.goal.progress[0].status, "completed");
  assert.equal(h.goal.execution.attempts["step-1"], 2);
  assert.equal(h.goal.execution.history.length, 2);
  assert.deepEqual(h.goal.progress[0].result.observedChangedFiles, ["a.mjs"]);
  assert.deepEqual(result, { initial: h.baseline, after: h.files });
  assert.equal(h.goal.execution.cursor, executionSchedule(h.goal.plan).length);
  assert.equal(h.records[0].label, "check-1");
  h.assertAuthority();
});

test("no-progress limit pauses rather than declaring unfinished work complete", async () => {
  const h = harness({ work: () => report("continue") });
  await pauses(h, /No file progress/);
  assert.equal(h.events.length, EXECUTION_POLICY.maxNoProgressAttempts);
  assert.equal(h.goal.progress[0].status, "in_progress");
  assert.equal(h.goal.review, null);
  assert.deepEqual(h.goal.checks, []);
});

test("legacy policy still pauses after four productive attempts and reports their progress", async () => {
  let attempts = 0;
  const h = harness({
    execution: LEGACY_EXECUTION_POLICY,
    work(s, f, h) {
      h.put("a.mjs", `${++attempts}`);
      return report("continue");
    },
  });
  await pauses(h, /Worker attempt limit/);
  assert.equal(attempts, LEGACY_EXECUTION_POLICY.maxStepAttempts);
  assert.equal(h.goal.execution.noProgress["step-1"], 0);
  assert.equal(h.goal.progress[0].status, "in_progress");
  assert.equal(h.goal.review, null);
  await assert.rejects(h.run(), /results with observed file changes: 4/);
  assert.equal(
    attempts,
    4,
    "repeated execution must not reset old approval limits",
  );
  await assert.rejects(h.run(), /Last worker observed file changes: a.mjs/);
});

test("productive continuation passes the old cap without resetting attempts or approval", async () => {
  let attempts = 0;
  const h = harness({
    work(s, f, h) {
      h.put("a.mjs", `revision ${++attempts}`);
      return report(attempts < 12 ? "continue" : "completed");
    },
  });
  await h.run();
  assert.equal(attempts, 12);
  assert.equal(h.goal.execution.attempts["step-1"], 12);
  assert.equal(h.goal.execution.history.length, 12);
  assert.equal(h.goal.execution.noProgress["step-1"], 0);
  assert.equal(h.goal.progress[0].status, "completed");
  assert.deepEqual(h.events.slice(-2), ["check:verify", "review"]);
  assert.ok(
    h.notices.some((n) =>
      n.includes("attempt 5 (progress-based continuation)"),
    ),
  );
  assert.ok(h.notices.some((n) => n.includes("Observed file changes: a.mjs")));
  assert.ok(
    h.notices.every((n) => !n.includes("/null") && !n.includes("/undefined")),
  );
  h.assertAuthority();
});

test("observed progress resets the stall counter, but claimed changes do not", async () => {
  let attempts = 0;
  const h = harness({
    work(s, f, h) {
      attempts++;
      // Alternating no-change attempts get a grace attempt; later stalls must stop.
      if (attempts <= 8 && attempts % 2 === 0)
        h.put("a.mjs", `revision ${attempts}`);
      return { ...report("continue"), summary: "Claimed file progress" };
    },
  });
  await pauses(h, /No file progress in 2 consecutive attempts/);
  assert.equal(attempts, 10);
  assert.equal(h.goal.execution.noProgress["step-1"], 2);
  assert.equal(
    h.goal.execution.history.filter((r) => r.observedChangedFiles.length)
      .length,
    4,
  );
});

test("identical file rewrites are not observed progress", async () => {
  let attempts = 0;
  const h = harness({
    work(s, f, h) {
      attempts++;
      h.put("a.mjs", "unchanged bytes");
      return report("continue");
    },
  });
  await pauses(h, /No file progress/);
  assert.equal(attempts, 3);
});

test("completed code can proceed to verification without another file change", async () => {
  let attempts = 0;
  const h = harness({
    work(s, f, h) {
      attempts++;
      if (attempts === 1) h.put("a.mjs", "implemented");
      return report(attempts < 3 ? "continue" : "completed");
    },
  });
  await h.run();
  assert.equal(attempts, 3);
  assert.deepEqual(h.events.slice(-2), ["check:verify", "review"]);
});

test("a productive repair can exceed four attempts within one repair round", async () => {
  let checks = 0,
    repairs = 0;
  const h = harness({
    exec: () => output(++checks === 1 ? 1 : 0),
    work(s, f, h) {
      if (s.id === "repair-1") {
        h.put("a.mjs", `repair ${++repairs}`);
        return report(repairs < 6 ? "continue" : "completed");
      }
      h.put("a.mjs", "initial implementation");
      return report();
    },
  });
  await h.run();
  assert.equal(repairs, 6);
  assert.equal(h.goal.execution.repairs, 1);
  assert.equal(h.goal.execution.attempts["repair-1"], 6);
  assert.equal(h.goal.review.verdict, "pass");
  h.assertAuthority();
});

test("failed repeatable verification repairs, rechecks, then reviews", async () => {
  let checks = 0;
  const h = harness({ exec: () => output(++checks === 1 ? 1 : 0) });
  await h.run();
  assert.deepEqual(h.events, [
    "work:1",
    "check:verify",
    "work:repair-1",
    "check:verify",
    "review",
  ]);
  assert.match(h.feedback[1], /Verification failed: verify/);
  assert.match(h.feedback[1], /regression failed/);
  assert.match(h.feedback[1], /memory:check-1/);
  assert.deepEqual(
    h.goal.checks.map((c) => c.code),
    [1, 0],
  );
  assert.equal(h.goal.execution.repairs, 1);
  assert.equal(h.goal.execution.pendingRepair, null);
  h.assertAuthority();
});

test("review repair reruns earlier repeatable checks but not successful one-shot commands", async () => {
  let reviews = 0;
  const h = harness({
    steps: [step("a.mjs"), step("b.mjs")],
    checks: [check("setup", 0, false), check("early", 1), check("late", 2)],
    review(e, initial, h) {
      return h.assessment(++reviews === 1 ? "blocked" : "pass");
    },
  });
  await h.run();
  assert.deepEqual(h.events, [
    "check:setup",
    "work:1",
    "check:early",
    "work:2",
    "check:late",
    "review",
    "work:repair-1",
    "check:early",
    "check:late",
    "review",
  ]);
  assert.match(h.feedback[2], /Independent review requires repair/);
  assert.equal(h.goal.review.verdict, "pass");
  h.assertAuthority();
});

test("schedule executes afterStep=0 before workers and checks after each step", async () => {
  const h = harness({
    steps: [step("a.mjs"), step("b.mjs")],
    checks: [
      check("last", 2),
      check("before", 0),
      check("middle", 1),
      { command: "default", timeout: 10, repeatable: true },
    ],
  });
  assert.deepEqual(executionSchedule(h.goal.plan), [
    { kind: "check", index: 1, afterStep: 0 },
    { kind: "step", index: 0 },
    { kind: "check", index: 2, afterStep: 1 },
    { kind: "step", index: 1 },
    { kind: "check", index: 0, afterStep: 2 },
    { kind: "check", index: 3, afterStep: 2 },
    { kind: "review" },
  ]);
  await h.run();
  assert.deepEqual(h.events, [
    "check:before",
    "work:1",
    "check:middle",
    "work:2",
    "check:last",
    "check:default",
    "review",
  ]);
});

for (const repeatable of [false, undefined]) {
  test(`failed one-shot (${repeatable}) stops before repair and retries only on explicit continuation`, async () => {
    let checks = 0;
    const c = { command: "setup", timeout: 10, afterStep: 1 };
    if (repeatable !== undefined) c.repeatable = repeatable;
    const h = harness({
      checks: [c],
      exec: () => output(++checks === 1 ? 1 : 0),
    });
    await pauses(h, /not approved for automatic reruns/);
    assert.deepEqual(h.events, ["work:1", "check:setup"]);
    assert.equal(h.goal.execution.repairs, 0);
    assert.equal(h.goal.execution.pendingRepair, null);
    await h.run();
    assert.deepEqual(h.events, [
      "work:1",
      "check:setup",
      "check:setup",
      "review",
    ]);
    h.assertAuthority();
  });
}

test("repair eligibility is limited to reached steps, not later approved files", async () => {
  let checks = 0;
  const h = harness({
    steps: [step("a.mjs"), step("b.mjs")],
    checks: [check("early", 1)],
    exec: () => output(++checks === 1 ? 1 : 0),
    work(s, f, h) {
      if (s.id === "repair-1") assert.deepEqual(s.files, ["a.mjs"]);
      h.put(s.files[0], `${s.id}`);
      return report("completed", s.files);
    },
  });
  await h.run();
  assert.deepEqual(h.events, [
    "work:1",
    "check:early",
    "work:repair-1",
    "check:early",
    "work:2",
    "review",
  ]);
});

test("failed pre-worker repeatable check has no eligible repair files", async () => {
  const h = harness({ checks: [check("preflight", 0)], exec: () => output(1) });
  await pauses(h, /No reached implementation files/);
  assert.deepEqual(h.events, ["check:preflight"]);
  assert.equal(h.goal.execution.repairs, 0);
});

test("repair rounds are bounded even when every repair changes files", async () => {
  const h = harness({ exec: () => output(1) });
  await pauses(h, /Repair limit/);
  assert.equal(h.goal.execution.repairs, EXECUTION_POLICY.maxRepairAttempts);
  assert.equal(
    h.events.filter((e) => e.startsWith("work:repair")).length,
    EXECUTION_POLICY.maxRepairAttempts,
  );
  assert.equal(h.goal.checks.length, EXECUTION_POLICY.maxRepairAttempts + 1);
  assert.equal(h.goal.review, null);
});

test("actual blocked worker reports stop immediately despite file progress", async () => {
  const h = harness({
    work(s, f, h) {
      h.put("a.mjs", "partial");
      return report("blocked");
    },
  });
  await pauses(h, /Worker needs external input/);
  assert.deepEqual(h.events, ["work:1"]);
  assert.equal(h.goal.progress[0].status, "in_progress");
  assert.equal(h.goal.execution.repairs, 0);
  assert.deepEqual(h.goal.execution.expected, h.files);
});

for (const boundary of ["changed", "reported"]) {
  test(`${boundary} files cannot cross a worker's step boundary even inside the overall plan`, async () => {
    const h = harness({
      steps: [step("a.mjs"), step("b.mjs")],
      work(s, f, h) {
        if (boundary === "changed") h.put("b.mjs", "unauthorized");
        return report(
          "completed",
          boundary === "reported" ? ["b.mjs"] : ["a.mjs"],
        );
      },
    });
    await assert.rejects(h.run(), /outside its approved targets/);
    assert.deepEqual(h.events, ["work:1"]);
    assert.notEqual(h.goal.progress[0].status, "completed");
    assert.deepEqual(h.goal.execution.expected, h.baseline);
  });
  test(`${boundary} files cannot cross the reached repair boundary`, async () => {
    const h = harness({
      steps: [step("a.mjs"), step("b.mjs")],
      checks: [check("early", 1)],
      exec: () => output(1),
      work(s, f, h) {
        if (s.id === "repair-1") {
          if (boundary === "changed") h.put("b.mjs", "unauthorized repair");
          return report(
            "completed",
            boundary === "reported" ? ["b.mjs"] : s.files,
          );
        }
        h.put("a.mjs", "implemented");
        return report();
      },
    });
    await assert.rejects(h.run(), /outside its approved targets/);
    assert.deepEqual(h.events, ["work:1", "check:early", "work:repair-1"]);
    assert.equal(h.goal.progress[1].status, "pending");
  });
}

test("external drift before execution fails closed without creating a checkpoint", async () => {
  const h = harness();
  h.put("a.mjs", "external");
  await assert.rejects(h.run(), /changed outside owned execution/);
  assert.deepEqual(h.events, []);
  assert.equal(h.goal.execution, null);
});

test("external drift at a retained checkpoint prevents continuation", async () => {
  const h = harness({ work: () => report("blocked") });
  await pauses(h, /external input/);
  h.put("a.mjs", "external");
  await assert.rejects(h.run(), /changed outside owned execution/);
  assert.deepEqual(h.events, ["work:1"]);
});

test("external drift between owned operations is not adopted", async () => {
  let injected = false;
  const h = harness({
    persist(h) {
      if (!injected && h.goal.execution?.cursor === 1) {
        injected = true;
        h.put("a.mjs", "external");
      }
    },
  });
  await assert.rejects(h.run(), /changed between owned operations/);
  assert.deepEqual(h.events, ["work:1"]);
  assert.notDeepEqual(h.goal.execution.expected, h.files);
});

test("independent review file changes invalidate the assessment", async () => {
  const h = harness({
    review(e, i, h) {
      h.put("a.mjs", "review mutation");
      return h.assessment();
    },
  });
  await assert.rejects(h.run(), /Files changed during independent review/);
  assert.equal(h.goal.review, null);
});

test("unsupported persisted policy fails closed before snapshots or worker dispatch", async () => {
  let snapshots = 0;
  const h = harness({
    snapshot() {
      snapshots++;
    },
  });
  h.goal.plan.execution.version = 99;
  h.goal.approval = approvalToken(h.goal);
  await assert.rejects(h.run(), /Unsupported execution policy/);
  assert.equal(snapshots, 0);
  assert.deepEqual(h.events, []);
  assert.equal(h.goal.execution, null);
});

test("revoked approval stops productive continuation beyond the old cap", async () => {
  let attempts = 0;
  const h = harness({
    work(s, f, h) {
      h.put("a.mjs", `revision ${++attempts}`);
      if (attempts === 6) h.goal.approval = null;
      return report("continue");
    },
  });
  await assert.rejects(h.run(), /Approval invalid/);
  assert.equal(attempts, 6);
  assert.equal(h.goal.execution.history.length, 5);
  assert.notDeepEqual(h.goal.execution.expected, h.files);
  assert.deepEqual(h.goal.checks, []);
});

test("invalid approval token prevents all execution effects", async () => {
  const h = harness();
  h.goal.approval = "invalid";
  await assert.rejects(h.run(), /Approval invalid/);
  assert.deepEqual(h.events, []);
  assert.equal(h.goal.execution, null);
});

test("mismatched checkpoint token cannot reuse current approval", async () => {
  const h = harness({ work: () => report("blocked") });
  await pauses(h, /external input/);
  h.goal.execution.token = "another-revision";
  await assert.rejects(h.run(), /checkpoint does not match/);
  assert.deepEqual(h.events, ["work:1"]);
});

test("approval revoked during a worker prevents adopting effects or continuing", async () => {
  const h = harness({
    work(s, f, h) {
      h.put("a.mjs", "partial");
      h.goal.approval = null;
      return report();
    },
  });
  await assert.rejects(h.run(), /Approval invalid/);
  assert.deepEqual(h.events, ["work:1"]);
  assert.deepEqual(h.goal.execution.expected, h.baseline);
  assert.notEqual(h.goal.progress[0].status, "completed");
});

for (const execution of [LEGACY_EXECUTION_POLICY, V2_EXECUTION_POLICY]) {
  test(`v${execution.version} retains global repair budget and omits worker metadata`, async () => {
    const h = harness({
      execution,
      checks: [check("first", 1), check("second", 1)],
      exec(c, h) {
        return output(
          c.command === "first" && h.goal.execution.repairs >= 2 ? 0 : 1,
        );
      },
      work(s, f, h, metadata) {
        assert.equal(metadata, undefined);
        h.put("a.mjs", `${h.events.length}`);
        return report();
      },
    });
    await pauses(h, /Repair limit/);
    assert.equal(h.goal.execution.repairs, 2);
    assert.equal(h.goal.execution.repairsByCheckpoint, undefined);
    assert.equal(h.goal.execution.reachedSteps, undefined);
    assert.equal(h.goal.checks.at(-1).command, "second");
  });
}

test("v2 productive continuation remains uncapped", async () => {
  let attempts = 0;
  const h = harness({
    execution: V2_EXECUTION_POLICY,
    work(s, f, h, metadata) {
      assert.equal(metadata, undefined);
      h.put("a.mjs", `${++attempts}`);
      return report(attempts < 7 ? "continue" : "completed");
    },
  });
  await h.run();
  assert.equal(attempts, 7);
});

test("v3 each check and review gets two repairs with stable workers across rounds and partial results", async () => {
  const keys = [];
  const h = harness({
    // Duplicate commands still have distinct index-based budgets.
    checks: [check("same", 1), check("same", 1)],
    exec(c, h) {
      const index = h.goal.plan.checks.indexOf(c);
      return output(
        (h.goal.execution.repairsByCheckpoint[`check-${index}`] ?? 0) < 2
          ? 1
          : 0,
      );
    },
    review(e, i, h) {
      return h.assessment(
        (h.goal.execution.repairsByCheckpoint.review ?? 0) < 2
          ? "blocked"
          : "pass",
      );
    },
    work(s, f, h, metadata) {
      keys.push(metadata.workerKey);
      h.put("a.mjs", `${h.events.length}`);
      const attempt =
        h.goal.execution.attempts[
          typeof s.id === "number" ? `step-${s.id}` : s.id
        ];
      return report(attempt === 1 ? "continue" : "completed");
    },
  });
  await h.run();
  assert.deepEqual(h.goal.execution.repairsByCheckpoint, {
    "check-0": 2,
    "check-1": 2,
    review: 2,
  });
  assert.equal(h.goal.execution.repairs, 6);
  assert.deepEqual(keys, [
    "step-1",
    "step-1",
    ...["check-0", "check-1", "review"].flatMap((key) =>
      Array(4).fill(`repair:${key}`),
    ),
  ]);
  for (let round = 1; round <= 6; round++)
    assert.equal(h.goal.execution.attempts[`repair-${round}`], 2);
  h.assertAuthority();
});

test("v3 passing another checkpoint never replenishes a prior repair budget", async () => {
  const outcomes = { first: [1, 0, 1, 0, 1], second: [1, 1] };
  const h = harness({
    checks: [check("first", 1), check("second", 1)],
    exec(c) {
      assert.ok(
        outcomes[c.command].length,
        "must stop before unbounded revalidation",
      );
      return output(outcomes[c.command].shift());
    },
  });
  await pauses(h, /Repair limit \(2\) reached for check-0/);
  assert.deepEqual(h.goal.execution.repairsByCheckpoint, {
    "check-0": 2,
    "check-1": 2,
  });
  assert.equal(h.goal.execution.repairs, 4);
  assert.equal(h.goal.execution.pendingRepair, null);
});

for (const execution of [
  LEGACY_EXECUTION_POLICY,
  V2_EXECUTION_POLICY,
  EXECUTION_POLICY,
]) {
  test(`v${execution.version} rewind repair scope preserves versioned semantics`, async () => {
    let early = 0;
    const scopes = [];
    const h = harness({
      execution,
      steps: [step("a.mjs"), step("b.mjs"), step("unreached.mjs")],
      checks: [check("early", 1), check("late", 2)],
      exec(c) {
        return output(c.command === "early" ? (++early === 1 ? 0 : 1) : 1);
      },
      work(s, f, h) {
        if (typeof s.id === "string") {
          scopes.push(s.files);
          if (s.id === "repair-2") return report("blocked", s.files);
        }
        h.put(s.files[0], `${h.events.length}`);
        return report("completed", s.files);
      },
    });
    await pauses(h, /external input/);
    assert.deepEqual(scopes, [
      ["a.mjs", "b.mjs"],
      execution.version === 3 ? ["a.mjs", "b.mjs"] : ["a.mjs"],
    ]);
    assert.equal(h.goal.progress[2].status, "pending");
    if (execution.version === 3) {
      assert.equal(h.goal.execution.reachedSteps, 2);
      delete h.goal.execution.reachedSteps;
      await pauses(h, /external input/);
      assert.equal(
        h.goal.execution.reachedSteps,
        2,
        "derive scope from progress on continuation",
      );
      assert.equal(
        h.goal.execution.repairs,
        2,
        "continuation stays in the existing round",
      );
    }
  });
}

test("v3 preflight failure grants neither repair scope nor checkpoint budget", async () => {
  const h = harness({ checks: [check("preflight", 0)], exec: () => output(1) });
  await pauses(h, /No reached implementation files/);
  assert.equal(h.goal.execution.reachedSteps, 0);
  assert.deepEqual(h.goal.execution.repairsByCheckpoint, {});
  assert.equal(h.goal.execution.pendingRepair, null);
  assert.deepEqual(h.events, ["check:preflight"]);
});

test("completed journals still reject external drift rather than silently succeeding", async () => {
  const h = harness();
  await h.run();
  const events = [...h.events];
  h.put("a.mjs", "external after completion");
  await assert.rejects(h.run(), /changed outside owned execution/);
  assert.deepEqual(h.events, events);
});
