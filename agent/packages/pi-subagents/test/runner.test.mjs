import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import fs, { writeFileSync, existsSync } from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  childArguments,
  childEnvironment,
  childTools,
  JsonLines,
  MAX_TEXT,
  runSubagent,
  Transcript,
} from "../runner.mjs";
const fixture = fileURLToPath(new URL("./fake-pi.mjs", import.meta.url));

async function run(t, mode = "success", overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pi-subagent-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return runSubagent({
    invocation: { command: process.execPath, args: [fixture, mode] },
    args: [],
    task: "Inspect files",
    cwd: dir,
    env: process.env,
    outputDir: dir,
    killGraceMs: 50,
    ...overrides,
  });
}

test("tool policy and environment preserve filesystem capabilities without parent identity", () => {
  assert.deepEqual(
    childTools([
      "read",
      "subagent",
      "Agent",
      "ask_user",
      "ask_question",
      "AskUserQuestion",
      "read",
    ]),
    ["read"],
  );
  const env = childEnvironment(
    {
      PI_SESSION_ID: "parent",
      PI_SESSION_FILE: "/private",
      PI_MODEL: "parent-model",
      PI_ACP_FS_SOCKET: "/socket",
      PI_ACP_FS_CAPS: "read",
      PI_ACP_TERMINAL: "1",
      PI_ACP_SUBAGENTS: "1",
      API_KEY: "existing",
    },
    ["read", "Agent"],
  );
  assert.equal(env.PI_ACP_FS_SOCKET, "/socket");
  assert.equal(env.PI_ACP_FS_CAPS, "read");
  assert.equal(env.PI_ACP_TERMINAL, "0");
  assert.equal(env.PI_ACP_SUBAGENTS, "0");
  assert.equal(env.PI_SESSION_ID, undefined);
  assert.equal(env.PI_SESSION_FILE, undefined);
  assert.equal(env.PI_MODEL, undefined);
  assert.equal(env.API_KEY, "existing");
  assert.equal(env.PI_SUBAGENT_TOOLS, '["read"]');
});

test("child arguments propagate model/thinking/trust, with empty allowlist fail-closed", () => {
  const defaults = {
    model: "provider/model",
    thinking: "high",
    trusted: false,
    extension: "/extension.ts",
  };
  const args = childArguments({ ...defaults, tools: ["subagent", "ask_user"] });
  assert.ok(args.includes("--no-tools"));
  assert.ok(args.includes("--no-approve"));
  assert.equal(args[args.indexOf("--provider") + 1], "provider");
  assert.equal(args[args.indexOf("--model") + 1], "model");
  assert.ok(args.includes("high"));
  assert.ok(!args.includes("--approve"));
  const enabled = childArguments({
    ...defaults,
    trusted: true,
    tools: ["read", "bash"],
  });
  assert.ok(enabled.includes("read,bash"));
  assert.ok(enabled.includes("--approve"));
  const nested = childArguments({
    ...defaults,
    model: "provider/vendor/model",
    thinking: "off",
    tools: [],
  });
  assert.equal(nested[nested.indexOf("--model") + 1], "vendor/model");
  assert.equal(nested[nested.indexOf("--thinking") + 1], "off");
});

test("LF framing preserves Unicode separators, rejects oversized/malformed records", () => {
  const events = [];
  const decoder = new JsonLines((e) => events.push(e));
  const event = { text: "a\u2028b\u2029c\rd" };
  const json = JSON.stringify(event);
  decoder.push(json.slice(0, 8));
  decoder.push(json.slice(8));
  decoder.end();
  assert.deepEqual(events, [event]);
  assert.throws(() => new JsonLines(() => {}, 5).push("123456"), /size limit/);
  assert.throws(
    () => new JsonLines(() => {}, 5).push("123456\n"),
    /size limit/,
  );
  assert.throws(() => decoder.push("junk\n"), /Invalid JSON/);
});

test("transcript ignores prompts, thinking, duplicate history and tool messages", () => {
  const transcript = new Transcript();
  transcript.event({
    type: "message_end",
    message: { role: "user", content: "PRIVATE" },
  });
  transcript.event({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", delta: "PRIVATE" },
  });
  transcript.event({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Answer" },
        { type: "thinking", thinking: "PRIVATE" },
      ],
      stopReason: "stop",
    },
  });
  transcript.event({
    type: "agent_end",
    messages: [{ role: "assistant", content: "DUPLICATE" }],
  });
  transcript.event({
    type: "message_end",
    message: { role: "toolResult", content: "DUPLICATE" },
  });
  assert.equal(transcript.visible(), "Answer");
});

