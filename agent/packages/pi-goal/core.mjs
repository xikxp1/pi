import { createHash, randomUUID } from "node:crypto";

export const STATE_TYPE = "pi-goal:state:v1";
export const ROLES = ["researcher", "planner", "implementer", "reviewer"];
export const THINKING = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
export const TURN_LIMITS = {
  researcher: 16,
  planner: 16,
  implementer: 24,
  reviewer: 16,
};
export const AGENT_TYPES = Object.fromEntries(
  ROLES.map((role) => [role, `PiGoal${role[0].toUpperCase()}${role.slice(1)}`]),
);
const PHASES = [
  "discussing",
  "asking",
  "planning",
  "awaiting_approval",
  "approved",
  "executing",
  "paused",
  "blocked",
  "completed",
  "cancelled",
];
export const READ_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "fffind",
  "ffgrep",
]);
export const GOAL_TOOLS = new Set([
  "goal_question",
  "goal_research",
  "goal_plan",
  "goal_execute",
]);
export const clone = (value) => structuredClone(value);
export const hash = (value) =>
  createHash("sha256")
    .update(
      typeof value === "string" || value instanceof Uint8Array
        ? value
        : JSON.stringify(value),
    )
    .digest("hex");
export function text(value, label, max = 12000) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(
      `${label} must be non-empty text, at most ${max} characters`,
    );
  return value.trim();
}
export function profile(value) {
  if (!value || typeof value !== "object")
    throw new Error("Missing role profile");
  const model = text(value.model, "Model", 300);
  if (!/^[^\s/]+\/\S+$/.test(model) || /[*?\[\]]/.test(model))
    throw new Error("Use an exact provider/model ID");
  if (!THINKING.includes(value.thinking))
    throw new Error("Unsupported thinking level");
  if (
    !Number.isInteger(value.maxTurns) ||
    value.maxTurns < 1 ||
    value.maxTurns > 100
  )
    throw new Error("maxTurns must be 1-100");
  return { model, thinking: value.thinking, maxTurns: value.maxTurns };
}
export function profiles(value = {}, requireAll = false) {
  const result = {};
  for (const role of ROLES) {
    if (value[role]) result[role] = profile(value[role]);
    else if (requireAll)
      throw new Error(`Configure the ${role} profile with /goal configure`);
  }
  return result;
}
function strings(value, label, min, max, length = 12000) {
  if (!Array.isArray(value) || value.length < min || value.length > max)
    throw new Error(`${label} must contain ${min}-${max} items`);
  return value.map((item) => text(item, label, length));
}
export function filePath(value) {
  const path = text(value, "File path", 1000);
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((p) => p === "." || p === ".." || !p) ||
    /[\x00-\x1f*?\[\]]/.test(path)
  ) {
    throw new Error(
      `Use an exact project-relative file path, not a directory or glob: ${path}`,
    );
  }
  return path;
}
export function validatePlan(value) {
  if (!value || typeof value !== "object")
    throw new Error("Plan must be an object");
  const title = text(value.title, "Plan title", 300);
  const summary = text(value.summary, "Plan summary", 8000);
  const acceptance = strings(
    value.acceptance,
    "Acceptance criteria",
    1,
    12,
    2000,
  );
  const constraints = strings(value.constraints, "Constraints", 0, 12, 2000);
  const risks = strings(value.risks, "Risks", 0, 12, 2000);
  if (
    !Array.isArray(value.steps) ||
    value.steps.length < 1 ||
    value.steps.length > 12
  )
    throw new Error("Plan needs 1-12 steps");
  const steps = value.steps.map((step, index) => ({
    id: index + 1,
    title: text(step.title, "Step title", 300),
    instructions: text(step.instructions, "Implementation instructions", 6000),
    files: [
      ...new Set(strings(step.files, "Step files", 1, 30, 1000).map(filePath)),
    ],
  }));
  if (
    !Array.isArray(value.checks) ||
    value.checks.length < 1 ||
    value.checks.length > 12
  )
    throw new Error("Plan needs 1-12 verification commands");
  const checks = value.checks.map((check) => {
    const timeout = check.timeout;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 600)
      throw new Error("Check timeout must be 1-600 seconds");
    return {
      command: text(check.command, "Verification command", 2000),
      timeout,
    };
  });
  const result = {
    title,
    summary,
    acceptance,
    constraints,
    risks,
    steps,
    checks,
  };
  if (JSON.stringify(result).length > 50000)
    throw new Error("Plan exceeds 50,000 characters; simplify it");
  return result;
}
export const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "title",
    "summary",
    "acceptance",
    "constraints",
    "risks",
    "steps",
    "checks",
  ],
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    acceptance: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      maxItems: 12,
    },
    constraints: { type: "array", items: { type: "string" }, maxItems: 12 },
    risks: { type: "array", items: { type: "string" }, maxItems: 12 },
    steps: {
      type: "array",
      minItems: 1,
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "instructions", "files"],
        properties: {
          title: { type: "string" },
          instructions: { type: "string" },
          files: {
            type: "array",
            minItems: 1,
            maxItems: 30,
            items: { type: "string" },
          },
        },
      },
    },
    checks: {
      type: "array",
      minItems: 1,
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["command", "timeout"],
        properties: {
          command: { type: "string" },
          timeout: { type: "integer", minimum: 1, maximum: 600 },
        },
      },
    },
  },
};
export const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "criteria", "issues"],
  properties: {
    verdict: { type: "string", enum: ["pass", "blocked"] },
    summary: { type: "string" },
    criteria: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["criterion", "evidence"],
        properties: {
          criterion: { type: "string" },
          evidence: { type: "string" },
        },
      },
    },
    issues: { type: "array", items: { type: "string" } },
  },
};
export function validateReview(value, acceptance) {
  if (!value || !["pass", "blocked"].includes(value.verdict))
    throw new Error("Invalid review verdict");
  const summary = text(value.summary, "Review summary", 8000);
  const issues = strings(value.issues, "Review issues", 0, 30, 2000);
  if (
    !Array.isArray(value.criteria) ||
    value.criteria.length !== acceptance.length
  )
    throw new Error("Review must cover every acceptance criterion");
  const criteria = value.criteria.map((item, i) => {
    if (item.criterion !== acceptance[i])
      throw new Error("Review criteria must match the approved plan, in order");
    return {
      criterion: item.criterion,
      evidence: text(item.evidence, "Criterion evidence", 3000),
    };
  });
  if (value.verdict === "pass" && issues.length)
    throw new Error("A passing review cannot contain unresolved issues");
  return { verdict: value.verdict, summary, criteria, issues };
}
export function compiled(schema, validate) {
  return {
    schema,
    check(value) {
      try {
        validate(value);
        return true;
      } catch (error) {
        return error.message;
      }
    },
  };
}
export function newGoal(feature, cwd, defaults = {}) {
  return {
    version: 1,
    id: randomUUID(),
    cwd,
    feature: text(feature, "Feature", 12000),
    phase: "discussing",
    profiles: profiles(defaults),
    answers: [],
    research: [],
    revision: 0,
    plan: null,
    approval: null,
    pendingQuestion: null,
    progress: [],
    checks: [],
    review: null,
    baseline: null,
    worker: null,
    reason: null,
    createdAt: new Date().toISOString(),
  };
}
export function approvalToken(state) {
  if (!state.plan) throw new Error("There is no proposed plan");
  return `${state.revision}-${hash({ id: state.id, plan: state.plan, profiles: state.profiles, baseline: state.baseline, answers: state.answers }).slice(0, 12)}`;
}
export function isApproved(state) {
  return Boolean(
    state?.plan &&
    state.approval === approvalToken(state) &&
    ["approved", "executing"].includes(state.phase),
  );
}
export function invalidate(state, reason) {
  state.approval = null;
  state.reason = reason;
  state.phase = "discussing";
  state.pendingQuestion = null;
  state.review = null;
  state.worker = null;
}
export function askQuestion(state, value) {
  if (!["discussing", "awaiting_approval"].includes(state.phase))
    throw new Error(`Cannot ask a question while ${state.phase}`);
  const question = {
    id: randomUUID().slice(0, 8),
    question: text(value.question, "Question", 2000),
    context: text(value.context, "Question context", 4000),
    options: strings(value.options ?? [], "Question options", 0, 5, 500),
  };
  state.approval = null;
  state.phase = "asking";
  state.pendingQuestion = question;
  return question;
}
export function answerQuestion(state, answer, questionId) {
  if (state.phase !== "asking" || !state.pendingQuestion)
    throw new Error("No pending question");
  if (questionId && state.pendingQuestion.id !== questionId)
    throw new Error("That question is stale; use /goal status");
  const value = text(answer, "Answer", 8000);
  if (state.answers.length >= 30)
    throw new Error("Question limit reached; revise or cancel this goal");
  state.answers.push({ ...state.pendingQuestion, answer: value });
  state.pendingQuestion = null;
  state.phase = "discussing";
  state.approval = null;
}
export function propose(state, plan, baseline) {
  if (state.phase !== "planning") throw new Error("Goal is not planning");
  if (!state.answers.length)
    throw new Error("Ask and record at least one feature question first");
  if (!state.research.length)
    throw new Error("Recorded research is required before proposing a plan");
  profiles(state.profiles, true);
  state.plan = validatePlan(plan);
  state.baseline = baseline;
  state.revision++;
  state.approval = null;
  state.progress = state.plan.steps.map((step) => ({
    id: step.id,
    status: "pending",
    result: null,
  }));
  state.checks = [];
  state.review = null;
  state.phase = "awaiting_approval";
  state.reason = null;
}
export function approve(state, token) {
  if (state.phase !== "awaiting_approval")
    throw new Error("No plan is awaiting approval");
  if (token !== approvalToken(state))
    throw new Error(
      "Approval revision is stale or missing. Read /goal status and approve its exact revision.",
    );
  profiles(state.profiles, true);
  state.approval = token;
  state.phase = "approved";
}
export function pause(state, reason = "Paused by user") {
  if (["completed", "cancelled"].includes(state.phase)) return;
  state.phase = "paused";
  state.approval = null;
  state.reason = reason;
}
export function restore(entries, cwd) {
  let state = null;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== STATE_TYPE) continue;
    const candidate = entry.data;
    if (
      !candidate ||
      candidate.version !== 1 ||
      candidate.cwd !== cwd ||
      !PHASES.includes(candidate.phase)
    )
      continue;
    state = clone(candidate);
  }
  if (!state) return null;
  // Restored approvals are never executable, including /tree and fork.
  if (
    ["approved", "executing", "planning"].includes(state.phase) ||
    state.worker
  )
    pause(state, "Interrupted session. Inspect changes and use /goal resume.");
  state.worker = null;
  return state;
}
export function toolAllowed(state, name) {
  if (!state || ["completed", "cancelled"].includes(state.phase)) return true;
  if (READ_TOOLS.has(name) || name === "todo") return true;
  if (name === "goal_execute") return isApproved(state);
  if (name === "goal_research") return state.phase === "discussing";
  if (name === "goal_plan")
    return (
      state.phase === "discussing" &&
      state.answers.length > 0 &&
      state.research.length > 0
    );
  if (name === "goal_question")
    return ["discussing", "awaiting_approval"].includes(state.phase);
  return false;
}
export function renderQuestion(question) {
  return `## Goal question ${question.id}\n\n${question.context}\n\n**${question.question}**\n${question.options.map((option, i) => `${i + 1}. ${option}`).join("\n")}\n\nReply in chat, or use /goal answer <your answer>.`;
}
export function renderProfiles(value) {
  return ROLES.map(
    (role) =>
      `- ${role}: ${value[role] ? `${value[role].model} / ${value[role].thinking} / up to ${value[role].maxTurns} turns` : "not configured"}`,
  ).join("\n");
}
export function renderPlan(state) {
  const p = state.plan;
  if (!p) return "No plan proposed yet.";
  return `## ${p.title}\n\n${p.summary}\n\n### Acceptance criteria\n${p.acceptance.map((c) => `- ${c}`).join("\n")}\n\n### Constraints\n${p.constraints.map((c) => `- ${c}`).join("\n") || "- None specified"}\n\n### Steps\n${p.steps.map((s) => `${s.id}. **${s.title}**\n   Files: ${s.files.join(", ")}\n   ${s.instructions}`).join("\n\n")}\n\n### Verification (executed exactly as approved)\n${p.checks.map((c) => `- ${JSON.stringify(c.command)} (timeout ${c.timeout}s)`).join("\n")}\n\n### Risks\n${p.risks.map((c) => `- ${c}`).join("\n") || "- None identified"}\n\n### Role profiles\n${renderProfiles(state.profiles)}\n\nOne writer at a time. Workers have read/edit/write tools, no shell or nested agents. Verification commands run in ${state.cwd}. No automatic commits or merges. Review failure stops for your input; no automatic repair loop.\n\n**Revision: ${approvalToken(state)}**\nUse /goal approve ${approvalToken(state)} to approve and start, or /goal revise <feedback>.`;
}
export function renderStatus(state) {
  if (!state) return "No active goal. Start with /goal <feature>.";
  const lines = [
    `## Goal: ${state.feature}`,
    `State: ${state.phase}`,
    state.reason ?? "",
    renderProfiles(state.profiles),
  ];
  if (state.worker)
    lines.push(
      `Worker: ${state.worker.role} (${state.worker.id ?? "starting"})`,
    );
  for (const item of state.progress)
    lines.push(
      `${item.status}: ${state.plan?.steps.find((s) => s.id === item.id)?.title ?? item.id}`,
    );
  if (state.pendingQuestion) lines.push(renderQuestion(state.pendingQuestion));
  if (state.phase === "awaiting_approval") lines.push(renderPlan(state));
  if (state.review)
    lines.push(`Review: ${state.review.verdict}\n${state.review.summary}`);
  return lines.filter(Boolean).join("\n\n");
}
