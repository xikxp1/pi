import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { JsonLines } from "../runner.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const fsExtension = fileURLToPath(
  new URL("../../../extensions/pi-acp-fs.ts", import.meta.url),
);

async function integration(
  t,
  mode = "success",
  rpc = true,
  overrides = {},
  native = false,
) {
  const dir = await realpath(
    await mkdtemp(join(tmpdir(), "pi-subagent-integration-")),
  );
  t.after(() => rm(dir, { recursive: true, force: true }));
  const agentDir = join(dir, "agent");
  await mkdir(agentDir);
  const log = join(dir, "fixture.jsonl");
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      packages: [root],
      extensions: [join(root, "test/provider-fixture.ts"), fsExtension],
      enableInstallTelemetry: false,
      retry: { enabled: false },
      compaction: { enabled: false },
    }),
  );
  await writeFile(join(dir, "probe.txt"), "DISK_CONTENTS_NOT_BUFFER");
  // A real local ACP filesystem transport returns an unsaved editor buffer.
  const socketPath = join(dir, "fs.sock");
  const requests = [];
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    const decoder = new JsonLines((message) => {
      requests.push(message);
      socket.write(
        JSON.stringify({ id: message.id, content: "UNSAVED_ZED_BUFFER" }) +
          "\n",
      );
    });
    socket.on("data", (chunk) => decoder.push(chunk));
  });
  server.listen(socketPath);
  await once(server, "listening");
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  const env = {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
    PI_SUBAGENT_TEST_LOG: log,
    PI_SUBAGENT_TEST_MODE: mode,
    PI_SUBAGENT_TEST_OVERRIDES: JSON.stringify(overrides),
    PI_ACP_SUBAGENTS: "1",
    PI_ACP_SUBAGENT_SESSIONS: native ? "1" : "0",
    PI_ACP_TERMINAL: "1",
    PI_ACP_FS_SOCKET: socketPath,
    PI_ACP_FS_CAPS: "read",
  };
  delete env.PI_SUBAGENT_CHILD;
  delete env.PI_SUBAGENT_TOOLS;
  const args = [
    "--mode",
    rpc ? "rpc" : "json",
    "--session",
    join(dir, "parent.jsonl"),
    "--no-context-files",
    "--no-skills",
    "--no-approve",
    "--model",
    "subagent-test/fixture",
    "--thinking",
    "high",
    "--tools",
    "read,subagent,ask_user",
  ];
  const child = spawn("pi", args, {
    cwd: dir,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const events = [];
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const closed = once(child, "close");
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await closed;
    }
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `Pi integration timed out\n${stderr}\n${JSON.stringify(events.slice(-3))}`,
        ),
      );
    }, 25000);
    let childControl;
    const decoder = new JsonLines((event) => {
      events.push(event);
      if (
        native &&
        event.type === "extension_ui_request" &&
        event.statusKey === "pi-acp:subagent-session"
      ) {
        const update = JSON.parse(event.statusText);
        if (update.type === "register") childControl = update.cancelFile;
        if (
          mode === "cancel" &&
          childControl &&
          update.event?.assistantMessageEvent?.delta === "READY_TO_CANCEL"
        ) {
          writeFileSync(childControl, "", { flag: "wx", mode: 0o600 });
          childControl = undefined;
        }
      }
      if (
        mode === "cancel" &&
        event.type === "extension_ui_request" &&
        event.statusKey === "pi-acp:subagent"
      ) {
        const snapshot = JSON.parse(event.statusText);
        if (
          snapshot.status === "in_progress" &&
          snapshot.text.includes("READY_TO_CANCEL")
        ) {
          child.stdin.write(JSON.stringify({ type: "abort" }) + "\n");
        }
      }
      if (rpc && event.type === "agent_settled") {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stdout.on("data", (chunk) => {
      try {
        decoder.push(chunk);
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (!rpc && code === 0) resolve();
      else reject(new Error(`Pi exited ${code}\n${stderr}`));
    });
    if (rpc)
      child.stdin.write(
        JSON.stringify({
          type: "prompt",
          message: "PRIVATE_PARENT_CONTEXT: delegate the probe.",
        }) + "\n",
      );
    else child.stdin.end("PRIVATE_PARENT_CONTEXT: delegate the probe.");
  });
  if (rpc) {
    child.kill("SIGTERM");
    await closed;
  }
  assert.doesNotMatch(stderr, /Failed to load extension|Extension error/);
  assert.ok(
    !events.some((e) => e.type === "extension_error"),
    JSON.stringify(events.filter((e) => e.type === "extension_error")),
  );
  const toolResult = events.find(
    (e) => e.type === "tool_execution_end" && e.toolName === "subagent",
  );
  assert.ok(toolResult, JSON.stringify(events));
  for (const event of events.filter(
    (e) => e.type === "tool_execution_end" && e.toolName === "subagent",
  )) {
    const outputFile = event.result.details?.outputFile;
    if (outputFile)
      t.after(() => rm(dirname(outputFile), { recursive: true, force: true }));
  }
  const snapshots = events
    .filter(
      (e) =>
        e.type === "extension_ui_request" && e.statusKey === "pi-acp:subagent",
    )
    .map((e) => JSON.parse(e.statusText));
  const metadata = (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  if (process.env.PI_SUBAGENT_TEST_SNAPSHOTS) {
    await writeFile(
      process.env.PI_SUBAGENT_TEST_SNAPSHOTS,
      JSON.stringify(snapshots),
    );
  }
  return { dir, events, toolResult, snapshots, metadata, requests };
}

for (const [name, overrides, provider, model, thinking] of [
  [
    "model only",
    { model: "subagent-test/alternate" },
    "subagent-test",
    "alternate",
    "high",
  ],
  ["thinking only", { thinking: "off" }, "subagent-test", "fixture", "off"],
  [
    "both across providers",
    { model: "subagent-other/alternate", thinking: "low" },
    "subagent-other",
    "alternate",
    "low",
  ],
  [
    "slashed model ID",
    { model: "subagent-other/vendor/slashed", thinking: "medium" },
    "subagent-other",
    "vendor/slashed",
    "medium",
  ],
  [
    "non-reasoning model clamps to off",
    { model: "subagent-other/plain", thinking: "high" },
    "subagent-other",
    "plain",
    "off",
  ],
]) {
  test(
    `real Pi RPC: per-call override - ${name}`,
    { timeout: 30000 },
    async (t) => {
      const { toolResult, metadata } = await integration(
        t,
        "success",
        true,
        overrides,
      );
      assert.equal(toolResult.isError, false, JSON.stringify(toolResult));
      assert.match(toolResult.result.content[0].text, /UNSAVED_ZED_BUFFER/);
      const children = metadata.filter((m) => m.child && m.messages);
      assert.ok(children.length >= 2);
      assert.ok(
        children.every((m) => m.model === model && m.provider === provider),
      );
      assert.ok(metadata.some((m) => m.child && m.thinking === thinking));
      // The parent's subsequent model request must still use its original model.
      const parents = metadata.filter((m) => !m.child && m.messages);
      assert.ok(parents.length >= 2);
      assert.ok(
        parents.every(
          (m) => m.model === "fixture" && m.provider === "subagent-test",
        ),
      );
    },
  );
}

for (const overrides of [
  { model: "subagent-test/does-not-exist" },
  { model: "fixture" },
  { model: "subagent-test/fixt" },
  { model: "subagent-test/fixture:low" },
  { model: " " },
  { thinking: "invalid" },
]) {
  test(
    `real Pi RPC: rejects invalid override ${JSON.stringify(overrides)} without spawning`,
    { timeout: 30000 },
    async (t) => {
      const { toolResult, snapshots, metadata } = await integration(
        t,
        "success",
        true,
        overrides,
      );
      assert.equal(toolResult.isError, true);
      assert.deepEqual(snapshots, []);
      assert.ok(!metadata.some((m) => m.child));
    },
  );
}

test(
  "real Pi RPC: parallel children use independent model and thinking overrides",
  { timeout: 30000 },
  async (t) => {
    const { events, metadata } = await integration(t, "mixed");
    const results = events.filter(
      (e) => e.type === "tool_execution_end" && e.toolName === "subagent",
    );
    assert.equal(results.length, 2);
    assert.ok(results.every((e) => !e.isError));
    assert.ok(
      metadata.some(
        (m) =>
          m.child && m.provider === "subagent-test" && m.model === "fixture",
      ),
    );
    assert.ok(
      metadata.some(
        (m) =>
          m.child && m.provider === "subagent-other" && m.model === "alternate",
      ),
    );
    assert.deepEqual(
      metadata
        .filter((m) => m.child && m.thinking)
        .map((m) => m.thinking)
        .sort(),
      ["low", "off"],
    );
  },
);

test(
  "real Pi RPC: child reads unsaved ACP buffer, isolated context, inherited model/thinking/trust and live cards",
  { timeout: 30000 },
  async (t) => {
    const { dir, toolResult, snapshots, metadata, requests } =
      await integration(t);
    assert.equal(toolResult.isError, false, JSON.stringify(toolResult));
    assert.match(toolResult.result.content[0].text, /UNSAVED_ZED_BUFFER/);
    assert.equal(toolResult.result.usage.totalTokens, 30);
    assert.equal(toolResult.result.details.toolUses, 1);
    assert.equal(snapshots[0].status, "pending");
    assert.equal(snapshots.at(-1).status, "completed");
    assert.equal(new Set(snapshots.map((s) => s.runId)).size, 1);
    for (const s of snapshots) {
      assert.equal(s.version, 1);
      assert.equal(s.title, "Subagent: Read probe");
      assert.ok(s.text.length <= 65536);
      assert.doesNotMatch(
        s.text,
        /PRIVATE_PARENT_CONTEXT|PRIVATE_CHILD_THINKING/,
      );
    }
    assert.ok(
      requests.some(
        (r) => r.op === "readTextFile" && r.path === join(dir, "probe.txt"),
      ),
    );
    const childRequests = metadata.filter((m) => m.child && m.messages);
    assert.ok(childRequests.length >= 2);
    assert.deepEqual(childRequests[0].tools, ["read"]);
    assert.equal(childRequests[0].terminal, "0");
    assert.equal(childRequests[0].model, "fixture");
    assert.doesNotMatch(
      JSON.stringify(childRequests),
      /PRIVATE_PARENT_CONTEXT/,
    );
    assert.ok(
      metadata.some(
        (m) =>
          m.child &&
          m.thinking === "high" &&
          m.trusted === false &&
          m.cwd === dir,
      ),
    );
  },
);

test(
  "real Pi RPC: failed child marks both tool result and ACP card failed, retaining usage",
  { timeout: 30000 },
  async (t) => {
    const { toolResult, snapshots } = await integration(t, "failure");
    assert.equal(toolResult.isError, true);
    assert.equal(toolResult.result.details.status, "failed");
    assert.match(
      toolResult.result.content[0].text,
      /DETERMINISTIC_CHILD_FAILURE/,
    );
    assert.equal(snapshots.at(-1).status, "failed");
    assert.equal(toolResult.result.usage.totalTokens, 15);
  },
);

test(
  "real Pi: forbidden tools stay unavailable despite another extension attempting to enable them",
  { timeout: 30000 },
  async (t) => {
    const { toolResult } = await integration(t, "guard");
    assert.match(
      toolResult.result.content[0].text,
      /disabled in this subagent|Tool ask_user not found/,
    );
    assert.doesNotMatch(
      toolResult.result.content[0].text,
      /FORBIDDEN_TOOL_EXECUTED/,
    );
  },
);

test(
  "real Pi JSON: ordinary headless mode works without ACP UI requests",
  { timeout: 30000 },
  async (t) => {
    const { toolResult, snapshots } = await integration(t, "success", false);
    assert.equal(toolResult.isError, false);
    assert.match(toolResult.result.content[0].text, /UNSAVED_ZED_BUFFER/);
    assert.deepEqual(snapshots, []);
  },
);

test(
  "real Pi RPC: four concurrent children have independent cards and the fifth is rejected",
  { timeout: 30000 },
  async (t) => {
    const { events, snapshots } = await integration(t, "parallel");
    const results = events.filter(
      (e) => e.type === "tool_execution_end" && e.toolName === "subagent",
    );
    assert.equal(results.length, 5);
    assert.equal(results.filter((e) => !e.isError).length, 4);
    assert.match(
      results.find((e) => e.isError).result.content[0].text,
      /At most 4/,
    );
    assert.equal(new Set(snapshots.map((s) => s.runId)).size, 4);
    assert.equal(snapshots.filter((s) => s.status === "completed").length, 4);
  },
);

test(
  "real Pi RPC: negotiated children persist real histories and parent links with exact structured events",
  { timeout: 30000 },
  async (t) => {
    const { dir, events, snapshots, toolResult } = await integration(
      t,
      "success",
      true,
      {},
      true,
    );
    assert.equal(toolResult.isError, false);
    assert.deepEqual(snapshots, []);
    const native = events
      .filter(
        (event) =>
          event.type === "extension_ui_request" &&
          event.statusKey === "pi-acp:subagent-session",
      )
      .map((event) => JSON.parse(event.statusText));
    const registered = native[0];
    assert.equal(registered.type, "register");
    assert.equal(registered.parentToolCallId, "delegate-probe");
    assert.equal(native.at(-1).status, "completed");
    const history = (await readFile(registered.sessionFile, "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(history[0].id, registered.runId);
    assert.equal(history[0].piSubagent, true);
    assert.ok(history.some((entry) => entry.message?.role === "user"));
    assert.ok(history.some((entry) => entry.message?.role === "assistant"));
    assert.ok(
      history.some(
        (entry) =>
          entry.message?.role === "toolResult" &&
          entry.message.toolCallId === "read-probe",
      ),
    );
    assert.doesNotMatch(JSON.stringify(history), /PRIVATE_PARENT_CONTEXT/);
    const journal = (await readFile(registered.eventsFile, "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.deepEqual(
      native.filter((event) => event.type === "event"),
      journal,
    );
    const parent = (await readFile(join(dir, "parent.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.ok(
      parent.some(
        (entry) =>
          entry.customType === "pi-subagent-session" &&
          entry.data.runId === registered.runId,
      ),
    );
    assert.equal(
      toolResult.result.details.subagentSession.runId,
      registered.runId,
    );
  },
);

test(
  "real Pi RPC: child-only cancellation leaves the parent running to completion",
  { timeout: 30000 },
  async (t) => {
    const { events, toolResult } = await integration(
      t,
      "cancel",
      true,
      {},
      true,
    );
    assert.equal(toolResult.isError, true);
    assert.match(toolResult.result.content[0].text, /cancelled/);
    assert.ok(
      events.some(
        (event) =>
          event.type === "message_end" &&
          event.message?.role === "assistant" &&
          event.message.content.some(
            (block) => block.text === "PARENT_FINISHED",
          ),
      ),
    );
    const native = events
      .filter((event) => event.statusKey === "pi-acp:subagent-session")
      .map((event) => JSON.parse(event.statusText));
    assert.equal(native.at(-1).status, "failed");
  },
);

test(
  "real Pi RPC: parent abort stops the child and finalizes its card",
  { timeout: 30000 },
  async (t) => {
    const { snapshots, metadata } = await integration(t, "cancel");
    assert.equal(snapshots.at(-1).status, "failed");
    assert.match(snapshots.at(-1).text, /cancelled/);
    const child = metadata.find((m) => m.child && m.pid);
    assert.ok(child);
    assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
  },
);
