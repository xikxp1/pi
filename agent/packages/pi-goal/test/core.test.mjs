import test from "node:test";
import assert from "node:assert/strict";
import {
  STATE_TYPE,
  EXECUTION_POLICY,
  LEGACY_EXECUTION_POLICY,
  V2_EXECUTION_POLICY,
  ROLES,
  THINKING,
  READ_TOOLS,
  validatePlan,
  profile,
  profiles,
  newGoal,
  askQuestion,
  answerQuestion,
  propose,
  approvalToken,
  approve,
  isApproved,
  toolAllowed,
  pause,
  restore,
  renderPlan,
  renderStatus,
  renderStepProgress,
} from "../core.mjs";

const cwd = "/project";
const settings = () =>
  Object.fromEntries(
    ROLES.map((role) => [
      role,
      {
        model: `provider/${role}-exact-v1`,
        thinking: "high",
        maxTurns: 8,
      },
    ]),
  );
const plan = () => ({
  title: "Add feature",
  summary: "Implement the approved feature",
  acceptance: ["Tests pass"],
  constraints: ["No commits"],
  risks: ["Compatibility"],
  steps: [
    {
      title: "Implement",
      instructions: "Change only the listed file",
      files: ["src/main.mjs"],
    },
  ],
  checks: [{ command: 'node --test "test/core.test.mjs"', timeout: 60 }],
});
const question = () => ({
  question: "Which behavior?",
  context: "We need a scope decision",
  options: ["Minimal", "Extended"],
});
function discussed() {
  const state = newGoal("Feature", cwd, settings());
  const q = askQuestion(state, question());
  answerQuestion(state, "Minimal", q.id);
  return state;
}
function proposed() {
  const state = discussed();
  state.research.push({ summary: "Inspected existing behavior" });
  state.phase = "planning";
  propose(state, plan(), { head: "abc123", dirty: [] });
  return state;
}
function approved() {
  const state = proposed();
  approve(state, approvalToken(state));
  return state;
}
const entry = (data) => ({ type: "custom", customType: STATE_TYPE, data });

test("checkpoint policy and repeatability are explicit, validated and bound to approval", () => {
  const input = plan();
  input.execution = { ...EXECUTION_POLICY };
  input.checks[0].afterStep = 0;
  input.checks[0].repeatable = false;
  const p = validatePlan(input);
  assert.equal(p.checks[0].afterStep, 0);
  assert.equal(p.checks[0].repeatable, false);
  const s = proposed();
  const legacyToken = approvalToken(s);
  s.plan = p;
  const token = approvalToken(s);
  assert.notEqual(token, legacyToken);
  s.plan.checks[0].repeatable = true;
  assert.notEqual(approvalToken(s), token);
  for (const afterStep of [-1, 2, 0.5, "0", null]) {
    assert.throws(
      () =>
        validatePlan({ ...input, checks: [{ ...input.checks[0], afterStep }] }),
      /afterStep/,
    );
  }
  assert.throws(
    () =>
      validatePlan({
        ...input,
        checks: [{ ...input.checks[0], repeatable: "yes" }],
      }),
    /boolean/,
  );
  assert.throws(
    () => validatePlan({ ...input, execution: undefined }),
    /explicit execution policy/,
  );
  assert.throws(
    () =>
      validatePlan({
        ...input,
        execution: { ...EXECUTION_POLICY, maxStepAttempts: 1000 },
      }),
    /Unsupported/,
  );
  assert.throws(
    () =>
      validatePlan({
        ...input,
        execution: { ...EXECUTION_POLICY, unknown: true },
      }),
    /Unsupported/,
  );
  assert.equal(
    validatePlan(plan()).execution,
    undefined,
    "legacy validation does not upgrade authority",
  );
});

