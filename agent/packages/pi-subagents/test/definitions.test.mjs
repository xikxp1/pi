import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadDefinitions,
  resolveDefinition,
  prepareResources,
} from "../definitions.mjs";

function fixture(t) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "pi-definitions-")),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "project"),
    agentDir = path.join(root, "global");
  fs.mkdirSync(cwd);
  fs.mkdirSync(agentDir);
  return { root, cwd, agentDir };
}
function put(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
const md = (header, body = "Task prompt.") => `---\n${header}\n---\n${body}`;
const def = (extra) => ({
  name: "reviewer",
  description: "review",
  systemPrompt: "Base.",
  ...extra,
});

test("builtins, exact-name precedence, filename defaults, case-insensitive resolution", (t) => {
  const f = fixture(t);
  assert.deepEqual(
    [...loadDefinitions(f).keys()],
    ["general-purpose", "Explore", "Plan"],
  );
  put(
    path.join(f.agentDir, "agents/a.md"),
    md("name: Explore\ndescription: global"),
  );
  put(
    path.join(f.cwd, ".agents/agents/b.md"),
    md("name: Explore\ndescription: shared"),
  );
  assert.equal(
    resolveDefinition(loadDefinitions(f), "EXPLORE").description,
    "shared",
  );
  put(
    path.join(f.cwd, ".pi/agents/c.md"),
    md("name: Explore\ndescription: pi"),
  );
  put(path.join(f.cwd, ".pi/agents/custom.md"), "Standalone prompt");
  const map = loadDefinitions(f);
  assert.equal(resolveDefinition(map, "explore").description, "pi");
  assert.equal(map.get("custom").systemPrompt, "Standalone prompt");
  assert.throws(() => resolveDefinition(map, "missing"), /unknown/);
  put(path.join(f.cwd, ".pi/agents/disabled.md"), md("enabled: false"));
  assert.throws(
    () => resolveDefinition(loadDefinitions(f), "disabled"),
    /disabled/,
  );
  put(path.join(f.cwd, ".pi/agents/explore.md"), md("enabled: false"));
  assert.throws(
    () => resolveDefinition(loadDefinitions(f), "Explore"),
    /ambiguous/,
  );
});

test("YAML lists, quoted strings, aliases and explicit false values survive", (t) => {
  const f = fixture(t);
  put(
    path.join(f.agentDir, "agents/test.md"),
    md(`description: 'A: quoted description'
tools: "read, grep, custom_tool"
disallowed_tools: [write, edit]
model: provider/model
thinking: high
max_turns: 8
persist_session: false
output_transcript: false
inherit_context: true
skills: [alpha, beta]
extensions: false
memory: local
disabled: false
allowed_subagents: []
isolation: off
prompt_mode: replace
display_name: Test
color: red`),
  );
  const d = loadDefinitions(f).get("test");
  assert.deepEqual(d.tools, ["read", "grep", "custom_tool"]);
  assert.deepEqual(d.disallowedTools, ["write", "edit"]);
  assert.deepEqual(d.skills, ["alpha", "beta"]);
  assert.equal(d.description, "A: quoted description");
  assert.equal(d.maxTurns, 8);
  assert.equal(d.persistSession, false);
  assert.equal(d.outputTranscript, false);
  assert.equal(d.inheritContext, true);
  assert.equal(d.extensions, false);
});

test("malformed and unsupported frontmatter fails closed, never falls back", (t) => {
  const f = fixture(t),
    file = path.join(f.cwd, ".pi/agents/Explore.md");
  for (const header of [
    "tools: [read",
    "tools: false",
    "tools: [read, 2]",
    "tools: null",
    'tools: "read,,write"',
    'tools: "none, read"',
    "tools: ext:mcp",
    "tools: read\ntools: write",
    "disallowed_tools: 42",
    "max_turns: -1",
    "max_turns: 0",
    "max_turns: 101",
    'max_turns: "5"',
    'persist_session: "false"',
    "inherit_context: no",
    "memory: other",
    "name: ../escape",
    "thinking: turbo",
    "allowed_subagents: [Explore]",
    "allowed_subagents: true",
    "isolation: worktree",
    "exclude_extensions: mcp",
    "prompt_mode: append",
    "isolated: true",
    "disabled: true\nenabled: true",
    "maxTurns: 2\nmax_turns: 2",
    "schedule: 5m",
  ]) {
    put(file, md(header));
    assert.throws(() => loadDefinitions(f), undefined, header);
  }
  put(file, "---\ntools: read");
  assert.throws(() => loadDefinitions(f), /unterminated/);
});

test("memory scopes preserve paths, readonly never creates; writable never adds tools", (t) => {
  const f = fixture(t);
  for (const memory of ["user", "project", "local"]) {
    const d = def({ memory, tools: ["read"] });
    const expected =
      memory === "user"
        ? path.join(f.agentDir, "agent-memory/reviewer")
        : path.join(
            f.cwd,
            ".pi",
            memory === "local" ? "agent-memory-local" : "agent-memory",
            "reviewer",
          );
    const snapshot = structuredClone(d);
    const result = prepareResources(d, { ...f, canWrite: true });
    assert.equal(result.memoryDir, expected);
    assert.match(result.prompt, /read-only/);
    assert.equal(fs.existsSync(expected), false);
    assert.deepEqual(d, snapshot);
    put(path.join(expected, "MEMORY.md"), "Remember this.");
    assert.match(prepareResources(d, f).prompt, /Remember this/);
  }
  const denied = def({
    name: "denied",
    memory: "project",
    tools: ["write"],
    disallowedTools: ["write"],
  });
  assert.equal(
    fs.existsSync(prepareResources(denied, { ...f, canWrite: true }).memoryDir),
    false,
  );
  const writer = def({ name: "writer", memory: "project", tools: ["write"] });
  const result = prepareResources(writer, { ...f, canWrite: true });
  assert.equal(fs.statSync(result.memoryDir).isDirectory(), true);
  assert.equal(fs.existsSync(path.join(result.memoryDir, "MEMORY.md")), false);
  assert.match(result.prompt, /read-write/);
});

test("memory snapshot has line and byte limits", (t) => {
  const f = fixture(t),
    d = def({ memory: "project" });
  const file = path.join(f.cwd, ".pi/agent-memory/reviewer/MEMORY.md");
  put(file, `${"line\n".repeat(200)}SECRET_AFTER_LIMIT`);
  assert.doesNotMatch(prepareResources(d, f).prompt, /SECRET_AFTER_LIMIT/);
  put(file, `${"é".repeat(20000)}SECRET_AFTER_BYTES`);
  const prompt = prepareResources(d, f).prompt;
  assert.doesNotMatch(prompt, /SECRET_AFTER_BYTES|\uFFFD/);
  assert.ok(Buffer.byteLength(prompt) < 34000);
});

test("memory rejects traversal and symlinks at each path component", (t) => {
  const f = fixture(t);
  assert.throws(
    () => prepareResources(def({ name: "../out", memory: "user" }), f),
    /unsafe/,
  );
  for (const component of [
    ".pi",
    ".pi/agent-memory",
    ".pi/agent-memory/reviewer",
    ".pi/agent-memory/reviewer/MEMORY.md",
  ]) {
    fs.rmSync(path.join(f.cwd, ".pi"), { recursive: true, force: true });
    const link = path.join(f.cwd, component);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(f.agentDir, link);
    assert.throws(
      () =>
        prepareResources(def({ memory: "project" }), { ...f, canWrite: true }),
      /symlink/,
    );
    assert.deepEqual(fs.readdirSync(f.agentDir), []);
  }
});

test("skills preload global, shared and pi content; missing names fail", (t) => {
  const f = fixture(t);
  put(
    path.join(f.agentDir, "skills/alpha/SKILL.md"),
    md("name: alpha\ndescription: Global", "global skill"),
  );
  put(
    path.join(f.cwd, ".agents/skills/group/beta/SKILL.md"),
    md("name: beta\ndescription: Shared", "shared skill"),
  );
  put(
    path.join(f.cwd, ".pi/skills/alpha/SKILL.md"),
    md("name: alpha\ndescription: Override", "project skill"),
  );
  const result = prepareResources(def({ skills: ["alpha", "beta"] }), f);
  assert.equal(result.skills.length, 2);
  assert.match(result.prompt, /project skill/);
  assert.match(result.prompt, /shared skill/);
  assert.doesNotMatch(result.prompt, /global skill/);
  assert.ok(result.skills.every(path.isAbsolute));
  assert.equal(prepareResources(def({ skills: true }), f).skills.length, 2);
  assert.deepEqual(prepareResources(def({ skills: false }), f).skills, []);
  assert.throws(
    () => prepareResources(def({ skills: ["missing"] }), f),
    /unknown skill/,
  );
});

test("isolated skips every skill and memory read or write", (t) => {
  const f = fixture(t);
  const result = prepareResources(
    def({ memory: "user", skills: ["missing"], tools: ["write"] }),
    { ...f, isolated: true, canWrite: true },
  );
  assert.deepEqual(result, { prompt: "Base.", skills: [] });
  assert.deepEqual(fs.readdirSync(f.agentDir), []);
  assert.deepEqual(fs.readdirSync(f.cwd), []);
});
