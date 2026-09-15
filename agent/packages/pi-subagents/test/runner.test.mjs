import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
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
  assert.deepEqual(captured.args, []);
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