test("proposal renders checkpoint order, repeat permissions and progress-based continuation", () => {
  const s = proposed();
  s.plan.execution = { ...EXECUTION_POLICY };
  s.plan.checks[0].afterStep = 0;
  s.plan.checks[0].repeatable = true;
  const output = renderPlan(s);
  assert.match(output, /before implementation/);
  assert.match(output, /automatic reruns authorized/);
  assert.match(output, /no total worker attempt cap/);
  assert.match(output, /continued attempts consume tokens/);
  assert.match(output, /2 consecutive no-file-progress continuation attempts/);
  assert.match(output, /2 repair rounds per checkpoint/);
  assert.match(output, /persistent workers per step and per repair checkpoint/);
  assert.match(output, /passing revalidation does not reset its budget/);
  s.plan.execution = { ...V2_EXECUTION_POLICY };
  assert.match(renderPlan(s), /no total worker attempt cap/);
  assert.doesNotMatch(renderPlan(s), /per checkpoint|persistent workers/);
  assert.doesNotMatch(output, /up to 4 worker attempts/);
  s.plan.execution = { ...LEGACY_EXECUTION_POLICY };
  assert.match(renderPlan(s), /up to 4 worker attempts/);
  assert.doesNotMatch(renderPlan(s), /no total worker attempt cap/);
});

test("versioned policies preserve old authority and require new approval to remove the cap", () => {
  const s = proposed();
  s.plan = validatePlan({ ...plan(), execution: LEGACY_EXECUTION_POLICY });
  assert.deepEqual(s.plan.execution, LEGACY_EXECUTION_POLICY);
  const token = approvalToken(s);
  approve(s, token);
  assert.equal(isApproved(s), true);
  assert.equal(approvalToken({ ...s, plan: validatePlan(s.plan) }), token);
  const restored = restore([entry(s)], cwd);
  assert.deepEqual(restored.plan.execution, LEGACY_EXECUTION_POLICY);
  assert.equal(restored.approval, null);
  s.plan.execution = { ...EXECUTION_POLICY };
  assert.notEqual(approvalToken(s), token);
  assert.equal(isApproved(s), false);
  for (const execution of [
    { ...LEGACY_EXECUTION_POLICY, maxStepAttempts: null },
    { ...EXECUTION_POLICY, maxStepAttempts: 4 },
    { ...EXECUTION_POLICY, maxNoProgressAttempts: 0 },
    { ...EXECUTION_POLICY, maxRepairAttempts: 3 },
    { ...EXECUTION_POLICY, version: 4 },
    { version: 2, maxRepairAttempts: 2, maxNoProgressAttempts: 2 },
    null,
  ])
    assert.throws(() => validatePlan({ ...plan(), execution }), /Unsupported/);
});

test("v2 policy remains exact and v3 requires fresh approval", () => {
  assert.equal(EXECUTION_POLICY.version, 3);
  for (const execution of [
    LEGACY_EXECUTION_POLICY,
    V2_EXECUTION_POLICY,
    EXECUTION_POLICY,
  ]) {
    assert.deepEqual(
      validatePlan({ ...plan(), execution }).execution,
      execution,
    );
    for (const invalid of [
      { ...execution, extra: true },
      { ...execution, maxRepairAttempts: 1 },
      { ...execution, maxNoProgressAttempts: 3 },
      { ...execution, maxStepAttempts: 5 },
    ])
      assert.throws(
        () => validatePlan({ ...plan(), execution: invalid }),
        /Unsupported/,
      );
  }
  const s = proposed();
  s.plan.execution = { ...V2_EXECUTION_POLICY };
  const token = approvalToken(s);
  approve(s, token);
  assert.equal(approvalToken({ ...s, plan: validatePlan(s.plan) }), token);
  assert.deepEqual(
    restore([entry(s)], cwd).plan.execution,
    V2_EXECUTION_POLICY,
  );
  s.plan.execution = { ...EXECUTION_POLICY };
  assert.notEqual(approvalToken(s), token);
  assert.equal(isApproved(s), false);
});

test("paused status distinguishes unfinished work from active workers and includes observed progress", () => {
  const s = approved();
  s.progress[0].status = "in_progress";
  s.phase = "executing";
  assert.match(renderStepProgress(s, s.progress[0]), /^in_progress:/);
  s.phase = "paused";
  s.worker = null;
  s.execution = {
    history: [
      {
        step: 1,
        summary: "Added greeting; more work remains",
        observedChangedFiles: ["src/main.mjs"],
        artifact: "memory:worker",
      },
    ],
  };
  const output = renderStatus(s);
  assert.match(output, /No active goal worker/);
  assert.match(output, /unfinished \(paused\): Implement/);
  assert.doesNotMatch(output, /in_progress:/);
  assert.match(output, /results with observed file changes: 1/);
  assert.match(output, /Added greeting; more work remains/);
  assert.match(output, /Last worker observed file changes: src\/main.mjs/);
  assert.match(output, /Full worker evidence: memory:worker/);
  assert.equal(
    s.progress[0].status,
    "in_progress",
    "rendering must not mutate the execution journal",
  );
  s.worker = { role: "implementer", id: "unsettled-child" };
  assert.doesNotMatch(renderStatus(s), /No active goal worker/);
  assert.match(renderStatus(s), /unsettled-child/);
});

