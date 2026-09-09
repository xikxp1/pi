# pi-claude-native

Handcrafted, dependency-free Claude Code transport for Pi. Uses the installed
`claude` CLI and its Claude Max login. **Pi owns the agent loop.**

## Use

Loaded globally from `~/.pi/agent/settings.json`:

```json
"packages": ["./packages/pi-claude-native"]
```

Keep your other package entries. Do not also load `pi-claude-bridge`.
Restart Pi after migrating from the old bridge, then select:

```text
/model claude-native/claude-fable-5-1
```

CLI:

```sh
pi --provider claude-native --model claude-fable-5-1
```

`/claude-native-status` shows configuration without exposing prompts or credentials.
Authentication stays in Claude Code; use `claude auth status` / `claude auth login`.
This extension does not copy or refresh OAuth tokens in Pi's `auth.json`.

## What changed

- **Full Pi prompt** forwarded verbatim, followed only by a tool-name mapping.
  Includes `promptGuidelines`, `toolSnippets`, context files, skills and late
  `before_agent_start` modifications. No prompt reconstruction or capture cache.
- **No model allowlist.** Projects all Claude models from Pi's catalog, including
  Fable 5.1. Uses the runtime's persisted catalog on session start when available.
  Pi updates provide new catalog entries; no separate bridge release is needed.
- **Only Pi tools.** A schema-only MCP server advertises Pi's exact JSON schemas.
  It has no executor. Tool calls are returned as ordinary Pi tool calls: Pi does
  validation, permission hooks, execution, questions, updates and result hooks.
- **No AskClaude.** Use the existing Pi `Agent` tool with a `claude-native/...`
  model for delegation. This preserves your Pi subagent harness and its tools.
- **No parked Claude agents.** Each model response has its own process group and
  request files. After the complete response, terminate the process group before
  letting Pi execute any tools. The next call starts from current Pi history.
- **No shared conversation state.** Parent and child sessions, provider switches,
  compaction and branch changes don't need session-ID routing or cursor guesses.
- **Bounded failure.** AbortSignal, idle timeout, absolute deadline, process-group
  SIGTERM/SIGKILL, strict JSONL decoding, malformed-tool rejection and exactly one
  terminal Pi stream event. EOF without a complete response is an error.
- **History fidelity.** Native role/tool-result replay, images, errors, Unicode,
  partial-turn repair, same-provider thinking signatures and redacted reasoning.
  Foreign reasoning signatures are omitted, never repackaged as public text.
- **Pi request hook.** `before_provider_request` receives
  `{ systemPrompt, messages, tools }`; valid replacements are honored. These are
  sensitive fields and are not logged by the extension.

## Implementation

`index.ts` registers the provider. `models.mjs` projects the catalog.
`protocol.mjs` converts history and streams. `transport.mjs` owns the CLI process.
`mcp-schema-server.mjs` only serves schemas, never executes a tool.

Every request:

1. Take Pi's current prompt, messages and active tools (including request hooks).
2. Create a private `0700` temp directory with `0600` prompt/schema/transcript files.
3. Start `claude` there with native tools, hooks, skills, memory and external MCP
   discovery disabled. No user/project settings are loaded; managed policies
   still apply. API-key/routing environment variables are removed in the child
   only, to avoid accidentally using a different billing/authentication path.
4. Resume the request-local transcript, submit the latest user prompt and translate
   a single complete Anthropic response into Pi events.
5. Kill the entire process group, remove request files, then finalize the Pi stream.

**CLI trap:** stdin stream-json is a prompt interface, not an API tool-result
interface. Tool results must already be paired in the resumed transcript.
Tool-result continuations therefore add a short explicit continuation prompt.
The CLI is launched with `--system-prompt-snapshot off` so resumed history cannot
restore obsolete system instructions.

## Configuration and limits

Optional global `~/.pi/agent/claude-native.json` (reload after edits):

