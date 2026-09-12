import { randomUUID } from "node:crypto";

const abortError = () =>
  Object.assign(new Error("Subagent run aborted"), { name: "AbortError" });
const timeoutError = (verb) =>
  Object.assign(
    new Error(
      `Subagents ${verb} timed out (service unavailable or startup pending)`,
    ),
    { name: "TimeoutError" },
  );

/** In-process protocol-v2 client. timeoutMs bounds RPC acknowledgement, not model work.
 * A timeout/abort is NOT proof that tools have stopped. Ownership is retained until
 * a terminal lifecycle event (or a spawn refusal before ownership was established).
 * In 0.19.0 queued cancellation emits no terminal event. Only a synchronous
 * queued -> stopped registry observation can release that case without an event.
 */
export class SubagentClient {
  #events;
  #timeoutMs;
  #onActivity;
  #getRecord;
  #getManager;
  #resumable = new Map();
  #active;
  #disposed = false;
  #cleanups = new Set();

  constructor(
    events,
    { timeoutMs = 5000, onActivity = () => {}, getRecord, getManager } = {},
  ) {
    this.#events = events;
    this.#timeoutMs = timeoutMs;
    this.#onActivity = onActivity;
    this.#getManager =
      getManager ?? (() => globalThis[Symbol.for("pi-subagents:manager")]);
    this.#getRecord =
      getRecord ?? ((id) => this.#getManager()?.getRecord?.(id));
  }

  #record(id) {
    try {
      return id ? this.#getRecord(id) : undefined;
    } catch {
      return undefined;
    }
  }

  get hasUnsettled() {
    return Boolean(this.#active);
  }

  #listen(channel, handler) {
    const off = this.#events.on(channel, handler);
    const cleanup = () => {
      off();
      this.#cleanups.delete(cleanup);
    };
    this.#cleanups.add(cleanup);
    return cleanup;
  }

