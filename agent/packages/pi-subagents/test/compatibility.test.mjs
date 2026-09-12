import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, copyFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadDefinitions } from "../definitions.mjs";
import { providerView } from "../providers.mjs";

test("shipped goal definitions load without edits, including memory:false and replace prompts", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "local-agent-compat-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const agentDir = join(cwd, "agent");
  await mkdir(join(agentDir, "agents"), { recursive: true });
  for (const role of ["Researcher", "Planner", "Implementer", "Reviewer"]) {
    const name = `PiGoal${role}`;
    await copyFile(
      fileURLToPath(
        new URL(`../../pi-goal/agents/${name}.md`, import.meta.url),
      ),
      join(agentDir, "agents", `${name}.md`),
    );
  }
  const defs = loadDefinitions({ cwd, agentDir });
  for (const role of ["Researcher", "Planner", "Implementer", "Reviewer"]) {
    const def = defs.get(`PiGoal${role}`);
    assert.equal(def.memory, undefined);
    assert.equal(def.extensions, false);
    assert.equal(def.skills, false);
    assert.equal(def.promptMode, "replace");
    assert(!def.tools.includes("bash"));
  }
});

test("child provider view retains bound authentication and blocks provider/credential mutations", async () => {
  const calls = [];
  const catalog = [{ id: "model", metadata: { enabled: true } }];
  const parent = {
    credentials: {
      delete: () => calls.push("deleted"),
      setRuntimeApiKey: () => calls.push("overwritten"),
    },
    models: { registerProvider: () => calls.push("nested-register") },
    getModels: () => catalog,
    getAvailable: async () => catalog,
    key: "temporary-parent-key",
    streamSimple() {
      return this.key;
    },
    getAuth() {
      return this.key;
    },
    registerProvider() {
      calls.push("register");
    },
    registerNativeProvider() {
      calls.push("native");
    },
    unregisterProvider() {
      calls.push("unregister");
    },
    setRuntimeApiKey() {
      calls.push("set-key");
    },
    removeRuntimeApiKey() {
      calls.push("remove-key");
    },
    login() {
      calls.push("login");
    },
    logout() {
      calls.push("logout");
    },
  };
  const child = providerView(parent);
  assert.equal(child.streamSimple(), parent.key);
  parent.key = "refreshed-key";
  assert.equal(child.getAuth(), "refreshed-key");
  child.registerProvider();
  child.registerNativeProvider();
  child.unregisterProvider();
  for (const name of [
    "setRuntimeApiKey",
    "removeRuntimeApiKey",
    "login",
    "logout",
  ])
    assert.throws(() => child[name](), /parent-owned/);
  assert.throws(() => {
    child.key = "other";
  }, /read.only|not extensible/i);
  assert.equal(child.credentials, undefined);
  assert.equal(child.models, undefined);
  assert.equal(
    Object.getOwnPropertyDescriptor(child, "credentials"),
    undefined,
  );
  child.getModels()[0].metadata.enabled = false;
  (await child.getAvailable())[0].id = "changed";
  assert.deepEqual(catalog, [{ id: "model", metadata: { enabled: true } }]);
  assert.deepEqual(calls, []);
  assert.equal(parent.key, "refreshed-key");
});
