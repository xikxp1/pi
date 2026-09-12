# pi-subagents-local

A small, independently implemented delegation runtime for this Pi harness. This is a local rewrite, not a vendored fork or runtime patch of `@tintinweb/pi-subagents`.

## Installation and migration

Requires Pi 0.85.1-compatible SDK APIs and Node 24. Dependencies are locked locally:

```sh
cd ~/.pi/agent/packages/pi-subagents
npm ci --ignore-scripts
npm test
```

In `agent/settings.json`, use `./packages/pi-subagents` before `./packages/pi-goal`, **instead of** `npm:@tintinweb/pi-subagents`. Never load both runtimes. Local packages are not installed by npm automatically; run the dependency command after cloning this harness.

Changing settings does not replace a running extension. Let workers settle, then restart Pi or reconnect Zed. Existing goal approvals, transcripts, agent definitions, and memory directories are not rewritten. The old installed npm files can remain unused while live sessions finish; this package never imports them. No vendor patch is required.

## Retained capabilities

- `Agent`, `get_subagent_result`, and `steer_subagent`, with background notifications and foreground joins.
- Case-insensitive agent types, named handles, explicit/fuzzy model selection, thinking overrides, tool allowlists/denylists, and optional context inheritance.
- Persistent SDK sessions and same-session, same-worker continuation. A single queue governs both fresh and resumed work. Turn limits are per invocation: a wrap-up warning at the limit, then a five-turn grace period.
- Protocol-v2 `subagents:rpc:ping/spawn/stop/consume`, lifecycle events, and the `Symbol.for("pi-subagents:manager")` registry expected by pi-goal and the ACP bridge.
- Native `goalResumeVersion: 1`: managed resume requires an invocation token and preserves the session and structured-output tool. Terminal events carry that token. Cancellation holds ownership until work actually settles.
- Scripted workflows, direct `@agent` mentions, persistent memory, and skill preloading.

**Not supported:** scheduling, git worktree isolation, nested delegation, hidden model-driven mention clones, or upstream fleet/graph UI. Unsupported scheduling/worktree/delegation requests fail rather than silently executing in a different scope. There is no automatic commit behavior.

## Agent definitions and resources

Discovery precedence: built-ins < `<agentDir>/agents` < `<cwd>/.agents/agents` < `<cwd>/.pi/agents`. Exact names override; ambiguous case variants, disabled agents, malformed definitions, and unknown types fail closed. Built-ins are `general-purpose`, `Explore`, and `Plan`. Definitions are reloaded before each new dispatch.

Supported frontmatter includes `name`, `description`, `model`, `thinking`, `tools`, `disallowed_tools`, `max_turns` (1..100), `persist_session`, `output_transcript`, `inherit_context`, `extensions`, `skills`, `memory`, `disabled`/`enabled`, and `prompt_mode: replace`. Explicit false values are preserved. Tool selectors are exact names; `none` disables tools and `all`/`*` selects built-ins. Extension tools can be named explicitly, or all tools are available when `tools` is omitted. Restrictions never grant delegation tools. Unknown frontmatter is rejected rather than ignored.

Memory uses `agent-memory/<type>` under the global agent directory, `.pi/agent-memory/<type>` for project memory, and `.pi/agent-memory-local/<type>` for local memory. `MEMORY.md` is injected as a bounded snapshot (200 lines/32 KiB). Read-only agents do not create memory paths. `memory: false` disables it; symlink/traversal memory paths are refused.

`skills: [name, ...]` preloads named skill bodies; `skills: true` preloads discovered local/package skills. Project skills override global/package entries. Relative references resolve from each skill's directory. Isolated workers get neither skills nor memory, regardless of defaults.

Settings are read from global and project `.pi/subagents.json`. Supported settings include `maxConcurrent` (1..64, default 10), `rememberAgents`, `outputTranscript`, `workflowsEnabled`, `agentMentions: off`, and `scopeModels`. With `scopeModels: true`, configured Pi `enabledModels` constrain all child model choices, including frontmatter pins. Upstream UI-only settings have no effect.

## Provider and extension ownership

Providers and authentication are parent-owned. The runtime uses an explicit, restricted SDK facade: it does not expose backing credential/provider collections, ignores child provider registration/unregistration, and rejects explicit child credential mutation. Normal streaming and authentication use the parent's coordinated runtime, preserving temporary keys and OAuth refresh behavior. Enable providers in the parent before delegating.

Each child has its own session, tool registry and extension instances. Goal, subagent, and ACP orchestration extensions are excluded before their factories execute. Isolated children execute no extension factories. Non-isolated children may load configured tool extensions; missing requested extensions fail closed. This is capability scoping, **not an OS security sandbox**: trusted extensions, bash, and permitted tools retain their normal system access.

## Mentions and management

In TUI/RPC sessions, `@Explore inspect the parser` starts an agent directly. A handle can steer a running agent or resume its settled session. `@main text` bypasses mention routing; unknown handles/file-like mentions remain normal input. No hidden extra model call constructs the prompt. Print-mode mentions remain ordinary parent input instead of detaching work into a process that may exit.

`/agents` offers a simple list/detail/action menu. Text commands are also available:

```text
/agents list
/agents show <id-or-handle>
/agents stop <id-or-handle>
/agents steer <id-or-handle> <message>
/agents resume <id-or-handle> <message>
/agents workflows
/agents workflows <run-id>
/agents workflows stop <run-id>
```

ACP progress cards continue through the existing `agent/extensions/pi-acp-subagents.ts` bridge. Persistent session files remain readable in Pi, but active handles and managed goal reuse do not cross parent-session replacement/restart.

## Workflows

`SubagentWorkflow` is explicitly opt-in orchestration. Its description documents `agent`, `parallel`, `pipeline`, `workflow`, `phase`, `log`, `args`, and `budget`. Source starts with a pure-literal `export const meta = { name, description }`. Saved scripts resolve from `.pi/workflows`, `.agents/workflows`, then `<agentDir>/workflows`.

Workers execute scripts off the host event loop, with no filesystem/network/module globals or dynamic code generation. Nondeterministic time/random APIs are blocked. This is a determinism/accident boundary, not a promise to contain hostile Node code.

Structured agent results are validated against their schema. Gate commands execute after a child in the project cwd, with bounded output and cancellation. Child failures become `null`; invalid options/cap violations fail the run. Child `resume` preserves context, including the prior structured result mode.

Journals retain successful unchanged-prefix results for `resumeFromRunId` within the same parent session. Changes or failed calls end replay; later work runs live. Runs containing child `resume` are not journal-replayable. Workflow stop/disposal waits for owned agents and gates to unwind. The workflow pool is shared across runs and also uses the main agent queue; this deliberately simplifies upstream's separate pools.

## Verification

```sh
npm test
cd ../pi-goal
PI_GOAL_TEST_ACP=/Users/xikxp1/Projects/pi-acp/dist/index.js npm test
cd ../pi-claude-native
npm test
```

Tests use temporary configuration, fake sessions/providers, and real offline Pi RPC/ACP processes. Live Claude tests remain opt-in. No tests need to restart a live harness or edit a project under development.
