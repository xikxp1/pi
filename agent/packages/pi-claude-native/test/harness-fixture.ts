import { appendFileSync } from "node:fs";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const log = (value: unknown) =>
    appendFileSync(
      process.env.PI_CLAUDE_TEST_LOG!,
      JSON.stringify(value) + "\n",
    );
  pi.registerTool({
    name: "integration_probe",
    label: "Integration Probe",
    description: "Return the integration passphrase. Call once.",
    promptSnippet: "PI_TOOL_SNIPPET_SENTINEL",
    promptGuidelines: [
      "For integration_probe, the key argument MUST be PI_GUIDELINE_SENTINEL.",
    ],
    parameters: Type.Object({ key: Type.String() }),
    async execute(_id, params) {
      if (params.key !== "PI_GUIDELINE_SENTINEL")
        throw new Error("Pi prompt guidelines were not followed");
      log({ execute: params.key });
      return { content: [{ type: "text", text: "BEFORE_RESULT_HOOK" }] };
    },
  });
  pi.on("before_agent_start", (event) => ({
    systemPrompt:
      event.systemPrompt +
      "\nPI_LATE_HOOK_SENTINEL: After calling integration_probe, reply exactly with its returned text.",
  }));
  pi.on("before_provider_request", (event, ctx) => {
    if (ctx.model?.provider !== "claude-native") return;
    const payload = event.payload as any;
    for (const s of [
      "PI_TOOL_SNIPPET_SENTINEL",
      "PI_GUIDELINE_SENTINEL",
      "PI_LATE_HOOK_SENTINEL",
    ]) {
      if (!payload.systemPrompt.includes(s))
        throw new Error(`Missing prompt section: ${s}`);
    }
    log({
      payload: true,
      messages: payload.messages.length,
      tools: payload.tools.map((t) => t.name),
    });
  });
  pi.on("tool_call", (event) => {
    if (event.toolName === "integration_probe") log({ tool_call: true });
  });
  pi.on("tool_result", (event) => {
    if (event.toolName === "integration_probe") {
      log({ tool_result: true });
      return { content: [{ type: "text", text: "HARNESS_PASSED_9247" }] };
    }
  });
}