test("foreground result streams live text, finalizes once, preserves UTF-8 and records usage", async (t) => {
  const updates = [];
  const result = await run(t, "success", { onUpdate: (s) => updates.push(s) });
  assert.equal(result.status, "completed", result.error);
  assert.equal(result.toolUses, 1);
  assert.equal(result.usage.totalTokens, 30);
  assert.equal(result.result, "Done 🙂\u2028still one record\u2029end");
  assert.equal(updates[0].status, "pending");
  assert.ok(
    updates.some((s) => s.status === "in_progress" && s.text === "Live output"),
  );
  assert.equal(updates.at(-1).status, "completed");
  assert.equal(updates.filter((s) => s.status === "completed").length, 1);
  assert.equal(new Set(updates.map((s) => s.runId)).size, 1);
  const transcript = await readFile(result.outputFile, "utf8");
  assert.match(transcript, /File contents/);
  assert.doesNotMatch(transcript, /PRIVATE|�/);
  assert.equal(transcript.split("Live output").length, 2);
  if (process.platform !== "win32")
    assert.equal((await stat(result.outputFile)).mode & 0o777, 0o600);
});

test("bounded snapshots retain a complete visible output file", async (t) => {
  const result = await run(t, "large");
  assert.equal(result.status, "completed");
  assert.ok(result.text.length <= MAX_TEXT);
  assert.ok(result.result.length <= MAX_TEXT);
  assert.match(result.text, /truncated/);
  assert.match(result.result, /FINAL$/);
  assert.ok(
    (await readFile(result.outputFile, "utf8")).includes("🙂".repeat(80000)),
  );
});

test("task is passed literally over stdin, not as arguments", async (t) => {
  const result = await run(t, "inspect", {
    task: "/quit\n$(not-a-shell) --model other",
  });
  const captured = JSON.parse(result.result);
  assert.equal(
    captured.input,
    "Delegated task:\n\n/quit\n$(not-a-shell) --model other",
  );
  assert.deepEqual(captured.args, ["--session", result.sessionFile]);
});

for (const [mode, message] of [
  ["error", /Provider failed/],
  ["aborted", /Provider failed/],
  ["exit", /configuration broken/],
  ["silent", /no assistant response/],
  ["malformed", /Invalid JSON/],
]) {
  test(
    `reports ${mode} as failed even if process exits successfully`,
    { timeout: 5000 },
    async (t) => {
      const result = await run(t, mode);
      assert.equal(result.status, "failed");
      assert.match(result.error, message);
    },
  );
}

test("spawn failure finishes the ACP card", async (t) => {
  const updates = [];
  const result = await run(t, "success", {
    invocation: { command: "/nonexistent/pi" },
    onUpdate: (s) => updates.push(s),
  });
  assert.equal(result.status, "failed");
  assert.match(result.error, /Cannot launch/);
  assert.equal(updates.at(-1).status, "failed");
});

for (const failedWrite of [
  "pending",
  "in_progress",
  "completed",
  "failed",
  "output",
  "journal",
  "registration",
  "rename",
]) {
  test(
    `persistence failure at ${failedWrite} still terminates and publishes failure`,
    { timeout: 5000 },
    async (t) => {
      const events = [];
      const updates = [];
      const processes = [];
      const intervals = new Set();
      const write = fs.writeFileSync;
      const append = fs.appendFileSync;
      const rename = fs.renameSync;
      const spawn = childProcess.spawn;
      const interval = globalThis.setInterval;
      const clear = globalThis.clearInterval;
      let writesFailed = false;
      const fullDisk = () =>
        Object.assign(new Error("ENOSPC: no space left on device"), {
          code: "ENOSPC",
        });
      t.mock.method(fs, "writeFileSync", (path, content, ...args) => {
        if (String(path).endsWith("state.json.tmp")) {
          const state = JSON.parse(content);
          if (state.status === failedWrite) writesFailed = true;
          if (writesFailed) throw fullDisk();
        }
        return write(path, content, ...args);
      });
      t.mock.method(fs, "renameSync", (path, destination) => {
        if (
          failedWrite === "rename" &&
          JSON.parse(fs.readFileSync(path, "utf8")).status === "completed"
        ) {
          writesFailed = true;
          throw fullDisk();
        }
        return rename(path, destination);
      });
      t.mock.method(fs, "appendFileSync", (path, ...args) => {
        if (
          (failedWrite === "output" && String(path).endsWith("output.txt")) ||
          (failedWrite === "journal" && String(path).endsWith("events.jsonl"))
        ) {
          writesFailed = true;
          throw fullDisk();
        }
        return append(path, ...args);
      });
      t.mock.method(childProcess, "spawn", (...args) => {
        const process = spawn(...args);
        processes.push(process);
        return process;
      });
      t.mock.method(globalThis, "setInterval", (...args) => {
        const timer = interval(...args);
        intervals.add(timer);
        return timer;
      });
      t.mock.method(globalThis, "clearInterval", (timer) => {
        intervals.delete(timer);
        return clear(timer);
      });
      syncBuiltinESMExports();
      t.after(() => {
        t.mock.restoreAll();
        syncBuiltinESMExports();
      });
      const result = await run(
        t,
        failedWrite === "failed" ? "malformed" : "success",
        {
          onBridge: (event) => events.push(event),
          onUpdate: (update) => updates.push(update),
          onRegister() {
            if (failedWrite === "registration") {
              writesFailed = true;
              throw fullDisk();
            }
          },
        },
      );
      assert.equal(writesFailed, true);
      assert.equal(result.status, "failed");
      assert.match(result.error, /ENOSPC/);
      assert.match(result.text, /ENOSPC/);
      assert.equal(events[0].type, "register");
      assert.equal(events.at(-1).type, "status");
      assert.equal(events.at(-1).status, "failed");
      assert.match(events.at(-1).error, /ENOSPC/);
      assert.equal(
        events.filter(
          (event) =>
            event.type === "status" &&
            ["completed", "failed"].includes(event.status),
        ).length,
        1,
      );
      assert.equal(updates.at(-1).status, "failed");
      assert.equal(intervals.size, 0);
      assert.equal(
        processes.length,
        ["pending", "registration"].includes(failedWrite) ? 0 : 1,
      );
      for (const child of processes) {
        assert.ok(child.exitCode !== null || child.signalCode !== null);
        assert.equal(child.stdin.destroyed, true);
        assert.equal(child.stdout.destroyed, true);
        assert.equal(child.stderr.destroyed, true);
      }
      if (["completed", "rename"].includes(failedWrite)) {
        assert.match(result.result, /Done/);
        assert.match(result.text, /Done/);
        assert.match(await readFile(result.outputFile, "utf8"), /Done/);
      }
      if (failedWrite === "output") {
        assert.match(result.text, /Live output/);
        assert.ok(
          events.some(
            (event) =>
              event.type === "event" && event.event.type === "message_end",
          ),
        );
      }
      if (failedWrite === "journal")
        assert.ok(events.some((event) => event.type === "event"));
    },
  );
}

