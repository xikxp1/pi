import test from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { SubagentClient } from "../subagents.mjs";

class Bus {
  handlers = new Map();
  sent = [];
  on(name, fn) {
    const set = this.handlers.get(name) ?? new Set();
    this.handlers.set(name, set);
    set.add(fn);
    return () => {
      set.delete(fn);
      if (!set.size) this.handlers.delete(name);
    };
  }
  emit(name, data) {
    this.sent.push({ name, data });
    for (const fn of [...(this.handlers.get(name) ?? [])]) fn(data);
  }
  reply(verb, request, data) {
    this.emit(`subagents:rpc:${verb}:reply:${request.requestId}`, data);
  }
  requests(verb) {
    return this.sent
      .filter((x) => x.name === `subagents:rpc:${verb}`)
      .map((x) => x.data);
  }
  get listeners() {
    return [...this.handlers.values()].reduce((n, set) => n + set.size, 0);
  }
}
const args = {
  type: "general-purpose",
  prompt: "Work",
  model: "provider/exact-model",
  thinkingLevel: "high",
  maxTurns: 4,
  cwd: "/project",
  structuredOutput: { schema: "compiled" },
};
const complete = (bus, id = "owned", extra = {}) =>
  bus.emit("subagents:completed", {
    id,
    type: args.type,
    status: "completed",
    result: "done",
    usage: { cost: { total: 1 } },
    ...extra,
  });
function service(bus, handler) {
  return bus.on("subagents:rpc:spawn", handler);
}

test("ping verifies v2, scopes channels, rejects wrong version, cleans listeners", async () => {
  const bus = new Bus();
  let version = 2;
  const off = bus.on("subagents:rpc:ping", (q) =>
    bus.reply("ping", q, { success: true, data: { version } }),
  );
  const client = new SubagentClient(bus);
  assert.equal(bus.listeners, 1);
  assert.deepEqual(await Promise.all([client.ping(), client.ping()]), [2, 2]);
  assert.notEqual(...bus.requests("ping").map((q) => q.requestId));
  version = 3;
  await assert.rejects(client.ping(), /Unsupported.*3/);
  off();
  await client.dispose();
  assert.equal(bus.listeners, 0);
});

test("dispatch uses exact camelCase settings and fast completion is consumed before spawn reply", async () => {
  const bus = new Bus();
  const activity = [];
  const spawned = [];
  const client = new SubagentClient(bus, {
    onActivity: (e) => activity.push(e),
  });
  const off = service(bus, (q) => {
    const o = q.options;
    assert.equal(q.type, args.type);
    assert.equal(q.prompt, args.prompt);
    assert.deepEqual(
      Object.keys(o).sort(),
      [
        "isBackground",
        "isolated",
        "inheritContext",
        "signal",
        "description",
        "name",
        "model",
        "thinkingLevel",
        "maxTurns",
        "cwd",
        "structuredOutput",
        "onSpawned",
        "onQueued",
      ].sort(),
    );
    assert.equal(o.isBackground, true);
    assert.equal(o.isolated, true);
    assert.equal(o.inheritContext, false);
    for (const key of [
      "model",
      "thinkingLevel",
      "maxTurns",
      "cwd",
      "structuredOutput",
    ])
      assert.equal(o[key], args[key]);
    assert.equal(o.description, args.type);
    assert.match(o.name, /^goal-/);
    assert.ok(o.signal instanceof AbortSignal);
    o.onSpawned("owned");
    assert.deepEqual(spawned, ["owned"]);
    complete(bus);
    assert.equal(bus.requests("consume").at(-1).agentId, "owned");
    bus.reply("spawn", q, { success: true, data: { id: "owned" } });
  });
  const result = await client.run({
    ...args,
    onSpawned: (id) => spawned.push(id),
  });
  assert.deepEqual(result, {
    id: "owned",
    type: args.type,
    status: "completed",
    result: "done",
    error: undefined,
    usage: { cost: { total: 1 } },
  });
  assert.deepEqual(
    activity.map((e) => e.event),
    ["started", "settled"],
  );
  assert.equal(client.hasUnsettled, false);
  assert.equal(bus.listeners, 1);
  off();
  await client.dispose();
  assert.equal(bus.listeners, 0);
});

