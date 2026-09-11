import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  access,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { ROLES } from "../core.mjs";

const acp = process.env.PI_GOAL_TEST_ACP;
const root = fileURLToPath(new URL("../", import.meta.url));
const subagents =
  process.env.PI_GOAL_TEST_SUBAGENTS ??
  fileURLToPath(
    new URL(
      "../../../npm/node_modules/@tintinweb/pi-subagents/src/index.ts",
      import.meta.url,
    ),
  );
const bridge = fileURLToPath(
  new URL("../../../extensions/pi-acp-subagents.ts", import.meta.url),
);

for (const configured of [true, false])
  test(
    `real pi-acp without elicitation: ${configured ? "saved profiles" : "first-use profile selection"}, full workflow and subagent cards`,
    { skip: !acp, timeout: 90000 },
    async (t) => {
      const cwd = await mkdtemp(join(tmpdir(), "pi-goal-acp-"));
      const agentDir = join(cwd, "agent");
      await mkdir(agentDir);
      await writeFile(join(cwd, "seed.txt"), "preserve-me");
      await writeFile(
        join(agentDir, "settings.json"),
        JSON.stringify({
          defaultProvider: "goal-test",
          defaultModel: "scripted",
          defaultThinkingLevel: "medium",
          enableInstallTelemetry: false,
          extensions: [
            join(root, "test/faux-provider.ts"),
            subagents,
            bridge,
            join(root, "index.ts"),
          ],
        }),
      );
      if (configured)
        await writeFile(
          join(agentDir, "goal.json"),
          JSON.stringify({
            version: 1,
            profiles: Object.fromEntries(
              ROLES.map((role) => [
                role,
                {
                  model: "goal-test/scripted",
                  thinking: "medium",
                  maxTurns: 8,
                },
              ]),
            ),
          }),
        );
      await writeFile(
        join(agentDir, "subagents.json"),
        JSON.stringify({
          workflowsEnabled: false,
          schedulingEnabled: false,
          rememberAgents: false,
          outputTranscript: false,
          reportUsage: false,
        }),
      );
      const child = spawn(process.execPath, [acp], {
        cwd,
        env: {
          ...process.env,
          HOME: cwd,
          PI_CODING_AGENT_DIR: agentDir,
          PI_OFFLINE: "1",
          PI_TELEMETRY: "0",
          PI_ACP_SUBAGENTS: "1",
          PI_ACP_SESSION_MAP: join(cwd, "session-map.json"),
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let buffer = "",
        stderr = "",
        sequence = 0,
        exited = false;
      const responses = new Map(),
        updates = [],
        requests = [];
      const updateWaiters = new Set();
      child.stderr.setEncoding("utf8").on("data", (chunk) => {
        stderr += chunk;
      });
      child.stdout.setEncoding("utf8").on("data", (chunk) => {
        buffer += chunk;
        for (;;) {
          const end = buffer.indexOf("\n");
          if (end < 0) break;
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          let message;
          try {
            message = JSON.parse(line);
          } catch {
            continue;
          }
          if (message.method === "session/update") {
            updates.push(message.params.update);
            for (const waiter of [...updateWaiters])
              waiter(message.params.update);
          }
          if (message.method && message.id !== undefined) {
            requests.push(message);
            // Basic selection works through permissions; no freeform elicitation.
            const choice =
              message.method === "session/request_permission" &&
              message.params.options?.find(
                (option) =>
                  option.name.includes("goal-test/scripted") ||
                  option.name === "medium" ||
                  option.name === "Yes",
              );
            child.stdin.write(
              JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                ...(choice
                  ? {
                      result: {
                        outcome: {
                          outcome: "selected",
                          optionId: choice.optionId,
                        },
                      },
                    }
                  : {
                      error: {
                        code: -32601,
                        message: "Not supported by test client",
                      },
                    }),
              }) + "\n",
            );
          } else if (message.id !== undefined) {
            const pending = responses.get(message.id);
            if (pending) {
              clearTimeout(pending.timer);
              responses.delete(message.id);
              message.error
                ? pending.reject(new Error(JSON.stringify(message.error)))
                : pending.resolve(message.result);
            }
          }
        }
      });
      child.on("exit", () => {
        exited = true;
        for (const pending of responses.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error(`ACP exited: ${stderr}`));
        }
        responses.clear();
      });
      const send = (method, params) =>
        new Promise((resolve, reject) => {
          const id = ++sequence;
          const timer = setTimeout(() => {
            responses.delete(id);
            reject(
              new Error(
                `ACP ${method} timeout: ${stderr}\n${JSON.stringify(updates.slice(-8))}`,
              ),
            );
          }, 30000);
          responses.set(id, { resolve, reject, timer });
          child.stdin.write(
            JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
          );
        });
      const waitUpdate = (predicate) =>
        new Promise((resolve, reject) => {
          const existing = updates.find(predicate);
          if (existing) return resolve(existing);
          const timer = setTimeout(() => {
            updateWaiters.delete(listener);
            reject(
              new Error(
                `ACP update timeout: ${JSON.stringify(updates.slice(-8))}`,
              ),
            );
          }, 25000);
          const listener = (update) => {
            if (predicate(update)) {
              clearTimeout(timer);
              updateWaiters.delete(listener);
              resolve(update);
            }
          };
          updateWaiters.add(listener);
        });
      t.after(async () => {
        if (!exited) child.kill("SIGTERM");
        await new Promise((resolve) => {
          if (exited) return resolve();
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            resolve();
          }, 4000);
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
        await rm(cwd, { recursive: true, force: true });
      });
      await send("initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "pi-goal-test", version: "1" },
      });
      const session = await send("session/new", { cwd, mcpServers: [] });
      await waitUpdate(
        (update) =>
          update.sessionUpdate === "available_commands_update" &&
          update.availableCommands?.some((command) => command.name === "goal"),
      );
      await send("session/set_config_option", {
        sessionId: session.sessionId,
        configId: "model",
        value: "goal-test/scripted",
      });
      const prompt = (text) =>
        send("session/prompt", {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text }],
        });
      await prompt("/goal Add a greeting");
      await waitUpdate(
        (update) =>
          update.sessionUpdate === "agent_message_chunk" &&
          update.content?.text?.includes("Which greeting"),
      );
      assert(
        updates.some(
          (update) =>
            update.sessionUpdate === "agent_message_chunk" &&
            update.content?.text?.includes("Which greeting"),
        ),
      );
      await assert.rejects(access(join(cwd, "greeting.txt")), {
        code: "ENOENT",
      });
      await prompt(configured ? "/goal answer hello" : "hello");
      // Extension commands may acknowledge before their injected turn finishes.
      // Observe authoritative session updates, not the command acknowledgement.
      await waitUpdate(
        (update) =>
          update.sessionUpdate === "agent_message_chunk" &&
          update.content?.text?.includes("**Revision:"),
      );
      const published = updates
        .filter((update) => update.sessionUpdate === "agent_message_chunk")
        .map((update) => update.content?.text ?? "")
        .join("\n");
      const revision = /\*\*Revision: (\d+-[a-f0-9]{12})\*\*/.exec(
        published,
      )?.[1];
      assert(revision, JSON.stringify(updates.slice(-15), null, 2));
      await assert.rejects(access(join(cwd, "greeting.txt")), {
        code: "ENOENT",
      });
      await prompt(configured ? `/goal approve ${revision}` : "/goal approve");
      await waitUpdate(
        (update) =>
          update.sessionUpdate === "agent_message_chunk" &&
          update.content?.text?.includes("Goal completed."),
      );
      assert.equal(await readFile(join(cwd, "greeting.txt"), "utf8"), "hello");
      assert.equal(
        await readFile(join(cwd, "seed.txt"), "utf8"),
        "preserve-me",
      );
      assert(
        updates.some(
          (update) =>
            update.sessionUpdate === "agent_message_chunk" &&
            update.content?.text?.includes("Goal completed."),
        ),
      );
      assert(
        updates.some(
          (update) =>
            ["tool_call", "tool_call_update"].includes(update.sessionUpdate) &&
            JSON.stringify(update).includes("PiGoalImplementer"),
        ),
        "No ACP subagent card was emitted",
      );
      assert.equal(
        requests.length,
        configured ? 0 : 9,
        `Unexpected blocking client requests: ${JSON.stringify(requests)}`,
      );
      assert.doesNotMatch(stderr, /Failed to load extension|Extension error/);
    },
  );