test("validatePlan normalizes, assigns step IDs and deduplicates exact files", () => {
  const input = plan();
  input.title = "  Add feature  ";
  input.steps[0].id = 99;
  input.steps[0].files.push("src/main.mjs");
  const original = structuredClone(input);
  const result = validatePlan(input);
  assert.equal(result.title, "Add feature");
  assert.equal(result.steps[0].id, 1);
  assert.deepEqual(result.steps[0].files, ["src/main.mjs"]);
  assert.deepEqual(input, original);
});

for (const [field, min, max] of [
  ["acceptance", 1, 12],
  ["constraints", 0, 12],
  ["risks", 0, 12],
  ["steps", 1, 12],
  ["checks", 1, 12],
]) {
  test(`validatePlan ${field} item bounds`, () => {
    const sample = plan()[field][0];
    for (const count of [min, max]) {
      assert.doesNotThrow(() =>
        validatePlan({
          ...plan(),
          [field]: Array.from({ length: count }, () => structuredClone(sample)),
        }),
      );
    }
    for (const value of [
      null,
      "invalid",
      Array(max + 1).fill(sample),
      ...(min ? [[]] : []),
    ]) {
      assert.throws(() => validatePlan({ ...plan(), [field]: value }));
    }
  });
}
for (const [label, limit, change] of [
  [
    "title",
    300,
    (p, v) => {
      p.title = v;
    },
  ],
  [
    "summary",
    8000,
    (p, v) => {
      p.summary = v;
    },
  ],
  [
    "acceptance",
    2000,
    (p, v) => {
      p.acceptance = [v];
    },
  ],
  [
    "constraints",
    2000,
    (p, v) => {
      p.constraints = [v];
    },
  ],
  [
    "risks",
    2000,
    (p, v) => {
      p.risks = [v];
    },
  ],
  [
    "step title",
    300,
    (p, v) => {
      p.steps[0].title = v;
    },
  ],
  [
    "instructions",
    6000,
    (p, v) => {
      p.steps[0].instructions = v;
    },
  ],
  [
    "file",
    1000,
    (p, v) => {
      p.steps[0].files = [v];
    },
  ],
  [
    "command",
    2000,
    (p, v) => {
      p.checks[0].command = v;
    },
  ],
]) {
  test(`validatePlan ${label} text bounds`, () => {
    const valid = plan();
    change(valid, "x".repeat(limit));
    assert.doesNotThrow(() => validatePlan(valid));
    for (const value of ["", "   ", null, 42, "x".repeat(limit + 1)]) {
      const invalid = plan();
      change(invalid, value);
      assert.throws(() => validatePlan(invalid));
    }
  });
}
test("validatePlan file counts, command timeouts and total size", () => {
  for (const count of [1, 30]) {
    const p = plan();
    p.steps[0].files = Array.from({ length: count }, (_, i) => `src/${i}.mjs`);
    assert.doesNotThrow(() => validatePlan(p));
  }
  for (const files of [[], Array(31).fill("a"), null]) {
    const p = plan();
    p.steps[0].files = files;
    assert.throws(() => validatePlan(p));
  }
  for (const timeout of [1, 600]) {
    const p = plan();
    p.checks[0].timeout = timeout;
    assert.doesNotThrow(() => validatePlan(p));
  }
  for (const timeout of [0, 601, 1.5, "60", null, NaN, Infinity]) {
    const p = plan();
    p.checks[0].timeout = timeout;
    assert.throws(() => validatePlan(p));
  }
  const large = plan();
  large.steps = Array.from({ length: 9 }, () => ({
    ...plan().steps[0],
    instructions: "x".repeat(6000),
  }));
  assert.throws(() => validatePlan(large), /50,000/);
  for (const value of [null, undefined, 1, {}, []])
    assert.throws(() => validatePlan(value));
});
for (const path of [
  "/etc/passwd",
  "../secret",
  "src/../secret",
  "src\\main.mjs",
  "src//main.mjs",
  "src/",
  "src/*.mjs",
  "src/?.mjs",
  "src/[ab].mjs",
  "src/\0bad",
  "src/\nbad",
]) {
  test(`validatePlan rejects unsafe path ${JSON.stringify(path)}`, () => {
    const p = plan();
    p.steps[0].files = [path];
    assert.throws(() => validatePlan(p), /path/);
  });
}
test("validatePlan rejects the project directory itself as a file", () => {
  const p = plan();
  p.steps[0].files = ["."];
  assert.throws(() => validatePlan(p));
});

