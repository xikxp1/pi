import test from "node:test";
import assert from "node:assert/strict";
import { AgentManager, topLevel } from "../manager.mjs";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

// Each prompt and the SDK tool barrier are independently controllable.
function fixture(options = {}) {
  const calls = [],
    waiters = [],
    sessions = [],
    events = [],
    notifications = [];
  const manager = new AgentManager({
    maxConcurrent: 1,
    emit: (name, payload) => events.push({ name, payload }),
    notify: (record) => notifications.push(record.id),
    createSession: async (record, invocationOptions) => {
      const listeners = new Set();
      const session = {
        record,
        invocationOptions,
        messages: [],
        isStreaming: false,
        steers: [],
        aborts: 0,
        disposed: 0,
        idle: null,
        idleEntered: deferred(),
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        emit(event) {
          for (const listener of listeners) listener(event);
        },
        get subscribers() {
          return listeners.size;
        },
        async prompt(prompt, promptOptions) {
          session.isStreaming = true;
          const done = deferred();
          const call = {
            record,
            session,
            prompt,
            promptOptions,
            finish(value = "fresh answer", extra = {}) {
              if (value !== null) {
                const message = {
                  role: "assistant",
                  content: [{ type: "text", text: value }],
                  stopReason: "stop",
                  ...extra,
                };
                session.messages.push(message);
                session.emit({ type: "message_end", message });
              }
              done.resolve();
            },
            fail: done.reject,
          };
          if (waiters.length) waiters.shift().resolve(call);
          else calls.push(call);
          try {
            await done.promise;
          } finally {
            session.isStreaming = false;
          }
        },
        async steer(message) {
          session.steers.push(message);
        },
        async abort() {
          session.aborts++;
        },
        agent: {
          async waitForIdle() {
            session.idleEntered.resolve();
            await session.idle?.promise;
          },
        },
        dispose() {
          session.disposed++;
        },
      };
      sessions.push(session);
      return session;
    },
    ...options,
  });
  return {
    manager,
    sessions,
    events,
    notifications,
    nextPrompt() {
      if (calls.length) return Promise.resolve(calls.shift());
      const waiter = deferred();
      waiters.push(waiter);
      return waiter.promise;
    },
  };
}

async function complete(f, record, text = "fresh answer") {
  const call = await f.nextPrompt();
  assert.equal(call.record, record);
  call.finish(text);
  await record.promise;
  return call.session;
}

test("bounded FIFO shares slots between fresh and resumed invocations", async () => {
  const f = fixture({ maxConcurrent: 2 }),
    m = f.manager;
  const old = m.spawn("old", "first");
  const oldSession = await complete(f, old);
  const a = m.spawn("a", "a"),
    b = m.spawn("b", "b");
  const ca = await f.nextPrompt(),
    cb = await f.nextPrompt();
  m.resume(old.id, "again");
  const c = m.spawn("c", "c");
  assert.equal(m.running, 2);
  assert.equal(old.status, "queued");
  assert.equal(c.status, "queued");
  assert.equal(m.hasRunning(), true);
  ca.finish();
  await a.promise;
  const resumed = await f.nextPrompt();
  assert.equal(resumed.record, old);
  assert.equal(resumed.session, oldSession);
  assert.equal(c.status, "queued");
  cb.finish();
  await b.promise;
  const cc = await f.nextPrompt();
  assert.equal(cc.record, c);
  assert.equal(m.running, 2);
  resumed.finish();
  cc.finish();
  await m.waitForAll();
  assert.equal(m.running, 0);
  assert.equal(m.hasRunning(), false);
  assert.equal(f.sessions.length, 4);
  await m.dispose();
});

