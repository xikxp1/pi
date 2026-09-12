# pi-goal-local

Approval-first goals for Pi TUI and Zed through the local pi-acp fork. A goal investigates the project, asks one consequential question at a time, proposes an explicit plan, and waits for user approval before implementation.

## Start

The package is enabled by `./packages/pi-goal` in `agent/settings.json`, after the local [`pi-subagents`](../pi-subagents/README.md) package. Integration targets Pi 0.85.1 and the local protocol-v2 runtime.

Version-3 worker reuse is built into the local runtime (`goalResumeVersion: 1`); no vendor patch or npm subagents dependency is needed. Do not load both subagent runtimes. Once owned workers have settled, restart Pi or reconnect Zed to activate a package migration. A runtime missing managed resume refuses new version-3 execution rather than silently reverting to fresh workers. Existing goal approvals and v1/v2 policies remain unchanged.

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
2. A planner produces acceptance criteria, constraints, risks, small ordered code-writing steps, exact file paths, and exact commands with timeouts and execution checkpoints. The plan must deliver the requested feature, not replace it with preparation-only work.
3. The full proposal shows all four resolved model/thinking/turn-limit profiles and a revision token. Inspect commands carefully: approval authorizes their shell side effects, not just their labels.
4. Approve that revision explicitly:

   ```text
   /goal approve 3-0123456789ab
   ```

   Use the actual token from your plan. `/goal approve` without a token opens a confirmation containing the plan. Ordinary `yes`, `looks good`, or an assistant's statement never count as approval.

5. Isolated implementers execute sequentially. Version-3 plans retain worker context for unfinished steps and checkpoint repairs rather than starting a fresh conversation after each partial result. A new step starts a separate worker. Unfinished work continues without another approval. The coordinator runs exactly the approved commands at their checkpoints. Failed repeatable checks and review findings receive bounded in-scope repairs. An independent reviewer must return a passing assessment with evidence for every acceptance criterion before the goal completes.

### Progress-based continuation and command checkpoints

New proposals include an explicit, approval-token-bound execution policy:

- **Version 3: persistent worker context with no total productive attempt cap per step or repair.** Productive unfinished work continues automatically, without repeated `/goal resume` requests. Each invocation still has its configured turn limit, using the runtime's existing wrap-up grace behavior. Workers are instructed to finish coherent implementations, not return after a small edit while they can still make progress. Continuations carry current scope and feedback instead of resending the full plan; they must not replay completed work. Session reuse is in-memory within one `goal_execute` operation, not across pauses, cancellation, reloads or approval changes. Independent review remains a fresh read-only worker.
- Progress is measured by changes in approved file snapshots, not worker claims. **2 consecutive no-file-progress continuation attempts** pause execution; an observed file change resets this stall counter. Identical rewrites do not count. File changes do not prove useful progress or correctness: a worker that keeps changing files can keep consuming tokens until completion, a blocker, or cancellation. Use `/goal pause` to stop it.
- **2 repair rounds per failing checkpoint**, including a separate independent-review checkpoint. A repair at one checkpoint does not spend another checkpoint's budget. Passing a rerun does not erase its repair count, so alternating failures cannot reset budgets indefinitely. A productive partial repair remains in its current round. Stall and repair-round counters reset only when the user explicitly requests `/goal resume`.
- `completed` means the delegated code-writing step is finished. `continue` means work remains without an external blocker. `blocked` means a concrete external prerequisite, new decision, or operation beyond approved scope is needed. Workers must not call themselves blocked just because tests are delegated to the coordinator.
- Every check can specify `afterStep: 0` to run before any worker, or `afterStep: N` to run immediately after step N. Omission means after the final step. Checkpoints execute in ascending step order, preserving command order within each checkpoint.
- `repeatable: true` explicitly authorizes automatic reruns. Build/test commands usually belong here. Setup, installation, deployment, and other potentially non-idempotent commands should normally use `false` (the default). Exact commands, checkpoints and repeat permissions appear in the proposal.
- Repairs may edit only files belonging to reached steps and may not change the approved plan, acceptance criteria, commands or profiles. Rewinding verification to an earlier checkpoint does not shrink repair scope: files of later steps already reached remain available, while genuinely unreached files remain excluded. They receive actual failed-check/review evidence. Completed workers and successful one-shot commands are not replayed; previously passed repeatable checks are rerun after repairs.
- Failed one-shot commands stop without automatic repair or rerun. `/goal resume` explicitly retries the failed command; inspect its output and partial side effects first.
- Consecutive stalls, repair-round limits, concrete blockers, and settled workers/reviewers missing usable output pause at an inspected checkpoint while retaining approval. Pauses include recorded worker progress and an evidence link; status and the widget label unfinished steps as paused rather than implying a worker is running. `/goal resume` continues unchanged authorized work, without another interview, plan or approval. File drift prevents this continuation.
- Cancellation, uncertain worker settlement, session restoration, scope/profile changes and external changes still require inspection and fresh approval. Existing edits and evidence are preserved. No automatic commits, merges, arbitrary shell commands or scope expansion occur.

**Existing plans are not silently upgraded.** Version-1 policies retain their approved four-attempt cap. Version-2 policies retain fresh-worker continuation and the overall two-repair budget. Plans without an execution policy retain the original stop-on-failure behavior. Reload the extension only after owned work has settled. Then use `/goal revise Keep the implementation scope and retained edits; use version-3 persistent workers and per-checkpoint repairs` once and approve the new proposal explicitly. Merely resuming or reapproving an old plan does not change its policy. Read-only research/planning incur model usage before implementation approval.

