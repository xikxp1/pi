import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installGoal } from "../controller.mjs";
import { snapshot as snapshotFiles } from "../storage.mjs";
import { ROLES, TURN_LIMITS, STATE_TYPE, approvalToken } from "../core.mjs";

const plan = {
  title: "Add a greeting",
  summary: "A small test feature",
  acceptance: ["Greeting is hello"],
  constraints: ["Preserve unrelated files"],
  risks: [],
  steps: [
    {
      title: "Write greeting",
      instructions: "Set greeting.txt to hello",
      files: ["greeting.txt"],
    },
  ],
  checks: [{ command: 'test "$(cat greeting.txt)" = hello', timeout: 5 }],
};
const defaultProfiles = Object.fromEntries(
  ROLES.map((role) => [
    role,
    { model: "test/model", thinking: "medium", maxTurns: TURN_LIMITS[role] },
  ]),
);
const parseFrontmatter = (raw) => ({
  frontmatter: Object.fromEntries(
    raw
      .split("---")[1]
      .trim()
      .split("\n")
      .map((line) => {
        const colon = line.indexOf(":");
        return [line.slice(0, colon), line.slice(colon + 1).trim()];
      }),
  ),
});
const bus = () => {
  const listeners = new Map();
  return {
    on(name, fn) {
      const set = listeners.get(name) ?? new Set();
      listeners.set(name, set);
      set.add(fn);
      return () => set.delete(fn);
    },
    emit(name, value) {
      for (const fn of listeners.get(name) ?? []) fn(value);
    },
  };
};
async function fixture(
  t,
  { mode = "rpc", configured = true, replies = [], proposal = plan } = {},
) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-goal-controller-"));
  const previousCwd = process.cwd();
  process.chdir(cwd);
  const agentDir = join(cwd, "agent");
  await mkdir(agentDir);
  if (configured)
    await writeFile(
      join(agentDir, "goal.json"),
      JSON.stringify({ version: 1, profiles: defaultProfiles }),
    );
  const entries = [],
    messages = [],
    notifications = [],
    prompts = [],
    requests = [],
    spawns = [],
    execs = [],
    widgets = [];
  const hooks = new Map(),
    tools = new Map(),
    commands = new Map();
  let number = 0,
    confirm = true,
    execCode = 0,
    execOverride,
    runOverride,
    snapshotOverride;
  const fakeClient = {
    hasUnsettled: false,
    async ping() {
      return 2;
    },
    assertResumeSupport() {},
    forgetContinuations() {},
    async stop() {},
    async dispose() {},
    async run(request) {
      spawns.push(request);
      const id = request.resumeId ?? `child-${++number}`;
      request.onSpawned(id);
      if (runOverride) {
        const outcome = await runOverride(request, id);
        if (outcome) {
          if (request.structuredOutput)
            request.structuredOutput.check(JSON.parse(outcome.result));
          return outcome;
        }
      }
      let result;
      if (request.type.endsWith("Researcher"))
        result = "Observed the project. greeting.txt is the intended new file.";
      if (request.type.endsWith("Planner")) result = JSON.stringify(proposal);
      if (request.type.endsWith("Implementer")) {
        await writeFile(join(cwd, "greeting.txt"), "hello");
        result = JSON.stringify({
          status: "completed",
          summary: "Created greeting",
          files: ["greeting.txt"],
        });
      }
      if (request.type.endsWith("Reviewer"))
        result = JSON.stringify({
          verdict: "pass",
          summary: "Read greeting.txt and confirmed hello",
          issues: [],
          criteria: [
            {
              criterion: plan.acceptance[0],
              evidence:
                "greeting.txt contains hello; approved shell check exited 0",
            },
          ],
        });
      if (request.structuredOutput)
        request.structuredOutput.check(JSON.parse(result));
      return { id, status: "completed", result };
    },
  };
  const pi = {
    events: bus(),
    on(name, fn) {
      const list = hooks.get(name) ?? [];
      hooks.set(name, list);
      list.push(fn);
    },
    registerCommand(name, definition) {
      commands.set(name, definition);
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    appendEntry(customType, data) {
      entries.push({ type: "custom", customType, data: structuredClone(data) });
    },
    sendMessage(message) {
      messages.push(message);
    },
    sendUserMessage(message) {
      prompts.push(message);
    },
    async exec(command, args, options) {
      execs.push({ command, args, options });
      if (execOverride) return execOverride(command, args, options);
      return {
        code: execCode,
        killed: false,
        stdout: execCode ? "failed" : "passed",
        stderr: "",
      };
    },
  };
  const ctx = {
    mode,
    hasUI: true,
    cwd,
    modelRegistry: {
      find(provider, id) {
        return provider === "test" && id === "model"
          ? { provider, id }
          : undefined;
      },
      hasConfiguredAuth() {
        return true;
      },
      getAvailable() {
        return [{ provider: "test", id: "model" }];
      },
    },
    ui: {
      async select(title, options, settings) {
        requests.push({ title, options, settings });
        return replies.shift();
      },
      async confirm(title, content) {
        requests.push({ title, content });
        return confirm;
      },
      notify(message) {
        notifications.push(message);
      },
      setStatus() {},
      setWidget(name, lines) {
        widgets.push({ name, lines });
      },
      input() {
        throw new Error("Freeform dialogs must not be used");
      },
      editor() {
        throw new Error("Freeform editors must not be used");
      },
    },
    sessionManager: {
      getSessionId() {
        return "fixture-session";
      },
      getBranch() {
        return entries;
      },
    },
    abort() {},
  };
  const controller = installGoal(pi, {
    agentDir,
    getSupportedThinkingLevels: () => ["off", "medium", "high"],
    parseFrontmatter,
    clientFactory: () => fakeClient,
    snapshot: (...args) =>
      snapshotOverride ? snapshotOverride(...args) : snapshotFiles(...args),
  });
  const fire = async (name, event = {}) => {
    let result;
    for (const fn of hooks.get(name) ?? []) result = await fn(event, ctx);
    return result;
  };
  await fire("session_start");
  t.after(async () => {
    await fire("session_shutdown");
    process.chdir(previousCwd);
    await rm(cwd, { recursive: true, force: true });
  });
  const call = (name, args = {}, signal) =>
    tools.get(name).execute("tool-id", args, signal, () => {}, ctx);
  const command = (args) => commands.get("goal").handler(args, ctx);
  const readyPlan = async () => {
    await command("Add greeting");
    await call("goal_research", { question: "Inspect greeting behavior" });
    await call("goal_question", {
      question: "What should the greeting say?",
      context: "No greeting exists yet.",
      options: ["hello", "hi"],
    });
    if (controller.getState().phase === "asking") await command("answer hello");
    await call("goal_plan");
  };
  return {
    cwd,
    agentDir,
    entries,
    messages,
    notifications,
    prompts,
    requests,
    spawns,
    execs,
    widgets,
    controller,
    tools,
    ctx,
    fire,
    command,
    call,
    readyPlan,
    setConfirm: (value) => {
      confirm = value;
    },
    setExecCode: (value) => {
      execCode = value;
    },
    setExec: (value) => {
      execOverride = value;
    },
    setRun: (value) => {
      runOverride = value;
    },
    fakeClient,
    setSnapshot: (value) => {
      snapshotOverride = value;
    },
  };
}

