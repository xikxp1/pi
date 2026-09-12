import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

test(
  "real Pi: extension tools, provider scope, package skills, memory and foreground resume",
  { timeout: 30000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "local-subagents-runtime-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const agentDir = join(dir, "agent");
    const skillPackage = join(agentDir, "skill-package");
    await mkdir(join(agentDir, "agents"), { recursive: true });
    await mkdir(join(skillPackage, "skills/probe-skill"), { recursive: true });
    await writeFile(
      join(skillPackage, "package.json"),
      JSON.stringify({ name: "probe-skills", pi: { skills: ["./skills"] } }),
    );
    await writeFile(
      join(skillPackage, "skills/probe-skill/SKILL.md"),
      "---\nname: probe-skill\ndescription: Integration skill\n---\nPACKAGE_SKILL_HINT\n",
    );
    await mkdir(join(dir, ".pi/agent-memory-local/Probe"), { recursive: true });
    await writeFile(
      join(dir, ".pi/agent-memory-local/Probe/MEMORY.md"),
      "MEMORY_HINT\n",
    );
    const entry = fileURLToPath(new URL("../index.ts", import.meta.url));
    const fixture = fileURLToPath(
      new URL("runtime-fixture.ts", import.meta.url),
    );
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({
        extensions: [fixture, entry],
        packages: [skillPackage],
        enabledModels: ["local-runtime-test/scripted"],
        defaultProvider: "local-runtime-test",
        defaultModel: "scripted",
        enableInstallTelemetry: false,
      }),
    );
    await writeFile(
      join(agentDir, "subagents.json"),
      JSON.stringify({
        rememberAgents: false,
        outputTranscript: false,
        scopeModels: true,
      }),
    );
    await writeFile(
      join(agentDir, "agents/Probe.md"),
      "---\nname: Probe\ntools: read, extension_probe\nextensions: true\nskills: [probe-skill]\nmemory: local\npersist_session: false\noutput_transcript: false\n---\nUse the requested tools then report the result.\n",
    );
    await writeFile(join(dir, "seed.txt"), "seed");
    const child = spawn(
      process.env.PI_GOAL_TEST_PI ?? "pi",
      [
        "--no-session",
        "--no-skills",
        "--no-context-files",
        "-p",
        "Run the delegation roundtrip",
      ],
      {
        cwd: dir,
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: agentDir,
          PI_OFFLINE: "1",
          PI_TELEMETRY: "0",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    t.after(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    });
    child.stdin.end();
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (b) => (stdout += b));
    child.stderr.on("data", (b) => (stderr += b));
    const code = await new Promise((resolve, reject) => {
      child.on("exit", resolve);
      child.on("error", reject);
    });
    assert.equal(code, 0, stderr + stdout);
    assert.match(stdout, /FIRST_DONE_EXTENSION_OK/, stderr + stdout);
    assert.match(stdout, /RESUMED_MEMORY_OK/, stderr + stdout);
    assert.doesNotMatch(stderr, /Extension error|Failed to load/);
  },
);
