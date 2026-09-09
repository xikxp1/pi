import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = (...args) => {
  const pending = promisify(execFile)(...args);
  pending.child.stdin.end(); // pi print mode reads piped stdin until EOF.
  return pending;
};
const live = process.env.PI_CLAUDE_LIVE === "1";
const root = fileURLToPath(new URL("../", import.meta.url));
const provider = join(root, "index.ts");
const parentModel = process.env.PI_CLAUDE_TEST_MODEL ?? "claude-fable-5-1";

async function environment() {
  const dir = await mkdtemp(join(tmpdir(), "pi-native-integration-"));
  const agentDir = join(dir, "agent");
  await mkdir(agentDir);
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ packages: [root], enableInstallTelemetry: false }),
  );
  return {
    dir,
    agentDir,
    env: { ...process.env, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: agentDir },
  };
}
const base = [
  "--no-extensions",
  "-e",
  provider,
  "--no-context-files",
  "--no-skills",
  "--no-session",
  "--provider",
  "claude-native",
  "--model",
  parentModel,
  "--thinking",
  "low",
];

test(
  "live Pi: Fable 5.1, prompt snippets/guidelines/late hooks, Pi-owned execution and result hooks",
  { skip: !live, timeout: 120000 },
  async () => {
    const e = await environment();
    try {
      const log = join(e.dir, "events.jsonl");
      const r = await exec(
        "pi",
        [
          ...base,
          "-e",
          join(root, "test/harness-fixture.ts"),
          "--tools",
          "integration_probe",
          "-p",
          "Call integration_probe using the key specified in your guidelines, then report its result.",
        ],
        {
          cwd: e.dir,
          env: { ...e.env, PI_CLAUDE_TEST_LOG: log },
          timeout: 100000,
          maxBuffer: 2e6,
        },
      );
      assert.match(r.stdout, /HARNESS_PASSED_9247/);
      assert.doesNotMatch(r.stderr, /Extension error/);
      const events = (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map(JSON.parse);
      assert.equal(events.filter((e) => e.execute).length, 1);
      assert.equal(events.filter((e) => e.tool_call).length, 1);
      assert.equal(events.filter((e) => e.tool_result).length, 1);
      assert.equal(events.filter((e) => e.payload).length, 2);
    } finally {
      await rm(e.dir, { recursive: true, force: true });
    }
  },
);

test(
  "live Pi: existing pi-subagents executes a native Claude child with Pi read tool",
  { skip: !live, timeout: 150000 },
  async () => {
    const e = await environment();
    try {
      const agents = join(e.agentDir, "agents");
      await mkdir(agents);
      await writeFile(
        join(agents, "NativeProbe.md"),
        "---\nname: NativeProbe\ndescription: Read a test file\nmodel: claude-native/claude-haiku-4-5\ntools: read\nskills: false\npersist_session: false\noutput_transcript: false\nmax_turns: 3\n---\nRead the requested file using the Pi read tool and return its contents verbatim. Do not perform any other work.\n",
      );
      await writeFile(
        join(e.agentDir, "subagents.json"),
        JSON.stringify({
          rememberAgents: false,
          outputTranscript: false,
          workflowsEnabled: false,
          schedulingEnabled: false,
        }),
      );
      await writeFile(join(e.dir, "probe.txt"), "SUBAGENT_NATIVE_PASSED_6731");
      const subagents =
        process.env.PI_SUBAGENTS_EXTENSION ??
        fileURLToPath(
          new URL(
            "../../../npm/node_modules/@tintinweb/pi-subagents/src/index.ts",
            import.meta.url,
          ),
        );
      const r = await exec(
        "pi",
        [
          ...base,
          "-e",
          subagents,
          "--tools",
          "Agent",
          "-p",
          `Call the Agent tool exactly once using subagent_type NativeProbe, description "Read native test fixture", run_in_background false, and prompt "Read ${join(e.dir, "probe.txt")} using the read tool and return the contents verbatim." Then report the subagent's answer. Do not use any workflow.`,
        ],
        { cwd: e.dir, env: e.env, timeout: 130000, maxBuffer: 4e6 },
      );
      assert.match(r.stdout, /SUBAGENT_NATIVE_PASSED_6731/);
      assert.doesNotMatch(r.stderr, /Extension error|OAuth refresh failed/);
    } finally {
      await rm(e.dir, { recursive: true, force: true });
    }
  },
);