## Commands

| Command                                                        | Effect                                                                                                                                                           |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/goal <feature>`                                              | Start a goal, or resume first-use profile setup.                                                                                                                 |
| `/goal help`                                                   | Show command help.                                                                                                                                               |
| `/goal status`                                                 | Show phase, profiles, progress, and pending proposal.                                                                                                            |
| `/goal configure [role]`                                       | Select missing settings, or reconfigure one default role.                                                                                                        |
| `/goal profile <role> <provider/model> <thinking> [maxTurns]`  | Set an explicit default; useful when dialogs are unavailable.                                                                                                    |
| `/goal override <role> <provider/model> <thinking> [maxTurns]` | Override this goal's profile and invalidate its approval.                                                                                                        |
| `/goal answer <text>`                                          | Answer the pending question. Ordinary chat also works.                                                                                                           |
| `/goal approve [revision]`                                     | Approve the displayed exact revision or use confirmation.                                                                                                        |
| `/goal revise <feedback>`                                      | Return to discussion and obtain a new proposal.                                                                                                                  |
| `/goal pause`                                                  | Abort owned work and preserve edits.                                                                                                                             |
| `/goal resume`                                                 | Continue an unchanged authorized checkpoint and reset retry limits; otherwise inspect/reapprove the retained plan. Explicitly retries a failed one-shot command. |
| `/goal cancel`                                                 | Stop the goal and leave goal mode, preserving edits.                                                                                                             |

After a profile override, use `/goal revise <feedback>` to request a fresh plan. New ordinary input during execution pauses it. New input while awaiting approval invalidates the proposal. Revisions preserve failure evidence for the planner, but changing the plan requires new approval. Prefer `/goal resume` for unchanged in-scope continuation; `/goal revise` is not needed just because a worker has unfinished work. Legacy plans still require a revised repair plan after verification/review failure.

## TUI and Zed

- **TUI:** ordinary Pi selection/confirmation dialogs, Markdown plan messages, a status indicator, and a progress widget. Dismiss a question selector to answer in chat instead. Expand tool results for detailed output.
- **Zed/pi-acp:** questions and plans appear as normal agent text through the existing notification bridge. Answer directly in chat or with `/goal answer`. First-use profile selection and optional approval confirmation use the fork's existing permission bridge. Freeform input dialogs and custom terminal widgets are not required.
- The existing `pi-acp-subagents.ts` bridge publishes child progress cards. The extension does not modify pi-acp.
- Extension commands can acknowledge before their injected agent turn finishes. Follow the subsequent goal messages and subagent cards, rather than treating command acknowledgement as completion.
- Pi's normal abort/cancel also propagates to the active goal operation. Use `/goal pause` for an explicit persisted pause. Cancellation does not undo edits.

## Approval and execution boundaries

Approval is bound to goal identity, revision, plan (including execution policy/checkpoints/repeat permissions), recorded answers and feedback, resolved profiles, and hashes of declared files. The approved baseline stays immutable. A separate execution journal records snapshots after owned effects, completed commands, continuation reports, repair attempts and the next checkpoint. Unchanged inspected checkpoints retain the same approval; changed declared files invalidate it. State transitions are extension-owned, not inferred from assistant prose or completion markers.

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
- Research, child output (including settled errors/missing structured output), proposals, every verification attempt, and final review are stored under `agent/goals/<session-id>/<goal-id>/`. Long displayed results link to these artifacts. Failed-check history remains available after a successful repair; review uses the latest result for each command.
- `agent/goal.json`, goal artifacts, and installed copies of bundled agents are ignored by this repository. Artifacts may contain project contents and prompts; remove them manually when no longer needed.
- Invalid profile JSON fails closed. Repair `goal.json` and restart/reload the extension. No credentials are stored in goal configuration.

## Validation

```sh
cd ~/.pi/agent/packages/pi-goal
npm test

# Optional integration against your existing built pi-acp checkout:
PI_GOAL_TEST_ACP=/absolute/path/to/pi-acp/dist/index.js npm test
```

`PI_GOAL_TEST_PI` can override the Pi executable used by the RPC fixture. `PI_GOAL_TEST_SUBAGENTS` can point to another compatible subagents entrypoint. Tests use isolated temporary configuration and a deterministic offline faux provider; they do not spend model credits or access live credentials.

Coverage includes state/profile/path validation, stale approval, branch restoration, parent tool gates, callback races, cancellation, model/thinking and child tool isolation, verification/review failure, real Pi RPC, and optional real pi-acp transport with an ACP client that has no elicitation capability. The ACP test covers both saved profiles and first-use selection, chat answers, explicit-token/confirmation approval, and native child cards.

Live Zed and interactive TUI rendering still require a manual smoke test: start a disposable goal, configure roles, answer a question, reject/revise a plan, approve it, observe productive continuation beyond four attempts and repair, resume a stall-paused checkpoint without reapproval, then interrupt/reload and confirm fresh approval is required.

## Design references

- [wassname/pi-goals](https://github.com/wassname/pi-goals): deliberate interviewing, revision-aware review, and branch-aware restoration. Its edxeth subagent dependency differs from the installed Tintinweb runtime.
- [Pi-Agent-Goal](https://github.com/KristjanPikhof/Pi-Agent-Goal): explicit draft review.
- [@narumitw/pi-goal](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-goal): continuation and pause/resume patterns.
- Pi's official plan-mode and subagent examples: lifecycle/UI and isolated child patterns.

This is an independent local implementation, not an installation or modification of those extensions.
