export function buildModels(catalog, overrides = {}) {
  return catalog
    .filter((m) => m.id.startsWith("claude-"))
    .map((m) => ({
      id: m.id,
      name: `${m.name} (Claude Max)`,
      reasoning: m.reasoning,
      input: m.input,
      thinkingLevelMap: m.thinkingLevelMap,
      // API catalog limits do not prove subscription entitlements. Be conservative
      // until the user explicitly selects a larger CLI model/context configuration.
      contextWindow: Math.min(m.contextWindow, 200000),
      maxTokens: Math.min(m.maxTokens, 32000),
      ...overrides[m.id],
      // API-equivalent estimates, not Claude Max subscription charges.
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        ...m.cost,
        ...overrides[m.id]?.cost,
      },
    }));
}
