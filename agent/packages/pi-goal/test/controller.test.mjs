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
  { mode = "rpc", configured = true, replies = [] } = {},
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
    execs = [];
  const hooks = new Map(),
    tools = new Map(),
    commands = new Map();
  let number = 0,
    confirm = true,
    execCode = 0,
    runOverride,
    snapshotOverride;
  const fakeClient = {
    hasUnsettled: false,
    async ping() {
      return 2;
    },
    async stop() {},
    async dispose() {},
    async run(request) {
      spawns.push(request);
      const id = `child-${++number}`;
      request.onSpawned(id);
      if (runOverride) {
        const outcome = await runOverride(request, id);
        if (request.structuredOutput)
          request.structuredOutput.check(JSON.parse(outcome.result));
        return outcome;
      }
      let result;
      if (request.type.endsWith("Researcher"))
        result = "Observed the project. greeting.txt is the intended new file.";
      if (request.type.endsWith("Planner")) result = JSON.stringify(plan);
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
      setWidget() {},
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

test("failed verification blocks completion and never launches reviewer or automatic repairs", async (t) => {
  const f = await fixture(t);
  await f.readyPlan();
  await f.command(`approve ${approvalToken(f.controller.getState())}`);
  f.setExecCode(1);
  await assert.rejects(f.call("goal_execute"), /Verification failed/);
  assert.equal(f.controller.getState().phase, "blocked");
  assert.equal(f.controller.getState().approval, null);
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
  assert.equal(f.controller.getState().phase, "blocked");
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
  const failed = assert.rejects(running, /aborted/);
  await didStart;
  await f.command("pause");
  await failed;
  assert.equal(f.controller.getState().phase, "paused");
  assert.equal(f.execs.length, 0);
  await f.command("resume");
  assert.equal(f.controller.getState().phase, "awaiting_approval");
  assert.equal(f.controller.getState().approval, null);
  assert.equal(f.controller.getState().progress[0].status, "pending");
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
