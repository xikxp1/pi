import {
  approvalToken,
  hash,
  renderExecutionProgress,
  validateExecutionPolicy,
} from "./core.mjs";
import { changedFiles } from "./storage.mjs";

/** A settled, inspected checkpoint. Only the user command may resume it. */
export class ContinuationPause extends Error {
  constructor(message) {
    super(message);
    this.name = "ContinuationPause";
  }
}

export function executionSchedule(plan) {
  const events = [];
  for (let afterStep = 0; afterStep <= plan.steps.length; afterStep++) {
    if (afterStep) events.push({ kind: "step", index: afterStep - 1 });
    plan.checks.forEach((check, index) => {
      if ((check.afterStep ?? plan.steps.length) === afterStep)
        events.push({ kind: "check", index, afterStep });
    });
  }
  events.push({ kind: "review" });
  return events;
}

/** All effects are supplied by the owning controller, never model-selected.
 * The approved baseline stays immutable. expected tracks only owned effects.
 * A journal permits explicit continuation without replaying completed workers
 * or successful one-shot commands. It never authorizes a restored session.
 */
export async function runBoundedExecution({
  goal,
  snapshot,
  work,
  review,
  exec,
  record,
  persist,
  checkApproval,
  notify,
}) {
  const policy = validateExecutionPolicy(goal.plan.execution);
  const token = approvalToken(goal);
  checkApproval();
  const initial = await snapshot();
  checkApproval();
  if (goal.execution && goal.execution.token !== token)
    throw new Error(
      "Execution checkpoint does not match the approved revision",
    );
  if (hash(initial) !== hash(goal.execution?.expected ?? goal.baseline))
    throw new Error(
      "Planned files changed outside owned execution. Inspect and obtain fresh approval.",
    );
  const journal = (goal.execution ??= {
    token,
    expected: initial,
    initial,
    cursor: 0,
    attempts: {},
    noProgress: {},
    repairs: 0,
    passed: [],
    pendingRepair: null,
    history: [],
  });
  const schedule = executionSchedule(goal.plan);
  const save = () => {
    checkApproval();
    persist();
  };
  const announce = (message) => {
    checkApproval();
    notify(message);
  };
  const assertFresh = async () => {
    checkApproval();
    const now = await snapshot();
    checkApproval();
    if (hash(now) !== hash(journal.expected))
      throw new Error(
        "Planned files changed between owned operations. Inspect and obtain fresh approval.",
      );
    return now;
  };
  const pause = (message) => {
    save();
    throw new ContinuationPause(
      `${message}\n${renderExecutionProgress(goal)}\nApproval retained for the unchanged scope. Use /goal resume to continue, or /goal revise for scope changes.`,
    );
  };
  const evidence = () =>
    JSON.stringify({
      checks: goal.checks,
      review: goal.review,
      recentWork: journal.history.slice(-6),
    });

  async function runWork(step, key, feedback, progress) {
    const before = await assertFresh();
    if (
      policy.maxStepAttempts !== null &&
      (journal.attempts[key] ?? 0) >= policy.maxStepAttempts
    )
      pause(
        `Worker attempt limit (${policy.maxStepAttempts}) reached for ${step.title}.`,
      );
    journal.attempts[key] = (journal.attempts[key] ?? 0) + 1;
    if (progress) progress.status = "in_progress";
    save();
    announce(
      `Implementing ${step.title}, attempt ${journal.attempts[key]}${policy.maxStepAttempts === null ? " (progress-based continuation)" : `/${policy.maxStepAttempts}`}.`,
    );
    let report;
    try {
      report = await work(
        step,
        `${feedback}\n\nPrevious result:\n${JSON.stringify(progress?.result ?? journal.pendingRepair?.result ?? null)}\n\nExecution evidence:\n${evidence()}`,
      );
    } catch (error) {
      // Aborts and unsettled child ownership are not safe checkpoints. The
      // controller must revoke authority rather than bless unknown tool effects.
      checkApproval();
      if (!error.settledChild) throw error;
      const after = await snapshot();
      checkApproval();
      if (
        changedFiles(before, after).some((file) => !step.files.includes(file))
      )
        throw new Error(
          "Failed worker changed files outside its approved targets",
        );
      journal.expected = after;
      journal.history.push({
        step: step.id,
        error: error.message,
        artifact: error.artifact,
        observedChangedFiles: changedFiles(before, after),
      });
      pause(`Worker stopped without a usable result: ${error.message}`);
    }
    checkApproval();
    const after = await snapshot();
    checkApproval();
    const changed = changedFiles(before, after);
    if (
      changed.some((file) => !step.files.includes(file)) ||
      report.files.some((file) => !step.files.includes(file))
    )
      throw new Error(
        "Worker changed files outside its approved targets; inspect partial edits",
      );
    journal.expected = after;
    const result = { ...report, observedChangedFiles: changed };
    if (progress) progress.result = result;
    else journal.pendingRepair.result = result;
    journal.history.push({ step: step.id, ...result });
    journal.noProgress[key] = changed.length
      ? 0
      : (journal.noProgress[key] ?? 0) + 1;
    save();
    if (report.status === "blocked")
      pause(`Worker needs external input: ${report.summary}`);
    if (report.status === "completed") {
      if (progress) progress.status = "completed";
      save();
      return true;
    }
    if (journal.noProgress[key] >= policy.maxNoProgressAttempts)
      pause(
        `No file progress in ${journal.noProgress[key]} consecutive attempts: ${report.summary}`,
      );
    announce(
      `Continuing unfinished work without another approval. Observed file changes: ${changed.join(", ") || "none"}. Consecutive no-file-progress attempts: ${journal.noProgress[key]}/${policy.maxNoProgressAttempts}. Worker report: ${report.summary}`,
    );
    return false;
  }

  function requestRepair(feedback, afterStep) {
    const files = [
      ...new Set(goal.plan.steps.slice(0, afterStep).flatMap((s) => s.files)),
    ];
    if (!files.length)
      pause(
        `No reached implementation files are available for repair. ${feedback}`,
      );
    if (journal.repairs >= policy.maxRepairAttempts)
      pause(`Repair limit (${policy.maxRepairAttempts}) reached. ${feedback}`);
    journal.repairs++;
    journal.pendingRepair = {
      step: {
        id: `repair-${journal.repairs}`,
        title: `Repair ${journal.repairs}/${policy.maxRepairAttempts}`,
        files,
        instructions:
          "Repair only defects identified by the supplied verification/review evidence within the approved acceptance criteria. Do not change the plan, commands, dependencies outside authorized files, or implement new scope. Preserve completed work. If a new user decision or command is needed, report blocked.",
      },
      feedback,
    };
    save();
  }

  while (journal.cursor < schedule.length) {
    checkApproval();
    if (journal.pendingRepair) {
      const repair = journal.pendingRepair;
      if (!(await runWork(repair.step, repair.step.id, repair.feedback)))
        continue;
      journal.pendingRepair = null;
      // A repair can affect earlier results. Revalidate all reached repeatable
      // checks; never replay successful setup/install/deployment commands.
      journal.passed = journal.passed.filter(
        (i) => goal.plan.checks[i].repeatable !== true,
      );
      journal.cursor = 0;
      save();
      continue;
    }
    const event = schedule[journal.cursor];
    if (event.kind === "step") {
      const step = goal.plan.steps[event.index];
      const progress = goal.progress.find((p) => p.id === step.id);
      if (
        progress.status !== "completed" &&
        !(await runWork(
          step,
          `step-${step.id}`,
          "Finish the delegated step. Unfinished work is a continuation, not an external blocker.",
          progress,
        ))
      )
        continue;
    } else if (event.kind === "check") {
      if (!journal.passed.includes(event.index)) {
        await assertFresh();
        const check = goal.plan.checks[event.index];
        announce(`Verification ${event.index + 1}: ${check.command}`);
        const output = await exec(check);
        checkApproval();
        const succeeded = output.code === 0 && !output.killed;
        const result = {
          ...check,
          index: event.index,
          code: output.code,
          killed: output.killed,
          output: `${output.stdout ?? ""}\n${output.stderr ?? ""}`.slice(-6000),
          artifact: null,
        };
        goal.checks.push(result);
        // Persist known command success BEFORE asynchronous artifact/snapshot
        // bookkeeping. Cancellation there must never replay a one-shot effect.
        if (succeeded) journal.passed.push(event.index);
        save();
        result.artifact = await record(`check-${event.index + 1}`, {
          ...check,
          ...output,
        });
        save();
        journal.expected = await snapshot();
        save();
        if (!succeeded) {
          const feedback = `Verification failed: ${check.command}\n${result.output}\nFull evidence: ${result.artifact}`;
          if (check.repeatable !== true)
            pause(
              `${feedback}\nThis command is not approved for automatic reruns. /goal resume explicitly retries it.`,
            );
          requestRepair(feedback, event.afterStep);
          continue;
        }
      }
    } else {
      const before = await assertFresh();
      let assessment;
      try {
        assessment = await review(evidence(), journal.initial);
      } catch (error) {
        checkApproval();
        if (!error.settledChild) throw error;
        await assertFresh();
        journal.history.push({
          role: "reviewer",
          error: error.message,
          artifact: error.artifact,
        });
        pause(`Review stopped without a usable result: ${error.message}`);
      }
      checkApproval();
      const after = await snapshot();
      checkApproval();
      if (hash(before) !== hash(after))
        throw new Error(
          "Files changed during independent review; assessment is stale",
        );
      goal.review = assessment;
      save();
      if (assessment.verdict !== "pass") {
        requestRepair(
          `Independent review requires repair:\n${JSON.stringify(assessment)}`,
          goal.plan.steps.length,
        );
        continue;
      }
    }
    journal.cursor++;
    save();
  }
  // Even a completed journal must be rechecked before recording an outcome.
  const after = await assertFresh();
  return { initial: journal.initial, after };
}
