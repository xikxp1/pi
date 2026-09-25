import { appendFileSync } from "node:fs";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { emptyUsage } from "../runner.mjs";

// Deterministic, offline provider: exercises the real Pi agent loop in both parent
// and child without reading the user's credentials or making model requests.
export default function fixture(pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_user",
    label: "Forbidden test tool",
    description: "Must not run in children",
    parameters: Type.Object({}),
    async execute() {
      throw new Error("FORBIDDEN_TOOL_EXECUTED");
    },
  });
  for (const provider of ["subagent-test", "subagent-other"])
    pi.registerProvider(provider, {
      baseUrl: "http://invalid.test",
      apiKey: "test-only",
      api: "subagent-test",
      models: ["fixture", "alternate", "vendor/slashed", "plain"].map((id) => ({
        id,
        name: id,
        reasoning: id !== "plain",
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100000,
        maxTokens: 1000,
      })),
      streamSimple(model, context) {
        const stream = createAssistantMessageEventStream();
        const child = process.env.PI_SUBAGENT_CHILD === "1";
        const mode = process.env.PI_SUBAGENT_TEST_MODE;
        appendFileSync(
          process.env.PI_SUBAGENT_TEST_LOG!,
          JSON.stringify({
            child,
            tools: pi.getActiveTools(),
            messages: context.messages,
            model: model.id,
            provider: model.provider,
            terminal: process.env.PI_ACP_TERMINAL,
          }) + "\n",
        );
        const result = context.messages.findLast(
          (m) => m.role === "toolResult",
        );
        const message: AssistantMessage = {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: Date.now(),
          usage: { ...emptyUsage(), input: 10, output: 5, totalTokens: 15 },
          stopReason: "stop",
          content: [],
        };
        if (child && mode === "cancel") {
          message.content = [{ type: "text", text: "READY_TO_CANCEL" }];
          stream.push({ type: "start", partial: message });
          stream.push({
            type: "text_delta",
            contentIndex: 0,
            delta: "READY_TO_CANCEL",
            partial: message,
          });
          // The parent must terminate this subprocess, not wait for a model answer.
          setInterval(() => {}, 1000);
          return stream;
        }
        if (child && mode === "failure") {
          message.stopReason = "error";
          message.errorMessage = "DETERMINISTIC_CHILD_FAILURE";
          stream.push({ type: "error", reason: "error", error: message });
        } else {
          if (!result) {
            message.stopReason = "toolUse";
            message.content = [
              { type: "thinking", thinking: "PRIVATE_CHILD_THINKING" },
              {
                type: "toolCall",
                id: child ? "read-probe" : "delegate-probe",
                name: child
                  ? mode === "guard"
                    ? "ask_user"
                    : "read"
                  : "subagent",
                arguments: child
                  ? mode === "guard"
                    ? {}
                    : { path: "probe.txt" }
                  : {
                      task: "Read probe.txt using read and return its contents.",
                      description: "Read probe",
                      timeout: 15,
                      ...JSON.parse(
                        process.env.PI_SUBAGENT_TEST_OVERRIDES ?? "{}",
                      ),
                    },
              },
            ];
          } else {
            message.content = [
              {
                type: "text",
                text: child
                  ? result.content
                      .filter((c) => c.type === "text")
                      .map((c) => c.text)
                      .join("\n")
                  : "PARENT_FINISHED",
              },
            ];
          }
          if (!child && !result && (mode === "parallel" || mode === "mixed")) {
            message.content = Array.from(
              { length: mode === "mixed" ? 2 : 5 },
              (_, i) => ({
                type: "toolCall" as const,
                id: `parallel-${i}`,
                name: "subagent",
                arguments: {
                  task: "Read probe.txt.",
                  description: `Probe ${i}`,
                  timeout: 15,
                  ...(mode === "mixed"
                    ? {
                        model: i
                          ? "subagent-other/alternate"
                          : "subagent-test/fixture",
                        thinking: i ? "low" : "off",
                      }
                    : {}),
                },
              }),
            );
          }
          stream.push({
            type: "done",
            reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
            message,
          });
        }
        stream.end();
        return stream;
      },
    });
  pi.on("before_agent_start", (_event, ctx) => {
    appendFileSync(
      process.env.PI_SUBAGENT_TEST_LOG!,
      JSON.stringify({
        child: process.env.PI_SUBAGENT_CHILD === "1",
        thinking: ctx.thinkingLevel,
        trusted: ctx.isProjectTrusted(),
        cwd: ctx.cwd,
        pid: process.pid,
      }) + "\n",
    );
    // Simulate a later extension re-enabling a prohibited tool. The child-side
    // tool_call guard must still block its execution.
    if (
      process.env.PI_SUBAGENT_CHILD === "1" &&
      process.env.PI_SUBAGENT_TEST_MODE === "guard"
    )
      pi.setActiveTools([...pi.getActiveTools(), "ask_user"]);
  });
}
