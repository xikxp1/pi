// Offline integration fixture. Never loaded by the package manifest.
import { appendFileSync } from "node:fs";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const faux = fauxProvider({
    provider: "goal-test",
    models: [{ id: "scripted", reasoning: true }],
    tokensPerSecond: 0,
  });
  const plan = {
    title: "Greeting fixture",
    summary: "Create greeting.txt after user approval.",
    acceptance: ["Greeting contains hello"],
    constraints: ["Preserve seed.txt"],
    risks: [],
    steps: [
      {
        title: "Create greeting",
        instructions: "Write hello to greeting.txt.",
        files: ["greeting.txt"],
      },
    ],
    checks: [
      {
        command: 'test "$(cat seed.txt)" = preserve-me',
        timeout: 5,
        afterStep: 0,
        repeatable: true,
      },
      {
        command: 'test "$(cat greeting.txt)" = hello',
        timeout: 5,
        afterStep: 1,
        repeatable: true,
      },
    ],
  };
  const respond = (context: any, options: any, _state: any, model: any) => {
    const role =
      /<active_agent name="(PiGoal\w+)"/.exec(context.systemPrompt)?.[1] ??
      "parent";
    const lastUserIndex = context.messages.findLastIndex(
      (m: any) => m.role === "user",
    );
    // Resumed workers retain earlier tool calls. Script this invocation only,
    // while logging retained history so the integration test proves real reuse.
    const invocationMessages =
      role === "PiGoalImplementer"
        ? context.messages.slice(lastUserIndex + 1)
        : context.messages;
    const tools = invocationMessages.filter(
      (m: any) => m.role === "toolResult",
    );
    const has = (name: string) => tools.some((m: any) => m.toolName === name);
    const last = context.messages.at(-1);
    const userText = context.messages
      .filter((m: any) => m.role === "user")
      .map((m: any) =>
        typeof m.content === "string"
          ? m.content
          : m.content
              .filter((c: any) => c.type === "text")
              .map((c: any) => c.text)
              .join("\n"),
      )
      .join("\n");
    if (process.env.PI_GOAL_TEST_LOG)
      appendFileSync(
        process.env.PI_GOAL_TEST_LOG,
        JSON.stringify({
          role,
          model: `${model.provider}/${model.id}`,
          reasoning: options?.reasoning,
          continuation: userText.includes(
            "Retained partial greeting needs completion",
          ),
          tools: context.tools?.map((t: any) => t.name),
          priorStructuredOutputs: context.messages
            .slice(0, lastUserIndex)
            .filter(
              (m: any) =>
                m.role === "toolResult" && m.toolName === "StructuredOutput",
            ).length,
        }) + "\n",
      );
    const call = (name: string, args: any) =>
      fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
    if (role === "PiGoalResearcher") {
      return has("read")
        ? fauxAssistantMessage(
            "Read seed.txt. Existing seed must remain unchanged. greeting.txt is a new file.",
          )
        : call("read", { path: "seed.txt" });
    }
    if (role === "PiGoalPlanner") {
      if (!has("read")) return call("read", { path: "seed.txt" });
      return has("StructuredOutput")
        ? fauxAssistantMessage("Plan recorded.")
        : call("StructuredOutput", plan);
    }
    if (role === "PiGoalImplementer") {
      const continuing = userText.includes(
        "Retained partial greeting needs completion",
      );
      if (!has("read"))
        return call("read", { path: continuing ? "greeting.txt" : "seed.txt" });
      if (!has("write"))
        return call("write", {
          path: "greeting.txt",
          content: continuing ? "hello" : "hel",
        });
      return has("StructuredOutput")
        ? fauxAssistantMessage("Implementation recorded.")
        : call("StructuredOutput", {
            status: continuing ? "completed" : "continue",
            summary: continuing
              ? "Completed greeting.txt."
              : "Retained partial greeting needs completion",
            files: ["greeting.txt"],
          });
    }
    if (role === "PiGoalReviewer") {
      if (!has("read")) return call("read", { path: "greeting.txt" });
      return has("StructuredOutput")
        ? fauxAssistantMessage("Review recorded.")
        : call("StructuredOutput", {
            verdict: "pass",
            summary: "Read the actual file and inspected the passing check.",
            issues: [],
            criteria: [
              {
                criterion: plan.acceptance[0],
                evidence:
                  "greeting.txt contains hello; the recorded test command exited 0.",
              },
            ],
          });
    }
    if (userText.includes("explicitly approved goal revision"))
      return call("goal_execute", {});
    if (
      userText.includes("user answered the pending goal question") ||
      /^hello$/m.test(userText)
    )
      return call("goal_plan", {});
    if (last?.role === "toolResult" && last.toolName === "goal_research")
      return call("goal_question", {
        question: "Which greeting should be created?",
        context:
          "The project has only seed.txt. This choice determines the new content.",
        options: ["hello", "hi"],
      });
    if (userText.includes("Start the goal interview"))
      return call("goal_research", {
        question: "Inspect the existing seed file.",
      });
    return fauxAssistantMessage("Waiting for an explicit goal command.");
  };
  faux.setResponses(Array.from({ length: 80 }, () => respond));
  pi.registerProvider(faux.provider);
}
