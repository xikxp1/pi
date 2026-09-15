import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getPackageDir,
  truncateTail,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  bounded,
  childArguments,
  childEnvironment,
  childTools,
  runSubagent,
} from "./runner.mjs";

const MAX_CONCURRENT = 4;

function piInvocation() {
  // Never re-execute process.argv[1]: SDK hosts and ACP adapters are not Pi CLIs.
  const cli = join(getPackageDir(), "dist", "cli.js");
  if (existsSync(cli)) return { command: process.execPath, args: [cli] };
  if (!/^(node|bun)(\.exe)?$/i.test(basename(process.execPath)))
    return { command: process.execPath, args: [] };
  return { command: "pi", args: [] };
}

export default function subagents(pi: ExtensionAPI) {
  if (process.env.PI_SUBAGENT_CHILD === "1") {
    let allowed = new Set<string>();
    try {
      const names: unknown = JSON.parse(process.env.PI_SUBAGENT_TOOLS ?? "[]");
      if (
        Array.isArray(names) &&
        names.every((name) => typeof name === "string")
      )
        allowed = new Set(childTools(names));
    } catch {
      /* Fail closed if the parent policy is malformed. */
    }
    pi.on("session_start", () =>
      pi.setActiveTools(
        pi.getActiveTools().filter((name) => allowed.has(name)),
      ),
    );
    pi.on("tool_call", (event) => {
      if (!allowed.has(event.toolName))
        return {
          block: true,
          reason: `Tool ${event.toolName} is disabled in this subagent.`,
        };
    });
    return;
  }

  const active = new Set<{
    controller: AbortController;
    done: Promise<unknown>;
  }>();
  let closing = false;
  pi.on("session_shutdown", async () => {
    closing = true;
    for (const run of active) run.controller.abort();
    await Promise.allSettled([...active].map((run) => run.done));
  });
  // Returning details preserves child usage and output-file locations even on
  // failure. Pi's result hook supplies the actual tool error flag.
  pi.on("tool_result", (event) => {
    if (
      event.toolName === "subagent" &&
      (event.details as { status?: string } | undefined)?.status === "failed"
    ) {
      return { isError: true };
    }
  });
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Delegate one self-contained task to an isolated foreground Pi process. Optionally override model and thinking independently; omitted values inherit the parent settings. Inherits working directory, trust, and active tools except delegation and interactive questions. No parent conversation is copied. Waits for completion; parallel calls are supported (maximum 4 active children). Children share files, not a sandbox: assign disjoint edits. Returns the final answer capped at 48 KiB/1900 lines; full visible transcript is saved in outputFile. Optional timeout in seconds, no default timeout.",
    promptSnippet:
      "Delegate a self-contained task to an isolated Pi subagent and wait for its result",
    promptGuidelines: [
      "Give subagent all necessary context and a concrete deliverable; it cannot see the parent conversation.",
      "Use parallel subagent calls only for independent work. Do not assign overlapping file edits.",
      "Subagents cannot ask interactive questions. Resolve decisions in the parent before delegating.",
    ],
    parameters: Type.Object({
      task: Type.String({
        minLength: 1,
        maxLength: 200000,
        description: "Complete instructions and context for the delegated task",
      }),
      description: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 200,
          description: "Short title displayed in Zed and tool results",
        }),
      ),
      timeout: Type.Optional(
        Type.Number({
          exclusiveMinimum: 0,
          maximum: 2147483,
          description: "Optional timeout in seconds",
        }),
      ),
      model: Type.Optional(
        Type.String({
          minLength: 1,
          description:
            "Exact provider/model-id from the Pi model catalog. Omit to inherit the parent model. No fuzzy matching or :thinking suffix.",
        }),
      ),
      thinking: Type.Optional(
        StringEnum(
          ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const,
          {
            description:
              "Thinking level for this child. Omit to inherit the parent level. Pi clamps it to the selected model capabilities.",
          },
        ),
      ),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      if (closing) throw new Error("Subagent extension is shutting down");
      if (signal?.aborted) throw new Error("Subagent cancelled before launch");
      if (!params.task.trim())
        throw new Error("Subagent task must not be empty");
      const model =
        params.model === undefined
          ? ctx.model
          : ctx.modelRegistry
              .getAll()
              .find(
                (candidate) =>
                  `${candidate.provider}/${candidate.id}` ===
                  params.model!.trim(),
              );
      if (!model) {
        if (params.model !== undefined)
          throw new Error(
            `Unknown subagent model "${params.model}". Use an exact provider/model-id from pi --list-models.`,
          );
        throw new Error(
          "Select a model before launching a subagent or supply model explicitly",
        );
      }
      const thinking =
        params.thinking ?? ctx.thinkingLevel ?? pi.getThinkingLevel();
      if (active.size >= MAX_CONCURRENT)
        throw new Error(
          `At most ${MAX_CONCURRENT} subagents may run concurrently`,
        );
      const title =
        `Subagent: ${params.description?.trim() || params.task.trim().split("\n")[0]}`.slice(
          0,
          512,
        );
      const tools = childTools(pi.getActiveTools());
      const controller = new AbortController();
      const combinedSignal = signal
        ? AbortSignal.any([signal, controller.signal])
        : controller.signal;
      const started = Date.now();
      const done = runSubagent({
        invocation: piInvocation(),
        args: childArguments({
          model: `${model.provider}/${model.id}`,
          thinking,
          tools,
          trusted: ctx.isProjectTrusted(),
          extension: fileURLToPath(import.meta.url),
        }),
        task: params.task,
        cwd: ctx.cwd,
        env: childEnvironment(process.env, tools),
        signal: combinedSignal,
        timeout: params.timeout,
        onUpdate: (snapshot) => {
          if (ctx.mode === "rpc" && process.env.PI_ACP_SUBAGENTS === "1") {
            try {
              // Version 1 is the existing pi-acp SubagentCards contract. No
              // legacy pi-subagents manager/global registry is required.
              ctx.ui.setStatus(
                "pi-acp:subagent",
                JSON.stringify({ ...snapshot, title }),
              );
            } catch {
              /* ACP UI may have disconnected. */
            }
          }
          onUpdate?.({
            content: [
              {
                type: "text",
                text: `${title} (${snapshot.status})\n${bounded(snapshot.text, 8192)}`,
              },
            ],
            details: {
              status: snapshot.status,
              toolUses: snapshot.toolUses,
              outputFile: snapshot.outputFile,
            },
          });
        },
      });
      const run = { controller, done };
      active.add(run);
      try {
        const result = await done;
        const output = truncateTail(
          result.error ||
            result.result ||
            "(Subagent completed without a text answer.)",
          { maxBytes: 48 * 1024, maxLines: 1900 },
        );
        return {
          content: [
            {
              type: "text",
              text: `${title} (${result.status})\n\n${output.content}${output.truncated ? "\n[Answer truncated.]" : ""}\n\nFull visible transcript: ${result.outputFile}`,
            },
          ],
          details: {
            status: result.status,
            runId: result.runId,
            outputFile: result.outputFile,
            toolUses: result.toolUses,
            durationMs: Date.now() - started,
            ...(result.error ? { error: result.error } : {}),
          },
          usage: result.usage,
        };
      } finally {
        active.delete(run);
      }
    },
  });
}