test("profiles preserve exact provider/model IDs and validate all settings", () => {
  const base = { model: "openai/gpt-5.1-codex", thinking: "high", maxTurns: 8 };
  assert.deepEqual(profile({ ...base, extra: "ignored" }), base);
  for (const thinking of THINKING)
    assert.equal(profile({ ...base, thinking }).thinking, thinking);
  for (const maxTurns of [1, 100])
    assert.equal(profile({ ...base, maxTurns }).maxTurns, maxTurns);
  for (const model of [
    "",
    "alias",
    "/model",
    "provider/",
    "provider/model with spaces",
    "pro vider/model",
  ])
    assert.throws(() => profile({ ...base, model }));
  for (const thinking of ["HIGH", "", null, "auto"])
    assert.throws(() => profile({ ...base, thinking }));
  for (const maxTurns of [0, 101, 1.1, "8", null, NaN])
    assert.throws(() => profile({ ...base, maxTurns }));
  assert.throws(() => profile(null));
  assert.deepEqual(profiles(), {});
  assert.deepEqual(profiles(settings(), true), settings());
  for (const role of ROLES) {
    const incomplete = settings();
    delete incomplete[role];
    assert.throws(() => profiles(incomplete, true), new RegExp(role));
  }
});
test("profiles reject wildcard model selectors rather than treating them as exact IDs", () => {
  assert.throws(() =>
    profile({ model: "provider/*", thinking: "high", maxTurns: 8 }),
  );
});

test("planning requires a user answer and research, research is discussion-only", () => {
  const state = newGoal("Feature", cwd, settings());
  assert.equal(toolAllowed(state, "goal_research"), true);
  assert.equal(toolAllowed(state, "goal_plan"), false);
  state.research.push("Evidence");
  assert.equal(toolAllowed(state, "goal_plan"), false);
  const q = askQuestion(state, question());
  assert.equal(toolAllowed(state, "goal_research"), false);
  answerQuestion(state, "Minimal", q.id);
  assert.equal(toolAllowed(state, "goal_plan"), true);
  state.research = [];
  assert.equal(toolAllowed(state, "goal_plan"), false);
  state.phase = "planning";
  state.answers = [];
  assert.throws(() => propose(state, plan(), {}), /question/);
});
test("propose cannot bypass the research prerequisite", () => {
  const state = discussed();
  state.phase = "planning";
  assert.throws(() => propose(state, plan(), {}), /research/i);
});
test("questions reject stale IDs without mutation and record the actual answer", () => {
  const state = discussed();
  const oldId = state.answers[0].id;
  const q = askQuestion(state, question());
  const before = structuredClone(state);
  assert.throws(() => answerQuestion(state, "Wrong", oldId), /stale/);
  assert.deepEqual(state, before);
  assert.throws(() => askQuestion(state, question()), /Cannot ask/);
  answerQuestion(state, "  Extended  ", q.id);
  assert.equal(state.answers.at(-1).answer, "Extended");
  assert.equal(state.answers.at(-1).id, q.id);
  assert.equal(state.pendingQuestion, null);
  assert.equal(state.phase, "discussing");
  assert.throws(() => answerQuestion(state, "Again", q.id), /No pending/);
  const awaiting = proposed();
  askQuestion(awaiting, question());
  assert.equal(awaiting.phase, "asking");
  assert.equal(awaiting.approval, null);
});
test("invalid and excessive answers do not consume the pending question", () => {
  const state = discussed();
  askQuestion(state, question());
  for (const answer of ["", " ", "x".repeat(8001)])
    assert.throws(() => answerQuestion(state, answer));
  state.answers = Array(30).fill(state.answers[0]);
  assert.throws(() => answerQuestion(state, "Answer"), /limit/);
  assert.equal(state.phase, "asking");
  assert.ok(state.pendingQuestion);
});

