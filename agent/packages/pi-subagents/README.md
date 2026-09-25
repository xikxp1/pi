> [!IMPORTANT]
> Remove this line to confirm you've reviewed this PR before submitting.

# Local Pi subagents

A self-contained `subagent` tool for Pi TUI, JSON/print, and Zed through pi-acp. Each call runs a foreground Pi subprocess with a fresh context, saves a real Pi history, and returns its final answer. The coordinated adapter in `~/Projects/pi-acp` supports persistent, live inspect-only child views when Zed negotiates them; older clients keep the existing progress cards. No external subagents package is required.

## Enable

This repository's `agent/settings.json` already includes `"./packages/pi-subagents"`. Restart the Zed ACP session, or run `/reload` in Pi TUI. Do not enable another package registering `subagent` alongside it.

Requires a recent Pi with delta-only JSON events, project-trust CLI flags, and tool-result usage accounting (tested with 0.85.1). Node 22+ is recommended. No dependency installation or build step is needed when loaded by Pi.

## Usage

```json
{
  "task": "Review src/auth.ts for input-validation bugs. Do not edit files. Return findings with file paths and line numbers.",
  "description": "Review authentication",
  "model": "anthropic/claude-haiku-4-5",
  "thinking": "low",
  "timeout": 120
}
```

