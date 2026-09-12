import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv from "ajv";
import { Type } from "typebox";
import {
  getAgentDir,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { AgentManager, topLevel } from "./manager.mjs";
import { createRegistry } from "./registry.mjs";
import { loadDefinitions, resolveDefinition } from "./definitions.mjs";
import { createChild, resolveModel } from "./runner.ts";
import { WorkflowService } from "./workflows.mjs";

const KEY = Symbol.for("pi-subagents:manager");
const globals = globalThis as any;
const result = (text: string, details: any = {}) => ({
  content: [{ type: "text" as const, text }],
  details,
});
const bounded = (text: string) =>
  text.length > 64000
    ? text.slice(0, 64000) + "\n[Truncated; see transcript.]"
    : text;
const finished = (r: any) => !["running", "queued"].includes(r.status);
const errorText = (e: any) => e?.message ?? String(e);
function configuration(cwd: string, agentDir: string) {
  let value: any = {};
  for (const path of [
    join(agentDir, "subagents.json"),
    join(cwd, ".pi", "subagents.json"),
  ]) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object")
        throw new Error("Expected an object");
      value = { ...value, ...parsed };
    } catch (e: any) {
      if (e.code !== "ENOENT") throw new Error(`Invalid ${path}: ${e.message}`);
    }
  }
  if (value.schedulingEnabled === true || value.worktreeIsolation === true)
    throw new Error(
      "Scheduling/worktree isolation are not supported; remove those enabled settings before using the local runtime",
    );
  return value;
}

