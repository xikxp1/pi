# pi-goal-local

Approval-first goals for Pi TUI and Zed through the local pi-acp fork. A goal investigates the project, asks one consequential question at a time, proposes an explicit plan, and waits for user approval before implementation.

## Start

The package is enabled by `./packages/pi-goal` in `agent/settings.json`. Restart Pi or reconnect the Zed agent after installation. It requires the installed `@tintinweb/pi-subagents` protocol-v2 runtime; integration is tested against 0.19.0 and Pi 0.85.1.

```text
/goal Add pagination to the search results
```

On first use, choose an authenticated **exact provider/model ID and thinking level for each role**:

- `researcher`: repository investigation, read-only.
- `planner`: structured proposal, read-only.
- `implementer`: one approved step at a time, with read/search/edit/write tools but no shell.
- `reviewer`: independent read-only assessment after verification.

No model or thinking defaults are guessed, inherited, or silently substituted. Canceling setup leaves it incomplete. Resume with `/goal configure`. Maximum turns are bounded at 16/16/24/16 respectively unless explicitly configured.

Profiles are saved in `$PI_CODING_AGENT_DIR/goal.json` (normally `~/.pi/agent/goal.json`). Every goal freezes a copy. Changing a default does not silently change an existing goal.

## Workflow

1. Read-only investigation and a deliberate feature interview. At least one actual user answer and a recorded research result are required before proposing a plan. The model should ask about consequential uncertainty, not facts discoverable in the code.
2. A planner produces acceptance criteria, constraints, risks, ordered steps, exact file paths, and exact verification commands with timeouts.
3. The full proposal shows all four resolved model/thinking/turn-limit profiles and a revision token. Inspect commands carefully: approval authorizes their shell side effects, not just their labels.
4. Approve that revision explicitly:

   ```text
   /goal approve 3-0123456789ab
   ```

   Use the actual token from your plan. `/goal approve` without a token opens a confirmation containing the plan. Ordinary `yes`, `looks good`, or an assistant's statement never count as approval.
5. Fresh isolated implementers execute sequentially. The coordinator runs exactly the approved verification commands. An independent reviewer must return a passing assessment with evidence for every acceptance criterion before the goal completes.

A failed check, blocked worker, missing structured output, stale approval, or failed review stops the workflow. It does not automatically repair, replan, merge, or commit. Read-only research/planning incur model usage before implementation approval.

## Commands

| Command | Effect |
| --- | --- |
| `/goal <feature>` | Start a goal, or resume first-use profile setup. |
| `/goal help` | Show command help. |
| `/goal status` | Show phase, profiles, progress, and pending proposal. |
| `/goal configure [role]` | Select missing settings, or reconfigure one default role. |
| `/goal profile <role> <provider/model> <thinking> [maxTurns]` | Set an explicit default; useful when dialogs are unavailable. |
| `/goal override <role> <provider/model> <thinking> [maxTurns]` | Override this goal's profile and invalidate its approval. |
| `/goal answer <text>` | Answer the pending question. Ordinary chat also works. |
| `/goal approve [revision]` | Approve the displayed exact revision or use confirmation. |
| `/goal revise <feedback>` | Return to discussion and obtain a new proposal. |
| `/goal pause` | Abort owned work and preserve edits. |
| `/goal resume` | Inspect partial work and require fresh approval; completed steps are not replayed. |
| `/goal cancel` | Stop the goal and leave goal mode, preserving edits. |

After a profile override, use `/goal revise <feedback>` to request a fresh plan. New ordinary input during execution pauses it. New input while awaiting approval invalidates the proposal. Resume after failed verification/review asks for a revised repair plan, not an automatic retry of completed work.

## TUI and Zed

- **TUI:** ordinary Pi selection/confirmation dialogs, Markdown plan messages, a status indicator, and a progress widget. Dismiss a question selector to answer in chat instead. Expand tool results for detailed output.
- **Zed/pi-acp:** questions and plans appear as normal agent text through the existing notification bridge. Answer directly in chat or with `/goal answer`. First-use profile selection and optional approval confirmation use the fork's existing permission bridge. Freeform input dialogs and custom terminal widgets are not required.
- The existing `pi-acp-subagents.ts` bridge publishes child progress cards. The extension does not modify pi-acp.
- Extension commands can acknowledge before their injected agent turn finishes. Follow the subsequent goal messages and subagent cards, rather than treating command acknowledgement as completion.
- Pi's normal abort/cancel also propagates to the active goal operation. Use `/goal pause` for an explicit persisted pause. Cancellation does not undo edits.

