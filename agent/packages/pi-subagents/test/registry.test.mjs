import { test } from "node:test";
import assert from "node:assert/strict";
import { createRegistry } from "../registry.mjs";

test("retained registry cannot spawn or join another parent session", async () => {
  const calls = [];
  let current = true;
  const manager = {
    closed: false,
    getRecord: () => undefined,
    hasRunning: () => false,
    waitForAll: async () => calls.push("old-manager"),
    resume: () => calls.push("resume"),
  };
  const oldWorkflows = {
    list: () => [],
    waitForAll: async () => calls.push("old-workflows"),
  };
  const registry = createRegistry({
    manager,
    isCurrent: () => current,
    spawn: () => {
      calls.push("spawn");
      return { id: "owned" };
    },
    getWorkflows: () => oldWorkflows,
  });
  assert.equal(registry.spawn(null, null, "Explore", "read", {}), "owned");
  current = false;
  assert.throws(
    () => registry.spawn(null, null, "Explore", "read", {}),
    /inactive parent/,
  );
  await assert.rejects(
    registry.resume("owned", "read", { invocationId: "next" }),
    /inactive parent/,
  );
  await registry.waitForAll();
  assert.deepEqual(calls, ["spawn", "old-workflows", "old-manager"]);
});

test("managed resume requires a token and cannot widen the retained profile", async () => {
  let resumed = 0;
  const manager = {
    closed: false,
    resume: () => {
      resumed++;
      return { id: "owned" };
    },
  };
  const r = createRegistry({ manager, isCurrent: () => true, spawn: () => {} });
  await assert.rejects(r.resume("owned", "next", {}), /invocationId/);
  await assert.rejects(
    r.resume("owned", "next", { invocationId: "next", model: "other" }),
    /Unsupported/,
  );
  assert.equal(
    (await r.resume("owned", "next", { invocationId: "next", maxTurns: 24 }))
      .id,
    "owned",
  );
  assert.equal(resumed, 1);
});

test("a stopping workflow remains running until its gate and children settle", () => {
  let status = "stopping";
  const r = createRegistry({
    manager: { hasRunning: () => false },
    isCurrent: () => true,
    spawn: () => {},
    getWorkflows: () => ({ list: () => [{ status }] }),
  });
  assert.equal(r.hasRunning(), true);
  status = "cancelled";
  assert.equal(r.hasRunning(), false);
});
