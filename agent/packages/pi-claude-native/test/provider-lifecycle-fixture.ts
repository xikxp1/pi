// Loaded by installed Pi's jiti loader; no inference or real provider registration.
import assert from "node:assert/strict";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import provider from "../index.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default async function () {
  const agentDir = process.env.PI_CODING_AGENT_DIR!;
  const root = dirname(agentDir);
  const cachePath = join(agentDir, "claude-native-cache", "models.json");
  const modePath = join(root, "mode.json");
  const phases: string[] = [];
  const known = "claude-lifecycle-known-sentinel";
  const unknown = "claude-lifecycle-unknown-sentinel";
  const newest = "claude-lifecycle-newest-sentinel";
  const initialCost = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 };
  const effectiveCost = { input: 7, output: 19, cacheRead: 0.7, cacheWrite: 8.75 };
  const registrations: any[] = [];
  const commands = new Map<string, any>();
  const handlers = new Map<string, any>();
  const selections: any[] = [];
  const notifications: { message: string; level: string }[] = [];
  const statuses: (string | undefined)[] = [];
  let currentModels: any[] = [];
  let registryModels = [
    { provider: "anthropic", id: known, input: ["text", "image"], cost: effectiveCost },
    { provider: "anthropic", id: "claude-registry-only-sentinel", input: ["text"] },
    // A different provider with the same ID must not override Anthropic metadata.
    { provider: "other", id: known, input: ["text"], cost: initialCost },
  ];
  let waitCalls = 0;
  let idle: Promise<void> = Promise.resolve();
  const ctx: any = {
    hasUI: true,
    model: undefined,
    modelRegistry: {
      getAll: () => [...registryModels, ...currentModels],
      find: (name: string, id: string) => currentModels.find((m) => m.provider === name && m.id === id),
    },
    waitForIdle: () => { waitCalls++; return idle; },
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
      setStatus: (key: string, value: string | undefined) => {
        assert.equal(key, "claude-native-discovery");
        statuses.push(value);
      },
    },
  };
  const pi = {
    registerProvider: (name: string, definition: any) => {
      assert.equal(name, "claude-native");
      registrations.push(definition);
      // ModelRegistry registration replaces, rather than appends, provider models.
      currentModels = definition.models.map((model: any) => ({ ...model, provider: name }));
    },
    on: (name: string, handler: any) => {
      assert.equal(handlers.has(name), false);
      handlers.set(name, handler);
    },
    registerCommand: (name: string, command: any) => {
      assert.equal(commands.has(name), false);
      commands.set(name, command);
    },
    setModel: async (model: any) => {
      assert.ok(currentModels.includes(model), "reselection must use the newly registered model");
      selections.push(model);
      ctx.model = model;
      return true;
    },
  } as unknown as ExtensionAPI;
  const ids = () => currentModels.map((m) => m.id).sort();
  const command = (name: string) => commands.get(`claude-native-${name}`).handler("", ctx);
  const lastNotice = () => notifications.at(-1)!;
  const setMode = (mode: any) => writeFile(modePath, JSON.stringify(mode));

  const pending = provider(pi);
  assert.equal(registrations.length, 0, "startup must await asynchronous discovery");
  await pending;
  assert.equal(registrations.length, 1);
  assert.deepEqual(ids(), [known, unknown].sort());
  assert.deepEqual(currentModels.find((m) => m.id === known).cost, initialCost);
  assert.deepEqual(currentModels.find((m) => m.id === known).input, ["text"]);
  phases.push("async startup enumerates only CLI discoveries");

  await handlers.get("session_start")({ reason: "startup" }, ctx);
  assert.equal(registrations.length, 2);
  assert.deepEqual(ids(), [known, unknown].sort());
  assert.deepEqual(currentModels.find((m) => m.id === known).cost, effectiveCost);
  assert.deepEqual(currentModels.find((m) => m.id === known).input, ["text", "image"]);
  assert.equal(statuses.at(-1), undefined);
  phases.push("session_start enriches from effective Anthropic registry without enumerating it");

  await command("status");
  assert.equal(lastNotice().level, "info");
  assert.match(lastNotice().message, /Discovery: live; last success/);
  assert.ok(lastNotice().message.includes(`Pricing unknown (zero placeholders, not free usage): ${unknown}`));
  assert.doesNotMatch(lastNotice().message, /catalog-only|registry-only/);
  phases.push("status reports live discovery and unknown pricing");

  ctx.model = currentModels.find((m) => m.id === known);
  const oldSelected = ctx.model;
  await setMode({ models: [{ value: known }, { value: newest }] });
  // Keep an older valid snapshot on disk while a newer live result cannot persist.
  const oldCache = JSON.parse(await readFile(cachePath, "utf8"));
  oldCache.checkedAt = "2000-01-01T00:00:00.000Z";
  await writeFile(cachePath, JSON.stringify(oldCache));
  const oldDisk = await readFile(cachePath, "utf8");
  await chmod(dirname(cachePath), 0o755);
  await command("refresh");
  assert.deepEqual(ids(), [known, newest].sort());
  assert.equal(selections.length, 1);
  assert.notEqual(ctx.model, oldSelected);
  assert.equal(ctx.model.id, known);
  assert.equal(lastNotice().level, "warning");
  assert.match(lastNotice().message, /Discovery: live/);
  assert.match(statuses.at(-1)!, /cache write failed/);
  assert.equal(await readFile(cachePath, "utf8"), oldDisk);
  const newestCheckedAt = /last success \d+s ago \(([^)]+)\)/.exec(lastNotice().message)![1];
  assert.ok(Date.parse(newestCheckedAt) > Date.parse(oldCache.checkedAt));
  phases.push("successful refresh immediately replaces models and reselects the active ID despite cache write failure");

  await setMode("error");
  await command("refresh");
  assert.deepEqual(ids(), [known, newest].sort(), "failed refresh must not revert to older disk discoveries");
  assert.equal(await readFile(cachePath, "utf8"), oldDisk);
  assert.equal(lastNotice().level, "warning");
  assert.match(statuses.at(-1)!, /STALE model cache/);
  assert.match(lastNotice().message, /Discovery: STALE cache/);
  assert.match(lastNotice().message, /rejected initialization/);
  assert.ok(lastNotice().message.includes(newestCheckedAt), "stale memory retains its own success timestamp");
  await command("status");
  assert.match(lastNotice().message, /Discovery: STALE cache/);
  assert.ok(lastNotice().message.includes(`Pricing unknown (zero placeholders, not free usage): ${newest}`));
  phases.push("failed refresh preserves newest memory over older disk and marks status stale");

  await chmod(dirname(cachePath), 0o700);
  await setMode({ models: [{ value: known }] });
  registryModels = registryModels.map((m) => m.provider === "anthropic" && m.id === known
    ? { ...m, input: ["text"], cost: initialCost } : m);
  let release!: () => void;
  idle = new Promise<void>((resolve) => { release = resolve; });
  const before = registrations.length;
  const waitsBefore = waitCalls;
  const refreshing = command("refresh");
  assert.equal(waitCalls, waitsBefore + 1);
  assert.equal(registrations.length, before, "refresh must wait for idle before replacing models");
  await command("refresh");
  assert.equal(waitCalls, waitsBefore + 1, "concurrent refresh must not wait or start discovery");
  assert.equal(registrations.length, before);
  assert.match(lastNotice().message, /already running/);
  release();
  await refreshing;
  assert.equal(registrations.length, before + 1);
  assert.deepEqual(ids(), [known]);
  assert.deepEqual(ctx.model.cost, initialCost);
  assert.deepEqual(ctx.model.input, ["text"]);
  assert.equal(statuses.at(-1), undefined, "success must clear the stale warning");
  assert.equal(lastNotice().level, "info");
  assert.match(lastNotice().message, /Discovery: live/);
  assert.doesNotMatch(lastNotice().message, /STALE|Discovery error:|Cache:|Pricing unknown/);
  assert.deepEqual(JSON.parse(await readFile(cachePath, "utf8")).models, [{ value: known }]);
  phases.push("concurrency guard permits one refresh and recovery clears stale status and updates metadata");

  // A subsequent call verifies the guard resets, and a removed active ID is not reselected.
  idle = Promise.resolve();
  const selectionsBefore = selections.length;
  await setMode({ models: [{ value: newest }] });
  await command("refresh");
  assert.deepEqual(ids(), [newest]);
  assert.equal(selections.length, selectionsBefore);
  phases.push("refresh guard resets and removed active IDs are not reselected");
  await writeFile(join(root, "lifecycle-report.json"), JSON.stringify({ success: true, phases }));
}
