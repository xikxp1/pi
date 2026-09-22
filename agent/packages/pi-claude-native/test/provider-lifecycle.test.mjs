import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const fixture = fileURLToPath(new URL("./provider-lifecycle-fixture.ts", import.meta.url));
const fake = new URL("./fake-discovery.mjs", import.meta.url).href;

test("offline same-session provider lifecycle through installed Pi's TS loader", { timeout: 60000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-provider-lifecycle-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  const executable = join(root, "fake-claude.mjs");
  const modePath = join(root, "mode.json");
  const discoveryReport = join(root, "discovery-report.json");
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ enableInstallTelemetry: false }));
  await writeFile(join(agentDir, "claude-native.json"), JSON.stringify({
    executable, discoveryTimeoutMs: 3000, killGraceMs: 30,
  }));
  await writeFile(join(agentDir, "models-store.json"), JSON.stringify({ anthropic: { models: [
    { id: "claude-lifecycle-known-sentinel", input: ["text"], cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 } },
    { id: "claude-catalog-only-sentinel", input: ["text", "image"] },
  ] } }));
  await writeFile(modePath, JSON.stringify({ models: [
    { value: "default", resolvedModel: "claude-lifecycle-known-sentinel" },
    { value: "claude-lifecycle-known-sentinel" },
    { value: "claude-lifecycle-unknown-sentinel" },
  ] }));
  await writeFile(executable, `#!${process.execPath}
import { readFileSync } from "node:fs";
import { run } from ${JSON.stringify(fake)};
run(JSON.parse(readFileSync(${JSON.stringify(modePath)}, "utf8")), ${JSON.stringify(discoveryReport)});
`, { mode: 0o700 });

  // --list-models awaits the fixture factory but never starts a session or inference.
  const pending = exec("pi", ["--no-extensions", "-e", fixture, "--no-context-files", "--no-skills", "--list-models", "claude-native"], {
    cwd: root,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", NO_COLOR: "1" },
    timeout: 45000,
    maxBuffer: 2e6,
  });
  pending.child.stdin.end();
  const result = await pending;
  assert.doesNotMatch(result.stderr, /Extension error|Failed to load extension|AssertionError/);
  // Pi can report extension load failures without a failing exit code. Require a
  // report written only after every assertion in the actual TS factory passes.
  const report = JSON.parse(await readFile(join(root, "lifecycle-report.json"), "utf8"));
  assert.equal(report.success, true);
  assert.equal(report.phases.length, 7);
  for (const phase of report.phases) t.diagnostic(phase);
  const request = JSON.parse(JSON.parse(await readFile(discoveryReport, "utf8")).input.trim());
  assert.equal(request.type, "control_request");
  assert.deepEqual(request.request, { subtype: "initialize" });
});
