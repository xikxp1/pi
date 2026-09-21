import { test } from "node:test";
import assert from "node:assert/strict";
import { requestPayload } from "../protocol.mjs";

const tool = (name, description = name) => ({
  name,
  description,
  parameters: { type: "object", properties: {} },
});

function transcriptFixture(prompt = "Base instructions") {
  return {
    messages: [
      {
        role: "system",
        content: prompt,
        sections: { guidelines: "OLD GUIDELINES", removed: "REMOVED SECTION" },
        toolsAdded: [tool("old"), tool("probe", "OLD SCHEMA")],
        timestamp: 0,
      },
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "x", name: "probe", arguments: {} }],
      },
      {
        role: "system",
        content: [
          { type: "text", text: "Late instruction" },
          { type: "text", text: "Unicode 😀" },
        ],
        sections: {
          guidelines: "CURRENT GUIDELINES",
          removed: null,
          skills: "SKILLS",
        },
        toolsRemoved: [{ name: "old" }, { name: "probe" }],
        toolsAdded: [tool("probe", "CURRENT SCHEMA")],
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
}

test("normalized transcripts preserve current prompt sections, text and tools without mutation", () => {
  const input = transcriptFixture();
  const original = structuredClone(input);
  const payload = requestPayload(input);
  assert.equal(
    payload.systemPrompt,
    "Base instructions\n\nLate instruction\nUnicode 😀\n\nCURRENT GUIDELINES\n\nSKILLS",
  );
  assert.deepEqual(payload.tools, [tool("probe", "CURRENT SCHEMA")]);
  assert.deepEqual(
    payload.messages.map((m) => m.role),
    ["user", "assistant", "toolResult"],
  );
  assert.deepEqual(input, original);
  assert.deepEqual(requestPayload(payload), payload);
});

test("legacy prompts remain verbatim and hook-added system messages append instead of replacing", () => {
  const input = {
    systemPrompt: "  Legacy\n\n",
    tools: [tool("probe")],
    messages: [{ role: "user", content: "hi" }],
  };
  assert.deepEqual(requestPayload(input), input);
  input.messages.push({ role: "system", content: "Hook instructions" });
  const payload = requestPayload(input);
  assert.equal(payload.systemPrompt, "  Legacy\n\n\n\nHook instructions");
  assert.deepEqual(payload.tools, input.tools);
});

test("unsupported system content fails closed, not silently discarded or downgraded", () => {
  for (const content of [
    undefined,
    [{ type: "image", data: "abc" }],
    [{ type: "text", text: 123 }],
  ]) {
    assert.throws(
      () => requestPayload({ messages: [{ role: "system", content }] }),
      /Unsupported system message content/,
    );
  }
  assert.throws(
    () =>
      requestPayload({ messages: [], tools: [tool("probe"), tool("probe")] }),
    /Duplicate or empty tool name/,
  );
  assert.throws(
    () =>
      requestPayload({
        messages: [{ role: "system", content: "", sections: { bad: 123 } }],
      }),
    /Invalid system prompt section/,
  );
});