test("spawn reply alone establishes ownership; unrelated events and overlap cannot affect it", async () => {
  const bus = new Bus();
  const client = new SubagentClient(bus);
  const off = service(bus, (q) =>
    bus.reply("spawn", q, { success: true, data: { id: "owned" } }),
  );
  const run = client.run(args);
  complete(bus, "other");
  bus.emit("subagents:failed", { id: "other", status: "error" });
  assert.equal(client.hasUnsettled, true);
  assert.equal(bus.requests("consume").length, 0);
  await assert.rejects(client.run(args), /unsettled/);
  assert.equal(bus.requests("spawn").length, 1);
  complete(bus);
  await run;
  assert.equal(bus.requests("stop").length, 0);
  off();
  await client.dispose();
  assert.equal(bus.listeners, 0);
});

test("missing service: ping timeout cleans everything; spawn timeout retains a late-reply guard", async () => {
  const bus = new Bus();
  const client = new SubagentClient(bus, { timeoutMs: 5 });
  await assert.rejects(client.ping(), { name: "TimeoutError" });
  assert.equal(bus.listeners, 0);
  await assert.rejects(client.run(args), { name: "TimeoutError" });
  assert.equal(client.hasUnsettled, true);
  assert.equal(bus.requests("spawn")[0].options.signal.aborted, true);
  await assert.rejects(client.run(args), /unsettled/);
  await client.dispose();
  assert.equal(bus.listeners, 0);
});

test("spawn refusal before ownership releases run and listeners", async () => {
  const bus = new Bus();
  const client = new SubagentClient(bus);
  const off = service(bus, (q) =>
    bus.reply("spawn", q, { success: false, error: "Unknown type" }),
  );
  await assert.rejects(client.run(args), /Unknown type/);
  assert.equal(client.hasUnsettled, false);
  assert.equal(bus.listeners, 1);
  off();
  await client.dispose();
});

for (const status of ["error", "stopped", "aborted", "steered"]) {
  test(`non-completed status ${status} rejects and consumes`, async () => {
    const bus = new Bus();
    const client = new SubagentClient(bus);
    const off = service(bus, (q) => {
      q.options.onSpawned("owned");
      bus.emit("subagents:failed", { id: "owned", status, result: "partial" });
    });
    await assert.rejects(client.run(args), new RegExp(status));
    assert.equal(client.hasUnsettled, false);
    assert.equal(bus.requests("consume").length, 1);
    off();
    await client.dispose();
    assert.equal(bus.listeners, 0);
  });
}
for (const extra of [
  { result: "" },
  { result: "  " },
  { result: undefined },
  { error: "bad result" },
]) {
  test(`rejects empty/error completed result ${JSON.stringify(extra)}`, async () => {
    const bus = new Bus();
    const client = new SubagentClient(bus);
    const off = service(bus, (q) => {
      q.options.onSpawned("owned");
      complete(bus, "owned", extra);
    });
    await assert.rejects(
      client.run({ ...args, structuredOutput: undefined }),
      /empty result|bad result/,
    );
    off();
    await client.dispose();
    assert.equal(bus.listeners, 0);
  });
}

test("running abort rejects immediately, stops only owned id and holds lock until terminal", async () => {
  const bus = new Bus();
  const client = new SubagentClient(bus);
  const controller = new AbortController();
  const off = service(bus, (q) => {
    q.options.onSpawned("owned");
    bus.reply("spawn", q, { success: true, data: { id: "owned" } });
  });
  const run = client.run({ ...args, signal: controller.signal });
  const rejected = assert.rejects(run, { name: "AbortError" });
  controller.abort();
  await rejected;
  assert.equal(client.hasUnsettled, true);
  assert.deepEqual(
    bus.requests("stop").map((q) => q.agentId),
    ["owned"],
  );
  await assert.rejects(client.run(args), /unsettled/);
  bus.emit("subagents:failed", { id: "owned", status: "stopped" });
  assert.equal(client.hasUnsettled, false);
  assert.equal(bus.listeners, 1);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  off();
  await client.dispose();
});

test("queued abort before id reply propagates signal and never falsely releases ownership", async () => {
  const bus = new Bus();
  const client = new SubagentClient(bus);
  let request;
  const off = service(bus, (q) => {
    request = q;
  });
  const run = client.run(args);
  const rejected = assert.rejects(run, { name: "AbortError" });
  await client.stop();
  await rejected;
  assert.equal(request.options.signal.aborted, true);
  assert.equal(bus.requests("stop").length, 0);
  bus.reply("spawn", request, { success: true, data: { id: "queued-owned" } });
  assert.deepEqual(
    bus.requests("stop").map((q) => q.agentId),
    ["queued-owned"],
  );
  assert.equal(client.hasUnsettled, true); // 0.19.0 emits no queued-cancel terminal event.
  off();
  await client.dispose();
  assert.equal(bus.listeners, 0);
});

