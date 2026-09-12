import { randomUUID } from "node:crypto";

const terminal = (r) => !["queued", "running"].includes(r.status);
const safe = (fn, ...args) => {
  try {
    Promise.resolve(fn?.(...args)).catch(() => {});
  } catch {}
};
const text = (m) =>
  (m?.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
export const topLevel = (r) =>
  r && r.parentAgentId === undefined && r.workflowId === undefined;

/** One owner, queue and terminal barrier for both fresh and resumed sessions. */
export class AgentManager {
  records = new Map();
  queue = [];
  jobs = new Set();
  running = 0;
  closed = false;
  constructor({
    createSession,
    emit = () => {},
    notify = () => {},
    onRecord = () => {},
    maxConcurrent = 10,
  }) {
    Object.assign(this, { createSession, emit, notify, onRecord });
    if (
      !Number.isInteger(maxConcurrent) ||
      maxConcurrent < 1 ||
      maxConcurrent > 64
    )
      throw new Error("maxConcurrent must be 1..64");
    this.maxConcurrent = maxConcurrent;
  }
  getRecord(id) {
    return this.records.get(id);
  }
  list() {
    return [...this.records.values()];
  }
  resolve(ref, owner) {
    const rows = this.list().filter(
      (r) => r.workflowId === owner && r.parentAgentId === undefined,
    );
    const normalized = String(ref).replace(/^@/, "").toLowerCase();
    const matches = rows.filter((r) =>
      [r.id, r.name, r.handle].some((x) => x?.toLowerCase() === normalized),
    );
    if (matches.length !== 1)
      throw new Error(`Unknown or ambiguous agent: ${ref}`);
    return matches[0];
  }
  spawn(type, prompt, options = {}) {
    if (this.closed) throw new Error("Subagent manager is closed");
    if (!String(prompt).trim())
      throw new Error("Agent prompt must not be empty");
    if (options.isolation && options.isolation !== "off")
      throw new Error(
        "Worktree isolation is not supported by this local runtime",
      );
    if (options.schedule !== undefined || options.parentAgentId !== undefined)
      throw new Error("Scheduling and nested delegation are not supported");
    const slug =
      String(type)
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, "-") || "agent";
    let handle = slug === "main" ? "main-2" : slug;
    let i = 2;
    const taken = (s) =>
      this.list().some((r) => [r.handle, r.name].includes(s));
    while (taken(handle)) handle = `${slug}-${i++}`;
    const name = options.name?.toLowerCase();
    if (
      name &&
      (!/^[a-z0-9_-]{1,64}$/.test(name) || name === "main" || taken(name))
    )
      throw new Error("Agent name is invalid or already used");
    const r = {
      id: randomUUID(),
      type,
      description: options.description || type,
      handle,
      name,
      workflowId: options.workflowId,
      options,
      status: "queued",
      resultConsumed: false,
      usage: { input: 0, output: 0, totalTokens: 0 },
      turns: 0,
      toolUses: 0,
    };
    this.records.set(r.id, r);
    try {
      this.#enqueue(r, prompt, options);
    } catch (error) {
      this.records.delete(r.id);
      throw error;
    }
    return r;
  }
  resume(id, prompt, options = {}, owner) {
    const r = this.records.get(id);
    if (
      this.closed ||
      !r ||
      r.workflowId !== owner ||
      !["completed", "steered"].includes(r.status) ||
      !r.session ||
      r.session.isStreaming ||
      r.invocation?.active
    )
      throw new Error("Resume requires an owned settled session");
    options.signal?.throwIfAborted();
    if (!String(prompt).trim())
      throw new Error("Agent prompt must not be empty");
    if (
      options.invocationId !== undefined &&
      (typeof options.invocationId !== "string" || !options.invocationId.trim())
    )
      throw new Error("invocationId must be nonempty");
    this.#enqueue(r, prompt, {
      ...r.options,
      ...options,
      signal: options.signal,
      invocationId: options.invocationId,
      onQueued: undefined,
      onSpawned: undefined,
    });
    return r;
  }
  #enqueue(r, prompt, options) {
    const maxTurns = options.maxTurns ?? 24;
    if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 100)
      throw new Error("maxTurns must be an integer from 1 to 100");
    const controller = new AbortController();
    let done;
    const promise = new Promise((resolve) => {
      done = resolve;
    });
    const inv = {
      active: true,
      controller,
      options,
      prompt,
      maxTurns,
      done,
      promise,
      started: false,
      stopped: false,
      soft: false,
      hard: false,
      turns: 0,
    };
    r.invocation = inv;
    r.promise = promise;
    r.status = "queued";
    r.result = undefined;
    r.error = undefined;
    r.structuredJson = undefined;
    r.resultConsumed = false;
    r.goalInvocationId = options.invocationId;
    this.jobs.add(promise);
    const abort = () => this.stop(r.id, r.workflowId);
    options.signal?.addEventListener("abort", abort, { once: true });
    inv.detach = () => options.signal?.removeEventListener("abort", abort);
    this.queue.push([r, inv]);
    safe(options.onQueued, r.id);
    this.#event("created", r);
    if (options.signal?.aborted) abort();
    queueMicrotask(() => this.#pump());
  }
  #pump() {
    while (
      !this.closed &&
      this.running < this.maxConcurrent &&
      this.queue.length
    ) {
      const [r, inv] = this.queue.shift();
      if (!inv.active) continue;
      inv.started = true;
      this.running++;
      r.status = "running";
      r.startedAt = Date.now();
      this.#run(r, inv).catch((error) => this.#finish(r, inv, error));
    }
  }
  async #run(r, inv) {
    let unsubscribe;
    try {
      if (!r.session) r.session = await this.createSession(r, inv.options);
      const session = r.session;
      inv.controller.signal.throwIfAborted();
      safe(inv.options.onSpawned, r.id);
      inv.options.onStarted?.(session);
      inv.controller.signal.throwIfAborted();
      const fresh = []; // Event-local, so compaction cannot replay old prose.
      unsubscribe = session.subscribe((event) => {
        if (!inv.active || r.invocation !== inv) return;
        if (event.type === "tool_execution_start") r.toolUses++;
        if (
          event.type === "message_end" &&
          event.message?.role === "assistant"
        ) {
          fresh.push(event.message);
          const u = event.message.usage;
          if (u) {
            r.usage.input += u.input ?? 0;
            r.usage.output += u.output ?? 0;
            r.usage.totalTokens +=
              u.totalTokens ?? (u.input ?? 0) + (u.output ?? 0);
          }
        }
        if (event.type === "turn_end") {
          r.turns++;
          inv.turns++;
          if (inv.turns >= inv.maxTurns && !inv.soft) {
            inv.soft = true;
            safe(
              session.steer.bind(session),
              "Your turn budget is reached. Wrap up now with your final answer, using StructuredOutput if provided.",
            );
          } else if (inv.turns >= inv.maxTurns + 5) {
            inv.hard = true;
            inv.controller.abort();
            safe(session.abort.bind(session));
          }
        }
        if (event.type === "auto_compaction_end") this.#event("compacted", r);
      });
      this.#event("started", r);
      await session.prompt(inv.prompt, { expandPromptTemplates: false });
      if (
        !inv.stopped &&
        !inv.hard &&
        inv.options.structuredOutput &&
        r.structuredJson === undefined
      ) {
        await session.prompt(
          "Submit your final result through the StructuredOutput tool now. Do not answer only in prose.",
          { expandPromptTemplates: false },
        );
      }
      await session.agent?.waitForIdle?.();
      r.result = fresh.map(text).filter(Boolean).join("\n");
      const last = fresh.at(-1);
      if (last?.stopReason === "error")
        throw new Error(last.errorMessage || "Provider failed");
      if (last?.stopReason === "aborted" && !inv.stopped && !inv.hard)
        throw new Error("Provider aborted the response");
      if (
        !inv.stopped &&
        !inv.hard &&
        inv.options.structuredOutput &&
        r.structuredJson === undefined
      )
        throw new Error("Agent did not submit valid StructuredOutput");
      if (
        !inv.stopped &&
        !inv.hard &&
        !inv.options.structuredOutput &&
        !r.result.trim()
      )
        throw new Error("Agent returned an empty result");
      this.#finish(r, inv);
    } catch (error) {
      // SDK prompt/abort completion is the barrier - no terminal event while tools unwind.
      try {
        await r.session?.agent?.waitForIdle?.();
      } catch {}
      this.#finish(r, inv, error);
    } finally {
      unsubscribe?.();
    }
  }
  #event(event, r) {
    if (!topLevel(r)) return;
    safe(this.emit, `subagents:${event}`, {
      id: r.id,
      type: r.type,
      description: r.description,
      status: r.status,
      result: r.result,
      error: r.error,
      startedAt: r.startedAt,
      completedAt: r.completedAt,
      usage: { ...r.usage },
      ...(r.goalInvocationId !== undefined
        ? { goalInvocationId: r.goalInvocationId }
        : {}),
    });
  }
  #finish(r, inv, error) {
    if (!inv.active) return;
    inv.active = false;
    inv.detach();
    r.status = inv.hard
      ? "aborted"
      : inv.stopped
        ? "stopped"
        : error
          ? "error"
          : inv.soft
            ? "steered"
            : "completed";
    r.error = inv.hard
      ? "Agent exceeded its turn budget and grace turns"
      : error && !inv.stopped
        ? String(error.message ?? error)
        : undefined;
    r.completedAt = Date.now();
    if (inv.started) this.running--;
    this.jobs.delete(inv.promise);
    this.#event(
      ["completed", "steered"].includes(r.status) ? "completed" : "failed",
      r,
    );
    safe(this.onRecord, r);
    inv.done(r);
    if (
      topLevel(r) &&
      inv.options.isBackground &&
      !r.resultConsumed &&
      !this.closed
    ) {
      const timer = setTimeout(() => {
        if (!this.closed && r.invocation === inv && !r.resultConsumed)
          safe(this.notify, r);
      }, 200);
      timer.unref?.();
      inv.notification = timer;
    }
    queueMicrotask(() => this.#pump());
  }
  consume(id, owner) {
    const r = this.records.get(id);
    if (!r || r.workflowId !== owner || !terminal(r)) return false;
    r.resultConsumed = true;
    clearTimeout(r.invocation?.notification);
    return true;
  }
  stop(id, owner) {
    const r = this.records.get(id);
    if (!r || r.workflowId !== owner || !r.invocation?.active) return false;
    const inv = r.invocation;
    inv.stopped = true;
    inv.controller.abort();
    if (!inv.started) this.#finish(r, inv);
    else if (r.session) safe(r.session.abort.bind(r.session));
    return true;
  }
  async steer(id, message, owner) {
    const r = this.records.get(id);
    if (
      !r ||
      r.workflowId !== owner ||
      !r.invocation?.active ||
      !r.session ||
      r.status !== "running"
    )
      throw new Error("Agent is not running yet; steer after it starts");
    await r.session.steer(message);
    this.#event("steered", r);
  }
  hasRunning() {
    return this.jobs.size > 0;
  }
  async waitForAll() {
    while (this.jobs.size) await Promise.all([...this.jobs]);
  }
  async dispose() {
    this.closed = true;
    for (const r of this.records.values()) {
      clearTimeout(r.invocation?.notification);
      this.stop(r.id, r.workflowId);
    }
    await this.waitForAll();
    for (const r of this.records.values())
      safe(r.session?.dispose?.bind(r.session));
  }
}