export default function subagents(pi: ExtensionAPI) {
  let manager: any, workflows: any, ctx: any, config: any, registry: any;
  let closing = false;
  let unlisten: (() => void)[] = [];
  const agentDir = getAgentDir();
  const agentCatalog = [
    ...loadDefinitions({ cwd: process.cwd(), agentDir }).values(),
  ]
    .filter((def: any) => !def.disabled)
    .map((def: any) => `${def.name}: ${def.description}`)
    .join("\n");
  const requireReady = () => {
    if (!manager || manager.closed || closing)
      throw new Error("No active subagent session");
  };
  const show = (r: any, verbose = false) =>
    bounded(
      `${r.type ?? "Workflow"} ${r.id} (${r.status})\n${r.description ?? ""}\n${r.error ?? r.result ?? ""}${r.outputFile ? `\nTranscript: ${r.outputFile}` : ""}${verbose && r.session ? `\n${JSON.stringify(r.session.messages, null, 2)}` : ""}`,
    );
  const notify = (r: any) =>
    pi.sendMessage(
      {
        customType: "subagent-notification",
        content: show(r),
        display: true,
        details: { id: r.id, status: r.status, outputFile: r.outputFile },
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  function spawn(
    type: string,
    prompt: string,
    options: any = {},
    workflowId?: string,
  ) {
    requireReady();
    for (const key of [
      "schedule",
      "parentAgentId",
      "resumeSessionFile",
      "reclaim",
    ])
      if (options[key] !== undefined)
        throw new Error(`Unsupported spawn option: ${key}`);
    if (options.isolation && options.isolation !== "off")
      throw new Error("Worktree isolation is not supported");
    const definitions = loadDefinitions({ cwd: ctx.cwd, agentDir });
    const def = resolveDefinition(definitions, type);
    const model = resolveModel(ctx, options.model ?? def.model);
    const thinkingLevel =
      options.thinkingLevel ?? def.thinking ?? pi.getThinkingLevel();
    if (
      !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
        thinkingLevel,
      )
    )
      throw new Error(`Unsupported thinking level: ${thinkingLevel}`);
    return manager.spawn(def.name, prompt, {
      ...options,
      workflowId,
      definition: def,
      model,
      thinkingLevel,
      maxTurns: options.maxTurns ?? def.maxTurns ?? 24,
      inheritContext: options.inheritContext ?? def.inheritContext ?? false,
    });
  }
  async function shutdown() {
    closing = true;
    for (const off of unlisten.splice(0)) off();
    await workflows?.dispose();
    await manager?.dispose();
    if (globals[KEY] === registry) delete globals[KEY];
    manager = undefined;
    workflows = undefined;
    registry = undefined;
  }
  pi.on("session_start", async (_event, nextCtx) => {
    if (manager) await shutdown();
    if (globals[KEY])
      throw new Error(
        "Another subagents runtime is active. Load only ./packages/pi-subagents, not the npm package.",
      );
    ctx = nextCtx;
    closing = false;
    config = configuration(ctx.cwd, agentDir);
    manager = new AgentManager({
      maxConcurrent: config.maxConcurrent ?? 10,
      createSession: (r: any, o: any) =>
        createChild(ctx, agentDir, config, r, o),
      emit: (event: string, data: any) => pi.events.emit(event, data),
      notify,
      onRecord: (r: any) => {
        if (topLevel(r))
          pi.appendEntry("subagents:record", {
            id: r.id,
            type: r.type,
            description: r.description,
            status: r.status,
            result: r.result,
            error: r.error,
            startedAt: r.startedAt,
            completedAt: r.completedAt,
            sessionFile: r.session?.sessionFile,
          });
        ctx.ui.setStatus(
          "local-subagents",
          manager.hasRunning()
            ? `${manager.running} agents running`
            : undefined,
        );
      },
    });
    const ownedManager = manager;
    let ownedWorkflows: any;
    registry = createRegistry({
      manager: ownedManager,
      spawn,
      isCurrent: () => manager === ownedManager && !closing,
      getWorkflows: () => ownedWorkflows,
    });
    globals[KEY] = registry;
    const rpc = (verb: string, handler: (q: any) => any) => {
      unlisten.push(
        pi.events.on(`subagents:rpc:${verb}`, (q: any) => {
          const reply = (success: boolean, value: any) =>
            pi.events.emit(
              `subagents:rpc:${verb}:reply:${q?.requestId}`,
              success
                ? { success, ...(value === undefined ? {} : { data: value }) }
                : { success, error: errorText(value) },
            );
          try {
            const value = handler(q);
            if (value?.then)
              value.then(
                (v: any) => reply(true, v),
                (e: any) => reply(false, e),
              );
            else reply(true, value);
          } catch (e) {
            reply(false, e);
          }
        }),
      );
    };
    rpc("ping", () => ({ version: 2 }));
    rpc("spawn", async (q) => {
      const r = await spawn(q.type, q.prompt, {
        ...q.options,
        isBackground: true,
      });
      return { id: r.id };
    });
    rpc("stop", (q) => {
      if (!ownedManager.stop(q.agentId))
        throw new Error("Agent not found or not running");
    });
    // Consumption is deliberately synchronous inside terminal event delivery.
    rpc("consume", (q) => {
      if (!ownedManager.consume(q.agentId))
        throw new Error("Agent not found or still running");
    });
    workflows = ownedWorkflows = new WorkflowService({
      cwd: ctx.cwd,
      agentDir,
      sessionId: ctx.sessionManager.getSessionId(),
      notify: (r: any) =>
        notify({
          ...r,
          type: "Workflow",
          result:
            typeof r.result === "string" ? r.result : JSON.stringify(r.result),
        }),
      onUpdate: (r: any) => {
        const text = bounded(
          r.error ??
            (r.result !== undefined
              ? JSON.stringify(r.result)
              : r.log === undefined
                ? (r.description ?? r.name)
                : typeof r.log === "string"
                  ? r.log
                  : JSON.stringify(r.log)),
        );
        ctx.ui.setStatus(
          `workflow:${r.id}`,
          ["running", "stopping"].includes(r.status)
            ? `${r.name}: ${r.status}`
            : undefined,
        );
        if (ctx.mode === "rpc" && process.env.PI_ACP_SUBAGENTS === "1")
          ctx.ui.setStatus(
            "pi-acp:subagent",
            JSON.stringify({
              version: 1,
              agentId: r.id,
              runId: r.id,
              title: `Workflow: ${r.name}`,
              status: ["running", "stopping"].includes(r.status)
                ? "in_progress"
                : r.status === "completed"
                  ? "completed"
                  : "failed",
              text,
              outputFile: r.scriptPath,
            }),
          );
      },
      runAgent: async ({ prompt, options, signal, workflowId }: any) => {
        if (manager !== ownedManager || closing)
          throw new Error("Workflow parent session is inactive");
        const before = options.resume
          ? { ...ownedManager.getRecord(options.resume)?.usage }
          : {};
        let r;
        if (options.resume)
          r = ownedManager.resume(
            options.resume,
            prompt,
            { signal, isBackground: false },
            workflowId,
          );
        else {
          let structuredOutput;
          if (options.schema) {
            if (options.schema.type !== "object")
              throw new Error("Workflow schema root must be object");
            const ajv = new Ajv({ allErrors: true, strict: false });
            const check = ajv.compile(options.schema);
            structuredOutput = {
              schema: options.schema,
              check: (value: any) =>
                check(value) || ajv.errorsText(check.errors),
            };
          }
          r = await spawn(
            options.agentType ?? "general-purpose",
            prompt,
            {
              model: options.model,
              thinkingLevel: options.effort,
              description: options.label ?? "Workflow agent",
              structuredOutput,
              signal,
              isBackground: false,
            },
            workflowId,
          );
        }
        const settled = await r.promise;
        if (!["completed", "steered"].includes(settled.status))
          throw new Error(settled.error ?? `Agent ${settled.status}`);
        return {
          id: r.id,
          value: r.options.structuredOutput
            ? JSON.parse(r.structuredJson)
            : r.result,
          usage: Object.fromEntries(
            Object.entries(r.usage).map(([key, value]) => [
              key,
              Number(value) - Number(before[key] ?? 0),
            ]),
          ),
        };
      },
    });
    pi.events.emit("subagents:ready", {});
  });
  pi.on("session_shutdown", shutdown);
  pi.on("before_agent_start", (_event, nextCtx) => {
    ctx = nextCtx;
  });

  pi.registerTool({
    name: "Agent",
    label: "Agent",
    description:
      "Delegate a task to a separate Pi session. Background by default; returns an id and sends one completion notification. Use run_in_background:false only when the result gates your very next action. Use get_subagent_result after notification, not polling. Custom definitions in .pi/agents, .agents/agents and the global agent directory control tools/models. Resume an existing owned id to keep its context. Scheduling, worktree isolation and nested delegation are not supported. Never request automatic commits.\nAvailable agent types:\n" +
      agentCatalog,
    parameters: Type.Object(
      {
        prompt: Type.String(),
        description: Type.String(),
        subagent_type: Type.String(),
        name: Type.Optional(Type.String()),
        model: Type.Optional(Type.String()),
        thinking: Type.Optional(Type.String()),
        max_turns: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
        run_in_background: Type.Optional(Type.Boolean()),
        resume: Type.Optional(Type.String()),
        isolated: Type.Optional(Type.Boolean()),
        inherit_context: Type.Optional(Type.Boolean()),
      },
      { additionalProperties: false },
    ),
    async execute(_id, p, signal) {
      requireReady();
      const background = p.run_in_background !== false;
      let r;
      if (p.resume) {
        if (
          p.model ||
          p.thinking ||
          p.isolated !== undefined ||
          p.inherit_context !== undefined ||
          p.name
        )
          throw new Error(
            "Resume retains model, thinking, tools and identity; omit overrides",
          );
        const previous = manager.resolve(p.resume);
        r = manager.resume(previous.id, p.prompt, {
          signal: background ? undefined : signal,
          isBackground: background,
          ...(p.max_turns !== undefined ? { maxTurns: p.max_turns } : {}),
        });
      } else
        r = await spawn(p.subagent_type, p.prompt, {
          description: p.description,
          name: p.name,
          model: p.model,
          thinkingLevel: p.thinking,
          maxTurns: p.max_turns,
          isolated: p.isolated,
          inheritContext: p.inherit_context,
          isBackground: background,
          signal: background ? undefined : signal,
        });
      if (background)
        return result(
          `Agent started in background. Agent ID: ${r.id}\nHandle: ${r.name ?? r.handle}\nYou will be notified when it finishes. Do not poll or sleep waiting.`,
          { id: r.id },
        );
      await r.promise;
      manager?.consume(r.id);
      if (!["completed", "steered"].includes(r.status))
        throw new Error(show(r));
      return result(show(r), {
        id: r.id,
        status: r.status,
        ...(r.error ? { error: r.error } : {}),
      });
    },
  });
  pi.registerTool({
    name: "get_subagent_result",
    label: "Agent result",
    description:
      "Read a background agent result by id or handle after notification. wait:true joins its current invocation without stopping it if the wait is cancelled.",
    parameters: Type.Object({
      agent_id: Type.String(),
      wait: Type.Optional(Type.Boolean()),
      verbose: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, p, signal) {
      requireReady();
      const r = manager.resolve(p.agent_id);
      if (p.wait && !finished(r))
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            cleanup();
            reject(new Error("Result wait aborted"));
          };
          const cleanup = () => signal?.removeEventListener("abort", abort);
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) abort();
          r.promise.then(
            () => {
              cleanup();
              resolve();
            },
            (e: any) => {
              cleanup();
              reject(e);
            },
          );
        });
      if (finished(r)) manager.consume(r.id);
      return result(show(r, p.verbose), { id: r.id, status: r.status });
    },
  });
  pi.registerTool({
    name: "steer_subagent",
    label: "Steer agent",
    description:
      "Send a message to a running owned agent. Resume settled agents with Agent instead.",
    parameters: Type.Object({
      agent_id: Type.String(),
      message: Type.String(),
    }),
    async execute(_id, p) {
      requireReady();
      const r = manager.resolve(p.agent_id);
      await manager.steer(r.id, p.message);
      return result(`Message sent to ${r.id}`);
    },
  });
  pi.registerTool({
    name: "SubagentWorkflow",
    label: "Workflow",
    description:
      "Run a deterministic JavaScript workflow in the background ONLY when the user explicitly requests workflows or multi-agent orchestration. Source must start with export const meta = {name,description,phases?:[...]}, a pure literal. Hooks: agent(prompt,{label,phase,agentType,model,effort,schema,gate,resume}), pipeline(items,...stages) with (previous,item,index), parallel(thunks), phase(title), log(text), args, budget {total:null,spent(),remaining()}, workflow(nameOrRef,args). Prefer pipeline; parallel is a barrier. Agent failures become null; filter them. schema is object-root JSON Schema, returns validated output; gate executes a shell command after the child. resume uses a previous child label, cannot combine with profile/schema/gate overrides. No worktree isolation. No filesystem, imports, eval/Function, Date.now(), argless new Date(), or Math.random() in scripts. All real work is delegated. Await every agent call. Limits:1000 agents,4096 items per helper. Returns id/script path; notification on completion. Reuse scriptPath to edit; resumeFromRunId replays the unchanged successful prefix of a settled run in this session (not supported for runs containing child resume). Save scripts in .pi/workflows, .agents/workflows or global workflows. Do not poll.",
    parameters: Type.Object({
      script: Type.Optional(Type.String({ maxLength: 524288 })),
      scriptPath: Type.Optional(Type.String()),
      name: Type.Optional(Type.String()),
      args: Type.Optional(Type.Any()),
      resumeFromRunId: Type.Optional(Type.String()),
      title: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
    }),
    async execute(_id, p) {
      requireReady();
      if (config.workflowsEnabled === false)
        throw new Error("Workflows are disabled by subagents.json");
      const r = await workflows.start(p);
      return result(
        `Workflow started. Task ID: ${r.id}\nScript: ${r.scriptPath}\nJournal: ${r.journalPath}\nYou will be notified on completion. Do not poll.`,
        { id: r.id, scriptPath: r.scriptPath, journalPath: r.journalPath },
      );
    },
  });
  pi.on("input", async (event, inputCtx) => {
    // Print mode has no persistent notification loop; leave mentions to the
    // parent model rather than silently detaching a worker before process exit.
    if (!manager || config.agentMentions === "off" || inputCtx.mode === "print")
      return;
    ctx = inputCtx;
    if (event.text.startsWith("@main "))
      return { action: "transform" as const, text: event.text.slice(6) };
    const match = /^@([a-zA-Z0-9_-]+)\s+([\s\S]+)$/.exec(event.text);
    if (!match) return;
    let r;
    try {
      r = manager.resolve(match[1]);
    } catch {}
    let def;
    if (!r) {
      const defs = await loadDefinitions({ cwd: ctx.cwd, agentDir });
      try {
        def = resolveDefinition(defs, match[1].replace(/^agent-/, ""));
      } catch {
        return;
      }
    }
    try {
      if (!r)
        r = await spawn(def.name, match[2], {
          isBackground: true,
          description: match[2].slice(0, 100),
        });
      else if (!finished(r)) await manager.steer(r.id, match[2]);
      else r = manager.resume(r.id, match[2], { isBackground: true });
      inputCtx.ui.notify(`Message sent to @${r.name ?? r.handle}`, "info");
    } catch (error) {
      inputCtx.ui.notify(errorText(error), "error");
    }
    return { action: "handled" as const };
  });
  pi.registerCommand("agents", {
    description:
      "List/manage agents and workflows. /agents [list|show ID|stop ID|steer ID TEXT|resume ID TEXT|workflows [ID|stop ID]]",
    handler: async (args, uiCtx) => {
      requireReady();
      ctx = uiCtx;
      const [verb, ref, ...rest] = args.trim().split(/\s+/);
      if (verb === "workflows") {
        if (ref === "stop") await workflows.stop(rest[0]);
        const rows =
          ref && ref !== "stop" ? [workflows.get(ref)] : workflows.list();
        uiCtx.ui.notify(
          rows
            .filter(Boolean)
            .map((r: any) => show({ ...r, result: JSON.stringify(r.result) }))
            .join("\n") || "No workflows",
          "info",
        );
        return;
      }
      if (ref) {
        const r = manager.resolve(ref);
        if (verb === "stop") manager.stop(r.id);
        else if (verb === "steer") await manager.steer(r.id, rest.join(" "));
        else if (verb === "resume")
          manager.resume(r.id, rest.join(" "), { isBackground: true });
        else if (verb !== "show") throw new Error("Unknown /agents action");
        uiCtx.ui.notify(show(r), "info");
        return;
      }
      const rows = manager.list().filter(topLevel);
      if (!rows.length || !uiCtx.hasUI || verb === "list") {
        uiCtx.ui.notify(
          rows
            .map(
              (r: any) =>
                `${r.id} @${r.name ?? r.handle} ${r.status} ${r.description}`,
            )
            .join("\n") || "No agents",
          "info",
        );
        return;
      }
      const selected = await uiCtx.ui.select(
        "Agents",
        rows.map((r: any) => `${r.id} ${r.type}: ${r.status}`),
      );
      if (!selected) return;
      const r = manager.resolve(selected.split(" ")[0]);
      const action = await uiCtx.ui.select(
        show(r),
        finished(r)
          ? ["View transcript", "Resume"]
          : ["View transcript", "Steer", "Stop"],
      );
      if (action === "View transcript") uiCtx.ui.notify(show(r, true), "info");
      if (action === "Stop") manager.stop(r.id);
      if (action === "Steer" || action === "Resume") {
        const message = await uiCtx.ui.input(action, "Message");
        if (message) {
          if (action === "Steer") await manager.steer(r.id, message);
          else manager.resume(r.id, message, { isBackground: true });
        }
      }
    },
  });
}