test("already-aborted requests do not spawn", async (t) => {
  await assert.rejects(
    run(t, "hang", { signal: AbortSignal.abort() }),
    /cancelled before launch/,
  );
});

test(
  "cancellation escalates for a child ignoring SIGTERM",
  { timeout: 5000 },
  async (t) => {
    const controller = new AbortController();
    const updates = [];
    const result = await run(t, "stubborn", {
      signal: controller.signal,
      onUpdate: (s) => {
        updates.push(s);
        if (s.text.includes("READY")) controller.abort();
      },
    });
    assert.equal(result.status, "failed");
    assert.match(result.error, /cancelled/);
    assert.equal(updates.at(-1).status, "failed");
  },
);

test("timeout terminates a hanging child", { timeout: 5000 }, async (t) => {
  const result = await run(t, "hang", { timeout: 0.1 });
  assert.equal(result.status, "failed");
  assert.match(result.error, /timed out/);
});

test("persistent child history, ordered structured journal and private control are registered before output", async (t) => {
  const events = [];
  let descriptor;
  const result = await run(t, "success", {
    parentToolCallId: "original-call",
    onRegister(value) {
      descriptor = value;
    },
    onBridge(event) {
      events.push(event);
    },
  });
  assert.equal(events[0].type, "register");
  assert.equal(events[0].parentToolCallId, "original-call");
  assert.equal(events.at(-1).status, "completed");
  assert.equal(descriptor.runId, result.runId);
  const header = JSON.parse(
    (await readFile(result.sessionFile, "utf8")).split("\n")[0],
  );
  assert.equal(header.type, "session");
  assert.equal(header.id, result.runId);
  assert.equal(header.piSubagent, true);
  const journal = (await readFile(result.eventsFile, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.deepEqual(
    journal,
    events.filter((event) => event.type === "event"),
  );
  assert.deepEqual(
    journal.map((event) => event.sequence),
    journal.map((_, index) => index),
  );
  assert.ok(journal.some((event) => event.event.type === "tool_execution_end"));
  assert.ok(!journal.some((event) => event.event.type === "agent_end"));
  assert.ok(!JSON.stringify(descriptor).includes("cancel-"));
  if (process.platform !== "win32")
    assert.equal((await stat(result.sessionFile)).mode & 0o777, 0o600);
});

test(
  "random cancellation capability stops only its owning child",
  { timeout: 5000 },
  async (t) => {
    let control;
    const [cancelled, completed] = await Promise.all([
      run(t, "stubborn", {
        onBridge(event) {
          if (event.type === "register") control = event.cancelFile;
        },
        onUpdate(snapshot) {
          if (snapshot.text.includes("READY") && !existsSync(control))
            writeFileSync(control, "", { mode: 0o600, flag: "wx" });
        },
      }),
      run(t, "success"),
    ]);
    assert.equal(cancelled.status, "failed");
    assert.match(cancelled.error, /cancelled/);
    assert.equal(completed.status, "completed");
  },
);

test("independent runs have unique cards and output files; broken UI cannot fail a child", async (t) => {
  const [a, b] = await Promise.all([
    run(t),
    run(t, "success", {
      onUpdate() {
        throw new Error("UI gone");
      },
    }),
  ]);
  assert.equal(a.status, "completed");
  assert.equal(b.status, "completed");
  assert.notEqual(a.runId, b.runId);
  assert.notEqual(a.outputFile, b.outputFile);
});
