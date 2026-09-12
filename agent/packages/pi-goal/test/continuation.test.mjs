import test from "node:test";
import assert from "node:assert/strict";
import { SubagentClient } from "../subagents.mjs";

function fixture() {
  const listeners = new Map();
  const sent = [];
  const events = {
    on(name, fn) {
      const set = listeners.get(name) ?? new Set();
      listeners.set(name, set);
      set.add(fn);
      return () => {
        set.delete(fn);
        if (!set.size) listeners.delete(name);
      };
    },
    emit(name, value) {
      sent.push({ name, value });
      for (const fn of [...(listeners.get(name) ?? [])]) fn(value);
    },
  };
  const session = { isStreaming: false };
  const record = { id: "owned", status: "completed", session };
  const resumes = [];
  let resumeImpl;
  const manager = {
    goalResumeVersion: 1,
    getRecord: (id) => (id === record.id ? record : undefined),
    resume(id, prompt, options) {
      resumes.push({ id, prompt, options });
      if (resumeImpl) return resumeImpl(id, prompt, options);
      record.status = "running";
      options.onStarted(session);
      return record;
    },
  };
  const client = new SubagentClient(events, { getManager: () => manager });
  events.on("subagents:rpc:spawn", (q) => {
    record.status = "running";
    q.options.onSpawned(record.id);
    events.emit(`subagents:rpc:spawn:reply:${q.requestId}`, {
      success: true,
      data: { id: record.id },
    });
  });
  const complete = (status = "completed") => {
    record.status = status;
    events.emit(
      status === "completed" ? "subagents:completed" : "subagents:failed",
      {
        id: record.id,
        status,
        result: "",
        type: "PiGoalImplementer",
        goalInvocationId: resumes.at(-1)?.options.invocationId,
      },
    );
  };
  const args = {
    type: "PiGoalImplementer",
    prompt: "Work",
    model: "test/model",
    thinkingLevel: "low",
    maxTurns: 24,
    cwd: "/project",
    persistent: true,
    structuredOutput: { schema: { type: "object" }, check: () => true },
  };
  return {
    client,
    events,
    sent,
    record,
    session,
    args,
    resumes,
    complete,
    manager,
    setResume(fn) {
      resumeImpl = fn;
    },
  };
}

async function first(f) {
  const run = f.client.run(f.args);
  f.complete();
  await run;
}

test("persistent workers require the versioned managed-resume capability before spawning", async () => {
  const f = fixture();
  delete f.manager.goalResumeVersion;
  await assert.rejects(f.client.run(f.args), /local pi-subagents package/);
  assert.equal(f.sent.length, 0);
  await f.client.dispose();
});

test("continuation reuses the owned session and original capture tool without another spawn", async () => {
  const f = fixture();
  await first(f);
  const run = f.client.run({
    ...f.args,
    resumeId: "owned",
    prompt: "Finish retained work",
  });
  assert.equal(f.resumes.length, 1);
  assert.equal(f.resumes[0].id, "owned");
  assert.equal(f.resumes[0].options.maxTurns, 24);
  assert.ok(f.resumes[0].options.signal instanceof AbortSignal);
  assert.equal(
    f.sent.filter((x) => x.name === "subagents:rpc:spawn").length,
    1,
  );
  f.complete();
  assert.equal((await run).id, "owned");
  assert.equal(
    f.sent.filter((x) => x.name === "subagents:rpc:consume").length,
    2,
  );
  assert.equal(f.client.hasUnsettled, false);
  await f.client.dispose();
});

test("a structured v3 soft-limit handoff can resume without treating its budget as failure", async () => {
  const f = fixture();
  const initial = f.client.run(f.args);
  f.complete("steered");
  assert.equal((await initial).status, "steered");
  const continued = f.client.run({ ...f.args, resumeId: "owned" });
  assert.equal(f.resumes.length, 1);
  f.complete();
  await continued;
  await f.client.dispose();
});

test("foreign handles, changed profiles, capture tools and session identities cannot resume", async () => {
  const f = fixture();
  await first(f);
  for (const change of [
    { resumeId: "foreign" },
    { model: "test/other" },
    { maxTurns: 100 },
    { cwd: "/elsewhere" },
    { structuredOutput: { ...f.args.structuredOutput } },
  ])
    await assert.rejects(
      f.client.run({ ...f.args, resumeId: "owned", ...change }),
      /unowned/,
    );
  f.record.session = { isStreaming: false };
  await assert.rejects(
    f.client.run({ ...f.args, resumeId: "owned" }),
    /unowned/,
  );
  assert.equal(f.resumes.length, 0);
  await f.client.dispose();
});

