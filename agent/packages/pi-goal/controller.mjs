import { SubagentClient } from "./subagents.mjs";
import { ContinuationPause, runBoundedExecution } from "./execution.mjs";
import {
  STATE_TYPE,
  EXECUTION_POLICY,
  ROLES,
  TURN_LIMITS,
  AGENT_TYPES,
  clone,
  hash,
  text,
  profile,
  profiles,
  newGoal,
  approvalToken,
  isApproved,
  invalidate,
  askQuestion,
  answerQuestion,
  propose,
  approve,
  pause,
  restore,
  toolAllowed,
  renderQuestion,
  renderProfiles,
  renderPlan,
  renderStatus,
  validatePlan,
  PLAN_SCHEMA,
  REVIEW_SCHEMA,
  validateReview,
  compiled,
} from "./core.mjs";
import {
  readConfig,
  saveConfig,
  ensureAgents,
  snapshot as snapshotFiles,
  changedFiles,
  artifactDir,
  saveArtifact,
} from "./storage.mjs";

const HELP = `Goal workflow\n\n/goal <feature> - start a deliberate feature interview\n/goal configure [role] - pick missing profile settings (or reconfigure one role)\n/goal profile <role> <provider/model> <thinking> [maxTurns] - save a default\n/goal override <role> <provider/model> <thinking> [maxTurns] - change this goal and invalidate approval\n/goal answer <text> - answer the pending question (ordinary chat also works)\n/goal approve <revision> - approve the displayed plan and start\n/goal approve - review a confirmation dialog\n/goal revise <feedback> - return to discussion\n/goal pause - stop goal-owned work\n/goal resume - continue an unchanged checkpoint; inspect and reapprove changed authority\n/goal status - show state, profiles, and pending plan\n/goal cancel - stop and leave goal mode\n\nNo default models are chosen. No automatic commits or merges. New plans include bounded in-scope continuation and repairs. Shell commands run only as displayed in an approved plan. Freeform dialogs are never required.`;
const SHORT = 16000;
const clip = (value, max = SHORT) => {
  const content = String(value ?? "");
  return content.length <= max
    ? content
    : content.slice(0, max) +
        "\n[Truncated; full result is in the linked goal artifact.]";
};
const toolResult = (content, details = {}, terminate = false) => ({
  content: [{ type: "text", text: content }],
  details,
  ...(terminate ? { terminate: true } : {}),
});
const parameters = (properties) => ({
  type: "object",
  properties,
  additionalProperties: false,
});
const WORK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "summary", "files"],
  properties: {
    status: { type: "string", enum: ["completed", "continue", "blocked"] },
    summary: { type: "string" },
    files: { type: "array", items: { type: "string" } },
  },
};
function validateWork(value, step) {
  if (!value || !["completed", "continue", "blocked"].includes(value.status))
    throw new Error(
      "Worker must report completed, continue (unfinished), or blocked (external input required)",
    );
  const summary = text(value.summary, "Worker summary", 12000);
  if (
    !Array.isArray(value.files) ||
    value.files.some((file) => !step.files.includes(file))
  )
    throw new Error("Worker reported files outside its approved step");
  return { status: value.status, summary, files: value.files };
}

