import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  getAgentDir,
  getMarkdownTheme,
  parseFrontmatter,
} from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { installGoal } from "./controller.mjs";

export default function goalExtension(pi: ExtensionAPI) {
  pi.registerMessageRenderer(
    "pi-goal",
    (message) =>
      new Markdown(
        typeof message.content === "string" ? message.content : "",
        0,
        0,
        getMarkdownTheme(),
      ),
  );
  installGoal(pi, {
    agentDir: getAgentDir(),
    getSupportedThinkingLevels,
    parseFrontmatter,
    decorateTool(definition: ToolDefinition): ToolDefinition {
      return {
        ...definition,
        renderCall(_args, theme) {
          return new Text(
            theme.fg("toolTitle", theme.bold(definition.label)),
            0,
            0,
          );
        },
        renderResult(result, { expanded, isPartial }, theme, context) {
          const content = result.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n");
          if (expanded) return new Markdown(content, 0, 0, getMarkdownTheme());
          const summary = content
            .split("\n")
            .filter(Boolean)
            .slice(0, isPartial ? 3 : 2)
            .join("\n");
          return new Text(
            theme.fg(context.isError ? "error" : "muted", summary),
            0,
            0,
          );
        },
      };
    },
  });
}