test("ACP interview, revision approval, frozen profiles, worker, checks, independent review", async (t) => {
  const f = await fixture(t);
  await f.readyPlan();
  assert.equal(f.controller.getState().phase, "awaiting_approval");
  assert.equal(f.spawns.length, 2);
  assert.equal(
    f.requests.length,
    0,
    "ACP questions use ordinary chat, not unsupported freeform UI",
  );
  await assert.rejects(f.call("goal_execute"), /explicit approval/);
  await f.command("approve wrong-revision");
  assert.equal(f.spawns.length, 2);
  const token = approvalToken(f.controller.getState());
  await f.command(`approve ${token}`);
  assert.equal(f.controller.getState().phase, "approved");
  const result = await f.call("goal_execute");
  assert.equal(result.terminate, true);
  assert.equal(f.controller.getState().phase, "completed");
  assert.deepEqual(
    f.spawns.map((r) => r.type),
    [
      "PiGoalResearcher",
      "PiGoalPlanner",
      "PiGoalImplementer",
      "PiGoalReviewer",
    ],
  );
  assert(
    f.spawns.every(
      (r) =>
        r.model === "test/model" &&
        r.thinkingLevel === "medium" &&
        r.cwd === f.cwd,
    ),
  );
  assert.deepEqual(
    f.execs.map((e) => [e.command, e.args]),
    [["bash", ["-lc", plan.checks[0].command]]],
  );
  assert.equal(f.execs[0].options.timeout, 5000);
  assert.equal(await readFile(join(f.cwd, "greeting.txt"), "utf8"), "hello");
  assert.match(result.content[0].text, /Full outcome:/);
});