  #notify(callback, value) {
    // UI/persistence observers must never throw through the manager's spawn path.
    try {
      Promise.resolve(callback?.(value)).catch(() => {});
    } catch {
      /* observer only */
    }
  }

  #send(verb, agentId) {
    try {
      this.#events.emit(`subagents:rpc:${verb}`, {
        requestId: randomUUID(),
        agentId,
      });
    } catch {
      /* best effort; never infer settlement from a stop acknowledgement */
    }
  }

  async ping(signal) {
    if (this.#disposed) throw new Error("SubagentClient is disposed");
    if (signal?.aborted) throw abortError();
    const reply = await new Promise((resolve, reject) => {
      const requestId = randomUUID();
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        off();
        signal?.removeEventListener("abort", aborted);
        this.#cleanups.delete(cancel);
      };
      const finish = (error, data) => {
        cleanup();
        error ? reject(error) : resolve(data);
      };
      const aborted = () => finish(abortError());
      const cancel = aborted;
      const off = this.#listen(
        `subagents:rpc:ping:reply:${requestId}`,
        (reply) => {
          finish(
            reply?.success
              ? undefined
              : new Error(reply?.error || "Ping failed"),
            reply?.data,
          );
        },
      );
      this.#cleanups.add(cancel);
      signal?.addEventListener("abort", aborted, { once: true });
      timer = setTimeout(() => finish(timeoutError("ping")), this.#timeoutMs);
      try {
        this.#events.emit("subagents:rpc:ping", { requestId });
      } catch (error) {
        finish(error);
      }
    });
    if (reply?.version !== 2)
      throw new Error(
        `Unsupported subagents protocol version: ${reply?.version}`,
      );
    return 2;
  }

  assertResumeSupport() {
    const manager = this.#getManager();
    if (
      manager?.goalResumeVersion !== 1 ||
      typeof manager.resume !== "function"
    )
      throw new Error(
        "Persistent goal workers require the local pi-subagents package with managed resume support. Enable ./packages/pi-subagents in agent/settings.json, then restart Pi after owned workers settle.",
      );
    return manager;
  }

  /** Drop reuse authority, not live ownership. Never stop an unrelated worker. */
  forgetContinuations() {
    this.#resumable.clear();
  }

  run({
    type,
    prompt,
    model,
    thinkingLevel,
    maxTurns,
    signal,
    structuredOutput,
    cwd,
    onSpawned,
    persistent = false,
    resumeId,
  }) {
    if (this.#disposed)
      return Promise.reject(new Error("SubagentClient is disposed"));
    if (this.#active)
      return Promise.reject(new Error("A subagent run is still unsettled"));
    if (signal?.aborted) return Promise.reject(abortError());
    let manager, retained;
    if (persistent || resumeId) {
      try {
        manager = this.assertResumeSupport();
        if (resumeId) {
          retained = this.#resumable.get(resumeId);
          const record = this.#record(resumeId);
          if (
            !retained ||
            !record?.session ||
            record.session !== retained.session ||
            !["completed", "steered"].includes(record.status) ||
            record.session.isStreaming ||
            JSON.stringify([type, model, thinkingLevel, maxTurns, cwd]) !==
              retained.profile ||
            structuredOutput !== retained.structuredOutput
          )
            throw new Error(
              "Cannot resume a missing, changed, active or unowned goal worker",
            );
          this.#resumable.delete(resumeId);
        }
      } catch (error) {
        return Promise.reject(error);
      }
    }
    const state = {
      type,
      controller: new AbortController(),
      id: undefined,
      terminal: false,
      cancelled: false,
      invocationId: resumeId ? randomUUID() : undefined,
    };
    this.#active = state;
    const promise = new Promise((resolve, reject) => {
      let answered = false;
      let timer;
      let replyOff;
      const eventOffs = [];
      const detachWait = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", aborted);
      };
      const answer = (error, event) => {
        if (answered) return;
        answered = true;
        detachWait();
        error ? reject(error) : resolve(event);
      };
      const release = () => {
        state.terminal = true;
        if (this.#active === state) this.#active = undefined;
        for (const off of eventOffs) off();
        replyOff?.();
        detachWait();
      };
      const cancel = (error) => {
        if (state.terminal) return;
        state.cancelled = true;
        // Observe queued BEFORE abort: running records also become 'stopped'
        // immediately, while their tools may still be unwinding. Never release
        // a running worker based on that status alone.
        const wasQueued = this.#record(state.id)?.status === "queued";
        answer(error);
        state.controller.abort();
        if (state.id && !state.terminal) this.#send("stop", state.id);
        if (
          wasQueued &&
          !state.terminal &&
          this.#record(state.id)?.status === "stopped"
        ) {
          this.#send("consume", state.id);
          release();
        }
      };
      state.cancel = cancel;
      const aborted = () => cancel(abortError());
      const own = (id) => {
        if (typeof id !== "string" || !id) return;
        if (state.id && state.id !== id) return; // Never adopt another run's id.
        if (!state.id) {
          state.id = id;
          this.#notify(onSpawned, id);
          this.#notify(this.#onActivity, { event: "started", id, type });
        }
        if ((state.cancelled || this.#disposed) && !state.terminal) {
          this.#send("stop", id);
          this.#send("consume", id);
        }
      };
      const settled = (raw) => {
        if (!state.id || raw?.id !== state.id || state.terminal) return;
        // A resumed worker keeps its id. Only this invocation's correlated
        // terminal event can release ownership, never an older completion.
        if (resumeId && raw.goalInvocationId !== state.invocationId) return;
        // Must happen inside the lifecycle emit, before pi-subagents checks nudges.
        this.#send("consume", state.id);
        const event = {
          id: raw.id,
          type: raw.type ?? type,
          status: raw.status,
          result: raw.result,
          error: raw.error,
          usage: raw.usage,
        };
        release();
        this.#notify(this.#onActivity, { event: "settled", ...event });
        let error;
        const softHandoff =
          persistent && structuredOutput && event.status === "steered";
        if ((event.status !== "completed" && !softHandoff) || event.error) {
          error = new Error(
            event.error || `Subagent ended with status ${event.status}`,
          );
        } else if (
          !structuredOutput &&
          (event.result == null ||
            (typeof event.result === "string" && !event.result.trim()))
        ) {
          error = new Error("Subagent returned an empty result");
        }
        if (!error && persistent && !state.cancelled && !this.#disposed) {
          const session = this.#record(state.id)?.session;
          if (session)
            this.#resumable.set(state.id, {
              session,
              profile: JSON.stringify([
                type,
                model,
                thinkingLevel,
                maxTurns,
                cwd,
              ]),
              structuredOutput,
            });
        }
        if (error) error.event = event;
        answer(error, event);
      };
      eventOffs.push(
        this.#listen("subagents:completed", settled),
        this.#listen("subagents:failed", settled),
      );
      if (resumeId) {
        // Register ownership/listeners before dispatch: resume may start and
        // finish synchronously. The previous terminal emit has already returned
        // because callers await the preceding run's promise.
        signal?.addEventListener("abort", aborted, { once: true });
        own(resumeId);
        // Observers can synchronously abort while ownership is announced.
        // No new work has been dispatched yet, so releasing here is safe.
        if (signal?.aborted && !state.cancelled) aborted();
        if (state.cancelled) {
          release();
          return;
        }
        timer = setTimeout(
          () => cancel(timeoutError("resume")),
          this.#timeoutMs,
        );
        try {
          const pending = manager.resume(resumeId, prompt, {
            invocationId: state.invocationId,
            signal: state.controller.signal,
            maxTurns,
            onStarted: (session) => {
              if (session !== retained.session) {
                cancel(new Error("Resumed worker session identity changed"));
                return;
              }
              // onStarted precedes the runner's abort listener. Defer a repeat
              // stop to the microtask boundary if cancellation won that race.
              if (state.cancelled)
                queueMicrotask(() => {
                  if (!state.terminal) this.#send("stop", resumeId);
                });
            },
          });
          Promise.resolve(pending).then(
            (record) => {
              clearTimeout(timer);
              if (state.terminal) return;
              if (!record || record.id !== resumeId) {
                // A documented refusal is safe only if the original idle session
                // is still unchanged; otherwise keep ownership until settlement.
                if (
                  !record &&
                  this.#record(resumeId)?.session === retained.session &&
                  ["completed", "steered"].includes(
                    this.#record(resumeId)?.status,
                  ) &&
                  !retained.session.isStreaming
                ) {
                  release();
                  answer(
                    new Error("Subagent runtime refused worker continuation"),
                  );
                } else
                  cancel(
                    new Error(
                      "Subagent runtime did not acknowledge the owned continuation",
                    ),
                  );
              }
            },
            (error) => cancel(error),
          );
        } catch (error) {
          cancel(error);
        }
        return;
      }
      const requestId = randomUUID();
      replyOff = this.#listen(
        `subagents:rpc:spawn:reply:${requestId}`,
        (reply) => {
          replyOff();
          clearTimeout(timer);
          if (!reply?.success) {
            if (!state.id) release();
            else cancel(new Error(reply?.error || "Spawn failed"));
            answer(new Error(reply?.error || "Spawn failed"));
            return;
          }
          own(reply.data?.id);
          if (!state.id) cancel(new Error("Spawn reply did not contain an id"));
        },
      );
      signal?.addEventListener("abort", aborted, { once: true });
      timer = setTimeout(() => cancel(timeoutError("spawn")), this.#timeoutMs);
      try {
        this.#events.emit("subagents:rpc:spawn", {
          requestId,
          type,
          prompt,
          options: {
            isBackground: true,
            isolated: true,
            inheritContext: false,
            signal: state.controller.signal,
            description: type,
            name: `goal-${randomUUID()}`,
            model,
            thinkingLevel,
            maxTurns,
            cwd,
            structuredOutput,
            onSpawned: own,
            onQueued: own,
          },
        });
      } catch (error) {
        cancel(error);
      }
    });
    // Shutdown may reject an abandoned run. Mark it handled internally as well.
    promise.catch(() => {});
    return promise;
  }

  async stop() {
    this.#active?.cancel(abortError());
  }

  /** Stops this client's worker and removes bus listeners. Unknown settlement
   * remains reflected by hasUnsettled; disposal is not a shutdown barrier.
   */
  async dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.forgetContinuations();
    await this.stop();
    for (const cleanup of [...this.#cleanups]) cleanup();
  }
}