test("clearing continuation authority prevents reuse across operations", async () => {
  const f = fixture();
  await first(f);
  f.client.forgetContinuations();
  await assert.rejects(
    f.client.run({ ...f.args, resumeId: "owned" }),
    /unowned/,
  );
  await f.client.dispose();
});

test("pre-aborted continuation never starts", async () => {
  const f = fixture();
  await first(f);
  await assert.rejects(
    f.client.run({ ...f.args, resumeId: "owned", signal: AbortSignal.abort() }),
    { name: "AbortError" },
  );
  assert.equal(f.resumes.length, 0);
  await f.client.dispose();
});

test("running continuation cancellation holds ownership until tools actually settle", async () => {
  const f = fixture();
  await first(f);
  const controller = new AbortController();
  const run = f.client.run({
    ...f.args,
    resumeId: "owned",
    signal: controller.signal,
  });
  const rejected = assert.rejects(run, { name: "AbortError" });
  controller.abort();
  await rejected;
  f.record.status = "stopped";
  assert.equal(f.client.hasUnsettled, true);
  await assert.rejects(f.client.run(f.args), /unsettled/);
  f.complete("stopped");
  assert.equal(f.client.hasUnsettled, false);
  await assert.rejects(
    f.client.run({ ...f.args, resumeId: "owned" }),
    /unowned/,
  );
  await f.client.dispose();
});

test("queued continuation cancellation uses only the proven queued-to-stopped exception", async () => {
  const f = fixture();
  await first(f);
  f.setResume((_id, _prompt, options) => {
    f.record.status = "queued";
    options.signal.addEventListener("abort", () => {
      f.record.status = "stopped";
    });
    return f.record;
  });
  const run = f.client.run({ ...f.args, resumeId: "owned" });
  const rejected = assert.rejects(run, { name: "AbortError" });
  await f.client.stop();
  await rejected;
  assert.equal(f.client.hasUnsettled, false);
  await f.client.dispose();
});

test("synchronous completion is consumed even before resume acknowledgement", async () => {
  const f = fixture();
  await first(f);
  f.setResume((_id, _prompt, options) => {
    options.onStarted(f.session);
    f.complete();
    assert.equal(f.sent.at(-1).name, "subagents:rpc:consume");
    return f.record;
  });
  await f.client.run({ ...f.args, resumeId: "owned" });
  assert.equal(f.client.hasUnsettled, false);
  await f.client.dispose();
});

test("old same-ID terminal events cannot settle a new invocation or release its ownership", async () => {
  const f = fixture();
  await first(f);
  const run = f.client.run({ ...f.args, resumeId: "owned" });
  const currentToken = f.resumes.at(-1).options.invocationId;
  assert.ok(currentToken);
  f.events.emit("subagents:completed", {
    id: "owned",
    status: "completed",
    result: "old",
  });
  assert.equal(f.client.hasUnsettled, true);
  f.complete();
  await run;
  const again = f.client.run({ ...f.args, resumeId: "owned" });
  assert.notEqual(f.resumes.at(-1).options.invocationId, currentToken);
  f.events.emit("subagents:completed", {
    id: "owned",
    status: "completed",
    result: "old",
    goalInvocationId: currentToken,
  });
  assert.equal(f.client.hasUnsettled, true);
  await assert.rejects(f.client.run(f.args), /unsettled/);
  f.complete();
  await again;
  await f.client.dispose();
});

test("abort during resume ownership notification never dispatches the continuation", async () => {
  const f = fixture();
  await first(f);
  const controller = new AbortController();
  const run = f.client.run({
    ...f.args,
    resumeId: "owned",
    signal: controller.signal,
    onSpawned: () => controller.abort(),
  });
  await assert.rejects(run, { name: "AbortError" });
  assert.equal(f.resumes.length, 0);
  assert.equal(f.client.hasUnsettled, false);
  await f.client.dispose();
});

test("a refused idle continuation releases its lock but never silently respawns", async () => {
  const f = fixture();
  await first(f);
  f.setResume(() => undefined);
  await assert.rejects(
    f.client.run({ ...f.args, resumeId: "owned" }),
    /refused/,
  );
  assert.equal(f.client.hasUnsettled, false);
  assert.equal(
    f.sent.filter((x) => x.name === "subagents:rpc:spawn").length,
    1,
  );
  await f.client.dispose();
});