test("resume preserves session identity, resets fresh output, and clears ordinary invocation attribution", async () => {
  const f = fixture(),
    m = f.manager;
  const r = m.spawn("worker", "first", {
    name: "named",
    invocationId: "goal-one",
  });
  const session = await complete(f, r, "old answer");
  const identity = [r.id, r.name, r.handle];
  r.structuredJson = { old: true };
  r.error = "stale";
  assert.equal(m.consume(r.id), true);
  const previousPromise = r.promise;
  assert.equal(m.resume(r.id, "second", { invocationId: "goal-two" }), r);
  assert.notEqual(r.promise, previousPromise);
  assert.equal(r.result, undefined);
  assert.equal(r.error, undefined);
  assert.equal(r.structuredJson, undefined);
  assert.equal(r.resultConsumed, false);
  assert.equal(r.goalInvocationId, "goal-two");
  assert.equal(await complete(f, r, "new answer"), session);
  assert.equal(r.result, "new answer");
  m.resume(r.id, "ordinary");
  assert.equal(r.goalInvocationId, undefined);
  await complete(f, r, "ordinary answer");
  assert.deepEqual([r.id, r.name, r.handle], identity);
  assert.equal(r.result, "ordinary answer");
  const completed = f.events.filter((e) => e.name === "subagents:completed");
  assert.deepEqual(
    completed.map((e) => e.payload.goalInvocationId),
    ["goal-one", "goal-two", undefined],
  );
  assert.equal(
    Object.hasOwn(completed.at(-1).payload, "goalInvocationId"),
    false,
  );
  assert.equal(session.subscribers, 0);
  await m.dispose();
});

test("turn budget steers once, allows five grace turns, then hard-aborts at the idle barrier", async () => {
  const f = fixture(),
    m = f.manager;
  const r = m.spawn("worker", "work", { maxTurns: 2 });
  const call = await f.nextPrompt(),
    s = call.session;
  s.emit({ type: "tool_execution_start" });
  s.emit({ type: "turn_end" });
  assert.deepEqual(s.steers, []);
  s.emit({ type: "turn_end" });
  assert.equal(s.steers.length, 1);
  for (let i = 0; i < 4; i++) s.emit({ type: "turn_end" });
  assert.equal(s.aborts, 0);
  s.idle = deferred();
  s.emit({ type: "turn_end" });
  assert.equal(s.aborts, 1);
  assert.equal(r.invocation.controller.signal.aborted, true);
  assert.equal(r.status, "running");
  call.finish("partial", { usage: { input: 3, output: 4 } });
  await s.idleEntered.promise;
  assert.equal(r.status, "running");
  s.idle.resolve();
  await r.promise;
  assert.equal(r.status, "aborted");
  assert.match(r.error, /turn budget/);
  assert.equal(r.turns, 7);
  assert.equal(r.toolUses, 1);
  assert.deepEqual(r.usage, { input: 3, output: 4, totalTokens: 7 });
  assert.equal(s.steers.length, 1);
  await m.dispose();
});

test("soft-budget completion is steered and resumed budget starts fresh", async () => {
  const f = fixture(),
    m = f.manager;
  const r = m.spawn("worker", "work", { maxTurns: 1 });
  const call = await f.nextPrompt();
  call.session.emit({ type: "turn_end" });
  call.finish();
  await r.promise;
  assert.equal(r.status, "steered");
  m.resume(r.id, "continue");
  const resumed = await f.nextPrompt();
  assert.equal(r.invocation.turns, 0);
  resumed.finish();
  await r.promise;
  assert.equal(r.status, "completed");
  await m.dispose();
});

test("queued cancellation from synchronous callback settles without creating a session", async () => {
  const f = fixture(),
    m = f.manager,
    controller = new AbortController();
  let callbackId;
  const r = m.spawn("worker", "work", {
    signal: controller.signal,
    onQueued(id) {
      callbackId = id;
      controller.abort();
    },
    onSpawned() {
      assert.fail("cancelled queue entry must not spawn");
    },
  });
  assert.equal(callbackId, r.id);
  assert.equal(r.status, "stopped");
  assert.equal(m.hasRunning(), false);
  assert.equal(await r.promise, r);
  await m.waitForAll();
  assert.equal(f.sessions.length, 0);
  assert.equal(m.stop(r.id), false);
  await m.dispose();
});

test("running cancellation retains its slot until prompt failure and tools unwind", async () => {
  const callback = deferred();
  const f = fixture({
    onRecord: async () => {
      await callback.promise;
      throw new Error("ignored callback rejection");
    },
  });
  const m = f.manager,
    controller = new AbortController();
  const r = m.spawn("worker", "work", { signal: controller.signal });
  const call = await f.nextPrompt();
  call.session.idle = deferred();
  const queued = m.spawn("next", "next");
  controller.abort();
  assert.equal(call.session.aborts, 1);
  assert.equal(r.invocation.controller.signal.aborted, true);
  assert.equal(r.status, "running");
  assert.equal(m.running, 1);
  call.fail(new Error("aborted prompt"));
  await call.session.idleEntered.promise;
  assert.equal(queued.status, "queued");
  assert.equal(
    f.events.some((e) => e.name === "subagents:failed"),
    false,
  );
  call.session.idle.resolve();
  await r.promise;
  assert.equal(r.status, "stopped");
  assert.equal(r.error, undefined);
  await complete(f, queued);
  callback.resolve();
  await m.dispose();
});