for (const [label, mutate] of [
  [
    "plan",
    (s) => {
      s.plan.steps[0].instructions += " changed";
    },
  ],
  [
    "profiles",
    (s) => {
      s.profiles.implementer.maxTurns++;
    },
  ],
  [
    "baseline",
    (s) => {
      s.baseline.head = "different";
    },
  ],
  [
    "answers",
    (s) => {
      s.answers[0].answer = "Extended";
    },
  ],
  [
    "goal identity",
    (s) => {
      s.id = "other";
    },
  ],
  [
    "revision",
    (s) => {
      s.revision++;
    },
  ],
]) {
  test(`approval binds ${label}`, () => {
    const state = approved();
    const token = state.approval;
    mutate(state);
    assert.notEqual(approvalToken(state), token);
    assert.equal(isApproved(state), false);
    assert.equal(toolAllowed(state, "goal_execute"), false);
    state.phase = "awaiting_approval";
    assert.throws(() => approve(state, token), /stale/);
  });
}
test("only the exact current approval token authorizes execution", () => {
  const state = proposed();
  const token = approvalToken(state);
  for (const bad of [
    undefined,
    null,
    "",
    String(state.revision),
    `${token} `,
    token.toUpperCase(),
  ]) {
    assert.throws(() => approve(state, bad), /stale/);
    assert.equal(isApproved(state), false);
  }
  approve(state, token);
  assert.equal(isApproved(state), true);
  assert.throws(() => approve(state, token), /awaiting approval/);
  state.phase = "executing";
  assert.equal(isApproved(state), true);
  state.phase = "planning";
  propose(state, plan(), state.baseline);
  assert.equal(state.revision, 2);
  assert.equal(state.approval, null);
  assert.throws(() => approve(state, token), /stale/);
});
test("model-supplied approval fields in tool arguments never grant approval", () => {
  const state = discussed();
  state.research.push("Evidence");
  state.phase = "planning";
  propose(
    state,
    {
      ...plan(),
      approval: "approved",
      approved: true,
      phase: "approved",
      token: "yes",
    },
    {},
  );
  assert.equal(state.phase, "awaiting_approval");
  assert.equal(state.approval, null);
  assert.equal("approval" in state.plan, false);
  assert.equal(
    toolAllowed(state, "goal_execute", {
      approval: approvalToken(state),
      approved: true,
    }),
    false,
  );
  askQuestion(state, {
    ...question(),
    approval: approvalToken(state),
    phase: "approved",
  });
  assert.equal(state.phase, "asking");
  assert.equal(isApproved(state), false);
});

const forbidden = [
  "write",
  "edit",
  "bash",
  "shell",
  "exec",
  "terminal",
  "Agent",
  "agent",
  "SubagentWorkflow",
  "get_subagent_result",
  "steer_subagent",
  "parallel",
  "pipeline",
  "multi_tool_use.parallel",
  "functions.bash",
  "functions.write",
  "web_search",
  "fetch_content",
  "ask_user",
  "unknown",
  "",
  undefined,
];
for (const phase of [
  "discussing",
  "asking",
  "planning",
  "awaiting_approval",
  "approved",
  "executing",
  "paused",
  "blocked",
]) {
  test(`toolAllowed fails closed in ${phase}; main never writes`, () => {
    const state = approved();
    state.phase = phase;
    for (const name of forbidden)
      assert.equal(toolAllowed(state, name), false, String(name));
    for (const name of [...READ_TOOLS, "todo"])
      assert.equal(toolAllowed(state, name), true, name);
    assert.equal(
      toolAllowed(state, "goal_execute"),
      ["approved", "executing"].includes(phase),
    );
    assert.equal(toolAllowed(state, "goal_research"), phase === "discussing");
    assert.equal(toolAllowed(state, "goal_plan"), phase === "discussing");
    assert.equal(
      toolAllowed(state, "goal_question"),
      ["discussing", "awaiting_approval"].includes(phase),
    );
  });
}
test("pause invalidates approval and prevents token reuse", () => {
  const state = approved();
  const token = state.approval;
  state.phase = "executing";
  pause(state, "User interrupted");
  assert.equal(state.phase, "paused");
  assert.equal(state.approval, null);
  assert.equal(state.reason, "User interrupted");
  assert.equal(isApproved(state), false);
  assert.equal(toolAllowed(state, "goal_execute"), false);
  assert.throws(() => approve(state, token), /awaiting approval/);
});

