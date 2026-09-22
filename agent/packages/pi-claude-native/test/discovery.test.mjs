import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readFile,
  stat,
  rm,
  readdir,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverModels, loadDiscoveredModels } from "../discovery.mjs";

async function fixture(t, mode = "success") {
  const root = await mkdtemp(join(tmpdir(), "discovery-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, "claude");
  const report = join(root, "report.json");
  const setMode = (next) =>
    writeFile(
      executable,
      `#!${process.execPath}\nimport { run } from ${JSON.stringify(new URL("./fake-discovery.mjs", import.meta.url).href)};\nrun(${JSON.stringify(next)}, ${JSON.stringify(report)});\n`,
      { mode: 0o700 },
    );
  await setMode(mode);
  return {
    root,
    report,
    setMode,
    cachePath: join(root, "cache", "models.json"),
    config: { executable, discoveryTimeoutMs: 2000, killGraceMs: 30 },
  };
}

async function gone(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") return true;
    throw error;
  }
  // Linux containers may not reap an orphan immediately, but a zombie cannot execute.
  if (process.platform === "linux") {
    try {
      return /\) Z /.test(await readFile(`/proc/${pid}/stat`, "utf8"));
    } catch {
      return true;
    }
  }
  return false;
}

test("initializes without a prompt, isolates cwd, preserves aliases and whitelists metadata", async (t) => {
  const f = await fixture(t);
  const result = await discoverModels(f.config);
  assert.equal(result.models.length, 5);
  assert.equal(result.models[0].value, "default");
  assert.equal(result.models[1].resolvedModel, "claude-opus-5-5[1m]");
  assert.equal(result.models[2].value, "claude-fable-5-1[1m]");
  assert.equal(result.models[2].resolvedModel, "claude-fable-5-1");
  assert.deepEqual(result.models[0].supportedEffortLevels, ["low", "high"]);
  assert.equal(result.models[0].supportsAdaptiveThinking, true);
  assert.equal(JSON.stringify(result).includes("secret"), false);
  const report = JSON.parse(await readFile(f.report, "utf8"));
  const lines = report.input.trim().split("\n").map(JSON.parse);
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0].request, { subtype: "initialize" });
  assert.equal(lines[0].type, "control_request");
  assert.notEqual(report.cwd, process.cwd());
  await assert.rejects(stat(report.cwd), { code: "ENOENT" });
  for (const flag of [
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--no-session-persistence",
  ])
    assert.ok(report.args.includes(flag));
  const arg = (flag) => report.args[report.args.indexOf(flag) + 1];
  assert.equal(arg("--tools"), "");
  assert.equal(arg("--setting-sources"), "");
  assert.equal(arg("--permission-prompts"), "none");
  assert.deepEqual(JSON.parse(arg("--mcp-config")), { mcpServers: {} });
  assert.equal(JSON.parse(arg("--settings")).disableAllHooks, true);
  assert.equal(JSON.parse(arg("--settings")).autoMemoryEnabled, false);
});

for (const [mode, error] of [
  ["timeout", /timed out/],
  ["wrong-id", /timed out/],
  ["malformed", /Malformed/],
  ["empty", /empty/],
  ["error", /rejected/],
  ["invalid", /capability/],
  ["overflow", /limit/],
  ["stderr", /limit/],
  ["exit", /without/],
]) {
  test(`rejects ${mode} without retaining CLI output`, async (t) => {
    const f = await fixture(t, mode);
    f.config.discoveryTimeoutMs = 350;
    await assert.rejects(discoverModels(f.config), error);
    const report = JSON.parse(await readFile(f.report, "utf8"));
    await assert.rejects(stat(report.cwd), { code: "ENOENT" });
  });
}

test("spawn failure exposes no models", async () => {
  const result = await loadDiscoveredModels({
    config: { executable: "/nonexistent/discovery-command" },
  });
  assert.equal(result.source, "none");
  assert.deepEqual(result.models, []);
  assert.match(result.error, /Unable to start/);
});

test("private atomic cache stores only successful whitelisted responses and falls back", async (t) => {
  const f = await fixture(t);
  const live = await loadDiscoveredModels(f);
  assert.equal(live.source, "live");
  assert.equal(live.cacheError, undefined);
  const original = await readFile(f.cachePath, "utf8");
  assert.equal(original.includes("secret"), false);
  assert.equal((await stat(f.cachePath)).mode & 0o777, 0o600);
  assert.equal((await stat(join(f.root, "cache"))).mode & 0o777, 0o700);
  assert.deepEqual(await readdir(join(f.root, "cache")), ["models.json"]);
  await f.setMode("timeout");
  f.config.discoveryTimeoutMs = 350;
  const cached = await loadDiscoveredModels(f);
  assert.equal(cached.source, "cache");
  assert.deepEqual(cached.models, live.models);
  assert.equal(cached.checkedAt, live.checkedAt);
  assert.match(cached.error, /timed out/);
  assert.equal(await readFile(f.cachePath, "utf8"), original);
  const mismatch = await loadDiscoveredModels({
    ...f,
    config: { executable: "/not-same-claude" },
  });
  assert.equal(mismatch.source, "none");
  assert.deepEqual(mismatch.models, []);
  assert.ok(mismatch.cacheError);
});