## Approval and execution boundaries

Approval is bound to goal identity, revision, plan, recorded answers, resolved profiles, and hashes of declared files. Changed declared files invalidate approval before execution. State transitions are extension-owned, not inferred from assistant prose or completion markers.

While a nonterminal goal is active, the parent cannot use write, edit, shell, generic delegation, wrapper tools, or unknown extension tools. Only the goal executor may coordinate implementation. Goal children disable extensions, skills, memory, and nested delegation; read-only roles have no write or shell tools. The four bundled `PiGoal*` definitions are installed into the global agent directory and checked before each dispatch. Modified or shadowing definitions fail closed instead of silently changing child policy.

This is **workflow enforcement, not an OS sandbox**:

- Declared step file ownership is conveyed to workers and checked against their reported output. It is not a filesystem capability boundary. Snapshots cover declared files, not the entire repository.
- Children can read local files. Repository instructions and plans can influence model behavior; do not treat an untrusted project as safe merely because goal mode is enabled.
- Approved shell commands can have arbitrary side effects, including network access and writes outside the declared files. The coordinator executes them locally, not through an ACP terminal permission prompt. Review the exact commands before approval.
- Other trusted extensions and manual user commands are outside the model tool gate. Do not manually steer goal-owned workers or run competing writers while a goal executes.
- A worker stop acknowledgement alone does not prove its tools have finished. New dispatch remains locked until terminal completion. The installed runtime's queued-cancellation case is released only when a synchronous queued-to-stopped registry transition proves it never started. Uncertain ownership stays locked; restarting Pi may be required if a backend never reports settlement. Check for leftover work first.

## Persistence and artifacts

- Authoritative state is stored in `pi-goal:state:v1` entries on the **active session branch**.
- Reloading, reopening, or switching branches never auto-executes an approved/interrupted goal. It restores paused state and requires fresh approval.
- Research, full child output, proposals, verification output, and final review are stored under `agent/goals/<session-id>/<goal-id>/`. Long displayed results link to these artifacts.
- `agent/goal.json`, goal artifacts, and installed copies of bundled agents are ignored by this repository. Artifacts may contain project contents and prompts; remove them manually when no longer needed.
- Invalid profile JSON fails closed. Repair `goal.json` and restart/reload the extension. No credentials are stored in goal configuration.

## Validation

```sh
cd ~/.pi/agent/packages/pi-goal
npm test

# Optional integration against your existing built pi-acp checkout:
PI_GOAL_TEST_ACP=/absolute/path/to/pi-acp/dist/index.js npm test
```

`PI_GOAL_TEST_PI` can override the Pi executable used by the RPC fixture. `PI_GOAL_TEST_SUBAGENTS` can point to another installed subagents entrypoint. Tests use isolated temporary configuration and a deterministic offline faux provider; they do not spend model credits or access live credentials.

Coverage includes state/profile/path validation, stale approval, branch restoration, parent tool gates, callback races, cancellation, model/thinking and child tool isolation, verification/review failure, real Pi RPC, and optional real pi-acp transport with an ACP client that has no elicitation capability. The ACP test covers both saved profiles and first-use selection, chat answers, explicit-token/confirmation approval, and native child cards.

Live Zed and interactive TUI rendering still require a manual smoke test: start a disposable goal, configure roles, answer a question, reject/revise a plan, approve it, interrupt execution, and resume with fresh approval.

## Design references

- [wassname/pi-goals](https://github.com/wassname/pi-goals): deliberate interviewing, revision-aware review, and branch-aware restoration. Its edxeth subagent dependency differs from the installed Tintinweb runtime.
- [Pi-Agent-Goal](https://github.com/KristjanPikhof/Pi-Agent-Goal): explicit draft review.
- [@narumitw/pi-goal](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-goal): continuation and pause/resume patterns.
- Pi's official plan-mode and subagent examples: lifecycle/UI and isolated child patterns.

This is an independent local implementation, not an installation or modification of those extensions.