test("late spawn reply after timeout stops and consumes orphan, then terminal cleans guard", async () => {
  const bus = new Bus();
  const client = new SubagentClient(bus, { timeoutMs: 5 });
  let request;
  const off = service(bus, (q) => {
    request = q;
  });
  await assert.rejects(client.run(args), { name: "TimeoutError" });
  bus.reply("spawn", request, { success: true, data: { id: "late" } });
  assert.equal(bus.requests("stop").at(-1).agentId, "late");
  assert.equal(bus.requests("consume").at(-1).agentId, "late");
  complete(bus, "late", { status: "stopped" });
  assert.equal(client.hasUnsettled, false);
  assert.equal(bus.listeners, 1);
  off();
  await client.dispose();
  assert.equal(bus.listeners, 0);
});

test("pre-aborted signal never dispatches; dispose cancels ping and own run and cleans listeners", async () => {
  const bus = new Bus();
  const client = new SubagentClient(bus);
  const signal = AbortSignal.abort();
  await assert.rejects(client.run({ ...args, signal }), { name: "AbortError" });
  await assert.rejects(client.ping(signal), { name: "AbortError" });
  assert.equal(bus.sent.length, 0);
  const off = service(bus, (q) => q.options.onSpawned("owned"));
  const ping = assert.rejects(client.ping(), { name: "AbortError" });
  const run = assert.rejects(client.run(args), { name: "AbortError" });
  await client.dispose();
  await Promise.all([ping, run]);
  assert.equal(bus.requests("stop").at(-1).agentId, "owned");
  assert.equal(client.hasUnsettled, true);
  off();
  assert.equal(bus.listeners, 0);
  await assert.rejects(client.run(args), /disposed/);
  await assert.rejects(client.ping(), /disposed/);
  await client.dispose();
});

test("dispose handles an abandoned run rejection; consecutive handles stay unique", async () => {
  const bus = new Bus();
  const client = new SubagentClient(bus);
  let immediate = true;
  const off = service(bus, (q) => {
    q.options.onSpawned("owned");
    if (immediate) complete(bus);
    bus.reply("spawn", q, { success: true, data: { id: "owned" } });
  });
  await client.run(args);
  immediate = false;
  client.run(args); // Intentionally abandoned: dispose must not leak a rejection.
  await client.dispose();
  await new Promise((resolve) => setImmediate(resolve));
  const names = bus.requests("spawn").map((q) => q.options.name);
  assert.notEqual(names[0], names[1]);
  off();
  assert.equal(bus.listeners, 0);
});


test("structured output may settle without prose; caller owns captured payload validation", async () => {
  const bus = new Bus();
  const client = new SubagentClient(bus);
  const off = service(bus, q => { q.options.onSpawned("owned"); complete(bus, "owned", { result: "" }); });
  assert.equal((await client.run(args)).result, "");
  off(); await client.dispose(); assert.equal(bus.listeners, 0);
});

test("proven queued cancellation releases its slot without waiting for a nonexistent event", async () => {
  const bus = new Bus(); const record = { status: "queued" };
  const client = new SubagentClient(bus, { getRecord: id => id === "owned" ? record : undefined });
  const off = service(bus, q => {
    q.options.onQueued("owned", 1);
    q.options.signal.addEventListener("abort", () => { record.status = "stopped"; });
    bus.reply("spawn", q, { success: true, data: { id: "owned" } });
  });
  const run = client.run(args); const rejected = assert.rejects(run, { name: "AbortError" });
  await client.stop(); await rejected;
  assert.equal(client.hasUnsettled, false);
  assert.equal(bus.requests("consume").at(-1).agentId, "owned");
  off(); await client.dispose(); assert.equal(bus.listeners, 0);
});

test("running-to-stopped registry status is not proof the worker has finished", async () => {
  const bus = new Bus(); const record = { status: "running" };
  const client = new SubagentClient(bus, { getRecord: () => record });
  const off = service(bus, q => {
    q.options.onSpawned("owned");
    q.options.signal.addEventListener("abort", () => { record.status = "stopped"; });
    bus.reply("spawn", q, { success: true, data: { id: "owned" } });
  });
  const run = client.run(args); const rejected = assert.rejects(run, { name: "AbortError" });
  await client.stop(); await rejected;
  assert.equal(client.hasUnsettled, true);
  bus.emit("subagents:failed", { id: "owned", status: "stopped" });
  assert.equal(client.hasUnsettled, false);
  off(); await client.dispose(); assert.equal(bus.listeners, 0);
});
