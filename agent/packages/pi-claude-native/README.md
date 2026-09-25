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
/model claude-native/claude-opus-5-5[1m]
```

CLI:

```sh
pi --provider claude-native --model 'claude-opus-5-5[1m]'
```

`/claude-native-status` shows discovery source, cache age, errors, unknown pricing,
limits and configuration without exposing prompts or credentials.
`/claude-native-refresh` rediscovers models and updates the selector without a
restart. `/reload` also rediscovers models and rereads configuration.
Authentication stays in Claude Code; use `claude auth status` / `claude auth login`.
This extension does not copy or refresh OAuth tokens in Pi's `auth.json`.

## What changed

- **Full Pi prompt** forwarded verbatim, followed only by a tool-name mapping.
  Includes `promptGuidelines`, `toolSnippets`, context files, skills and late
  `before_agent_start` modifications. No prompt reconstruction or capture cache.
- **Claude Code model discovery.** Runs a bounded, isolated CLI initialization
  handshake without sending a user prompt. Only the CLI's reported models appear,
  including new models absent from Pi's catalog. Equivalent aliases are deduplicated
  into resolved IDs; explicit `[1m]` variants retain their 1M context. Older CLIs
  without resolved IDs retain their aliases. Discovery completes before startup
  selection and `pi --list-models`; no SDK dependency or inference request is needed.
- **Offline fallback.** Successful discoveries are saved atomically with private
  permissions in `~/.pi/agent/claude-native-cache/models.json`. Failure uses the last
  successful list with a visible stale warning. With no valid cache there are no
  automatic provider entries, never a fallback to Pi's catalog. Cache entries are
  tied to the configured executable, but can be stale after account changes; refresh
  after switching accounts. Only model metadata is cached, not account details.
  An empty or malformed response is treated as a discovery failure.
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
- **Pi transcript compatibility.** Current Pi stores system instructions and tool
  declarations in `messages`, not separate context fields. The transport replays
  system text, named section updates/removals and tool additions/removals into
  Claude's current system prompt and tool schemas before converting history.
  Legacy `{ systemPrompt, messages, tools }` contexts remain supported.
- **Pi request hook.** `before_provider_request` receives
  `{ systemPrompt, messages, tools }` after transcript projection; valid replacements
  (including cleared instructions) are honored. System-role messages added by a
  hook are folded into the system prompt, never dropped or sent as user text.
  Unsupported system content fails explicitly. These sensitive fields are not logged.

## Implementation

`index.ts` registers the provider. `discovery.mjs` discovers and caches CLI models.
`models.mjs` normalizes discoveries and enriches exact matches with catalog metadata.
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

**CLI trap: resume repair.** On `--resume`, Claude Code treats history ending in
a `tool_result` as an _interrupted turn_. It appends a synthetic user
"Continue from where you left off." and a synthetic assistant reply
"No response requested." before the stdin prompt. The model then believes it
answered that way itself and wastes a turn correcting it (seen after every
`ask_user` call). The transport passes `--resume-session-at <uuid of Pi's last
history record>`. Print mode applies that truncation _after_ the repair, so
both synthetic messages are dropped. `--resume-session-at` is **undocumented**
(absent from `claude --help`). Support is checked once per executable without
inference: a resume at an unknown uuid must fail with "No message found".

- Supported: the flag is passed on every resumed request.
- `unknown option`: plain resume fallback, plus a visible warning and a
  `/claude-native-status` entry. The synthetic messages can reappear.
- Inconclusive check (timeout, unexpected output): the request fails with an
  explicit error. The check is not cached and runs again on the next request.

`npm run test:live` asserts support and that no synthetic messages reach the
model. Run it after every CLI update.

## Configuration and limits

Optional global `~/.pi/agent/claude-native.json` (reload after edits):

```json
{
  "executable": "/absolute/path/to/claude",
  "idleTimeoutMs": 120000,
  "requestTimeoutMs": 600000,
  "killGraceMs": 250,
  "discoveryTimeoutMs": 10000,
  "modelIds": {},
  "modelOverrides": {}
}
```

Discovered **`[1m]` variants advertise 1M context** and pass that suffix to the CLI,
even when `resolvedModel` omits it (as with Fable). Other models remain capped at
**200K context / 32K output**, or smaller exact catalog limits. Discovery does not
supply numeric output limits, prices, or vision capabilities. Unknown models are
text-only until an exact catalog entry or a verified `input` override supplies
vision support. Effort choices come from the CLI, not the API catalog; a model
without advertised effort controls has no selectable Pi thinking levels.

Overrides remain available for verified metadata and limits. Base-ID overrides
apply to discovered `[1m]` variants; exact variant keys take precedence. Inherited
base `modelIds` mappings retain `[1m]`; an exact variant mapping is used verbatim.
For example, explicitly cap a discovered model's output:

```json
{
  "modelOverrides": {
    "claude-fable-5-1[1m]": { "maxTokens": 32000 }
  }
}
```

Discovery reflects the CLI's reported choices, not a guarantee that every request
will succeed or an exhaustive list of all accepted explicit IDs. Catalog-only
older entries are no longer automatically listed. Select the current discovered
ID when migrating saved selections, agent model pins, or scoped-model patterns.
Normal Pi `models.json` provider model definitions/overrides are still supported
as explicit user additions; `modelOverrides` alone does not enumerate new models.
Pi thinking levels map to CLI effort; `xhigh` and `max` remain distinct.

### Deliberate limitations

- POSIX only; discovery tested on macOS with Pi 0.87.0 and Claude Code 2.1.280.
  Each extension load (including a subagent) initializes the CLI, bounded by
  `discoveryTimeoutMs`, plus process cleanup. No long-lived discovery process remains.
- Starts a process for **every model response**, so tool-heavy work has additional
  latency and cache reuse may be lower than a persistent-process bridge.
- Native transcript and stream-json details can change with Claude CLI releases.
  Run live tests after CLI updates. The resume-repair suppression depends on the
  undocumented `--resume-session-at` flag (see _CLI trap: resume repair_). The adapter fails closed on unknown response
  shapes rather than executing unadvertised tools or silently dropping blocks.
- The CLI does not expose Pi's HTTP header/response hooks; no fake HTTP callbacks.
  Temperature/sampling overrides and deferred requests return explicit errors.
  Required strict constrained sampling is rejected; preferred schemas and grammar
  tools use their ordinary JSON schema fallback. `toolChoice: none` is honored.
- Claude controls actual thinking visibility and prompt-cache policy. Pi cache
  retention settings are not translated into undocumented CLI internals.
- Token usage comes from the actual streamed response. Pi reports **estimated
  API-equivalent costs** using exact-model Anthropic catalog prices, including
  cache reads and writes. For a new model with no known prices, Pi requires numeric
  rates: zero placeholders are used and `/claude-native-status` identifies them as
  **unknown, not free usage**. No prices are borrowed from an older model. These
  estimates are **not** Claude Max subscription charges or account overages.
  `modelOverrides` can override `cost` rates (USD per million tokens).
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
Agent({ subagent_type: "general-purpose", model: "claude-native/claude-fable-5-1[1m]", ... })
```

Use discovered IDs for agent model pins (currently Haiku resolves to
`claude-native/claude-haiku-4-5-20251001`). Existing `Explore.md` definitions may
still pin the earlier undated alias; review them when migrating. Agent frontmatter
is authoritative, so a caller-provided `model` cannot override that pin. Other
agent types retain their existing model selection. Project-specific agent
definitions can override this.

## Tests

```sh
cd ~/.pi/agent/packages/pi-claude-native
npm test                 # Offline, fake-process and conversion regression tests
npm run test:live        # Uses your Claude Max account and installed Pi/Claude
```

The offline suite also checks initialization without prompts, bounded failures,
process-group cleanup, private cache fallback, alias/context/effort mapping, and
installed-Pi `--list-models` startup discovery. No inference is used by those tests.

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