test("malformed identifiers fall back without overwriting a valid cache", async (t) => {
  const f = await fixture(t);
  const live = await loadDiscoveredModels(f);
  assert.equal(live.source, "live");
  const original = await readFile(f.cachePath, "utf8");
  for (const key of ["value", "resolvedModel"]) {
    for (const identifier of [
      "",
      " \t\n",
      " opus",
      "opus ",
      "opus model",
      "opus\tmodel",
      "opus\nmodel",
      "opus\u0000model",
      "opus\u001bmodel",
      "opus\u007fmodel",
      "opus\u009bmodel",
      "opus\u00a0model",
      "opus\u200bmodel",
      "opus\u202emodel",
      null,
      42,
    ]) {
      await t.test(`${key}=${JSON.stringify(identifier)}`, async () => {
        // Even a valid preceding record must not allow a partial cache replacement.
        await f.setMode({
          models: [
            { value: "new-alias" },
            { value: "default", [key]: identifier },
          ],
        });
        const result = await loadDiscoveredModels(f);
        assert.equal(result.source, "cache");
        assert.match(result.error, /Invalid Claude model/);
        assert.deepEqual(result.models, live.models);
        assert.equal(result.checkedAt, live.checkedAt);
        assert.equal(await readFile(f.cachePath, "utf8"), original);
      });
    }
  }
});

test("older CLI records may omit resolvedModel and display controls are sanitized before caching", async (t) => {
  const f = await fixture(t, {
    models: [
      {
        value: "opus[1m]",
        displayName: "Opus\u0000\u001b\u009b\u202e",
        description: "First\r\nSecond\tline\u007f\u2028End",
      },
    ],
  });
  const live = await loadDiscoveredModels(f);
  assert.equal(live.source, "live");
  assert.equal(live.cacheError, undefined);
  assert.deepEqual(live.models, [
    {
      value: "opus[1m]",
      displayName: "Opus    ",
      description: "First  Second line  End",
    },
  ]);
  assert.deepEqual(
    JSON.parse(await readFile(f.cachePath, "utf8")).models,
    live.models,
  );
  await f.setMode("error");
  const cached = await loadDiscoveredModels(f);
  assert.equal(cached.source, "cache");
  assert.deepEqual(cached.models, live.models);
});

test("malformed cached identifiers are rejected too", async (t) => {
  const f = await fixture(t, "error");
  const cachePath = join(f.root, "models.json");
  for (const model of [
    { value: "opus\u0000" },
    { value: "default", resolvedModel: " " },
  ]) {
    const contents = JSON.stringify({
      schemaVersion: 1,
      executable: f.config.executable,
      checkedAt: new Date().toISOString(),
      models: [model],
    });
    await writeFile(cachePath, contents);
    const result = await loadDiscoveredModels({ ...f, cachePath });
    assert.equal(result.source, "none");
    assert.deepEqual(result.models, []);
    assert.ok(result.cacheError);
    assert.equal(await readFile(cachePath, "utf8"), contents);
  }
});

test("missing, corrupt, empty, oversized and invalid-schema caches never invent models", async (t) => {
  const f = await fixture(t, "error");
  assert.equal((await loadDiscoveredModels(f)).source, "none");
  const cachePath = join(f.root, "models.json");
  for (const contents of [
    "{",
    "x".repeat(1024 * 1024 + 1),
    JSON.stringify({ schemaVersion: 2 }),
    JSON.stringify({
      schemaVersion: 1,
      executable: f.config.executable,
      checkedAt: new Date().toISOString(),
      models: [],
    }),
    JSON.stringify({
      schemaVersion: 1,
      executable: f.config.executable,
      checkedAt: "not-a-date",
      models: [{ value: "default" }],
    }),
  ]) {
    await writeFile(cachePath, contents);
    const result = await loadDiscoveredModels({ ...f, cachePath });
    assert.equal(result.source, "none");
    assert.deepEqual(result.models, []);
    assert.ok(result.cacheError);
    assert.equal(await readFile(cachePath, "utf8"), contents);
  }
});

test("cache write failure does not discard live models or change shared directory permissions", async (t) => {
  const f = await fixture(t);
  await chmod(f.root, 0o755);
  const result = await loadDiscoveredModels({
    ...f,
    cachePath: join(f.root, "models.json"),
  });
  assert.equal(result.source, "live");
  assert.equal(result.models.length, 5);
  assert.ok(result.cacheError);
  assert.equal((await stat(f.root)).mode & 0o777, 0o755);
});

for (const mode of ["group", "group-timeout"]) {
  test(`awaits process-group escalation even after leader exits: ${mode}`, async (t) => {
    const f = await fixture(t, mode);
    f.config.killGraceMs = 100;
    f.config.discoveryTimeoutMs = 400;
    const start = Date.now();
    if (mode === "group")
      assert.equal((await discoverModels(f.config)).models.length, 1);
    else await assert.rejects(discoverModels(f.config), /timed out|without/);
    assert.ok(Date.now() - start >= 100);
    const report = JSON.parse(await readFile(f.report, "utf8"));
    t.after(() => {
      try {
        process.kill(report.descendant, "SIGKILL");
      } catch {}
    });
    assert.equal(await gone(report.descendant), true);
    await assert.rejects(stat(report.cwd), { code: "ENOENT" });
  });
}
