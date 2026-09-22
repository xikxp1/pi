import test from "node:test";
import assert from "node:assert/strict";
import {
  buildModels,
  discoveredModelId,
  cliModelId,
  hasKnownPricing,
} from "../models.mjs";
import { commandArgs } from "../transport.mjs";

const cost = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const record = (value, resolvedModel, extra = {}) => ({
  value,
  resolvedModel,
  ...extra,
});

for (const [value, resolved, expected] of [
  ["opus", "claude-opus-5-5", "claude-opus-5-5"],
  ["opus[1m]", "claude-opus-5-5", "claude-opus-5-5[1m]"],
  ["opus", "claude-opus-5-5[1m]", "claude-opus-5-5[1m]"],
  ["opus[1m]", "claude-opus-5-5[1m]", "claude-opus-5-5[1m]"],
  ["claude-fable-5-1[1m]", "claude-fable-5-1", "claude-fable-5-1[1m]"],
  ["future[1m]", undefined, "future[1m]"],
  ["future", "", "future"],
]) {
  test(`canonical ID preserves advertised context: ${value} -> ${resolved}`, () => {
    assert.equal(discoveredModelId(record(value, resolved)), expected);
    assert.equal(buildModels([record(value, resolved)])[0].id, expected);
  });
}

test("only discoveries enumerate models; default/opus deduplicate in either order", () => {
  const generic = record("default", "claude-opus-5-5[1m]", {
    displayName: "Default",
    supportsEffort: false,
  });
  const opus = record("opus[1m]", "claude-opus-5-5", {
    displayName: "Opus",
    supportsEffort: true,
  });
  const catalog = [{ id: "catalog-only", cost }];
  assert.deepEqual(buildModels([], catalog), []);
  for (const records of [
    [generic, opus],
    [opus, generic],
  ]) {
    const models = buildModels(records, catalog);
    assert.equal(models.length, 1);
    assert.equal(models[0].id, "claude-opus-5-5[1m]");
    assert.equal(models[0].name, "Opus");
    assert.equal(models[0].reasoning, true);
  }
  assert.equal(
    buildModels([record("opus", "claude-opus-5-5"), opus]).length,
    2,
  );
});

test("unknown models do not borrow family pricing, vision, effort, or limits", () => {
  const catalog = [
    {
      id: "claude-fable-5",
      name: "Older Fable",
      cost,
      input: ["text", "image"],
      reasoning: true,
      contextWindow: 1000000,
      maxTokens: 128000,
    },
  ];
  const [model] = buildModels(
    [record("claude-fable-5-1[1m]", "claude-fable-5-1")],
    catalog,
  );
  assert.equal(model.name, "claude-fable-5-1[1m]");
  assert.deepEqual(model.input, ["text"]);
  assert.deepEqual(model.cost, {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });
  assert.equal(model.reasoning, false);
  assert.equal(model.contextWindow, 1000000);
  assert.equal(model.maxTokens, 32000);
  assert.equal(hasKnownPricing(model.id, catalog), false);
  assert.equal(buildModels([{ value: "unknown" }])[0].contextWindow, 200000);
});

test("exact catalog metadata enriches discoveries but CLI owns effort and context variants", () => {
  const catalog = [
    {
      id: "model",
      name: "Verified model",
      cost,
      input: ["text", "image"],
      reasoning: true,
      contextWindow: 1000000,
      maxTokens: 128000,
    },
  ];
  const [base, variant] = buildModels(
    [{ value: "model" }, { value: "model[1m]" }],
    catalog,
  );
  assert.equal(base.name, "Verified model");
  assert.deepEqual(base.input, ["text", "image"]);
  assert.equal(base.reasoning, false);
  assert.equal(base.contextWindow, 200000);
  assert.equal(variant.contextWindow, 1000000);
  assert.equal(base.maxTokens, 32000);
  assert.deepEqual(variant.cost, cost);
  assert.notEqual(variant.cost, cost);
  assert.equal(hasKnownPricing(variant.id, catalog), true);
  const [small] = buildModels(
    [{ value: "small" }],
    [{ id: "small", contextWindow: 100000, maxTokens: 8192 }],
  );
  assert.equal(small.contextWindow, 100000);
  assert.equal(small.maxTokens, 8192);
  const [exact] = buildModels(
    [{ value: "model[1m]" }],
    [
      ...catalog,
      {
        id: "model[1m]",
        name: "Exact variant",
        cost: { ...cost, input: 7 },
        input: ["text"],
      },
    ],
  );
  assert.equal(exact.name, "Exact variant");
  assert.equal(exact.cost.input, 7);
  assert.deepEqual(exact.input, ["text"]);
});