test("async queued/spawned callbacks may cancel and reject without leaking work", async () => {
  for (const hook of ["onQueued", "onSpawned"]) {
    const f = fixture(),
      m = f.manager,
      controller = new AbortController(),
      gate = deferred();
    const r = m.spawn("worker", "work", {
      signal: controller.signal,
      [hook]: async () => {
        await gate.promise;
        controller.abort();
        throw new Error("callback rejected");
      },
    });
    const call = await f.nextPrompt();
    gate.resolve();
    // Yield to the callback's explicit continuation, not a wall-clock delay.
    await gate.promise;
    assert.equal(controller.signal.aborted, true);
    call.finish();
    await r.promise;
    assert.equal(r.status, "stopped");
    assert.equal(m.running, 0);
    await m.dispose();
  }
});

test("consume and dispose suppress delayed background notifications", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(),
    m = f.manager;
  const consumed = m.spawn("consumed", "work", { isBackground: true });
  await complete(f, consumed);
  assert.equal(m.consume(consumed.id), true);
  t.mock.timers.tick(201);
  assert.deepEqual(f.notifications, []);
  const delivered = m.spawn("delivered", "work", { isBackground: true });
  await complete(f, delivered);
  t.mock.timers.tick(201);
  assert.deepEqual(f.notifications, [delivered.id]);
  const disposed = m.spawn("disposed", "work", { isBackground: true });
  await complete(f, disposed);
  await m.dispose();
  t.mock.timers.tick(201);
  assert.deepEqual(f.notifications, [delivered.id]);
  assert.ok(f.sessions.every((s) => s.disposed === 1));
  assert.throws(() => m.spawn("closed", "work"), /closed/);
});

test("workflow ownership fences resolve, stop, steer, consume, resume and public events", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(),
    m = f.manager;
  const r = m.spawn("child", "work", {
    workflowId: "workflow",
    isBackground: true,
  });
  assert.equal(topLevel(r), false);
  assert.equal(topLevel({ parentAgentId: "parent" }), false);
  assert.throws(() => m.resolve(r.id), /Unknown/);
  assert.equal(m.resolve(`@${r.handle}`, "workflow"), r);
  const call = await f.nextPrompt();
  assert.equal(m.stop(r.id), false);
  await assert.rejects(m.steer(r.id, "wrong"), /not running/);
  await m.steer(r.id, "owned", "workflow");
  call.session.emit({ type: "auto_compaction_end" });
  call.finish();
  await r.promise;
  assert.equal(m.consume(r.id), false);
  assert.throws(() => m.resume(r.id, "wrong"), /owned/);
  assert.equal(m.consume(r.id, "workflow"), true);
  m.resume(r.id, "owned", {}, "workflow");
  await complete(f, r);
  t.mock.timers.tick(201);
  assert.deepEqual(f.events, []);
  assert.deepEqual(f.notifications, []);
  await m.dispose();
});

test("failed resume validation neither widens options nor deletes a settled record", async () => {
  const f = fixture(),
    m = f.manager;
  const r = m.spawn("worker", "work", {
    tools: ["read"],
    invocationId: "original",
  });
  await complete(f, r);
  const original = {
    invocation: r.invocation,
    promise: r.promise,
    options: r.options,
    result: r.result,
  };
  const aborted = new AbortController();
  aborted.abort();
  for (const [prompt, options] of [
    ["", { tools: ["bash"] }],
    ["again", { invocationId: "", tools: ["bash"] }],
    ["again", { signal: aborted.signal, tools: ["bash"] }],
    ["again", { maxTurns: 0, tools: ["bash"] }],
  ]) {
    assert.throws(() => m.resume(r.id, prompt, options));
    assert.equal(
      m.getRecord(r.id),
      r,
      "invalid resume must retain the original record",
    );
    assert.equal(r.invocation, original.invocation);
    assert.equal(r.promise, original.promise);
    assert.equal(r.options, original.options);
    assert.deepEqual(r.options.tools, ["read"]);
    assert.equal(r.result, original.result);
    assert.equal(r.status, "completed");
    assert.equal(m.hasRunning(), false);
  }
  await m.dispose();
});

