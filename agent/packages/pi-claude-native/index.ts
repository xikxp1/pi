import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { getModels } from "@earendil-works/pi-ai/compat";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { runRequest, resumeSessionAtState } from "./transport.mjs";
import { buildModels, hasKnownPricing } from "./models.mjs";
import { loadDiscoveredModels } from "./discovery.mjs";

// Pi awaits this factory, including discovery, before resolving startup models.
export default async function (pi: ExtensionAPI) {
  const configPath = join(getAgentDir(), "claude-native.json");
  const cachePath = join(getAgentDir(), "claude-native-cache", "models.json");
  let config: Record<string, any> = {};
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!config || typeof config !== "object" || Array.isArray(config))
    throw new Error(`Invalid configuration: ${configPath}`);
  const allowed = new Set([
    "executable",
    "idleTimeoutMs",
    "requestTimeoutMs",
    "killGraceMs",
    "discoveryTimeoutMs",
    "modelIds",
    "modelOverrides",
  ]);
  for (const key of Object.keys(config))
    if (!allowed.has(key))
      throw new Error(`Unknown claude-native setting: ${key}`);
  for (const key of [
    "idleTimeoutMs",
    "requestTimeoutMs",
    "killGraceMs",
    "discoveryTimeoutMs",
  ]) {
    if (
      config[key] !== undefined &&
      (!Number.isSafeInteger(config[key]) ||
        config[key] <= 0 ||
        config[key] > 2147483647)
    )
      throw new Error(`${key} must be a positive timer-safe integer`);
  }
  if (
    config.executable !== undefined &&
    (typeof config.executable !== "string" || !config.executable)
  )
    throw new Error("executable must be a nonempty string");
  for (const key of ["modelIds", "modelOverrides"]) {
    if (
      config[key] !== undefined &&
      (!config[key] ||
        typeof config[key] !== "object" ||
        Array.isArray(config[key]))
    )
      throw new Error(`${key} must be an object`);
  }
  if (
    config.modelIds &&
    Object.values(config.modelIds).some((v) => typeof v !== "string" || !v)
  )
    throw new Error("modelIds values must be nonempty strings");

  // Read the persisted catalog for enrichment even in --list-models, where no
  // session_start event runs. Never enumerate models from this file.
  let catalog = getModels("anthropic");
  try {
    const stored = JSON.parse(
      readFileSync(join(getAgentDir(), "models-store.json"), "utf8"),
    ).anthropic?.models;
    if (Array.isArray(stored)) {
      const merged = new Map(catalog.map((model) => [model.id, model]));
      for (const model of stored)
        if (model && typeof model.id === "string") merged.set(model.id, model);
      catalog = [...merged.values()];
    }
  } catch {
    /* Bundled metadata is sufficient if no valid persisted catalog exists. */
  }

  let discovery = await loadDiscoveredModels({ config, cachePath });
  let models = buildModels(discovery.models, catalog, config.modelOverrides);
  let lastContext: ExtensionContext | undefined;
  let resumeWarned = false;
  const resumeFallbackWarning =
    "claude-native: Claude CLI lacks --resume-session-at; tool-result turns may include synthetic resume messages";
  // The transport probes support lazily on the first resumed request.
  const warnResumeFallback = () => {
    if (resumeWarned || resumeSessionAtState(config) !== "unsupported") return;
    resumeWarned = true;
    if (lastContext?.hasUI) {
      lastContext.ui.setStatus("claude-native-resume", resumeFallbackWarning);
      lastContext.ui.notify(resumeFallbackWarning, "warning");
    } else console.error(`[${resumeFallbackWarning}]`);
  };
  const register = () =>
    pi.registerProvider("claude-native", {
      name: "Claude Max (Pi Native)",
      baseUrl: "claude-native",
      apiKey: "claude-code-login",
      api: "claude-native",
      models,
      streamSimple(model, context, options) {
        const stream = createAssistantMessageEventStream();
        void runRequest(model, context, options, config, (event) =>
          stream.push(event),
        ).finally(() => {
          stream.end();
          warnResumeFallback();
        });
        return stream;
      },
    });
  register();

  const enrichFromRegistry = (ctx: ExtensionContext) => {
    const merged = new Map(catalog.map((model) => [model.id, model]));
    for (const model of ctx.modelRegistry.getAll()) {
      if (model.provider === "anthropic") merged.set(model.id, model);
    }
    catalog = [...merged.values()];
  };

  const status = () => {
    const unknownPrices = models
      .filter(
        (model) => !hasKnownPricing(model.id, catalog, config.modelOverrides),
      )
      .map((model) => model.id);
    const age = discovery.checkedAt
      ? Math.max(
          0,
          Math.floor((Date.now() - Date.parse(discovery.checkedAt)) / 1000),
        )
      : undefined;
    return [
      `Provider: claude-native (${models.length} discovered models)`,
      `Discovery: ${discovery.source === "cache" ? "STALE cache" : discovery.source}${age === undefined ? "" : `; last success ${age}s ago (${discovery.checkedAt})`}`,
      ...(discovery.error ? [`Discovery error: ${discovery.error}`] : []),
      ...(discovery.cacheError ? [`Cache: ${discovery.cacheError}`] : []),
      `CLI: ${config.executable ?? "claude"}; authentication: Claude Code login`,
      `Resume repair suppression (undocumented --resume-session-at): ${
        {
          supported: "supported",
          unsupported:
            "UNSUPPORTED by this CLI; synthetic resume messages may reach the model",
          unchecked: "not checked yet (probed on the first resumed request)",
        }[resumeSessionAtState(config)]
      }`,
      `Discovery timeout: ${config.discoveryTimeoutMs ?? 10000}ms; cache: ${cachePath}`,
      "Context: advertised [1m] variants use 1M; otherwise at most 200K. Output: at most 32K unless overridden.",
      ...(unknownPrices.length
        ? [
            `Pricing unknown (zero placeholders, not free usage): ${unknownPrices.join(", ")}`,
          ]
        : []),
      "Unknown vision capabilities default to text-only; modelOverrides can supply verified metadata.",
      `Idle timeout: ${config.idleTimeoutMs ?? 120000}ms; deadline: ${config.requestTimeoutMs ?? 600000}ms`,
      "One response per process; Pi owns all tools, questions, subagents and compaction.",
      `Config: ${configPath}`,
    ].join("\n");
  };
  const report = (ctx: ExtensionContext, full = false) => {
    const issue = discovery.source !== "live" || Boolean(discovery.cacheError);
    const warning =
      discovery.source === "cache"
        ? "claude-native: using STALE model cache"
        : discovery.source === "none"
          ? "claude-native: no discovered models available"
          : discovery.cacheError
            ? "claude-native: model cache write failed"
            : undefined;
    if (ctx.hasUI) {
      ctx.ui.setStatus("claude-native-discovery", warning);
      if (full || issue) ctx.ui.notify(status(), issue ? "warning" : "info");
    } else if (full || issue) {
      console.error(`[claude-native]\n${status()}`);
    }
  };
  // Warnings also reach --list-models, which does not create a session.
  if (discovery.source !== "live" || discovery.cacheError) {
    console.error(
      `[claude-native] Discovery: ${discovery.source}; ${discovery.error ?? discovery.cacheError}. Run /claude-native-status for details.`,
    );
  }
  pi.on("session_start", (_event, ctx) => {
    lastContext = ctx;
    // Preserve effective Anthropic metadata overrides, but never add its entries.
    enrichFromRegistry(ctx);
    models = buildModels(discovery.models, catalog, config.modelOverrides);
    register();
    report(ctx);
  });
  pi.registerCommand("claude-native-status", {
    description:
      "Show Claude model discovery, cache, limits and transport configuration",
    handler: async (_args, ctx) => {
      report(ctx, true);
    },
  });
  let refreshing = false;
  pi.registerCommand("claude-native-refresh", {
    description: "Rediscover Claude Code models and update the selector",
    handler: async (_args, ctx) => {
      if (refreshing) {
        if (ctx.hasUI)
          ctx.ui.notify("Claude model discovery is already running", "info");
        return;
      }
      refreshing = true;
      try {
        await ctx.waitForIdle();
        const next = await loadDiscoveredModels({ config, cachePath });
        // Prefer the newest successful discovery, including an in-memory result
        // whose cache write failed. Never revert it to an older disk snapshot.
        discovery =
          next.source !== "live" &&
          discovery.models.length &&
          (!next.checkedAt ||
            Date.parse(discovery.checkedAt!) >= Date.parse(next.checkedAt))
            ? {
                ...discovery,
                source: "cache",
                error: next.error,
                cacheError: next.cacheError,
              }
            : next;
        enrichFromRegistry(ctx);
        models = buildModels(discovery.models, catalog, config.modelOverrides);
        register();
        if (ctx.model?.provider === "claude-native") {
          const updated = ctx.modelRegistry.find("claude-native", ctx.model.id);
          if (updated) await pi.setModel(updated);
        }
        report(ctx, true);
      } finally {
        refreshing = false;
      }
    },
  });
}