test("restore considers only supplied active-branch entries and exact cwd", () => {
  const first = discussed();
  const last = proposed();
  const otherBranch = approved(); // Intentionally never supplied to restore.
  const entries = [
    entry(first),
    entry(last),
    entry({ ...otherBranch, cwd: "/other" }),
    entry({ ...otherBranch, version: 2 }),
    entry({ ...otherBranch, phase: "invented" }),
    entry(null),
    { ...entry(otherBranch), type: "message" },
    { ...entry(otherBranch), customType: "other" },
  ];
  const restored = restore(entries, cwd);
  assert.deepEqual(restored, last);
  assert.notEqual(restored, last);
  restored.answers[0].answer = "Mutated";
  assert.notEqual(last.answers[0].answer, "Mutated");
  assert.deepEqual(restore([entry(first)], cwd), first);
  assert.equal(restore([], cwd), null);
  assert.equal(restore(entries, "/unrelated"), null);
});
for (const phase of ["approved", "executing", "planning"]) {
  test(`restore pauses ${phase} and discards approval/worker without changing entries`, () => {
    const state = approved();
    state.phase = phase;
    state.worker = { id: "worker", role: "implementer" };
    const before = structuredClone(state);
    const result = restore([entry(state)], cwd);
    assert.equal(result.phase, "paused");
    assert.equal(result.approval, null);
    assert.equal(result.worker, null);
    assert.equal(isApproved(result), false);
    assert.match(result.reason, /Interrupted session/);
    assert.deepEqual(state, before);
    state.worker = null;
    assert.equal(restore([entry(state)], cwd).phase, "paused");
  });
}
test("restore pauses any nonterminal state with an interrupted worker", () => {
  const state = discussed();
  state.worker = { id: "worker" };
  assert.equal(restore([entry(state)], cwd).phase, "paused");
});
for (const phase of ["completed", "cancelled"]) {
  test(`${phase} restores normally, ignores pause and permits normal tools`, () => {
    const state = approved();
    state.phase = phase;
    const before = structuredClone(state);
    pause(state);
    assert.deepEqual(state, before);
    assert.deepEqual(restore([entry(state)], cwd), before);
    assert.equal(isApproved(state), false);
    for (const name of [...forbidden, "goal_execute"])
      assert.equal(toolAllowed(state, name), true);
  });
}
test("no active goal permits ordinary tools", () => {
  for (const name of forbidden) assert.equal(toolAllowed(null, name), true);
});
test("renderPlan reveals exact commands, timeouts, files, instructions, settings and token", () => {
  const state = proposed();
  state.plan.checks.push({
    command: 'printf "a\\nb" && node --version',
    timeout: 123,
  });
  const output = renderPlan(state);
  for (const check of state.plan.checks)
    assert.ok(
      output.includes(
        `${JSON.stringify(check.command)} (timeout ${check.timeout}s)`,
      ),
    );
  for (const role of ROLES) {
    const p = state.profiles[role];
    assert.ok(
      output.includes(
        `${role}: ${p.model} / ${p.thinking} / up to ${p.maxTurns} turns`,
      ),
    );
  }
  for (const value of [
    state.plan.title,
    state.plan.summary,
    ...state.plan.acceptance,
    ...state.plan.constraints,
    ...state.plan.risks,
    state.plan.steps[0].instructions,
    ...state.plan.steps[0].files,
    cwd,
    `**Revision: ${approvalToken(state)}**`,
    `/goal approve ${approvalToken(state)}`,
  ])
    assert.ok(output.includes(value), value);
  assert.match(output, /no shell or nested agents/);
  assert.match(output, /No automatic commits or merges/);
  assert.equal(renderPlan(newGoal("Feature", cwd)), "No plan proposed yet.");
});