test("ordinary yes is not approval; profile overrides invalidate a proposal", async (t) => {
  const f = await fixture(t);
  await f.readyPlan();
  const old = approvalToken(f.controller.getState());
  await f.fire("input", { text: "yes", source: "rpc" });
  assert.equal(f.controller.getState().phase, "discussing");
  await f.command(`approve ${old}`);
  assert.equal(f.controller.getState().approval, null);
  await f.call("goal_plan");
  await f.command("override implementer test/model high 10");
  assert.equal(f.controller.getState().phase, "discussing");
  assert.equal(f.controller.getState().profiles.implementer.thinking, "high");
  assert.equal(f.controller.getState().approval, null);
});

test("changed files make the displayed approval stale", async (t) => {
  const f = await fixture(t);
  await f.readyPlan();
  const token = approvalToken(f.controller.getState());
  await writeFile(join(f.cwd, "greeting.txt"), "user edit");
  await f.command(`approve ${token}`);
  assert.equal(f.controller.getState().approval, null);
  assert.equal(f.controller.getState().phase, "discussing");
  assert.equal(
    await readFile(join(f.cwd, "greeting.txt"), "utf8"),
    "user edit",
  );
  assert.equal(f.execs.length, 0);
});

test("TUI offers choices and records actual selected user input", async (t) => {
  const f = await fixture(t, { mode: "tui", replies: ["hello"] });
  await f.command("Add greeting");
  const result = await f.call("goal_question", {
    question: "Which greeting?",
    context: "This choice changes visible behavior.",
    options: ["hello", "hi"],
  });
  assert.equal(f.controller.getState().answers[0].answer, "hello");
  assert.notEqual(result.terminate, true);
  assert.equal(f.requests.length, 1);
});

test("first use selects explicit models/thinking; cancellation guesses nothing", async (t) => {
  const f = await fixture(t, {
    configured: false,
    replies: ["test/model", "high", undefined],
  });
  await f.command("Add greeting");
  assert.deepEqual(Object.keys(f.controller.getState().profiles), [
    "researcher",
  ]);
  assert.equal(f.controller.getState().profiles.researcher.thinking, "high");
  assert.equal(f.spawns.length, 0);
  await assert.rejects(
    f.call("goal_research", { question: "Inspect" }),
    /Configure the planner/,
  );
  assert.equal(f.spawns.length, 0);
  await f.command("profile planner test/model max");
  assert.equal(f.controller.getState().profiles.planner, undefined);
  assert(
    f.notifications.some((n) => n.includes("will not be silently clamped")),
  );
});

test("failed one-shot verification pauses with approval retained and no automatic rerun", async (t) => {
  const f = await fixture(t);
  await f.readyPlan();
  await f.command(`approve ${approvalToken(f.controller.getState())}`);
  f.setExecCode(1);
  await assert.rejects(f.call("goal_execute"), /Verification failed/);
  assert.equal(f.controller.getState().phase, "paused");
  assert.equal(
    f.controller.getState().approval,
    approvalToken(f.controller.getState()),
  );
  assert.equal(f.spawns.filter((r) => r.type.endsWith("Reviewer")).length, 0);
  assert.equal(f.execs.length, 1);
});

test("blocked worker status never becomes a completed step or a test run", async (t) => {
  const f = await fixture(t);
  await f.readyPlan();
  await f.command(`approve ${approvalToken(f.controller.getState())}`);
  f.setRun(async (_request, id) => ({
    id,
    status: "completed",
    result: JSON.stringify({
      status: "blocked",
      summary: "Need a user decision",
      files: [],
    }),
  }));
  await assert.rejects(f.call("goal_execute"), /Need a user decision/);
  assert.equal(f.controller.getState().phase, "paused");
  assert.equal(
    f.controller.getState().approval,
    approvalToken(f.controller.getState()),
  );
  assert.equal(f.controller.getState().progress[0].status, "in_progress");
  assert.equal(f.execs.length, 0);
});

test("pause during child execution stops advancement; resume requires fresh approval", async (t) => {
  const f = await fixture(t);
  await f.readyPlan();
  await f.command(`approve ${approvalToken(f.controller.getState())}`);
  let started;
  const didStart = new Promise((resolve) => {
    started = resolve;
  });
  f.setRun(async (request) => {
    started();
    await new Promise((resolve) =>
      request.signal.addEventListener("abort", resolve, { once: true }),
    );
    throw new DOMException("aborted", "AbortError");
  });
  const running = f.call("goal_execute");
  const failed = assert.rejects(running, /aborted|cancelled/);
  await didStart;
  await f.command("pause");
  await failed;
  assert.equal(f.controller.getState().phase, "paused");
  assert.equal(f.execs.length, 0);
  await f.command("resume");
  assert.equal(f.controller.getState().phase, "awaiting_approval");
  assert.equal(f.controller.getState().approval, null);
  assert.notEqual(f.controller.getState().progress[0].status, "completed");
});

