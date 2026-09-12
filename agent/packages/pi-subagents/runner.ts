import { appendFileSync, mkdtempSync, statSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import {
  createAgentSession,
  DefaultResourceLoader,
  DefaultPackageManager,
  SessionManager,
  SettingsManager,
  buildSessionContext,
  resolveModelScopeWithDiagnostics,
} from "@earendil-works/pi-coding-agent";
import { prepareResources } from "./definitions.mjs";
import { providerView } from "./providers.mjs";

export const BLOCKED_TOOLS = [
  "Agent",
  "SubagentWorkflow",
  "Workflow",
  "get_subagent_result",
  "steer_subagent",
  "goal_question",
  "goal_research",
  "goal_plan",
  "goal_execute",
];
const BUILTINS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const blockedPath = (p: string) =>
  /(?:^|[/\\])(?:pi-subagents|pi-goal)(?:[/\\]|$)|[/\\]pi-acp-[^/\\]+\.[cm]?[jt]s$/.test(
    realpathSync(p),
  );

export function resolveModel(ctx: any, requested: any) {
  if (!requested) {
    if (!ctx.model) throw new Error("No parent model to inherit");
    return ctx.model;
  }
  const input =
    typeof requested === "object"
      ? `${requested.provider}/${requested.id}`
      : String(requested);
  const all = ctx.modelRegistry.getAvailable();
  const exact = all.filter(
    (m: any) => `${m.provider}/${m.id}` === input || m.id === input,
  );
  const matches = exact.length
    ? exact
    : all.filter((m: any) =>
        `${m.provider}/${m.id}`.toLowerCase().includes(input.toLowerCase()),
      );
  if (matches.length !== 1)
    throw new Error(
      `Model is unavailable or ambiguous: ${input}. Use provider/model-id.`,
    );
  return matches[0];
}

/** Providers/authentication remain parent-owned. Child extension paths are
 * selected before evaluation; isolated workers execute no extension factories.
 */
export async function createChild(
  ctx: any,
  agentDir: string,
  settings: any,
  record: any,
  options: any,
) {
  const def = options.definition;
  const cwd = options.cwd ?? ctx.cwd;
  if (!isAbsolute(cwd) || !statSync(cwd).isDirectory())
    throw new Error("Agent cwd must be an existing absolute directory");
  const isolated = options.isolated === true;
  const noExtensions = isolated || def.extensions === false;
  const parentRuntime = (ctx.modelRegistry as any).runtime;
  if (!parentRuntime)
    throw new Error("Pi 0.85.1-compatible model runtime is required");
  const modelRuntime = providerView(parentRuntime);
  const sourceSettings = SettingsManager.create(ctx.cwd, agentDir);
  const scope = sourceSettings.getEnabledModels();
  if (settings.scopeModels && scope?.length) {
    const resolved = await resolveModelScopeWithDiagnostics(
      scope,
      parentRuntime,
    );
    if (
      !resolved.scopedModels.some(
        ({ model }) =>
          model.provider === options.model.provider &&
          model.id === options.model.id,
      )
    )
      throw new Error(
        `Model is outside enabledModels scope: ${options.model.provider}/${options.model.id}`,
      );
  }
  const childSettings = SettingsManager.inMemory({
    ...sourceSettings.getGlobalSettings(),
    ...sourceSettings.getProjectSettings(),
    packages: [],
    extensions: [],
    enableInstallTelemetry: false,
  });
  let paths: string[] = [];
  let skillPaths: string[] = [];
  if (!isolated) {
    const packages = new DefaultPackageManager({
      cwd: ctx.cwd,
      agentDir,
      settingsManager: sourceSettings,
    });
    const resources = await packages.resolve(async () => "skip");
    skillPaths = resources.skills.filter((x) => x.enabled).map((x) => x.path);
    paths = noExtensions
      ? []
      : resources.extensions
          .filter((x) => x.enabled && !blockedPath(x.path))
          .map((x) => x.path);
    if (Array.isArray(def.extensions)) {
      paths = paths.filter((p) =>
        def.extensions.some((name: string) => p.includes(name)),
      );
      for (const name of def.extensions)
        if (!paths.some((p) => p.includes(name)))
          throw new Error(`Requested child extension not found: ${name}`);
    }
  }
  const allowed =
    def.tools?.includes("*") || !def.tools ? undefined : def.tools;
  const canWrite =
    !isolated &&
    (!allowed ||
      allowed.some((x: string) => ["write", "edit", "bash"].includes(x))) &&
    !["write", "edit", "bash"].every((t) => def.disallowedTools?.includes(t));
  const resources = await prepareResources(def, {
    cwd,
    agentDir,
    isolated,
    canWrite,
    skillPaths,
  });
  const loader = new DefaultResourceLoader({
    cwd: ctx.cwd,
    agentDir,
    settingsManager: childSettings,
    noExtensions: true,
    additionalExtensionPaths: paths,
    additionalSkillPaths: isolated || def.skills === false ? [] : skillPaths,
    noSkills: isolated || def.skills === false,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: isolated || def.promptMode === "replace",
    systemPromptOverride: () =>
      `<active_agent name="${def.name}">\n${resources.prompt}\n</active_agent>`,
    appendSystemPromptOverride: () => [],
  });
  await loader.reload();
  const errors = loader.getExtensions().errors;
  if (errors.length)
    throw new Error(
      `Child extension load failed: ${errors.map((e) => `${e.path}: ${e.error}`).join("; ")}`,
    );
  const customTools: any[] = [];
  if (options.structuredOutput) {
    const compiled = options.structuredOutput;
    customTools.push({
      name: "StructuredOutput",
      label: "Structured output",
      description:
        "Submit the final result. Fix validation errors and submit again. This tool is required for completion.",
      parameters: compiled.schema,
      async execute(_id: string, args: any) {
        if (
          !record.invocation?.active ||
          record.invocation.controller.signal.aborted
        )
          throw new Error("Worker invocation is no longer active");
        const verdict = compiled.check(args);
        if (verdict !== true)
          return {
            content: [
              {
                type: "text",
                text: String(verdict || "Schema validation failed"),
              },
            ],
            details: {},
            isError: true,
          };
        record.structuredJson = JSON.stringify(args);
        return {
          content: [{ type: "text", text: "Structured output accepted." }],
          details: {},
        };
      },
    });
  }
  const persist = def.persistSession ?? settings.rememberAgents ?? true;
  const sessionManager = persist
    ? SessionManager.create(cwd, undefined, {
        parentSession: ctx.sessionManager?.getSessionFile?.(),
      })
    : SessionManager.inMemory(cwd);
  if (options.inheritContext) {
    const history = buildSessionContext(
      ctx.sessionManager.getBranch(),
    ).messages;
    for (const message of structuredClone(history))
      sessionManager.appendMessage(message);
  }
  const excludeTools = [
    ...new Set([...BLOCKED_TOOLS, ...(def.disallowedTools ?? [])]),
  ].filter((t) => t !== "StructuredOutput");
  const tools = allowed
    ? [
        ...allowed.filter((t: string) => !excludeTools.includes(t)),
        ...customTools.map((t) => t.name),
      ]
    : noExtensions
      ? [
          ...BUILTINS.filter((t) => !excludeTools.includes(t)),
          ...customTools.map((t) => t.name),
        ]
      : undefined;
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model: options.model,
    modelRuntime,
    thinkingLevel: options.thinkingLevel,
    sessionManager,
    settingsManager: childSettings,
    resourceLoader: loader,
    tools,
    excludeTools,
    customTools,
  });
  try {
    session.setSessionName(`${def.name}#${record.id.slice(0, 8)}`);
    await session.bindExtensions({
      mode: ctx.mode,
      uiContext: noExtensions ? undefined : ctx.ui,
      onError: (e) => {
        record.extensionError = `${e.extensionPath}: ${e.error}`;
      },
    });
    if (!tools)
      session.setActiveTools(
        session
          .getAllTools()
          .map((t: any) => t.name)
          .filter((t: string) => !excludeTools.includes(t)),
      );
    if (def.outputTranscript ?? settings.outputTranscript ?? true) {
      const dir = mkdtempSync(join(tmpdir(), "pi-subagents-local-"));
      record.outputFile = join(dir, `${record.id}.output`);
      appendFileSync(record.outputFile, "", { mode: 0o600 });
      session.subscribe((event) => {
        if (event.type === "message_end") {
          try {
            appendFileSync(
              record.outputFile,
              JSON.stringify(event.message) + "\n",
            );
          } catch (error) {
            record.transcriptError = String(error);
          }
        }
      });
    }
    return session;
  } catch (error) {
    session.dispose();
    throw error;
  }
}