export function installGoal(pi, deps) {
  const { agentDir, getSupportedThinkingLevels, parseFrontmatter } = deps;
  const snapshot = deps.snapshot ?? snapshotFiles;
  let state = null;
  let busy = false;
  let configuring = null;
  let operation = null;
  let generation = 0;
  let contextText = "";
  let client;
  let runtimeActive = false;
  let configError = null;
  let defaults = { version: 1, profiles: {} };
  const clientFactory =
    deps.clientFactory ?? ((events) => new SubagentClient(events));
  const initializeClient = () => {
    client ??= clientFactory(pi.events);
  };
  const persist = (ctx) => {
    if (!runtimeActive) return;
    if (state) pi.appendEntry(STATE_TYPE, clone(state));
    if (ctx?.mode === "tui") {
      ctx.ui.setStatus(
        "pi-goal",
        state && !["cancelled", "completed"].includes(state.phase)
          ? `goal: ${state.phase}`
          : undefined,
      );
      ctx.ui.setWidget(
        "pi-goal",
        state && !["cancelled", "completed"].includes(state.phase)
          ? [
              state.feature.slice(0, 160),
              ...state.progress.map(
                (p) =>
                  `${p.status}: ${state.plan?.steps.find((s) => s.id === p.id)?.title ?? p.id}`,
              ),
            ]
          : undefined,
      );
    }
  };
  const show = (ctx, message) => {
    if (!runtimeActive) return;
    // pi-acp does not render every custom-message kind. notify is explicitly
    // bridged as an ACP agent_message_chunk; persist the content separately.
    if (ctx.mode === "rpc") {
      ctx.ui.notify(message, "info");
      pi.sendMessage(
        { customType: "pi-goal", content: message, display: false },
        { deliverAs: "nextTurn" },
      );
    } else
      pi.sendMessage(
        { customType: "pi-goal", content: message, display: true },
        { deliverAs: "nextTurn" },
      );
  };
  const kickoff = (message) =>
    pi.sendUserMessage(message, { deliverAs: "followUp" });
  const activeState = () => {
    if (!state || ["completed", "cancelled"].includes(state.phase))
      throw new Error("Start a goal with /goal <feature>");
    return state;
  };
  const assertNotBusy = () => {
    if (busy || configuring || client?.hasUnsettled)
      throw new Error(
        "Goal work is still active. Use /goal pause and wait for the worker to stop.",
      );
  };
  const dir = (ctx, goal) =>
    artifactDir(agentDir, ctx.sessionManager.getSessionId(), goal.id);
  const record = async (ctx, goal, label, value) =>
    saveArtifact(dir(ctx, goal), label, value);
  const availableProfile = (value, ctx) => {
    const p = profile(value);
    const slash = p.model.indexOf("/");
    const model = ctx.modelRegistry.find(
      p.model.slice(0, slash),
      p.model.slice(slash + 1),
    );
    if (!model || `${model.provider}/${model.id}` !== p.model)
      throw new Error(
        `Model is unavailable: ${p.model}. No fallback was selected.`,
      );
    if (!ctx.modelRegistry.hasConfiguredAuth(model))
      throw new Error(`Authentication is not configured for ${p.model}`);
    if (!getSupportedThinkingLevels(model).includes(p.thinking))
      throw new Error(
        `${p.model} does not support ${p.thinking} thinking. Choose a supported level; it will not be silently clamped.`,
      );
    return p;
  };
  const preflight = async (ctx, goal, signal) => {
    if (configError) throw new Error(configError);
    for (const role of ROLES)
      availableProfile(profiles(goal.profiles, true)[role], ctx);
    await ensureAgents(agentDir, ctx.cwd, parseFrontmatter);
    initializeClient();
    await client.ping(signal);
  };
  const contextFor = (goal) =>
    `Feature (user wording):\n${goal.feature}\n\nRecorded user decisions:\n${JSON.stringify(goal.answers)}\n\nAdditional user feedback:\n${JSON.stringify(goal.feedback ?? [])}\n\nResearch:\n${JSON.stringify(goal.research)}\n\nApplicable project instructions:\n${contextText || "Read applicable AGENTS.md files before acting."}`;

  async function configure(ctx, role) {
    if (configuring || busy || client?.hasUnsettled)
      throw new Error("Cannot configure profiles while goal work is active");
    if (role && !ROLES.includes(role))
      throw new Error(`Role must be ${ROLES.join(", ")}`);
    if (!ctx.hasUI)
      throw new Error(
        "Interactive profile setup is unavailable. Use /goal profile <role> <provider/model> <thinking>.",
      );
    if (configError) throw new Error(configError);
    const controller = new AbortController();
    configuring = controller;
    const captured = state;
    try {
      const roles = role
        ? [role]
        : ROLES.filter((r) => !captured?.profiles[r] && !defaults.profiles[r]);
      for (const r of roles) {
        const models = ctx.modelRegistry
          .getAvailable()
          .slice()
          .sort((a, b) =>
            `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`),
          );
        if (!models.length)
          throw new Error(
            "No authenticated models are available. Configure a provider in Pi first.",
          );
        const names = models.map((m) => `${m.provider}/${m.id}`);
        const chosen = await ctx.ui.select(`Goal ${r}: select model`, names, {
          signal: controller.signal,
        });
        if (controller.signal.aborted || !chosen) return false;
        const model = models[names.indexOf(chosen)];
        if (!model) throw new Error("The selected model was not offered");
        const levels = getSupportedThinkingLevels(model);
        const thinking = await ctx.ui.select(
          `Goal ${r}: thinking level`,
          levels,
          { signal: controller.signal },
        );
        if (controller.signal.aborted || !thinking) return false;
        const selected = availableProfile(
          { model: chosen, thinking, maxTurns: TURN_LIMITS[r] },
          ctx,
        );
        defaults.profiles[r] = selected;
        await saveConfig(agentDir, defaults);
        if (state === captured && captured && !captured.profiles[r])
          captured.profiles[r] = clone(selected);
        persist(ctx);
      }
      if (captured && state === captured)
        for (const r of ROLES)
          if (!captured.profiles[r] && defaults.profiles[r])
            captured.profiles[r] = clone(defaults.profiles[r]);
      persist(ctx);
      show(
        ctx,
        `Default role profiles saved in ${agentDir}/goal.json.\n${renderProfiles(defaults.profiles)}${role && captured?.profiles[role] ? "\nExisting goal profiles are frozen. Use /goal override to change this goal." : ""}`,
      );
      return true;
    } finally {
      if (configuring === controller) configuring = null;
    }
  }

  async function stop(
    ctx,
    cancelled = false,
    reason = "Paused by user",
    save = true,
  ) {
    generation++;
    configuring?.abort();
    operation?.abort();
    if (state) {
      pause(state, reason);
      if (cancelled) state.phase = "cancelled";
      if (save) persist(ctx);
    }
    if (client) await client.stop();
  }

  async function runOperation(ctx, signal, work) {
    assertNotBusy();
    const goal = activeState();
    const epoch = generation;
    const controller = new AbortController();
    operation = controller;
    busy = true;
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    const current = () => {
      if (
        controller.signal.aborted ||
        state !== goal ||
        generation !== epoch ||
        !runtimeActive
      )
        throw new DOMException("Goal operation cancelled", "AbortError");
    };
    try {
      current();
      await preflight(ctx, goal, controller.signal);
      current();
      return await work(goal, controller.signal, current);
    } catch (error) {
      if (
        state === goal &&
        runtimeActive &&
        !["cancelled", "paused"].includes(goal.phase)
      ) {
        const resumable =
          error instanceof ContinuationPause &&
          !controller.signal.aborted &&
          !client?.hasUnsettled &&
          isApproved(goal) &&
          goal.execution?.token === approvalToken(goal);
        if (!resumable) goal.approval = null;
        goal.phase =
          resumable || controller.signal.aborted || error.name === "AbortError"
            ? "paused"
            : "blocked";
        goal.reason = error.message;
        persist(ctx);
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
      if (operation === controller) operation = null;
      busy = false;
      if (state === goal && runtimeActive) {
        if (!client?.hasUnsettled) goal.worker = null;
        persist(ctx);
      }
    }
  }

  async function child(
    ctx,
    goal,
    role,
    prompt,
    signal,
    current,
    structuredOutput,
    onUpdate,
  ) {
    current();
    const p = availableProfile(goal.profiles[role], ctx);
    // Definitions are rechecked for every dispatch, not just at goal start.
    await ensureAgents(agentDir, ctx.cwd, parseFrontmatter);
    current();
    goal.worker = { role, id: null };
    persist(ctx);
    onUpdate?.(
      toolResult(
        `Running ${role}: ${p.model}, ${p.thinking} thinking (up to ${p.maxTurns} turns)`,
      ),
    );
    // The bus event carries final prose, not record.structuredJson. Capture
    // validated tool output in-process instead of parsing untrusted final prose.
    let capturedJson;
    const capture = structuredOutput
      ? {
          schema: structuredOutput.schema,
          check(value) {
            const verdict = structuredOutput.check(value);
            if (verdict === true) capturedJson = JSON.stringify(value);
            return verdict;
          },
        }
      : undefined;
    let outcome;
    try {
      outcome = await client.run({
        type: AGENT_TYPES[role],
        prompt,
        model: p.model,
        thinkingLevel: p.thinking,
        maxTurns: p.maxTurns,
        cwd: ctx.cwd,
        signal,
        structuredOutput: capture,
        onSpawned(id) {
          if (state === goal && runtimeActive) {
            goal.worker = { role, id };
            persist(ctx);
          }
        },
      });
    } catch (error) {
      current();
      error.artifact = await record(ctx, goal, role, {
        ...(error.event ?? {}),
        error: error.message,
        capturedJson,
        profile: p,
      });
      current();
      error.settledChild =
        !client.hasUnsettled &&
        ["completed", "failed", "error"].includes(error.event?.status);
      throw error;
    }
    current();
    if (structuredOutput) {
      if (capturedJson === undefined) {
        const error = new Error(
          `${role} did not submit valid StructuredOutput`,
        );
        error.artifact = await record(ctx, goal, role, {
          ...outcome,
          error: error.message,
          profile: p,
        });
        current();
        error.settledChild = !client.hasUnsettled;
        throw error;
      }
      outcome = { ...outcome, rawResult: outcome.result, result: capturedJson };
    }
    const path = await record(ctx, goal, role, { ...outcome, profile: p });
    current();
    goal.worker = null;
    persist(ctx);
    return { outcome, path };
  }

  async function executeBounded(ctx, goal, signal, current, onUpdate) {
    const token = approvalToken(goal);
    const checkApproval = () => {
      current();
      if (!isApproved(goal) || approvalToken(goal) !== token)
        throw new Error("Approval changed during execution");
    };
    checkApproval();
    goal.phase = "executing";
    goal.reason = null;
    persist(ctx);
    const snapshots = await runBoundedExecution({
      goal,
      snapshot: () => snapshot(ctx.cwd, goal.plan),
      checkApproval,
      persist: () => persist(ctx),
      notify: (message) => onUpdate?.(toolResult(message)),
      record: (label, value) => record(ctx, goal, label, value),
      exec: (check) =>
        pi.exec("bash", ["-lc", check.command], {
          cwd: ctx.cwd,
          signal,
          timeout: check.timeout * 1000,
        }),
      work: async (step, feedback) => {
        const result = await child(
          ctx,
          goal,
          "implementer",
          `${contextFor(goal)}\n\nAPPROVED PLAN revision ${token}:\n${JSON.stringify(goal.plan)}\n\nImplement ONLY this delegated step or in-scope repair:\n${JSON.stringify(step)}\n\nCompleted steps:\n${JSON.stringify(goal.progress.filter((p) => p.status === "completed"))}\n\n${feedback}\n\nFinish real code rather than stopping after research. Inspect retained edits and complete the missing work. Report status completed when this step's code is finished; tests run at the coordinator's approved checkpoints, so not having run tests yourself is NOT a blocker. If code remains unfinished, use status continue with exact remaining tasks, never blocked merely because this invocation is unfinished. Use blocked ONLY for a concrete external dependency, a new consequential user decision, or an operation outside approved scope. Do not run shell commands, tests, commits or delegation. Return exact changed files through StructuredOutput.`,
          signal,
          current,
          compiled(WORK_SCHEMA, (value) => validateWork(value, step)),
          onUpdate,
        );
        checkApproval();
        return {
          ...validateWork(JSON.parse(result.outcome.result), step),
          artifact: result.path,
        };
      },
      review: async (evidence, initial) => {
        const result = await child(
          ctx,
          goal,
          "reviewer",
          `${contextFor(goal)}\n\nAPPROVED PLAN:\n${JSON.stringify(goal.plan)}\n\nWorker reports (claims, not proof):\n${JSON.stringify(goal.progress)}\n\nExecution evidence, including prior failures and repairs:\n${evidence}\n\nInitial file snapshot:\n${JSON.stringify(initial)}\n\nIndependently READ current source and full linked artifacts. A failed historical check is not an outstanding failure if its latest rerun passed. Cover every acceptance criterion exactly in order. Require actual feature delivery, not preparation-only claims. Report pass only when all criteria are supported and no issues remain; otherwise return actionable issues. No edits, shell or delegation.`,
          signal,
          current,
          compiled(REVIEW_SCHEMA, (value) =>
            validateReview(value, goal.plan.acceptance),
          ),
          onUpdate,
        );
        checkApproval();
        return {
          ...validateReview(
            JSON.parse(result.outcome.result),
            goal.plan.acceptance,
          ),
          artifact: result.path,
        };
      },
    });
    checkApproval();
    const path = await record(ctx, goal, "outcome", {
      goalId: goal.id,
      revision: token,
      phase: "completed",
      progress: goal.progress,
      checks: goal.checks,
      review: goal.review,
      execution: goal.execution,
      before: snapshots.initial,
      after: snapshots.after,
    });
    checkApproval();
    goal.phase = "completed";
    goal.approval = null;
    goal.reason = null;
    goal.worker = null;
    persist(ctx);
    const content = `Goal completed.\n\n${goal.review.summary}\n\n${goal.review.criteria.map((c) => `- ${c.criterion}: ${c.evidence}`).join("\n")}\n\nVerification: ${goal.execution.passed.length} approved commands passed; ${goal.checks.length} total attempts recorded.\nFull outcome: ${path}\nNo commits were created by the goal workflow.`;
    show(ctx, content);
    return toolResult(content, { artifact: path, phase: goal.phase }, true);
  }

  async function command(args, ctx) {
    const value = args.trim();
    const [action, ...words] = value.split(/\s+/);
    const rest = value.slice(action.length).trim();
    try {
      if (!value || action === "help") return show(ctx, HELP);
      if (action === "status") return show(ctx, renderStatus(state));
      if (action === "pause" || action === "cancel") {
        await stop(ctx, action === "cancel");
        show(
          ctx,
          `${action === "cancel" ? "Goal cancelled." : "Goal paused."} Existing edits are preserved.${client?.hasUnsettled ? " Waiting for the worker to stop; new dispatch is blocked." : ""}`,
        );
        void ctx.abort();
        return;
      }
      if (action === "configure") {
        assertNotBusy();
        const ready = await configure(ctx, rest || undefined);
        if (!ready)
          return show(
            ctx,
            "Profile setup cancelled. No defaults were guessed. Resume with /goal configure or /goal profile.",
          );
        if (state?.phase === "discussing")
          kickoff(
            "Continue the goal interview. Investigate with goal_research, then ask one consequential question using goal_question.",
          );
        return;
      }
      assertNotBusy();
      if (action === "profile" || action === "override") {
        if (!rest)
          return show(
            ctx,
            renderProfiles(
              action === "profile" ? defaults.profiles : activeState().profiles,
            ),
          );
        const [role, model, thinking, limit, ...extra] = words;
        if (!ROLES.includes(role) || extra.length || !model || !thinking)
          throw new Error(
            "Usage: /goal profile|override <role> <provider/model> <thinking> [maxTurns]",
          );
        const selected = availableProfile(
          {
            model,
            thinking,
            maxTurns: limit === undefined ? TURN_LIMITS[role] : Number(limit),
          },
          ctx,
        );
        if (action === "override") {
          const goal = activeState();
          goal.profiles[role] = selected;
          invalidate(
            goal,
            "Execution profile changed; the plan needs fresh review",
          );
        } else {
          if (configError) throw new Error(configError);
          defaults.profiles[role] = selected;
          await saveConfig(agentDir, defaults);
          if (state && !state.profiles[role])
            state.profiles[role] = clone(selected);
        }
        persist(ctx);
        return show(
          ctx,
          `${role}: ${selected.model}, ${selected.thinking}, up to ${selected.maxTurns} turns. ${action === "override" ? "Prior approval invalidated; use /goal revise to request a new plan." : "Saved as a default; existing configured goal profiles are unchanged."}`,
        );
      }
      if (action === "answer") {
        const goal = activeState();
        answerQuestion(goal, rest);
        persist(ctx);
        kickoff(
          "The user answered the pending goal question. Continue investigating and clarifying consequential uncertainty, then use goal_plan when ready.",
        );
        return;
      }
      if (action === "revise") {
        const goal = activeState();
        goal.feedback = [
          ...(goal.feedback ?? []),
          text(rest, "Revision feedback", 8000),
        ];
        invalidate(goal, "User requested revision");
        persist(ctx);
        kickoff(
          "Revise the goal using the recorded feedback and preserved execution evidence. Reuse research and recorded decisions. Ask only if a materially new consequential decision is needed; otherwise call goal_plan directly. Do not restart preparation or shrink the user's delivery goal.",
        );
        return;
      }
      if (action === "resume") {
        const goal = activeState();
        if (!["paused", "blocked"].includes(goal.phase))
          throw new Error("Only paused or blocked goals need resume");
        goal.worker = null;
        if (!goal.plan) {
          goal.phase = goal.pendingQuestion ? "asking" : "discussing";
          goal.reason = null;
          persist(ctx);
          if (goal.pendingQuestion)
            show(ctx, renderQuestion(goal.pendingQuestion));
          else
            kickoff(
              "Resume the goal interview. Read the persisted goal state and continue without assuming missing decisions.",
            );
          return;
        }
        if (goal.plan.execution) {
          const epoch = generation;
          const phase = goal.phase;
          const revision = goal.revision;
          const baseline = await snapshot(ctx.cwd, goal.plan);
          if (
            !runtimeActive ||
            state !== goal ||
            epoch !== generation ||
            goal.phase !== phase ||
            goal.revision !== revision
          )
            return;
          const journal = goal.execution;
          if (
            journal &&
            journal.token === approvalToken(goal) &&
            goal.approval === journal.token &&
            hash(baseline) === hash(journal.expected)
          ) {
            journal.attempts = {};
            journal.noProgress = {};
            journal.repairs = 0;
            goal.phase = "approved";
            goal.reason = null;
            persist(ctx);
            show(
              ctx,
              "Continuing the approved scope from its unchanged checkpoint. Completed work and successful one-shot commands will not replay. Any failed one-shot command is explicitly authorized to retry by /goal resume.",
            );
            kickoff(
              "The user requested continuation of the still-approved goal checkpoint. Call goal_execute now. Do not replan or ask for the same approval again.",
            );
            return;
          }
          // Interrupted/restored authority or external changes need a visible
          // new approval, not another interview or replacement implementation plan.
          if (journal) {
            const changed = changedFiles(journal.expected, baseline);
            for (const item of goal.progress) {
              if (
                goal.plan.steps
                  .find((s) => s.id === item.id)
                  .files.some((file) => changed.includes(file))
              )
                item.status = "pending";
            }
            journal.cursor = 0;
            journal.expected = baseline;
            journal.attempts = {};
            journal.noProgress = {};
            journal.repairs = 0;
            journal.passed = journal.passed.filter(
              (i) => goal.plan.checks[i].repeatable !== true,
            );
          }
          goal.baseline = baseline;
          goal.revision++;
          goal.approval = null;
          goal.phase = "awaiting_approval";
          if (journal) journal.token = approvalToken(goal);
          goal.reason =
            "Review current files and reapprove the retained plan after interruption or changed authority. No new interview or preparation stage is required.";
          persist(ctx);
          show(ctx, `${goal.reason}\n\n${renderPlan(goal)}`);
          return;
        }
        // A failed review needs a newly reviewed repair plan, not replay of an
        // already-completed implementation and the same failed checks forever.
        if (
          goal.review?.verdict === "blocked" ||
          goal.progress.every((item) => item.status === "completed")
        ) {
          invalidate(goal, "Verification/review needs a revised plan");
          persist(ctx);
          kickoff(
            "Prepare a revised repair plan for the blocked goal. Preserve existing edits. Ask about consequential changes and obtain fresh approval.",
          );
          return;
        }
        const epoch = generation;
        const phase = goal.phase;
        const revision = goal.revision;
        const baseline = await snapshot(ctx.cwd, goal.plan);
        if (
          !runtimeActive ||
          state !== goal ||
          epoch !== generation ||
          goal.phase !== phase ||
          goal.revision !== revision
        )
          return;
        goal.baseline = baseline;
        goal.revision++;
        goal.approval = null;
        goal.phase = "awaiting_approval";
        goal.reason =
          "Resume proposal includes existing partial edits. Completed steps will not rerun.";
        goal.checks = [];
        for (const item of goal.progress)
          if (item.status === "in_progress") item.status = "pending";
        persist(ctx);
        show(ctx, `${goal.reason}\n\n${renderPlan(goal)}`);
        return;
      }
      if (action === "approve") {
        const goal = activeState();
        if (goal.phase !== "awaiting_approval")
          throw new Error("No plan is awaiting approval");
        const token = approvalToken(goal);
        const epoch = generation;
        const fresh = () =>
          runtimeActive &&
          state === goal &&
          epoch === generation &&
          goal.phase === "awaiting_approval" &&
          token === approvalToken(goal);
        if (!rest) {
          if (!ctx.hasUI) throw new Error(`Use /goal approve ${token}`);
          if (
            !(await ctx.ui.confirm(
              "Approve goal implementation?",
              renderPlan(goal),
            ))
          )
            return;
        } else if (rest !== token)
          throw new Error(
            "Stale approval revision. Read /goal status for the current plan.",
          );
        if (!fresh())
          throw new Error(
            "The plan changed during review; approve its new revision",
          );
        await preflight(ctx, goal);
        if (!fresh()) throw new Error("Approval became stale");
        const now = await snapshot(ctx.cwd, goal.plan);
        if (!fresh()) throw new Error("Approval became stale");
        if (hash(now) !== hash(goal.baseline)) {
          invalidate(
            goal,
            "Planned files changed since proposal. Review a fresh plan.",
          );
          persist(ctx);
          throw new Error(goal.reason);
        }
        approve(goal, token);
        persist(ctx);
        show(
          ctx,
          `Approved revision ${token}. Starting implementation through goal-owned subagents.`,
        );
        kickoff(
          `The user explicitly approved goal revision ${token}. Call goal_execute now. Do not implement with parent tools or unrelated agents.`,
        );
        return;
      }
      if (state && !["completed", "cancelled"].includes(state.phase))
        throw new Error(
          "A goal is already active. Use /goal revise, /goal status, or /goal cancel before starting another.",
        );
      if (configError) throw new Error(configError);
      state = newGoal(value, ctx.cwd, defaults.profiles);
      persist(ctx);
      show(
        ctx,
        `Goal started: ${state.feature}\nInvestigation and questions come before planning; implementation remains locked until approval.`,
      );
      if (ROLES.some((role) => !state.profiles[role])) {
        const ready = await configure(ctx);
        if (!ready)
          return show(
            ctx,
            "Profile setup cancelled. No work dispatched. Continue with /goal configure.",
          );
      }
      kickoff(
        "Start the goal interview. First inspect relevant code with goal_research. Then deliberately ask one consequential feature question using goal_question. Do not infer approval from ordinary replies.",
      );
    } catch (error) {
      show(ctx, `Goal: ${error.message}`);
    }
  }

  pi.registerCommand("goal", {
    description:
      "Investigate, clarify, approve, and implement a goal with configured subagents",
    getArgumentCompletions(prefix) {
      const names = [
        "status",
        "configure",
        "profile",
        "override",
        "answer",
        "approve",
        "revise",
        "pause",
        "resume",
        "cancel",
        "help",
      ];
      return names
        .filter((name) => name.startsWith(prefix))
        .map((name) => ({ value: name, label: name }));
    },
    handler: command,
  });

  const registerTool = (definition) =>
    pi.registerTool(
      deps.decorateTool ? deps.decorateTool(definition) : definition,
    );
  registerTool({
    name: "goal_question",
    label: "Goal question",
    description:
      "Ask one consequential feature question with evidence/context and optional choices. Records an actual user answer; otherwise stops for a chat reply. Only available in goal mode. Never use this to manufacture approval.",
    parameters: {
      ...parameters({
        question: { type: "string" },
        context: { type: "string" },
        options: { type: "array", items: { type: "string" }, maxItems: 5 },
      }),
      required: ["question", "context"],
    },
    async execute(_id, params, signal, _onUpdate, ctx) {
      assertNotBusy();
      const goal = activeState();
      const question = askQuestion(goal, params);
      persist(ctx);
      const content = renderQuestion(question);
      show(ctx, content);
      if (ctx.mode === "tui" && question.options.length && ctx.hasUI) {
        const chat = "Reply in chat instead";
        const choice = await ctx.ui.select(
          question.question,
          [...question.options, chat],
          { signal },
        );
        if (
          !signal?.aborted &&
          state === goal &&
          goal.pendingQuestion?.id === question.id &&
          choice &&
          choice !== chat &&
          question.options.includes(choice)
        ) {
          answerQuestion(goal, choice, question.id);
          persist(ctx);
          return toolResult(`User answered: ${choice}`, {
            questionId: question.id,
          });
        }
      }
      return toolResult(
        content,
        { questionId: question.id, waitingForUser: true },
        true,
      );
    },
  });
  registerTool({
    name: "goal_research",
    label: "Goal research",
    description:
      "Run a read-only researcher for the active goal, using its configured model and thinking. Provide a focused investigation question; no files can be edited.",
    parameters: {
      ...parameters({ question: { type: "string" } }),
      required: ["question"],
    },
    async execute(_id, params, signal, onUpdate, ctx) {
      if (!toolAllowed(state, "goal_research"))
        throw new Error("Research is not available in this goal phase");
      return runOperation(ctx, signal, async (goal, childSignal, current) => {
        if (goal.research.length >= 8)
          throw new Error(
            "Research limit reached (8 runs per goal). Discuss existing evidence or start a narrower goal.",
          );
        const question = text(params.question, "Research question", 6000);
        const result = await child(
          ctx,
          goal,
          "researcher",
          `${contextFor(goal)}\n\nInvestigate:\n${question}\n\nRead-only research. Return evidence and exact paths, not an implementation or a request for approval.`,
          childSignal,
          current,
          undefined,
          onUpdate,
        );
        goal.research.push({
          question,
          summary: clip(result.outcome.result, 10000),
          artifact: result.path,
        });
        persist(ctx);
        return toolResult(
          `${clip(result.outcome.result)}\n\nFull research: ${result.path}\nAsk the user about consequential uncertainty using goal_question.`,
          { artifact: result.path },
        );
      });
    },
  });
  registerTool({
    name: "goal_plan",
    label: "Propose goal plan",
    description:
      "Run the read-only planner and publish a structured implementation plan for USER approval. Requires recorded research, a user answer, and configured profiles. This tool never authorizes implementation.",
    parameters: parameters({ focus: { type: "string" } }),
    async execute(_id, params, signal, onUpdate, ctx) {
      if (!toolAllowed(state, "goal_plan"))
        throw new Error(
          "Research and at least one user answer are required before planning",
        );
      return runOperation(ctx, signal, async (goal, childSignal, current) => {
        goal.phase = "planning";
        goal.approval = null;
        persist(ctx);
        const result = await child(
          ctx,
          goal,
          "planner",
          `${contextFor(goal)}\n\nPlanning focus:\n${params.focus ? text(params.focus, "Planning focus", 6000) : "Implement the clarified feature."}\n\nPrevious plan (if revising):\n${JSON.stringify(goal.plan)}\n\nPrevious execution evidence (preserve completed edits and diagnose the actual failure):\n${JSON.stringify({ reason: goal.reason, progress: goal.progress, checks: goal.checks, review: goal.review, execution: goal.execution })}\n\nCreate a plan that delivers the user's feature, not a preparation-only substitute. Use small code-writing steps with precise file ownership and independently testable acceptance criteria. Every step runs sequentially with an edit-only implementer. The coordinator runs each exact command at its afterStep checkpoint: 0 BEFORE any worker, or N immediately AFTER step N. Put Git/dependency/generation prerequisites before the workers that need them, and build/test checks incrementally rather than only at the end. Set repeatable:true ONLY for commands whose side effects the user can safely authorize to repeat during repairs; setup/install/deployment commands should normally be repeatable:false. Omitted afterStep means after the last step; omitted repeatable means no automatic rerun. The coordinator attaches a visible, token-bound bounded continuation policy (four worker attempts per step, two repair rounds, two consecutive no-progress attempts). Repairs are limited to files of reached steps; include necessary generated/lock files among declared targets. Do not require a new approval merely for unfinished in-scope work. Follow the StructuredOutput schema. Unresolved consequential decisions must be listed as risks, not silently assumed. The user will review the entire plan before any implementation.`,
          childSignal,
          current,
          compiled(PLAN_SCHEMA, (value) =>
            validatePlan({ ...value, execution: EXECUTION_POLICY }),
          ),
          onUpdate,
        );
        const plan = validatePlan({
          ...JSON.parse(result.outcome.result),
          execution: EXECUTION_POLICY,
        });
        const baseline = await snapshot(ctx.cwd, plan);
        current();
        propose(goal, plan, baseline);
        const path = await record(ctx, goal, `plan-r${goal.revision}`, {
          plan,
          profiles: goal.profiles,
          baseline,
          token: approvalToken(goal),
        });
        current();
        persist(ctx);
        const content = `${renderPlan(goal)}\n\nPlan artifact: ${path}`;
        show(ctx, content);
        return toolResult(
          content,
          {
            revision: approvalToken(goal),
            artifact: path,
            waitingForUser: true,
          },
          true,
        );
      });
    },
  });
  registerTool({
    name: "goal_execute",
    label: "Execute approved goal",
    description:
      "Execute ONLY the user-approved current goal revision. Runs sequential implementation subagents, exact approved verification commands, and independent read-only review. Cannot approve itself; no arbitrary task/model arguments are accepted. New approved plans support bounded in-scope continuation/repairs and explicit command checkpoints. Pauses for external blockers, retry limits, or cancellation. Never commits or grants new authority.",
    parameters: parameters({}),
    async execute(_id, params, signal, onUpdate, ctx) {
      if (Object.keys(params).length)
        throw new Error("goal_execute accepts no arguments");
      if (!isApproved(state))
        throw new Error(
          "Implementation requires explicit approval of the current plan revision",
        );
      return runOperation(ctx, signal, async (goal, childSignal, current) => {
        if (goal.plan.execution)
          return executeBounded(ctx, goal, childSignal, current, onUpdate);
        const initial = await snapshot(ctx.cwd, goal.plan);
        if (hash(initial) !== hash(goal.baseline))
          throw new Error(
            "Planned files changed after approval. Use /goal resume to inspect and reapprove current state.",
          );
        goal.phase = "executing";
        goal.reason = null;
        persist(ctx);
        let expected = initial;
        const executionToken = approvalToken(goal);
        const checkApproval = () => {
          current();
          if (!isApproved(goal) || approvalToken(goal) !== executionToken)
            throw new Error("Goal approval is no longer valid");
        };
        for (const step of goal.plan.steps) {
          checkApproval();
          const progress = goal.progress.find((p) => p.id === step.id);
          if (progress.status === "completed") continue;
          const before = await snapshot(ctx.cwd, goal.plan);
          checkApproval();
          if (hash(before) !== hash(expected))
            throw new Error(
              "Planned files changed between steps. Pause and review external changes.",
            );
          progress.status = "in_progress";
          persist(ctx);
          const result = await child(
            ctx,
            goal,
            "implementer",
            `${contextFor(goal)}\n\nAPPROVED PLAN revision ${executionToken}:\n${JSON.stringify(goal.plan)}\n\nCompleted steps:\n${JSON.stringify(goal.progress.filter((p) => p.status === "completed"))}\n\nImplement ONLY step ${step.id}:\n${JSON.stringify(step)}\n\nExisting file hashes (existing content may include user edits):\n${JSON.stringify(before)}\nRead current contents first; preserve pre-existing changes. If blocked, report status blocked with the reason. Do not run tests, shell commands, commit, or delegate. Return the exact changed files and summary through StructuredOutput.`,
            childSignal,
            current,
            compiled(WORK_SCHEMA, (value) => validateWork(value, step)),
            onUpdate,
          );
          checkApproval();
          const report = validateWork(JSON.parse(result.outcome.result), step);
          const after = await snapshot(ctx.cwd, goal.plan);
          checkApproval();
          const changed = changedFiles(before, after);
          progress.result = {
            ...report,
            artifact: result.path,
            observedChangedFiles: changed,
          };
          expected = after;
          persist(ctx);
          if (changed.some((file) => !step.files.includes(file)))
            throw new Error(
              `Step ${step.id} changed another planned step's files. Review the partial edits before continuing.`,
            );
          if (report.status !== "completed")
            throw new Error(`Step ${step.id} blocked: ${report.summary}`);
          progress.status = "completed";
          persist(ctx);
          onUpdate?.(
            toolResult(
              `Completed step ${step.id}/${goal.plan.steps.length}: ${step.title}\n${report.summary}\nEvidence: ${result.path}`,
            ),
          );
        }
        goal.checks = [];
        for (const [index, check] of goal.plan.checks.entries()) {
          checkApproval();
          onUpdate?.(
            toolResult(
              `Verification ${index + 1}/${goal.plan.checks.length}: ${check.command}`,
            ),
          );
          const output = await pi.exec("bash", ["-lc", check.command], {
            cwd: ctx.cwd,
            signal: childSignal,
            timeout: check.timeout * 1000,
          });
          const path = await record(ctx, goal, `check-${index + 1}`, {
            ...check,
            ...output,
          });
          checkApproval();
          goal.checks.push({
            ...check,
            code: output.code,
            killed: output.killed,
            output: clip(`${output.stdout}\n${output.stderr}`, 6000),
            artifact: path,
          });
          persist(ctx);
          if (output.code !== 0 || output.killed)
            throw new Error(
              `Verification failed: ${check.command}\n${clip(`${output.stdout}\n${output.stderr}`, 4000)}\nEvidence: ${path}`,
            );
        }
        const beforeReview = await snapshot(ctx.cwd, goal.plan);
        checkApproval();
        const result = await child(
          ctx,
          goal,
          "reviewer",
          `${contextFor(goal)}\n\nAPPROVED PLAN:\n${JSON.stringify(goal.plan)}\n\nWorker reports (claims, not proof):\n${JSON.stringify(goal.progress)}\n\nExecuted verification commands and outputs:\n${JSON.stringify(goal.checks)}\n\nFile snapshots before implementation:\n${JSON.stringify(initial)}\nAfter implementation/checks:\n${JSON.stringify(beforeReview)}\n\nIndependently READ the current source and inspect the linked evidence artifacts. Cover each acceptance criterion exactly, in its original order. Report pass only if every criterion is supported and no issues remain; otherwise blocked. Missing evidence and uncertainty mean blocked, not completed.`,
          childSignal,
          current,
          compiled(REVIEW_SCHEMA, (value) =>
            validateReview(value, goal.plan.acceptance),
          ),
          onUpdate,
        );
        checkApproval();
        goal.review = {
          ...validateReview(
            JSON.parse(result.outcome.result),
            goal.plan.acceptance,
          ),
          artifact: result.path,
        };
        const afterReview = await snapshot(ctx.cwd, goal.plan);
        checkApproval();
        if (hash(beforeReview) !== hash(afterReview))
          throw new Error(
            "Files changed while the reviewer was inspecting them; review is stale",
          );
        if (goal.review.verdict !== "pass") {
          goal.phase = "blocked";
          goal.approval = null;
          goal.reason =
            "Independent review requires changes or a user decision";
        } else {
          goal.phase = "completed";
          goal.approval = null;
          goal.reason = null;
        }
        goal.worker = null;
        persist(ctx);
        const path = await record(ctx, goal, "outcome", {
          goalId: goal.id,
          revision: executionToken,
          phase: goal.phase,
          progress: goal.progress,
          checks: goal.checks,
          review: goal.review,
          before: initial,
          after: afterReview,
        });
        const content = `Goal ${goal.phase}.\n\n${goal.review.summary}\n\n${goal.review.criteria.map((c) => `- ${c.criterion}: ${c.evidence}`).join("\n")}\n\n${goal.review.issues.join("\n")}\n\nVerification: ${goal.checks.length} commands passed.\nFull outcome: ${path}${goal.phase === "blocked" ? "\nUse /goal revise <feedback> to prepare a repair plan, or /goal resume to discuss next steps." : "\nNo commits were created by the goal workflow."}`;
        show(ctx, content);
        return toolResult(content, { artifact: path, phase: goal.phase }, true);
      });
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    runtimeActive = true;
    generation++;
    try {
      defaults = await readConfig(agentDir);
      configError = null;
    } catch (error) {
      configError = error.message;
    }
    state = restore(ctx.sessionManager.getBranch(), ctx.cwd);
    initializeClient();
    persist(ctx);
  });
  pi.on("session_tree", async (_event, ctx) => {
    await stop(ctx, false, "Session tree changed", false);
    state = restore(ctx.sessionManager.getBranch(), ctx.cwd);
    persist(ctx);
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    await stop(ctx, false, "Session closed or reloaded");
    runtimeActive = false;
    await client?.dispose();
    client = undefined;
  });
  pi.on("before_agent_start", (event, ctx) => {
    contextText = (event.systemPromptOptions?.contextFiles ?? [])
      .map((file) => `## ${file.path}\n${file.content}`)
      .join("\n\n");
    if (!state || ["completed", "cancelled"].includes(state.phase)) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n[GOAL WORKFLOW - EXTENSION-OWNED STATE]\n${renderStatus(state)}\n\nYou are the goal coordinator, not an implementation worker. Parent file writes, shell, unknown tools, and uncontrolled agents are blocked. For a NEW goal use goal_research for read-only investigation, then goal_question to ask ONE consequential feature question at a time. For revisions reuse existing research and answers; only ask again for a materially new consequential decision. Read/search tools and todo are available. Do not ask for facts discoverable from code. At least one actual user answer is required; ordinary replies NEVER authorize implementation. When requirements are clear, call goal_plan alone to obtain a planner-produced proposal and STOP for approval. Only /goal approve authorizes goal_execute. After approval call goal_execute alone; it owns worker sequencing, checks and review. Never bypass these controls through wrappers. Unfinished workers and repairable failures are handled inside goal_execute under the approved policy, not by new interviews or preparation stages. If waiting, paused, or blocked, explain the next user action and stop; do not loop or self-resume. For an unchanged approved checkpoint recommend /goal resume, not /goal revise or another approval. Unknown consequential decisions and new scope require user input. Reflect goal progress through todo when useful, but only goal-owned state decides completion.`,
    };
  });
  pi.on("tool_call", (event) => {
    // Ownership outlives cancellation and branch navigation. Keep even a
    // now-unrelated parent turn from racing a worker/shell still unwinding.
    const guardedState =
      busy || client?.hasUnsettled ? { phase: "paused" } : state;
    if (!toolAllowed(guardedState, event.toolName))
      return {
        block: true,
        terminate: true,
        reason: `Goal ${state?.phase}: ${event.toolName} is blocked. Follow the goal workflow; only explicit user approval can authorize goal_execute.`,
      };
  });
  pi.on("input", async (event, ctx) => {
    if (
      event.source === "extension" ||
      !state ||
      ["completed", "cancelled"].includes(state.phase)
    )
      return;
    // Slash commands belonging to other extensions are not handled here. Pi
    // dispatches them before input hooks; trusted extension code is not a sandbox.
    if (event.text.trim().startsWith("/")) return;
    if (state.phase === "asking" && state.pendingQuestion) {
      if (event.images?.length && !event.text.trim()) return;
      answerQuestion(state, event.text);
      persist(ctx);
      return { action: "continue" };
    }
    if (["approved", "executing"].includes(state.phase) || busy) {
      await stop(
        ctx,
        false,
        "New user input interrupted goal execution; use /goal revise or /goal resume",
      );
    } else if (state.phase === "awaiting_approval" || state.approval) {
      invalidate(
        state,
        "User feedback changed the proposal. Ordinary chat is not approval.",
      );
    }
    if (event.text.trim())
      state.feedback = [...(state.feedback ?? []), clip(event.text, 8000)];
    persist(ctx);
    return { action: "continue" };
  });
  return {
    command,
    getState: () => clone(state),
    get busy() {
      return busy;
    },
    get client() {
      return client;
    },
  };
}