- `task`: required, self-contained instructions and context (up to 200,000 characters).
- `description`: optional short title (up to 200 characters).
- `timeout`: optional positive number of seconds, with no default timeout.
- `model`: optional exact `provider/model-id` from the Pi model catalog (`pi --list-models`). Supports switching providers and model IDs containing slashes. Unknown IDs, fuzzy names, and thinking suffixes are not accepted as substitutes for an exact catalog ID.
- `thinking`: optional `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Pi applies its normal capability clamping, including `off` for non-reasoning models.

Model and thinking are independent overrides: omit either to inherit that value from the parent. For example, `{"task":"Review the changes","thinking":"off"}` keeps the current model. Specifying only `model` retains the parent's thinking level, subject to the new model's capabilities. Neither override changes the parent's settings, and parallel calls can use different combinations. The chosen provider must be configured and authenticated for the child.

The tool waits for the result. Independent tool calls can run in parallel, up to four active children per parent. Excess calls fail immediately rather than queueing. There are no background jobs, agent presets, workflows, conversational continuation, or nested delegation APIs. Saved child views can be reopened for inspection, not independently prompted.

## Execution and safety

- Inherits the parent's current provider/model and thinking level unless overridden per call. Working directory and project trust always follow the parent. It starts with no parent conversation and a new, persistent child session.
- Loads normal global resources and trusted project resources. Provider credentials come from the normal Pi configuration/environment. Temporary SDK/CLI-only providers or extensions not installed in settings are not automatically copied; unavailable tools/models may fail. Runtime-only API key overrides are not inherited.
- Uses the parent's active tool names as an allowlist. `subagent`, `Agent`/`agent`, `ask_user`, `ask_question`, and `AskUserQuestion` are excluded case-insensitively. A child-side tool-call guard also rejects tools outside this allowlist. Resolve user decisions in the parent before delegating.
- Task text travels over stdin, not through a shell or as CLI flags. Startup network operations are disabled; model/tool requests still work normally.
- This is **context isolation, not a sandbox**. Children share files, permissions, credentials, and installed extensions with the parent. The tool policy does not prevent arbitrary execution through an allowed shell tool or extension. Assign disjoint edits and do not concurrently edit the same files in parent and child.
- Cancellation, timeout, reload, and session shutdown stop children. Pi receives SIGTERM to clean up its tracked shell processes, with forced process-group termination after 1.5 seconds on POSIX. Arbitrarily detached processes created by third-party tools are not guaranteed to be cleaned up. Windows process-tree behavior has not been validated.

## Zed / ACP

With negotiated `clientCapabilities._meta["zed.dev/subagent-sessions"] = {"version":1}`, pi-acp echoes the capability and sets `PI_ACP_SUBAGENT_SESSIONS=1` on the parent. The extension then emits version-2 `register`, sequenced `event`, and `status` records through `ctx.ui.setStatus("pi-acp:subagent-session", ...)`. Registration includes the original parent tool-call ID, a unique stable run ID, file paths, and a random live-only cancellation-file capability. It precedes child output. Event records preserve actual child user/assistant messages and tool execution, not repeated flattened snapshots.

The adapter registers an inspect-only child before linking it from the original parent tool call, buffers output until `session/load`, replays in order, and then streams live updates. Opening a live child never starts another Pi process. Closing the child view only unsubscribes; cancelling it stops only that child. Prompting or configuring it independently is rejected. Parent cancellation/shutdown still stops all its children.

Without negotiation, `PI_ACP_SUBAGENTS=1` retains version-1 snapshots through `ctx.ui.setStatus("pi-acp:subagent", ...)` and the existing expandable `SubagentCards`. Updates remain deduplicated and throttled to approximately 250 ms, including terminal states.

The tool emits this contract directly. `agent/extensions/pi-acp-subagents.ts` may remain installed for legacy event-based packages, but it is not required for this tool, and there is no synthetic manager registry or duplicate legacy lifecycle event stream.

- ACP filesystem socket/capabilities and additional workspace directories are preserved. With `pi-acp-fs.ts` installed, children can read unsaved editor buffers and apply editor-backed changes.
- ACP terminal delegation is disabled in children: their tool IDs do not belong to the parent's ACP tool stream. Shell output instead appears as text inside the subagent card.
- Cards contain assistant text and executed tool calls/results, not user/system messages or thinking blocks. The transcript tail is capped at 64 Ki characters. Only the latest partial tool output is previewed when child tools run concurrently; all finalized results are retained.
- Legacy v1 cards remain ephemeral. Negotiated child views are persistent: custom parent entries and tool-result details preserve their relationship, and reopening replays the exact child event journal, with real Pi history or the visible text transcript as fallback. Children are not listed as independent ACP root sessions. Interrupted executions are shown as failed after restart, never automatically resumed.
- Native child views can show user prompts and thinking as well as assistant text and tools. The v1 card and `output.txt` retain their visible-only policy. Native replay/delivery is ordered but does not impose a hard memory/backlog limit.

## Output and usage

Model-visible answers are capped at 48 KiB or 1900 lines. Each run creates a private directory under `<Pi agent directory>/subagents/pi-subagent-*` (normally `~/.pi/agent/subagents/`). It contains `session.jsonl` (a real Pi-managed history), `events.jsonl` (sequenced child events), `state.json` (terminal state), and `output.txt` (full finalized visible transcript, including interrupted output). Files use mode `0600`; the run directory is private. `sessionFile` and `outputFile` are returned in tool details. These files can contain sensitive prompts, thinking, file contents, and tool output. They are retained until manually deleted; they are no longer subject to OS temporary-file cleanup.

A random `cancel-<uuid>` file is only a live control capability, polled every 250 ms by the owning runner. The adapter never restores cancellation targets or signals PIDs from disk. Its durable child index lives under `~/.pi/pi-acp/children/`; deleting both the run directory and matching index entry removes the saved view.

Persistence failures stop the child and report a failed terminal update even when lifecycle state cannot be saved. Already received output remains in the in-memory result and live bridge; files retain whatever was successfully written.

The JSON parser accepts LF-delimited records, handles fragmented UTF-8 and missing final newlines, and rejects malformed records or records over 16 Mi characters. Stderr is bounded. Child failures set the actual Pi tool error flag through a result hook; reported token/cost usage is preserved on both successful and failed tool results.

## Tests

```sh
npm test --prefix agent/packages/pi-subagents
```

Tests use fake child processes plus real Pi RPC/JSON sessions with a deterministic offline provider and a simulated ACP filesystem socket. No model requests or user credentials are needed. Coverage includes unsaved buffers, context isolation, model/thinking/trust inheritance, independent and parallel model/thinking overrides, cross-provider selection, capability clamping, invalid overrides, tool restrictions, usage, progress cards, bounded output, framing, spawn/provider failures, ENOSPC during registration/state/transcript/journal writes, cancellation, and timeouts. Pi must be on `PATH` for the integration tests.