test("cancellation during async session creation never prompts and retains the reserved slot", async () => {
  const creation = deferred(),
    entered = deferred(),
    idle = deferred(),
    idleEntered = deferred();
  let prompts = 0,
    disposed = 0;
  const session = {
    messages: [],
    isStreaming: false,
    prompt() {
      prompts++;
    },
    subscribe() {
      return () => {};
    },
    async steer() {},
    async abort() {},
    agent: {
      async waitForIdle() {
        idleEntered.resolve();
        await idle.promise;
      },
    },
    dispose() {
      disposed++;
    },
  };
  const m = new AgentManager({
    maxConcurrent: 1,
    createSession: async () => {
      entered.resolve();
      return creation.promise;
    },
  });
  const r = m.spawn("worker", "work");
  await entered.promise;
  assert.equal(m.stop(r.id), true);
  assert.equal(m.running, 1);
  assert.equal(r.status, "running");
  creation.resolve(session);
  await idleEntered.promise;
  assert.equal(prompts, 0);
  assert.equal(m.running, 1);
  idle.resolve();
  await r.promise;
  assert.equal(r.status, "stopped");
  await m.dispose();
  assert.equal(disposed, 1);
});

test("dispose cancels queued work immediately but awaits running tool cleanup", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(),
    m = f.manager;
  const r = m.spawn("running", "work", { isBackground: true });
  const call = await f.nextPrompt();
  call.session.idle = deferred();
  const queued = m.spawn("queued", "work", { isBackground: true });
  let settled = false;
  const disposal = m.dispose().then(() => {
    settled = true;
  });
  assert.equal(queued.status, "stopped");
  assert.equal(r.status, "running");
  call.finish();
  await call.session.idleEntered.promise;
  assert.equal(settled, false);
  assert.equal(call.session.disposed, 0);
  call.session.idle.resolve();
  await disposal;
  assert.equal(r.status, "stopped");
  assert.equal(f.sessions.length, 1);
  assert.equal(call.session.disposed, 1);
  assert.equal(m.hasRunning(), false);
  t.mock.timers.tick(201);
  assert.deepEqual(f.notifications, []);
});

test("provider errors, unexpected abortion and empty fresh output become errors", async () => {
  for (const [answer, extra, expected] of [
    [
      "partial",
      { stopReason: "error", errorMessage: "provider broke" },
      /provider broke/,
    ],
    ["partial", { stopReason: "aborted" }, /Provider aborted/],
    [null, {}, /empty result/],
  ]) {
    const f = fixture(),
      m = f.manager,
      r = m.spawn("worker", "work");
    const call = await f.nextPrompt();
    call.finish(answer, extra);
    await r.promise;
    assert.equal(r.status, "error");
    assert.match(r.error, expected);
    assert.equal(f.events.at(-1).name, "subagents:failed");
    await m.dispose();
  }
});

test("structured resume clears old JSON and asks again before rejecting missing output", async () => {
  const f = fixture(),
    m = f.manager;
  const r = m.spawn("worker", "work", { structuredOutput: { type: "object" } });
  const first = await f.nextPrompt();
  r.structuredJson = { answer: 1 };
  first.finish();
  await r.promise;
  assert.equal(r.status, "completed");
  m.resume(r.id, "again");
  assert.equal(r.structuredJson, undefined);
  const second = await f.nextPrompt();
  second.finish("new prose");
  const retry = await f.nextPrompt();
  assert.match(retry.prompt, /StructuredOutput/);
  assert.deepEqual(retry.promptOptions, { expandPromptTemplates: false });
  retry.finish("still prose");
  await r.promise;
  assert.equal(r.status, "error");
  assert.match(r.error, /valid StructuredOutput/);
  assert.equal(r.result, "new prose\nstill prose");
  await m.dispose();
});

test("compaction copies of old messages cannot count as fresh resume output", async () => {
  const f = fixture(),
    m = f.manager;
  const r = m.spawn("worker", "first");
  await complete(f, r, "old answer");
  m.resume(r.id, "again");
  const call = await f.nextPrompt();
  call.session.messages = structuredClone(call.session.messages);
  call.finish(null);
  await r.promise;
  assert.equal(r.status, "error");
  assert.match(r.error, /empty result/);
  await m.dispose();
});
