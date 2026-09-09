import { test } from "node:test";
import assert from "node:assert/strict";
import { runRequest } from "../transport.mjs";

const live = process.env.PI_CLAUDE_LIVE === "1";
const model = {
  id: process.env.PI_CLAUDE_TEST_MODEL ?? "claude-haiku-4-5",
  provider: "claude-native",
  api: "claude-native",
  maxTokens: 32000,
};
const user = (content) => ({ role: "user", content, timestamp: Date.now() });
const text = (m) =>
  m.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
const tool = {
  name: "probe",
  description: "Get a test secret. Must be called to answer the question.",
  parameters: {
    type: "object",
    properties: { key: { type: "string" } },
    required: ["key"],
    additionalProperties: false,
  },
};
const check = (m) => assert.notEqual(m.stopReason, "error", m.errorMessage);

test(
  "live: complete Pi prompt, native history, tool result replay and concurrency",
  { skip: !live, timeout: 180000 },
  async () => {
    const first = await runRequest(
      model,
      {
        systemPrompt:
          "PI_GUIDELINE: Call probe with key violet-7319. Do not answer without calling it. Only use the tools provided by Pi.",
        tools: [tool],
        messages: [user("Get the secret now.")],
      },
      { reasoning: "off" },
    );
    check(first);
    assert.equal(first.stopReason, "toolUse");
    const call = first.content.find((b) => b.type === "toolCall");
    assert.equal(call.name, "probe");
    assert.equal(call.arguments.key, "violet-7319");
    // This is Pi's execution result, NOT a Claude/MCP execution result.
    const history = [
      user("Get the secret now."),
      first,
      {
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text: "secret=marigold-8426" }],
        isError: false,
        timestamp: Date.now(),
      },
    ];
    const [a, b] = await Promise.all([
      runRequest(
        model,
        {
          systemPrompt:
            "NEW_PI_GUIDELINE: Your reply must start with VERIFIED: and contain the secret from the tool result. Do not call tools.",
          tools: [tool],
          messages: history,
        },
        { reasoning: "off" },
      ),
      runRequest(
        model,
        {
          systemPrompt:
            "You MUST reply exactly ISOLATED:kiwi-6392. No other words.",
          tools: [],
          messages: [user("What is 2+2?")],
        },
        { reasoning: "off" },
      ),
    ]);
    check(a);
    check(b);
    assert.match(text(a), /VERIFIED:.*marigold-8426/s);
    assert.match(text(b), /ISOLATED:kiwi-6392/);
    assert.doesNotMatch(text(b), /marigold|violet/);
    // History rewrite/branch: no prior secret should leak into this request.
    const branch = await runRequest(
      model,
      {
        systemPrompt:
          "You MUST reply exactly BRANCH:pear-1256. No other words.",
        tools: [],
        messages: [user("What is 2+2?")],
      },
      { reasoning: "off" },
    );
    check(branch);
    assert.match(text(branch), /BRANCH:pear-1256/);
  },
);
