import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const provider = fileURLToPath(new URL("../index.ts", import.meta.url));
const fake = new URL("./fake-discovery.mjs", import.meta.url).href;
const exec = promisify(execFile);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-provider-discovery-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  const executable = join(root, "fake-claude.mjs");
  const report = join(root, "report.json");
  const cachePath = join(agentDir, "claude-native-cache", "models.json");
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ enableInstallTelemetry: false }));
  await writeFile(join(agentDir, "claude-native.json"), JSON.stringify({ executable, discoveryTimeoutMs: 3000, killGraceMs: 30 }));
  // An attractive catalog entry must never become an enumerated CLI model.
  await writeFile(join(agentDir, "models-store.json"), JSON.stringify({ anthropic: { models: [
    { id: "claude-catalog-only-sentinel", name: "Catalog only", input: ["text", "image"], cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 }, contextWindow: 1000000, maxTokens: 64000 },
  ] } }));
  const setMode = (mode) => writeFile(executable, `#!${process.execPath}\nimport { run } from ${JSON.stringify(fake)};\nrun(${JSON.stringify(mode)}, ${JSON.stringify(report)});\n`, { mode: 0o700 });
  const setModels = (models) => writeFile(executable, `#!${process.execPath}
import { writeFileSync } from "node:fs";
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  if (!input.includes("\\n")) return;
  const request = JSON.parse(input.trim());
  if (request.type !== "control_request" || request.request?.subtype !== "initialize") process.exit(97);
  writeFileSync(${JSON.stringify(report)}, JSON.stringify({ input }));
  process.stdout.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: request.request_id, response: { models: ${JSON.stringify(models)} } } }) + "\\n");
});
`, { mode: 0o700 });
  const list = async () => {
    const pending = exec("pi", ["--no-extensions", "-e", provider, "--no-context-files", "--no-skills", "--list-models", "claude-native"], {
      cwd: root,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", NO_COLOR: "1" },
      timeout: 30000,
      maxBuffer: 2e6,
    });
    pending.child.stdin.end();
    const result = await pending;
    assert.doesNotMatch(result.stderr, /Extension error|Failed to load extension/);
    assert.doesNotMatch(result.stdout, /claude-catalog-only-sentinel/);
    return result;
  };
  return { root, report, cachePath, setMode, setModels, list };
}

const ids = (output) => output.split("\n").map((line) => line.trim().split(/\s+/)).filter((columns) => columns[0] === "claude-native").map((columns) => columns[1]).sort();

test("installed Pi awaits discovery at startup, uses stale cache, and replaces obsolete discoveries", { timeout: 100000 }, async (t) => {
  const f = await fixture(t);
  await f.setMode("success");
  const live = await f.list();
  const expected = ["claude-opus-5-5[1m]", "claude-fable-5-1[1m]", "claude-sonnet-5", "claude-haiku-4-5-20251001"].sort();
  assert.deepEqual(ids(live.stdout), expected, live.stdout);
  assert.doesNotMatch(live.stderr, /Discovery: (cache|none)/);
  const request = JSON.parse(JSON.parse(await readFile(f.report, "utf8")).input.trim());
  assert.equal(request.type, "control_request");
  assert.deepEqual(request.request, { subtype: "initialize" });
  const originalCache = await readFile(f.cachePath, "utf8");

  await f.setMode("error");
  const stale = await f.list();
  assert.deepEqual(ids(stale.stdout), expected);
  assert.match(stale.stderr, /Discovery: cache/);
  assert.match(stale.stderr, /rejected initialization/);
  assert.equal(await readFile(f.cachePath, "utf8"), originalCache);

  await f.setModels([{ value: "new-opus[1m]", resolvedModel: "claude-opus-future", displayName: "Future Opus", supportsEffort: true, supportedEffortLevels: ["high"] }]);
  const refreshed = await f.list();
  assert.deepEqual(ids(refreshed.stdout), ["claude-opus-future[1m]"]);
  assert.doesNotMatch(refreshed.stderr, /Discovery: (cache|none)/);
  const updated = JSON.parse(await readFile(f.cachePath, "utf8"));
  assert.equal(updated.models.length, 1);
  assert.equal(updated.models[0].resolvedModel, "claude-opus-future");
  await f.setMode("error");
  assert.deepEqual(ids((await f.list()).stdout), ["claude-opus-future[1m]"]);
});

test("installed Pi with failed discovery and no valid cache exposes no catalog models", { timeout: 70000 }, async (t) => {
  const f = await fixture(t);
  await f.setMode("error");
  for (const corrupt of [false, true]) {
    if (corrupt) {
      await mkdir(join(f.root, "agent", "claude-native-cache"), { recursive: true, mode: 0o700 });
      await writeFile(f.cachePath, "{invalid-json");
    }
    const result = await f.list();
    assert.deepEqual(ids(result.stdout), [], result.stdout);
    assert.match(result.stderr, /Discovery: none/);
    assert.match(result.stderr, /rejected initialization/);
    assert.doesNotMatch(result.stdout, /claude-(?:opus|sonnet|haiku|fable)/);
  }
});
