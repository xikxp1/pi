const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const COST_KEYS = ["input", "output", "cacheRead", "cacheWrite"];
const baseId = (id) => id.replace(/\[1m\]$/, "");

/** Keep explicit context variants even when resolvedModel omits their suffix. */
export function discoveredModelId(model) {
  const resolved = model.resolvedModel || model.value;
  return model.value.endsWith("[1m]") || resolved.endsWith("[1m]")
    ? `${baseId(resolved)}[1m]`
    : resolved;
}

function metadata(id, catalog, overrides) {
  const base = baseId(id);
  const source =
    catalog.find((model) => model.id === id) ??
    catalog.find((model) => model.id === base);
  const inherited = overrides[base] ?? {};
  const exact = overrides[id] ?? {};
  const override = { ...inherited, ...exact };
  const cost = { ...source?.cost, ...inherited.cost, ...exact.cost };
  return { source, override, cost };
}

export function hasKnownPricing(id, catalog = [], overrides = {}) {
  const { cost } = metadata(id, catalog, overrides);
  return COST_KEYS.every((key) => Number.isFinite(cost[key]) && cost[key] >= 0);
}

/** Explicit mappings win; old base-ID overrides still apply to discovered variants. */
export function cliModelId(id, modelIds = {}) {
  if (modelIds[id] !== undefined) return modelIds[id];
  const inherited = modelIds[baseId(id)];
  if (inherited === undefined) return id;
  return id.endsWith("[1m]") && !inherited.endsWith("[1m]")
    ? `${inherited}[1m]`
    : inherited;
}

/** Enumerate only CLI discoveries. The API catalog supplies metadata, never entries. */
export function buildModels(discovered, catalog = [], overrides = {}) {
  const unique = new Map();
  for (const model of discovered) {
    const id = discoveredModelId(model);
    // Prefer a descriptive alias over the generic "Default (recommended)" entry.
    if (!unique.has(id) || unique.get(id).value === "default")
      unique.set(id, model);
  }
  return [...unique].map(([id, model]) => {
    const { source, override, cost } = metadata(id, catalog, overrides);
    const effortSupported =
      model.supportsEffort !== false &&
      (model.supportsEffort === true ||
        Boolean(model.supportedEffortLevels?.length));
    const levels = effortSupported
      ? (model.supportedEffortLevels ?? ["low", "medium", "high"])
      : [];
    const thinkingLevelMap = Object.fromEntries(
      EFFORTS.map((level) => [level, levels.includes(level) ? level : null]),
    );
    thinkingLevelMap.minimal = levels.includes("low") ? "low" : null;
    return {
      name: source?.name ?? model.displayName ?? id,
      reasoning: EFFORTS.some((level) => levels.includes(level)),
      // Discovery has no vision metadata. Unknown models remain text-only until
      // an exact catalog entry or explicit override establishes support.
      input: source?.input ?? ["text"],
      thinkingLevelMap,
      contextWindow: id.endsWith("[1m]")
        ? 1000000
        : Math.min(source?.contextWindow ?? 200000, 200000),
      maxTokens: Math.min(source?.maxTokens ?? 32000, 32000),
      ...override,
      id,
      // Required numeric placeholders when prices are unknown, not a claim of
      // free usage. The status command reports missing estimates explicitly.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...cost },
    };
  });
}