```json
{
  "executable": "/absolute/path/to/claude",
  "idleTimeoutMs": 120000,
  "requestTimeoutMs": 600000,
  "killGraceMs": 250,
  "modelIds": {},
  "modelOverrides": {}
}
```

Default advertised limits are deliberately conservative: **200K context / 32K
output**. Anthropic API metadata does not establish Claude Max entitlements.
There is no automatic `[1m]` selection. If a model/account supports a larger
window, explicitly configure both the CLI model ID and Pi's corresponding limit:

```json
{
  "modelIds": { "claude-fable-5-1": "claude-fable-5-1[1m]" },
  "modelOverrides": {
    "claude-fable-5-1": { "contextWindow": 1000000, "maxTokens": 32000 }
  }
}
```

This is an example, not a claim that every account/model accepts that suffix.
Normal Pi `models.json` provider model definitions/overrides are also supported.
Pi thinking levels map to CLI effort; `xhigh` and `max` remain distinct.

### Deliberate limitations

- POSIX only; tested on macOS with Pi 0.85.1 and Claude Code 2.1.266.
- Starts a process for **every model response**, so tool-heavy work has additional
  latency and cache reuse may be lower than a persistent-process bridge.
- Native transcript and stream-json details can change with Claude CLI releases.
  Run live tests after CLI updates. The adapter fails closed on unknown response
  shapes rather than executing unadvertised tools or silently dropping blocks.
- The CLI does not expose Pi's HTTP header/response hooks; no fake HTTP callbacks.
  Temperature/sampling overrides and deferred requests return explicit errors.
  Required strict constrained sampling is rejected; preferred schemas and grammar
  tools use their ordinary JSON schema fallback. `toolChoice: none` is honored.
- Claude controls actual thinking visibility and prompt-cache policy. Pi cache
  retention settings are not translated into undocumented CLI internals.
- Token usage comes from the actual streamed response. Pi reports **estimated
  API-equivalent costs** using Anthropic catalog prices, including cache reads
  and writes. These are **not** Claude Max subscription charges or account
  overages. `modelOverrides` can override `cost` rates (USD per million tokens).
  Previously recorded zero-cost messages are not recalculated.
- No prompt/transcript debug logging. Request temp files are removed on normal
  completion/error/abort; an uncatchable host crash can leave private temp files.
  Claude may retain its own operational metadata despite disabled persistence.
- No special compaction override: summaries use this same stateless provider.
  Full end-to-end automatic compaction, TUI question overlays, every image format
  and workflow orchestration are not all covered by the initial live tests.

## Subagents

Use an explicit provider-qualified model to avoid fuzzy routing to Pi's direct
Anthropic provider (a stale OAuth credential can still look configured):

```text
Agent({ subagent_type: "general-purpose", model: "claude-native/claude-fable-5-1", ... })
```

`~/.pi/agent/agents/Explore.md` preserves the installed Explore prompt/tools but
pins `claude-native/claude-haiku-4-5`. Agent frontmatter is authoritative, so a
caller-provided `model` cannot override that pin. Other agent types retain their
existing model selection. Project-specific agent definitions can override this.

## Tests

```sh
cd ~/.pi/agent/packages/pi-claude-native
npm test                 # Offline, fake-process and conversion regression tests
npm run test:live        # Uses your Claude Max account and installed Pi/Claude
```

The live suite checks history, tool results, concurrent request isolation, real
Fable 5.1 via Pi, snippets/guidelines/late hooks, Pi execution/result hooks and an
actual pi-subagents child using Pi's read tool. Set `PI_CLAUDE_TEST_MODEL` to change
the test model; `PI_SUBAGENTS_EXTENSION` can override that extension's test path.

## Rollback

Replace `"./packages/pi-claude-native"` with `"npm:pi-claude-bridge"` in the
settings package list and remove the new Explore override, then restart Pi.
The old npm package was not uninstalled. The exact pre-migration settings backup
is in `~/.pi/agent/backups/settings.pre-claude-native.*.json`; do not overwrite
newer unrelated settings changes when restoring it. No commits were created.