test("tree navigation restores the selected branch, not old in-memory state", async (t) => {
  const f = await fixture(t);
  await f.command("First feature");
  const first = structuredClone(f.entries.at(-1));
  await f.command("cancel");
  await f.command("Second feature");
  f.entries.splice(0, f.entries.length, first);
  await f.fire("session_tree");
  assert.equal(f.controller.getState().feature, "First feature");
  assert.equal(
    f.entries.filter((e) => e.customType === STATE_TYPE).at(-1).data.feature,
    "First feature",
  );
});

test("parent tool gate blocks mutation, wrapper bypass, and uncontrolled delegation", async (t) => {
  const f = await fixture(t);
  await f.command("Add greeting");
  for (const name of [
    "bash",
    "write",
    "edit",
    "Agent",
    "SubagentWorkflow",
    "multi_tool_use.parallel",
    "unknown",
  ]) {
    const result = await f.fire("tool_call", { toolName: name });
    assert.equal(result.block, true, name);
    assert.equal(result.terminate, true);
  }
  assert.equal(await f.fire("tool_call", { toolName: "read" }), undefined);
  await f.command("cancel");
  assert.equal(await f.fire("tool_call", { toolName: "write" }), undefined);
});

test("project-declared shadow agent refuses dispatch, even with an unrelated filename", async (t) => {
  const f = await fixture(t);
  await f.command("Add greeting");
  await mkdir(join(f.cwd, ".pi", "agents"), { recursive: true });
  await writeFile(
    join(f.cwd, ".pi", "agents", "innocent.md"),
    "---\nname: PiGoalResearcher\ntools: bash, write\n---\nAnything",
  );
  await assert.rejects(
    f.call("goal_research", { question: "Inspect" }),
    /policy conflict/,
  );
  assert.equal(f.spawns.length, 0);
});

test("cancelled goals and empty branches remain write-locked until owned work settles", async (t) => {
  const f = await fixture(t);
  await f.command("Add greeting");
  f.fakeClient.hasUnsettled = true;
  await f.command("cancel");
  assert.equal(f.controller.getState().phase, "cancelled");
  for (const name of ["write", "bash", "Agent", "goal_execute"])
    assert.equal((await f.fire("tool_call", { toolName: name })).block, true);
  f.ctx.sessionManager.getBranch = () => [];
  await f.fire("session_tree");
  assert.equal(f.controller.getState(), null);
  assert.equal((await f.fire("tool_call", { toolName: "write" })).block, true);
  f.fakeClient.hasUnsettled = false;
  assert.equal(await f.fire("tool_call", { toolName: "write" }), undefined);
});

