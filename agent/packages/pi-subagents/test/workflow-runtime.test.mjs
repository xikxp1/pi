import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

for (const mode of ["workflow", "mentions"])
  test(
    `real Pi RPC: ${mode} delegation and ACP progress through completion`,
    { timeout: 30000 },
    async (t) => {
      const cwd = await mkdtemp(join(tmpdir(), "local-workflow-rpc-"));
      const agentDir = join(cwd, "agent");
      await mkdir(join(agentDir, "agents"), { recursive: true });
      await writeFile(
        join(agentDir, "agents/Probe.md"),
        "---\nname: Probe\ntools: read, extension_probe\nskills: false\npersist_session: false\noutput_transcript: false\n---\nPACKAGE_SKILL_HINT MEMORY_HINT\n",
      );
      await writeFile(join(cwd, "seed.txt"), "seed");
      await writeFile(
        join(agentDir, "settings.json"),
        JSON.stringify({
          extensions: [
            fileURLToPath(new URL("runtime-fixture.ts", import.meta.url)),
            fileURLToPath(new URL("../index.ts", import.meta.url)),
            fileURLToPath(
              new URL(
                "../../../extensions/pi-acp-subagents.ts",
                import.meta.url,
              ),
            ),
          ],
          defaultProvider: "local-runtime-test",
          defaultModel: "scripted",
          enableInstallTelemetry: false,
        }),
      );
      const child = spawn(
        process.env.PI_GOAL_TEST_PI ?? "pi",
        ["--mode", "rpc", "--no-session", "--no-skills", "--no-context-files"],
        {
          cwd,
          env: {
            ...process.env,
            PI_CODING_AGENT_DIR: agentDir,
            PI_OFFLINE: "1",
            PI_TELEMETRY: "0",
            PI_ACP_SUBAGENTS: "1",
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let stdout = "",
        stderr = "",
        seq = 0;
      const events = [],
        listeners = new Set();
      child.stderr.on("data", (b) => (stderr += b));
      child.stdout.on("data", (b) => {
        stdout += b;
        for (;;) {
          const at = stdout.indexOf("\n");
          if (at < 0) break;
          const line = stdout.slice(0, at);
          stdout = stdout.slice(at + 1);
          try {
            const event = JSON.parse(line);
            events.push(event);
            for (const fn of [...listeners]) fn(event);
          } catch {}
        }
      });
      t.after(async () => {
        if (child.exitCode === null) {
          child.kill("SIGTERM");
          await new Promise((resolve) => {
            const timer = setTimeout(() => {
              child.kill("SIGKILL");
              resolve();
            }, 2000);
            child.once("exit", () => {
              clearTimeout(timer);
              resolve();
            });
          });
        }
        await rm(cwd, { recursive: true, force: true });
      });
      const wait = (predicate) =>
        new Promise((resolve, reject) => {
          const found = events.find(predicate);
          if (found) return resolve(found);
          const timer = setTimeout(() => {
            listeners.delete(onEvent);
            reject(new Error(stderr + JSON.stringify(events.slice(-8))));
          }, 10000);
          const onEvent = (e) => {
            if (predicate(e)) {
              clearTimeout(timer);
              listeners.delete(onEvent);
              resolve(e);
            }
          };
          listeners.add(onEvent);
        });
      const send = (type, payload = {}) => {
        const id = String(++seq);
        child.stdin.write(JSON.stringify({ id, type, ...payload }) + "\n");
        return wait((e) => e.id === id);
      };
      assert.equal((await send("get_commands")).success, true);
      child.stdin.write(
        JSON.stringify({
          id: String(++seq),
          type: "prompt",
          message:
            mode === "workflow"
              ? "WORKFLOW_ROUNDTRIP"
              : "@Probe Read seed and probe",
        }) + "\n",
      );
      const status = (e) => {
        if (
          e.type !== "extension_ui_request" ||
          e.method !== "setStatus" ||
          e.statusKey !== "pi-acp:subagent"
        )
          return;
        try {
          return JSON.parse(e.statusText);
        } catch {}
      };
      const completed = await wait(
        (e) =>
          status(e)?.status === "completed" &&
          (mode !== "workflow" || status(e)?.agentId?.startsWith("wf_")),
      );
      assert.match(status(completed).text, /FIRST_DONE_EXTENSION_OK/);
      assert(
        events.some(
          (e) =>
            status(e)?.status === "in_progress" &&
            status(e)?.agentId === status(completed).agentId,
        ),
      );
      if (mode === "mentions") {
        child.stdin.write(
          JSON.stringify({
            id: String(++seq),
            type: "prompt",
            message: "@probe resume memory",
          }) + "\n",
        );
        const resumed = await wait(
          (e) =>
            status(e)?.status === "completed" &&
            status(e)?.agentId === status(completed).agentId &&
            status(e)?.runId !== status(completed).runId,
        );
        assert.match(status(resumed).text, /RESUMED_MEMORY_OK/);
      }
      assert.doesNotMatch(stderr, /Extension error|Failed to load/);
    },
  );
