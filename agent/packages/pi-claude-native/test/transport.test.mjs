import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runRequest,
  childEnvironment,
  commandArgs,
  resumeSessionAtSupport,
} from "../transport.mjs";
const executable = fileURLToPath(new URL("./fake-claude.mjs", import.meta.url));
await chmod(executable, 0o755);
const model = {
  id: "claude-fable-5-1",
  provider: "claude-native",
  api: "claude-native",
  maxTokens: 32000,
  thinkingLevelMap: { xhigh: "xhigh", max: "max" },
};
const context = (systemPrompt) => ({
  systemPrompt,
  messages: [{ role: "user", content: "hi" }],
  tools: [],
});
const config = {
  executable,
  killGraceMs: 25,
  idleTimeoutMs: 1000,
  requestTimeoutMs: 2000,
};
const text = (r) =>
  r.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

test("one terminal event, Unicode LF framing, mirror dedup and process cleanup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-native-test-"));
  try {
    const events = [];
    const out = await runRequest(
      model,
      context("fake:ok"),
      {},
      { ...config, tempRoot: dir },
      (e) => events.push(e),
    );
    assert.equal(out.stopReason, "stop", out.errorMessage);
    assert.equal(text(out), "héllo 😀\u2028world\u2029");
    assert.equal(out.usage.totalTokens, 18);
    assert.equal(
      events.filter((e) => ["done", "error"].includes(e.type)).length,
      1,
    );
    assert.equal(events[0].type, "start");
    assert.equal(events.at(-1).type, "done");
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("transport emits API-equivalent costs on partial and final messages", async () => {
  const priced = {
    ...model,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  };
  const costs = [];
  const out = await runRequest(priced, context("fake:ok"), {}, config, (e) => {
    const message = e.partial ?? e.message ?? e.error;
    costs.push({ type: e.type, cost: { ...message.usage.cost } });
  });
  assert.equal(out.stopReason, "stop", out.errorMessage);
  assert.equal(costs.find((e) => e.type === "text_start").cost.input, 0.00003);
  assert.deepEqual(costs.at(-1).cost, {
    input: 0.00003,
    output: 0.00012,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0.00003 + 0.00012,
  });
  assert.deepEqual(out.usage.cost, costs.at(-1).cost);
});

test("all failure paths terminate, errors normalize and abort stays abort", async () => {
  for (const mode of [
    "exit",
    "malformed",
    "error",
    "permissions",
    "unexpected-tool",
    "hang",
  ]) {
    const events = [];
    const out = await runRequest(
      model,
      context(`fake:${mode}`),
      {},
      { ...config, idleTimeoutMs: 100 },
      (e) => events.push(e),
    );
    assert.equal(out.stopReason, "error", mode);
    assert.equal(
      events.filter((e) => ["done", "error"].includes(e.type)).length,
      1,
    );
    if (mode === "error")
      assert.match(out.errorMessage, /context_length_exceeded/);
  }
  const pre = await runRequest(
    model,
    context("fake:hang"),
    { signal: AbortSignal.abort() },
    config,
  );
  assert.equal(pre.stopReason, "aborted");
  const out = await runRequest(
    model,
    context("fake:hang"),
    { signal: AbortSignal.timeout(80) },
    config,
  );
  assert.equal(out.stopReason, "aborted");
  const deadline = await runRequest(
    model,
    context("fake:hang"),
    {},
    { ...config, requestTimeoutMs: 80 },
  );
  assert.equal(deadline.stopReason, "error");
  assert.match(deadline.errorMessage, /deadline/);
  const missing = await runRequest(
    model,
    context("fake:ok"),
    {},
    { ...config, executable: "/no/such/claude" },
  );
  assert.equal(missing.stopReason, "error");
  const length = await runRequest(model, context("fake:length"), {}, config);
  assert.equal(length.stopReason, "length");
});

test("payload hook edits reach the transport, including tool-result replay", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-native-test-"));
  try {
    const dest = join(dir, "capture");
    const input = context("original");
    input.messages.push(
      {
        role: "assistant",
        provider: "other",
        model: "other",
        content: [{ type: "toolCall", id: "x", name: "probe", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "x",
        toolName: "probe",
        content: [{ type: "text", text: "PI_RESULT_123" }],
        isError: false,
      },
    );
    const out = await runRequest(
      model,
      input,
      {
        onPayload: (p) => ({
          ...p,
          systemPrompt: `fake:inspect\n${dest}\nPi snippets\nPi guidelines\nLATE_HOOK`,
        }),
      },
      config,
    );
    assert.equal(out.stopReason, "stop", out.errorMessage);
    const capture = JSON.parse(await readFile(dest, "utf8"));
    assert.match(capture.prompt, /Pi snippets\nPi guidelines\nLATE_HOOK/);
    assert.match(JSON.stringify(capture.history), /PI_RESULT_123/);
    assert.ok(
      capture.input.message.content.every((b) => b.type !== "tool_result"),
    );
    assert.notEqual(capture.cwd, process.cwd());
    assert.equal(capture.args[capture.args.indexOf("--tools") + 1], "");
    assert.equal(
      capture.args[capture.args.indexOf("--system-prompt-snapshot") + 1],
      "off",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("normalized Pi transcript reaches CLI with current instructions, tools and paired results", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-native-test-"));
  try {
    const dest = join(dir, "capture");
    const probe = {
      name: "probe",
      description: "CURRENT TOOL",
      parameters: { type: "object" },
    };
    const input = {
      messages: [
        {
          role: "system",
          content: `fake:inspect\n${dest}`,
          sections: { guidelines: "OLD", removed: "REMOVED" },
          timestamp: 0,
        },
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "x", name: "probe", arguments: {} },
          ],
        },
        {
          role: "system",
          content: "LATE",
          sections: { guidelines: "CURRENT", removed: null },
          toolsAdded: [probe],
          timestamp: 1,
        },
        {
          role: "toolResult",
          toolCallId: "x",
          toolName: "probe",
          content: "REAL RESULT",
        },
      ],
    };
    const original = structuredClone(input);
    const out = await runRequest(
      model,
      input,
      {
        onPayload(p) {
          assert.equal(
            p.systemPrompt,
            `fake:inspect\n${dest}\n\nLATE\n\nCURRENT`,
          );
          assert.deepEqual(p.tools, [probe]);
          assert.ok(p.messages.every((m) => m.role !== "system"));
        },
      },
      config,
    );
    assert.equal(out.stopReason, "stop", out.errorMessage);
    const capture = JSON.parse(await readFile(dest, "utf8"));
    assert.match(capture.prompt, /LATE\n\nCURRENT/);
    assert.match(capture.prompt, /probe: mcp__pi__/);
    assert.doesNotMatch(capture.prompt, /OLD|REMOVED/);
    assert.match(JSON.stringify(capture.history), /REAL RESULT/);
    assert.doesNotMatch(JSON.stringify(capture.history), /interrupted/);
    assert.deepEqual(input, original);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hook-injected system text is preserved for both mutation and replacement hooks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-native-test-"));
  try {
    for (const replace of [false, true]) {
      const dest = join(dir, `capture-${replace}`);
      const out = await runRequest(
        model,
        context(`fake:inspect\n${dest}\nBASE`),
        {
          onPayload(p) {
            const next = replace ? { ...p, messages: [...p.messages] } : p;
            next.messages.push({
              role: "system",
              content: [{ type: "text", text: "HOOK SYSTEM" }],
            });
            return replace ? next : undefined;
          },
        },
        config,
      );
      assert.equal(out.stopReason, "stop", out.errorMessage);
      const capture = JSON.parse(await readFile(dest, "utf8"));
      assert.equal(
        capture.prompt,
        `fake:inspect\n${dest}\nBASE\n\nHOOK SYSTEM`,
      );
      assert.deepEqual(capture.input.message, {
        role: "user",
        content: [{ type: "text", text: "hi" }],
      });
    }
    const cleared = await runRequest(
      model,
      {
        messages: [
          { role: "system", content: "fake:error", timestamp: 0 },
          { role: "user", content: "hi" },
        ],
      },
      { onPayload: (p) => ({ ...p, systemPrompt: "" }) },
      config,
    );
    assert.equal(cleared.stopReason, "stop", cleared.errorMessage);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cancellation also bounds a stuck request hook", async () => {
  const out = await runRequest(
    model,
    context("fake:ok"),
    { onPayload: () => new Promise(() => {}) },
    { ...config, requestTimeoutMs: 30 },
  );
  assert.equal(out.stopReason, "error");
  assert.match(out.errorMessage, /deadline/);
});

test("concurrent calls and child processes are isolated and terminated", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-native-test-"));
  try {
    const dest = join(dir, "pid");
    const [a, b] = await Promise.all([
      runRequest(model, context(`fake:grandchild\n${dest}`), {}, config),
      runRequest(
        model,
        context("fake:hang"),
        { signal: AbortSignal.timeout(100) },
        config,
      ),
    ]);
    assert.equal(a.stopReason, "stop");
    assert.equal(b.stopReason, "aborted");
    const pid = Number(await readFile(dest, "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const toolResultContext = (systemPrompt) => ({
  systemPrompt,
  tools: [{ name: "probe", description: "", parameters: { type: "object" } }],
  messages: [
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "x", name: "probe", arguments: {} }],
    },
    {
      role: "toolResult",
      toolCallId: "x",
      toolName: "probe",
      content: "ANSWER",
    },
  ],
});

// The support cache is keyed by executable, so each scenario needs its own path.
async function withFakeCli(dir, name, mode, run) {
  const path = join(dir, name);
  await symlink(executable, path);
  const before = process.env.FAKE_CLAUDE_RESUME_AT;
  const log = process.env.FAKE_CLAUDE_PROBE_LOG;
  process.env.FAKE_CLAUDE_RESUME_AT = mode;
  process.env.FAKE_CLAUDE_PROBE_LOG = join(dir, `${name}.probes`);
  try {
    return await run({ ...config, executable: path, tempRoot: dir });
  } finally {
    if (before === undefined) delete process.env.FAKE_CLAUDE_RESUME_AT;
    else process.env.FAKE_CLAUDE_RESUME_AT = before;
    if (log === undefined) delete process.env.FAKE_CLAUDE_PROBE_LOG;
    else process.env.FAKE_CLAUDE_PROBE_LOG = log;
  }
}
const probes = async (dir, name) =>
  (await readFile(join(dir, `${name}.probes`), "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean).length;

test("resumed history is truncated at Pi's last record, hiding CLI resume repair", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-native-test-"));
  try {
    await withFakeCli(dir, "supported", "supported", async (cli) => {
      for (const n of [1, 2]) {
        const dest = join(dir, `capture-${n}`);
        const out = await runRequest(
          model,
          toolResultContext(`fake:inspect\n${dest}`),
          {},
          cli,
        );
        assert.equal(out.stopReason, "stop", out.errorMessage);
        const capture = JSON.parse(await readFile(dest, "utf8"));
        const at = capture.args.indexOf("--resume-session-at");
        assert.ok(at > capture.args.indexOf("--resume"));
        assert.equal(capture.args[at + 1], capture.history.at(-1).uuid);
        assert.equal(
          capture.history.at(-1).message.content[0].type,
          "tool_result",
        );
      }
      // One probe per executable, shared by later requests.
      assert.equal(await probes(dir, "supported"), 1);
      // No history means no resume and no probe.
      const dest = join(dir, "capture-fresh");
      const fresh = await runRequest(
        model,
        context(`fake:inspect\n${dest}`),
        {},
        cli,
      );
      assert.equal(fresh.stopReason, "stop", fresh.errorMessage);
      const capture = JSON.parse(await readFile(dest, "utf8"));
      assert.ok(!capture.args.includes("--resume"));
      assert.ok(!capture.args.includes("--resume-session-at"));
    });
    assert.deepEqual(
      (await readdir(dir)).filter((name) => name.startsWith("pi-claude-")),
      [],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI without --resume-session-at falls back to a plain resume", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-native-test-"));
  try {
    await withFakeCli(dir, "older", "unsupported", async (cli) => {
      assert.equal(await resumeSessionAtSupport(cli), false);
      const dest = join(dir, "capture");
      const out = await runRequest(
        model,
        toolResultContext(`fake:inspect\n${dest}`),
        {},
        cli,
      );
      assert.equal(out.stopReason, "stop", out.errorMessage);
      const capture = JSON.parse(await readFile(dest, "utf8"));
      assert.ok(capture.args.includes("--resume"));
      assert.ok(!capture.args.includes("--resume-session-at"));
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a resume anchor the CLI dropped falls back to one plain resume", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-native-test-"));
  try {
    await withFakeCli(dir, "unanchored", "unanchored", async (cli) => {
      const dest = join(dir, "capture");
      const events = [];
      const out = await runRequest(
        model,
        toolResultContext(`fake:inspect\n${dest}`),
        {},
        cli,
        (e) => events.push(e),
      );
      assert.equal(out.stopReason, "stop", out.errorMessage);
      assert.equal(text(out), "héllo 😀\u2028world\u2029");
      assert.equal(
        events.filter((e) => ["done", "error"].includes(e.type)).length,
        1,
      );
      const capture = JSON.parse(await readFile(dest, "utf8"));
      assert.ok(capture.args.includes("--resume"));
      assert.ok(!capture.args.includes("--resume-session-at"));
      const log = await readFile(join(dir, "unanchored.probes"), "utf8");
      assert.equal(log.match(/anchored-request/g)?.length, 1);
    });
    assert.deepEqual(
      (await readdir(dir)).filter((name) => name.startsWith("pi-claude-")),
      [],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an inconclusive support check fails the request and is retried", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-native-test-"));
  try {
    await withFakeCli(dir, "broken", "ambiguous", async (cli) => {
      for (const n of [1, 2]) {
        const events = [];
        const out = await runRequest(
          model,
          toolResultContext("fake:ok"),
          {},
          cli,
          (e) => events.push(e),
        );
        assert.equal(out.stopReason, "error");
        assert.match(
          out.errorMessage,
          /Unable to verify .*--resume-session-at/,
        );
        assert.equal(events.at(-1).type, "error");
        assert.equal(await probes(dir, "broken"), n);
      }
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reasoning mapping, auth isolation, and no global environment mutations", () => {
  const before = { ...process.env };
  process.env.ANTHROPIC_API_KEY = "test-secret";
  process.env.CLAUDECODE = "nested";
  try {
    const env = childEnvironment({ reasoning: "off" });
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.CLAUDECODE, undefined);
    assert.equal(env.MAX_THINKING_TOKENS, "0");
    assert.equal(process.env.ANTHROPIC_API_KEY, "test-secret");
    for (const level of ["xhigh", "max"]) {
      const args = commandArgs({
        model,
        options: { reasoning: level },
        config: {},
        directory: "/tmp/request",
        hasHistory: false,
        hasTools: false,
      });
      assert.equal(args[args.indexOf("--effort") + 1], level);
    }
  } finally {
    for (const k of ["ANTHROPIC_API_KEY", "CLAUDECODE"]) {
      if (before[k] === undefined) delete process.env[k];
      else process.env[k] = before[k];
    }
  }
});
