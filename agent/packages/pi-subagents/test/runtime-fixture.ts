import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
export default function (pi: any) {
  const faux = fauxProvider({
    provider: "local-runtime-test",
    models: [{ id: "scripted", reasoning: true }],
    tokensPerSecond: 0,
  });
  const call = (name: string, args: any) =>
    fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
  const respond = (context: any) => {
    const messages = context.messages;
    const text = (m: any) =>
      typeof m?.content === "string"
        ? m.content
        : (m?.content ?? [])
            .filter((b: any) => b.type === "text")
            .map((b: any) => b.text)
            .join("\n");
    const user = [...messages].reverse().find((m: any) => m.role === "user");
    if (context.systemPrompt.includes("<active_agent")) {
      if (
        !context.systemPrompt.includes("PACKAGE_SKILL_HINT") ||
        !context.systemPrompt.includes("MEMORY_HINT")
      )
        return fauxAssistantMessage("MISSING_RESOURCES");
      if (text(user).includes("resume memory"))
        return fauxAssistantMessage(
          messages.some(
            (m: any) =>
              m.role === "toolResult" && m.toolName === "extension_probe",
          )
            ? "RESUMED_MEMORY_OK"
            : "LOST_MEMORY",
        );
      if (
        !messages.some(
          (m: any) => m.role === "toolResult" && m.toolName === "read",
        )
      )
        return call("read", { path: "seed.txt" });
      if (
        !messages.some(
          (m: any) =>
            m.role === "toolResult" && m.toolName === "extension_probe",
        )
      )
        return call("extension_probe", {});
      return fauxAssistantMessage("FIRST_DONE_EXTENSION_OK");
    }
    if (
      messages.some(
        (m: any) =>
          m.role === "toolResult" && m.toolName === "SubagentWorkflow",
      )
    )
      return fauxAssistantMessage("WORKFLOW_HANDLED");
    if (text(user).includes("WORKFLOW_ROUNDTRIP"))
      return call("SubagentWorkflow", {
        script:
          'export const meta = { name: "integration", description: "Read fixture" }; return await agent("Read seed and probe", {agentType:"Probe"});',
      });
    const previous = messages.filter(
      (m: any) => m.role === "toolResult" && m.toolName === "Agent",
    );
    if (!previous.length)
      return call("Agent", {
        subagent_type: "Probe",
        prompt: "Read seed then call extension_probe",
        description: "Probe child tools",
        run_in_background: false,
      });
    if (previous.length === 1) {
      const id = /Probe ([a-f0-9-]{36})/.exec(text(previous[0]))?.[1];
      if (!id) return fauxAssistantMessage(text(previous[0]));
      return call("Agent", {
        subagent_type: "Probe",
        prompt: "resume memory",
        description: "Check child history",
        run_in_background: false,
        resume: id,
      });
    }
    return fauxAssistantMessage(previous.map(text).join("\n"));
  };
  faux.setResponses(Array.from({ length: 40 }, () => respond));
  pi.registerProvider(faux.provider);
  pi.registerTool({
    name: "extension_probe",
    label: "Extension probe",
    description: "Offline extension-backed tool fixture",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: "EXTENSION_OK" }], details: {} };
    },
  });
}
