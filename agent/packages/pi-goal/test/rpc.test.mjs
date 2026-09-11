import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdtemp,
  writeFile,
  mkdir,
  readFile,
  rm,
  access,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { ROLES } from "../core.mjs";

const piCommand = process.env.PI_GOAL_TEST_PI ?? "pi";
const hasPi =
  spawnSync(piCommand, ["--version"], { stdio: "ignore" }).status === 0;
const root = fileURLToPath(new URL("../", import.meta.url));
const subagents =
  process.env.PI_GOAL_TEST_SUBAGENTS ??
  fileURLToPath(
    new URL(
      "../../../npm/node_modules/@tintinweb/pi-subagents/src/index.ts",
      import.meta.url,
    ),
  );
let hasSubagents = true;
try {
  await access(subagents);
} catch {
  hasSubagents = false;
}

test(
  "real Pi RPC + installed subagents: offline interview, approval, scoped child tools, checks and review",
  { skip: !hasPi || !hasSubagents, timeout: 90000 },
  async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-goal-rpc-"));
    const agentDir = join(cwd, "agent");
    await mkdir(agentDir);
    const log = join(cwd, "provider.jsonl");
    await writeFile(join(cwd, "seed.txt"), "preserve-me");
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({
        defaultProvider: "goal-test",
        defaultModel: "scripted",
        defaultThinkingLevel: "medium",
        enableInstallTelemetry: false,
        packages: [root],
      }),
    );
    await writeFile(
      join(agentDir, "goal.json"),
      JSON.stringify({
        version: 1,
        profiles: Object.fromEntries(
          ROLES.map((role) => [
            role,
            { model: "goal-test/scripted", thinking: "medium", maxTurns: 8 },
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
    const child = spawn(
      piCommand,
      [
        "--mode",
        "rpc",
        "--no-session",
        "--no-skills",
        "--no-context-files",
        "-e",
        join(root, "test/faux-provider.ts"),
        "-e",
        subagents,
      ],
      {
        cwd,
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: agentDir,
          PI_OFFLINE: "1",
          PI_TELEMETRY: "0",
          PI_GOAL_TEST_LOG: log,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stderr = "",
      buffer = "",
      exited = false;
    child.stderr.setEncoding("utf8").on("data", (part) => {
      stderr += part;
    });
    child.stdout.setEncoding("utf8");
    const events = [],
      waiters = new Set();
    const flush = (event) => {
      events.push(event);
      for (const waiter of [...waiters]) waiter(event);
    };
    child.stdout.on("data", (part) => {
      buffer += part;
      for (;;) {
        const end = buffer.indexOf("\n");
        if (end < 0) break;
        const line = buffer.slice(0, end).replace(/\r$/, "");
        buffer = buffer.slice(end + 1);
        try {
          flush(JSON.parse(line));
        } catch {
          /* non-protocol diagnostics are inspected through stderr */
        }
      }
    });
    child.on("error", (error) =>
      flush({ type: "child_error", error: error.message }),
    );
    child.on("exit", (code) => {
      exited = true;
      flush({ type: "child_exit", code });
    });
    const wait = (predicate, start = 0, timeout = 25000) =>
      new Promise((resolve, reject) => {
        const existing = events.slice(start).find(predicate);
        if (existing) return resolve(existing);
        const timer = setTimeout(() => {
          waiters.delete(listener);
          reject(
            new Error(
              `RPC timeout. stderr: ${stderr}\nRecent events: ${JSON.stringify(events.slice(-8))}`,
            ),
          );
        }, timeout);
        const listener = (event) => {
          if (predicate(event)) {
            clearTimeout(timer);
            waiters.delete(listener);
            resolve(event);
          } else if (
            event.type === "child_error" ||
            event.type === "child_exit"
          ) {
            clearTimeout(timer);
            waiters.delete(listener);
            reject(new Error(`Pi exited: ${JSON.stringify(event)}\n${stderr}`));
          }
        };
        waiters.add(listener);
      });
    let id = 0;
    const send = async (command, predicate) => {
      const start = events.length;
      const requestId = `request-${++id}`;
      child.stdin.write(JSON.stringify({ id: requestId, ...command }) + "\n");
      const response = await wait(
        (event) => event.type === "response" && event.id === requestId,
        start,
      );
      assert.equal(response.success, true, response.error);
      if (predicate) return wait(predicate, start);
      return response;
    };
    const text = (event) =>
      event.result?.content
        ?.filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n") ?? "";
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
    const commands = await send({ type: "get_commands" });
    assert(commands.data.commands.some((command) => command.name === "goal"));
    await send({
      type: "set_model",
      provider: "goal-test",
      modelId: "scripted",
    });
    await send(
      { type: "prompt", message: "/goal Add a greeting" },
      (event) =>
        event.type === "tool_execution_end" &&
        event.toolName === "goal_question",
    );
    assert(
      events.some(
        (event) =>
          event.type === "extension_ui_request" &&
          event.method === "notify" &&
          event.message?.includes("Which greeting"),
      ),
    );
    assert(
      !events.some(
        (event) =>
          event.type === "extension_ui_request" &&
          ["input", "editor", "custom"].includes(event.method),
      ),
    );
    await assert.rejects(access(join(cwd, "greeting.txt")), { code: "ENOENT" });
    const proposed = await send(
      { type: "prompt", message: "/goal answer hello" },
      (event) =>
        event.type === "tool_execution_end" && event.toolName === "goal_plan",
    );
    assert.equal(proposed.isError, false, text(proposed));
    const revision = proposed.result.details.revision;
    assert.match(revision, /^1-[a-f0-9]{12}$/);
    await assert.rejects(access(join(cwd, "greeting.txt")), { code: "ENOENT" });
    await send({ type: "prompt", message: "/goal approve stale" });
    await assert.rejects(access(join(cwd, "greeting.txt")), { code: "ENOENT" });
    const executed = await send(
      { type: "prompt", message: `/goal approve ${revision}` },
      (event) =>
        event.type === "tool_execution_end" &&
        event.toolName === "goal_execute",
    );
    assert.equal(executed.isError, false, text(executed));
    assert.equal(executed.result.details.phase, "completed", text(executed));
    assert.equal(await readFile(join(cwd, "greeting.txt"), "utf8"), "hello");
    assert.equal(await readFile(join(cwd, "seed.txt"), "utf8"), "preserve-me");
    const calls = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert(
      calls.some(
        (call) => call.role === "PiGoalImplementer" && !call.continuation,
      ),
    );
    assert(
      calls.some(
        (call) => call.role === "PiGoalImplementer" && call.continuation,
      ),
      "Partial implementation did not continue under the same approval",
    );
    assert.match(text(proposed), /before implementation/);
    assert.match(text(proposed), /automatic reruns authorized/);
    for (const role of [
      "PiGoalResearcher",
      "PiGoalPlanner",
      "PiGoalImplementer",
      "PiGoalReviewer",
    ]) {
      const entries = calls.filter((call) => call.role === role);
      assert(entries.length > 0, `Missing ${role} calls`);
      assert(
        entries.every(
          (call) =>
            call.model === "goal-test/scripted" && call.reasoning === "medium",
        ),
        JSON.stringify(entries),
      );
      assert(
        entries.every(
          (call) =>
            !call.tools.includes("bash") &&
            !call.tools.includes("Agent") &&
            !call.tools.includes("goal_execute"),
        ),
      );
      if (role !== "PiGoalImplementer")
        assert(
          entries.every(
            (call) =>
              !call.tools.includes("edit") && !call.tools.includes("write"),
          ),
        );
    }
    assert(
      !events.some((event) => event.type === "extension_error"),
      JSON.stringify(
        events.filter((event) => event.type === "extension_error"),
      ),
    );
    assert.doesNotMatch(stderr, /Failed to load extension|Extension error/);
  },
);
