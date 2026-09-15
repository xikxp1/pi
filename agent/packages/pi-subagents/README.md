# Local Pi subagents

A self-contained `subagent` tool for Pi TUI, JSON/print, and Zed through pi-acp. Each call runs a foreground Pi subprocess with a fresh context and returns its final answer. No external subagents package or ACP adapter changes are needed for the adapter in `~/Projects/pi-acp`.

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

The tool waits for the result. Independent tool calls can run in parallel, up to four active children per parent. Excess calls fail immediately rather than queueing. There are no background jobs, agent presets, workflows, memory, resume, or nested delegation APIs.

## Execution and safety

- Inherits the parent's current provider/model and thinking level unless overridden per call. Working directory and project trust always follow the parent. It starts with no parent conversation or persisted child session.
- Loads normal global resources and trusted project resources. Provider credentials come from the normal Pi configuration/environment. Temporary SDK/CLI-only providers or extensions not installed in settings are not automatically copied; unavailable tools/models may fail. Runtime-only API key overrides are not inherited.
- Uses the parent's active tool names as an allowlist. `subagent`, `Agent`/`agent`, `ask_user`, `ask_question`, and `AskUserQuestion` are excluded case-insensitively. A child-side tool-call guard also rejects tools outside this allowlist. Resolve user decisions in the parent before delegating.
- Task text travels over stdin, not through a shell or as CLI flags. Startup network operations are disabled; model/tool requests still work normally.
- This is **context isolation, not a sandbox**. Children share files, permissions, credentials, and installed extensions with the parent. The tool policy does not prevent arbitrary execution through an allowed shell tool or extension. Assign disjoint edits and do not concurrently edit the same files in parent and child.
- Cancellation, timeout, reload, and session shutdown stop children. Pi receives SIGTERM to clean up its tracked shell processes, with forced process-group termination after 1.5 seconds on POSIX. Arbitrarily detached processes created by third-party tools are not guaranteed to be cleaned up. Windows process-tree behavior has not been validated.

## Zed / ACP

In RPC mode with `PI_ACP_SUBAGENTS=1`, progress is sent as version-1 JSON snapshots through `ctx.ui.setStatus("pi-acp:subagent", ...)`. The existing pi-acp `SubagentCards` translator turns these into expandable pending/running/completed/failed ACP tool cards. IDs are unique per run, updates are deduplicated and throttled to approximately 250 ms, and terminal states are always sent.

The tool emits this contract directly. `agent/extensions/pi-acp-subagents.ts` may remain installed for legacy event-based packages, but it is not required for this tool, and there is no synthetic manager registry or duplicate legacy lifecycle event stream.

- ACP filesystem socket/capabilities and additional workspace directories are preserved. With `pi-acp-fs.ts` installed, children can read unsaved editor buffers and apply editor-backed changes.
- ACP terminal delegation is disabled in children: their tool IDs do not belong to the parent's ACP tool stream. Shell output instead appears as text inside the subagent card.
- Cards contain assistant text and executed tool calls/results, not user/system messages or thinking blocks. The transcript tail is capped at 64 Ki characters. Only the latest partial tool output is previewed when child tools run concurrently; all finalized results are retained.
- Live cards are ephemeral, not native Zed child threads. On session reload, ordinary persisted tool results remain, but live cards are not reconstructed. Other ACP adapters without this snapshot extension still receive ordinary tool progress/results.

## Output and usage

Model-visible answers are capped at 48 KiB or 1900 lines. Each run writes the full finalized visible transcript to a private temporary directory (`pi-subagent-*/output.txt`, file mode `0600`), including interrupted visible output on failure. `outputFile` is returned in tool details and shown as an ACP location. These files can contain sensitive tool output; they are retained for inspection and left to OS/user temporary-file cleanup.

The JSON parser accepts LF-delimited records, handles fragmented UTF-8 and missing final newlines, and rejects malformed records or records over 16 Mi characters. Stderr is bounded. Child failures set the actual Pi tool error flag through a result hook; reported token/cost usage is preserved on both successful and failed tool results.

## Tests

```sh
npm test --prefix agent/packages/pi-subagents
```

Tests use fake child processes plus real Pi RPC/JSON sessions with a deterministic offline provider and a simulated ACP filesystem socket. No model requests or user credentials are needed. Coverage includes unsaved buffers, context isolation, model/thinking/trust inheritance, independent and parallel model/thinking overrides, cross-provider selection, capability clamping, invalid overrides, tool restrictions, usage, progress cards, bounded output, framing, spawn/provider failures, cancellation, and timeouts. Pi must be on `PATH` for the integration tests.