test("a pending resume snapshot cannot resurrect cancellation", async (t) => {
  const f = await fixture(t);
  await f.readyPlan();
  await f.command("pause");
  let release, entered;
  const waiting = new Promise((resolve) => {
    entered = resolve;
  });
  f.setSnapshot(() => {
    entered();
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  const pending = f.command("resume");
  await waiting;
  await f.command("cancel");
  release({ "greeting.txt": null });
  await pending;
  assert.equal(f.controller.getState().phase, "cancelled");
  assert.equal(f.controller.getState().approval, null);
});

test("partial work continues under one approval without another research/planning round", async (t) => {
  const f = await fixture(t);
  await f.readyPlan();
  const token = approvalToken(f.controller.getState());
  await f.command(`approve ${token}`);
  let calls = 0;
  f.setRun(async (request, id) => {
    if (!request.type.endsWith("Implementer")) return;
    calls++;
    if (calls === 1) {
      await writeFile(join(f.cwd, "greeting.txt"), "partial");
      return {
        id,
        status: "completed",
        result: JSON.stringify({
          status: "continue",
          summary: "Finish greeting text; no external blocker",
          files: ["greeting.txt"],
        }),
      };
    }
    assert.match(request.prompt, /Finish greeting text/);
    assert.equal(f.controller.getState().approval, token);
  });
  await f.call("goal_execute");
  assert.equal(calls, 2);
  const workers = f.spawns.filter((r) => r.type.endsWith("Implementer"));
  assert.equal(workers[0].persistent, true);
  assert.equal(workers[0].resumeId, undefined);
  assert.equal(workers[1].resumeId, "child-3");
  assert.equal(workers[0].structuredOutput, workers[1].structuredOutput);
  assert.match(workers[1].prompt, /retained worker context/);
  assert.doesNotMatch(workers[1].prompt, /Feature \(user wording\)/);
  assert.match(workers[0].prompt, /Do not return continue after a tiny edit/);
  assert.equal(f.controller.getState().phase, "completed");
  assert.equal(f.spawns.filter((r) => r.type.endsWith("Planner")).length, 1);
});

test("productive workers continue beyond four attempts through checks and review without resume", async (t) => {
  const f = await fixture(t);
  await f.readyPlan();
  assert.equal(f.controller.getState().plan.execution.version, 3);
  const token = approvalToken(f.controller.getState());
  await f.command(`approve ${token}`);
  let attempts = 0;
  f.setRun(async (request, id) => {
    if (!request.type.endsWith("Implementer")) return;
    attempts++;
    assert.equal(f.controller.getState().approval, token);
    assert.equal(
      f.execs.length,
      0,
      "verification waits until the step completes",
    );
    await writeFile(
      join(f.cwd, "greeting.txt"),
      attempts === 6 ? "hello" : `partial ${attempts}`,
    );
    return {
      id,
      status: "completed",
      result: JSON.stringify({
        status: attempts === 6 ? "completed" : "continue",
        summary: `Attempt ${attempts}`,
        files: ["greeting.txt"],
      }),
    };
  });
  await f.call("goal_execute");
  assert.equal(attempts, 6);
  assert.equal(f.controller.getState().phase, "completed");
  assert.equal(f.controller.getState().execution.history.length, 6);
  assert.equal(f.execs.length, 1);
  assert.equal(f.spawns.filter((r) => r.type.endsWith("Reviewer")).length, 1);
  assert.equal(f.spawns.filter((r) => r.type.endsWith("Planner")).length, 1);
  assert.ok(!f.entries.some((e) => e.data.phase === "paused"));
});

test("stalled workers still pause with progress evidence and no misleading running widget", async (t) => {
  const f = await fixture(t, { mode: "tui" });
  await f.readyPlan();
  const token = approvalToken(f.controller.getState());
  await f.command(`approve ${token}`);
  let attempts = 0;
  f.setRun(async (request, id) => {
    if (!request.type.endsWith("Implementer")) return;
    if (++attempts === 1)
      await writeFile(join(f.cwd, "greeting.txt"), "partial");
    return {
      id,
      status: "completed",
      result: JSON.stringify({
        status: "continue",
        summary: "Greeting still needs work",
        files: ["greeting.txt"],
      }),
    };
  });
  await assert.rejects(f.call("goal_execute"), (error) => {
    assert.match(error.message, /No file progress in 2 consecutive attempts/);
    assert.match(error.message, /results with observed file changes: 1/);
    assert.match(error.message, /Greeting still needs work/);
    assert.match(error.message, /Last worker observed file changes: none/);
    assert.match(error.message, /Full worker evidence:/);
    return true;
  });
  assert.equal(attempts, 3);
  assert.equal(f.controller.getState().phase, "paused");
  assert.equal(f.controller.getState().worker, null);
  assert.equal(f.controller.getState().approval, token);
  assert.match(f.widgets.at(-1).lines.join("\n"), /unfinished \(paused\)/);
  assert.doesNotMatch(f.widgets.at(-1).lines.join("\n"), /in_progress/);
  await assert.rejects(f.call("goal_execute"), /explicit approval/);
  assert.equal(attempts, 3);
  f.setRun(undefined);
  await f.command("resume");
  assert.equal(f.controller.getState().approval, token);
  await f.call("goal_execute");
  assert.equal(f.controller.getState().phase, "completed");
});

test("user resume retains approval and skips completed workers after a failed one-shot check", async (t) => {
  const f = await fixture(t);
  await f.readyPlan();
  const token = approvalToken(f.controller.getState());
  await f.command(`approve ${token}`);
  f.setExecCode(1);
  await assert.rejects(
    f.call("goal_execute"),
    /not approved for automatic reruns/,
  );
  await assert.rejects(f.call("goal_execute"), /explicit approval/);
  f.setExecCode(0);
  await f.command("resume");
  assert.equal(f.controller.getState().approval, token);
  assert.equal(f.controller.getState().phase, "approved");
  await f.call("goal_execute");
  assert.equal(f.controller.getState().phase, "completed");
  assert.equal(
    f.spawns.filter((r) => r.type.endsWith("Implementer")).length,
    1,
  );
  assert.equal(f.spawns.filter((r) => r.type.endsWith("Planner")).length, 1);
  assert.equal(f.execs.length, 2);
});

test("repeatable verification failures feed an in-scope repair and rerun before independent review", async (t) => {
  const f = await fixture(t, {
    proposal: {
      ...plan,
      checks: [{ ...plan.checks[0], afterStep: 1, repeatable: true }],
    },
  });
  await f.readyPlan();
  const token = approvalToken(f.controller.getState());
  await f.command(`approve ${token}`);
  f.setExecCode(1);
  let repairs = 0;
  f.setRun(async (request) => {
    if (
      request.type.endsWith("Implementer") &&
      request.prompt.includes('"id":"repair-1"')
    ) {
      repairs++;
      assert.match(request.prompt, /Verification failed/);
      assert.equal(f.controller.getState().approval, token);
      f.setExecCode(0);
    }
  });
  await f.call("goal_execute");
  assert.equal(repairs, 1);
  assert.equal(f.controller.getState().phase, "completed");
  assert.equal(f.execs.length, 2);
});

test("new chat feedback revokes paused approval before it can reach a continuation worker", async (t) => {
  const f = await fixture(t);
  await f.readyPlan();
  const token = approvalToken(f.controller.getState());
  await f.command(`approve ${token}`);
  f.setExecCode(1);
  await assert.rejects(f.call("goal_execute"));
  assert.equal(f.controller.getState().approval, token);
  await f.fire("input", {
    text: "Change the requirement: implement new scope instead",
    source: "rpc",
  });
  assert.equal(f.controller.getState().approval, null);
  assert.equal(f.controller.getState().phase, "discussing");
  assert.notEqual(approvalToken(f.controller.getState()), token);
  await f.command("resume");
  await assert.rejects(f.call("goal_execute"), /explicit approval/);
  assert.equal(
    f.spawns.filter((r) => r.type.endsWith("Implementer")).length,
    1,
  );
});

test("cancellation during post-command snapshot never replays a successful one-shot", async (t) => {
  const f = await fixture(t);
  await f.readyPlan();
  await f.command(`approve ${approvalToken(f.controller.getState())}`);
  let enter,
    release,
    intercepted = false;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  f.setSnapshot(async (...args) => {
    if (f.execs.length === 1 && !intercepted) {
      intercepted = true;
      enter();
      await new Promise((resolve) => {
        release = resolve;
      });
    }
    return snapshotFiles(...args);
  });
  const running = f.call("goal_execute");
  const stopped = assert.rejects(running, /cancelled|aborted/);
  await entered;
  assert.deepEqual(f.controller.getState().execution.passed, [0]);
  assert(f.entries.some((entry) => entry.data.execution?.passed.includes(0)));
  await f.command("pause");
  release();
  await stopped;
  f.setSnapshot(undefined);
  await f.command("resume");
  assert.equal(f.controller.getState().phase, "awaiting_approval");
  await f.command(`approve ${approvalToken(f.controller.getState())}`);
  await f.call("goal_execute");
  assert.equal(f.controller.getState().phase, "completed");
  assert.equal(
    f.execs.length,
    1,
    "successful one-shot command must not replay",
  );
});

test("checkpoint drift on resume requires reapproval without replanning or overwriting user edits", async (t) => {
  const f = await fixture(t);
  await f.readyPlan();
  const old = approvalToken(f.controller.getState());
  await f.command(`approve ${old}`);
  f.setExecCode(1);
  await assert.rejects(f.call("goal_execute"));
  await writeFile(join(f.cwd, "greeting.txt"), "user change");
  await f.command("resume");
  assert.equal(f.controller.getState().phase, "awaiting_approval");
  assert.equal(f.controller.getState().approval, null);
  assert.notEqual(approvalToken(f.controller.getState()), old);
  assert.equal(f.spawns.filter((r) => r.type.endsWith("Planner")).length, 1);
  assert.equal(
    await readFile(join(f.cwd, "greeting.txt"), "utf8"),
    "user change",
  );
});

test("settled missing worker output preserves an inspectable checkpoint and error artifact", async (t) => {
  const f = await fixture(t);
  await f.readyPlan();
  const token = approvalToken(f.controller.getState());
  await f.command(`approve ${token}`);
  f.setRun(async (_request, id) => ({
    id,
    status: "completed",
    result: JSON.stringify({ wrong: true }),
  }));
  await assert.rejects(f.call("goal_execute"), /valid StructuredOutput/);
  assert.equal(f.controller.getState().phase, "paused");
  assert.equal(f.controller.getState().approval, token);
  const artifact = f.controller.getState().execution.history.at(-1).artifact;
  assert.match(await readFile(artifact, "utf8"), /valid StructuredOutput/);
  f.setRun(undefined);
  await f.command("resume");
  await f.call("goal_execute");
  assert.equal(f.controller.getState().phase, "completed");
});

test("settled provider errors keep partial edits and resume without another approval", async (t) => {
  const f = await fixture(t);
  await f.readyPlan();
  const token = approvalToken(f.controller.getState());
  await f.command(`approve ${token}`);
  f.setRun(async (_request, id) => {
    await writeFile(
      join(f.cwd, "greeting.txt"),
      "partial before provider error",
    );
    const error = new Error("Provider temporarily unavailable");
    error.event = { id, status: "error", error: error.message };
    throw error;
  });
  await assert.rejects(
    f.call("goal_execute"),
    /Provider temporarily unavailable/,
  );
  assert.equal(f.controller.getState().approval, token);
  assert.equal(f.controller.getState().phase, "paused");
  assert.equal(
    await readFile(join(f.cwd, "greeting.txt"), "utf8"),
    "partial before provider error",
  );
  f.setRun(undefined);
  await f.command("resume");
  assert.equal(f.controller.getState().approval, token);
  await f.call("goal_execute");
  assert.equal(f.controller.getState().phase, "completed");
});

test("missing reviewer output resumes review only, not implementation or successful setup", async (t) => {
  const f = await fixture(t);
  await f.readyPlan();
  const token = approvalToken(f.controller.getState());
  await f.command(`approve ${token}`);
  f.setRun(async (request, id) => {
    if (request.type.endsWith("Reviewer"))
      return { id, status: "completed", result: "{}" };
  });
  await assert.rejects(
    f.call("goal_execute"),
    /Review stopped without a usable result/,
  );
  assert.equal(f.controller.getState().approval, token);
  assert.equal(f.controller.getState().progress[0].status, "completed");
  f.setRun(undefined);
  await f.command("resume");
  await f.call("goal_execute");
  assert.equal(f.controller.getState().phase, "completed");
  assert.equal(
    f.spawns.filter((r) => r.type.endsWith("Implementer")).length,
    1,
  );
  assert.equal(f.execs.length, 1);
});

test("revision planner receives failed checks and review findings rather than losing repair context", async (t) => {
  const f = await fixture(t);
  await f.readyPlan();
  await f.command(`approve ${approvalToken(f.controller.getState())}`);
  f.setRun(async (request, id) => {
    if (!request.type.endsWith("Reviewer")) return;
    return {
      id,
      status: "completed",
      result: JSON.stringify({
        verdict: "blocked",
        summary: "Greeting lacks punctuation",
        issues: ["Add punctuation"],
        criteria: [
          { criterion: plan.acceptance[0], evidence: "Read greeting.txt" },
        ],
      }),
    };
  });
  await assert.rejects(f.call("goal_execute"), /Repair limit/);
  await f.command("revise Address punctuation, retain implementation");
  f.setRun(undefined);
  await f.call("goal_plan");
  const prompt = f.spawns
    .filter((r) => r.type.endsWith("Planner"))
    .at(-1).prompt;
  assert.match(prompt, /Greeting lacks punctuation/);
  assert.match(prompt, /check-1-/);
  assert.match(prompt, /"status":"completed"/);
});

test("legacy restored plans retain their original execution policy", async (t) => {
  const f = await fixture(t);
  await f.readyPlan();
  const legacy = f.controller.getState();
  delete legacy.plan.execution;
  delete legacy.execution;
  f.entries.splice(0, f.entries.length, {
    type: "custom",
    customType: STATE_TYPE,
    data: legacy,
  });
  await f.fire("session_tree");
  assert.equal(f.controller.getState().plan.execution, undefined);
  await f.command(`approve ${approvalToken(f.controller.getState())}`);
  f.setExecCode(1);
  await assert.rejects(f.call("goal_execute"), /Verification failed/);
  assert.equal(f.controller.getState().phase, "blocked");
  assert.equal(f.controller.getState().approval, null);
});

test("restoring even a safely paused new checkpoint never restores executable approval", async (t) => {
  const f = await fixture(t);
  await f.readyPlan();
  await f.command(`approve ${approvalToken(f.controller.getState())}`);
  f.setExecCode(1);
  await assert.rejects(f.call("goal_execute"));
  await f.fire("session_tree");
  assert.equal(f.controller.getState().approval, null);
  await f.command("resume");
  assert.equal(f.controller.getState().phase, "awaiting_approval");
});

test("a resumed worker must submit fresh output instead of reusing its previous valid report", async (t) => {
  const f = await fixture(t);
  await f.readyPlan();
  const token = approvalToken(f.controller.getState());
  await f.command(`approve ${token}`);
  let calls = 0;
  f.setRun(async (request, id) => {
    if (!request.type.endsWith("Implementer")) return;
    calls++;
    if (calls === 1) {
      await writeFile(join(f.cwd, "greeting.txt"), "partial");
      return {
        id,
        status: "completed",
        result: JSON.stringify({
          status: "continue",
          summary: "Finish retained greeting",
          files: ["greeting.txt"],
        }),
      };
    }
    assert.equal(request.resumeId, "child-3");
    return { id, status: "completed", result: "{}" };
  });
  await assert.rejects(f.call("goal_execute"), /valid StructuredOutput/);
  assert.equal(calls, 2);
  assert.equal(f.controller.getState().phase, "paused");
  assert.equal(f.controller.getState().approval, token);
  assert.equal(f.execs.length, 0);
  assert.equal(
    f.controller.getState().execution.history.at(-1).error,
    "implementer did not submit valid StructuredOutput",
  );
  f.setRun(undefined);
  await f.command("resume");
  await f.call("goal_execute");
  const lastWorker = f.spawns
    .filter((r) => r.type.endsWith("Implementer"))
    .at(-1);
  assert.equal(
    lastWorker.resumeId,
    undefined,
    "paused handles must not survive a new execution operation",
  );
});

test("checkpoint repair rounds share a worker but have fresh output validation", async (t) => {
  const f = await fixture(t, {
    proposal: {
      ...plan,
      checks: [{ ...plan.checks[0], afterStep: 1, repeatable: true }],
    },
  });
  await f.readyPlan();
  await f.command(`approve ${approvalToken(f.controller.getState())}`);
  let checks = 0;
  f.setExec(() => ({
    code: ++checks <= 2 ? 1 : 0,
    killed: false,
    stdout: "diagnostic",
    stderr: "",
  }));
  await f.call("goal_execute");
  const workers = f.spawns.filter((r) => r.type.endsWith("Implementer"));
  assert.equal(workers.length, 3);
  assert.equal(workers[0].resumeId, undefined);
  assert.equal(
    workers[1].resumeId,
    undefined,
    "repair starts at its own scope boundary",
  );
  assert.equal(workers[2].resumeId, "child-4");
  assert.equal(workers[1].structuredOutput, workers[2].structuredOutput);
  assert.match(workers[2].prompt, /"id":"repair-2"/);
  assert.equal(
    f.controller.getState().execution.repairsByCheckpoint["check-0"],
    2,
  );
});

test("version-2 restored plans keep fresh workers and do not require managed resume", async (t) => {
  const f = await fixture(t);
  await f.readyPlan();
  const old = f.controller.getState();
  old.plan.execution.version = 2;
  f.entries.splice(0, f.entries.length, {
    type: "custom",
    customType: STATE_TYPE,
    data: old,
  });
  await f.fire("session_tree");
  f.fakeClient.assertResumeSupport = () => {
    throw new Error("unsupported");
  };
  await f.command(`approve ${approvalToken(f.controller.getState())}`);
  let calls = 0;
  f.setRun(async (request, id) => {
    if (!request.type.endsWith("Implementer") || ++calls > 1) return;
    await writeFile(join(f.cwd, "greeting.txt"), "partial");
    return {
      id,
      status: "completed",
      result: JSON.stringify({
        status: "continue",
        summary: "Finish greeting",
        files: ["greeting.txt"],
      }),
    };
  });
  await f.call("goal_execute");
  const workers = f.spawns.filter((r) => r.type.endsWith("Implementer"));
  assert.equal(workers.length, 2);
  assert.ok(workers.every((r) => !r.persistent && !r.resumeId));
});

test("new planner prompt describes actual v3 policy instead of obsolete attempt limits", async (t) => {
  const f = await fixture(t);
  await f.readyPlan();
  const prompt = f.spawns.find((r) => r.type.endsWith("Planner")).prompt;
  assert.match(prompt, /two repair rounds per failing checkpoint/);
  assert.doesNotMatch(prompt, /four worker attempts/);
});

test("stale approval cannot invalidate cancellation even when snapshot reports changed files", async (t) => {
  const f = await fixture(t);
  await f.readyPlan();
  let release, entered;
  const waiting = new Promise((resolve) => {
    entered = resolve;
  });
  f.setSnapshot(() => {
    entered();
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  const pending = f.command(
    `approve ${approvalToken(f.controller.getState())}`,
  );
  await waiting;
  await f.command("cancel");
  release({ "greeting.txt": { hash: "changed", bytes: 1 } });
  await pending;
  assert.equal(f.controller.getState().phase, "cancelled");
  assert.equal(f.controller.getState().approval, null);
});