test("CLI effort capabilities determine reasoning and supported Pi levels", () => {
  for (const [extra, supported] of [
    [{}, []],
    [{ supportsAdaptiveThinking: true }, []],
    [{ supportsEffort: true }, ["low", "medium", "high"]],
    [{ supportsEffort: true, supportedEffortLevels: [] }, []],
    [
      { supportedEffortLevels: ["low", "xhigh", "max", "future"] },
      ["low", "xhigh", "max"],
    ],
    [{ supportsEffort: false, supportedEffortLevels: ["high"] }, []],
    [{ supportedEffortLevels: ["future"] }, []],
  ]) {
    const [model] = buildModels([{ value: "effort", ...extra }]);
    assert.equal(model.reasoning, supported.length > 0);
    assert.deepEqual(
      model.thinkingLevelMap,
      Object.fromEntries(
        ["low", "medium", "high", "xhigh", "max", "minimal"].map((level) => {
          const cli = level === "minimal" ? "low" : level;
          return [level, supported.includes(cli) ? cli : null];
        }),
      ),
    );
  }
});

test("base overrides remain compatible; exact variant wins and costs are merged copies", () => {
  const catalog = [{ id: "claude-fable-5-1", cost }];
  const overrides = {
    "claude-fable-5-1": {
      name: "Base",
      input: ["text", "image"],
      contextWindow: 250000,
      maxTokens: 64000,
      cost: { input: 9, output: 20 },
    },
    "claude-fable-5-1[1m]": {
      id: "must-not-replace-canonical-id",
      name: "Variant",
      contextWindow: 1200000,
      cost: { output: 30 },
    },
  };
  const snapshot = structuredClone({ catalog, overrides });
  const [base, variant] = buildModels(
    [
      { value: "claude-fable-5-1" },
      record("claude-fable-5-1[1m]", "claude-fable-5-1"),
    ],
    catalog,
    overrides,
  );
  assert.equal(base.name, "Base");
  assert.equal(base.contextWindow, 250000);
  assert.equal(variant.id, "claude-fable-5-1[1m]");
  assert.equal(variant.name, "Variant");
  assert.equal(variant.contextWindow, 1200000);
  assert.equal(variant.maxTokens, 64000);
  assert.deepEqual(variant.input, ["text", "image"]);
  assert.deepEqual(variant.cost, { ...cost, input: 9, output: 30 });
  variant.cost.input = 100;
  base.cost.output = 200;
  assert.deepEqual({ catalog, overrides }, snapshot);
});

test("known pricing requires all four finite nonnegative values, including explicit free pricing", () => {
  assert.equal(hasKnownPricing("unknown"), false);
  assert.equal(
    hasKnownPricing("model", [], { model: { cost: { input: 1 } } }),
    false,
  );
  assert.equal(hasKnownPricing("model[1m]", [], { model: { cost } }), true);
  assert.equal(
    hasKnownPricing("model", [], {
      model: { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    }),
    true,
  );
  for (const invalid of [-1, NaN, Infinity, "3", null]) {
    assert.equal(
      hasKnownPricing("model", [{ id: "model", cost }], {
        model: { cost: { input: invalid } },
      }),
      false,
    );
  }
  assert.equal(
    hasKnownPricing("model[1m]", [], {
      model: { cost: { ...cost, input: -1 } },
      "model[1m]": { cost: { input: 4 } },
    }),
    true,
  );
});

test("CLI IDs default to canonical IDs, inherit base mapping, and prefer exact mappings in transport", () => {
  const id = "claude-fable-5-1[1m]";
  const base = "claude-fable-5-1";
  assert.equal(cliModelId(id), id);
  assert.equal(cliModelId(id, { [base]: "fable" }), "fable[1m]");
  assert.equal(cliModelId(id, { [base]: "fable[1m]" }), "fable[1m]");
  assert.equal(cliModelId(id, { [id]: "fable" }), "fable");
  const modelIds = { [base]: "fable", [id]: "fable[1m]" };
  assert.equal(cliModelId(id, modelIds), "fable[1m]");
  assert.equal(cliModelId(base, modelIds), "fable");
  const args = commandArgs({
    model: { id },
    options: {},
    config: { modelIds },
    directory: "/unused",
    hasHistory: false,
    hasTools: false,
  });
  assert.equal(args[args.indexOf("--model") + 1], "fable[1m]");
});
