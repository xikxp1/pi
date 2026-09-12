import { Worker } from "node:worker_threads";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { parse } from "acorn";
import Ajv from "ajv";

const MAX_AGENTS = 1000,
  MAX_NESTED = 256;
const safeName = (value) =>
  typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);
const plain = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const canonical = (x) =>
  JSON.stringify(x, (_, v) =>
    plain(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );
const json = (value) => {
  const text = JSON.stringify(value);
  if (text === undefined || Buffer.byteLength(text) > 1024 * 1024)
    throw new Error("Expected bounded JSON data (1 MiB)");
  return JSON.parse(text);
};
class Fatal extends Error {}
function jsonArgs(value) {
  const seen = new Set();
  const visit = (item) => {
    if (item === null || typeof item === "string" || typeof item === "boolean")
      return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (
      typeof item !== "object" ||
      seen.has(item) ||
      (!Array.isArray(item) &&
        Object.getPrototypeOf(item) !== Object.prototype &&
        Object.getPrototypeOf(item) !== null)
    )
      throw new Fatal("Workflow args must be strict JSON data");
    seen.add(item);
    const keys = Reflect.ownKeys(item).filter(
      (key) => !(Array.isArray(item) && key === "length"),
    );
    if (Array.isArray(item) && keys.length !== item.length)
      throw new Fatal("Workflow args must be strict JSON data");
    for (const key of keys) {
      const property = Object.getOwnPropertyDescriptor(item, key);
      if (
        typeof key !== "string" ||
        !property.enumerable ||
        !Object.hasOwn(property, "value") ||
        (Array.isArray(item) &&
          (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= item.length))
      )
        throw new Fatal("Workflow args must be strict JSON data");
      visit(property.value);
    }
    seen.delete(item);
  };
  visit(value);
  return json(value);
}
function literal(node) {
  if (node.type === "Literal" && !node.regex && !node.bigint) return node.value;
  if (
    node.type === "UnaryExpression" &&
    node.operator === "-" &&
    node.argument.type === "Literal" &&
    typeof node.argument.value === "number"
  )
    return -node.argument.value;
  if (node.type === "ArrayExpression")
    return node.elements.map((n) => {
      if (!n) throw new Fatal("meta must be pure literal");
      return literal(n);
    });
  if (node.type === "ObjectExpression") {
    const result = Object.create(null);
    for (const p of node.properties) {
      if (
        p.type !== "Property" ||
        p.computed ||
        p.method ||
        p.shorthand ||
        p.kind !== "init"
      )
        throw new Fatal("meta must be pure literal");
      const key = p.key.name ?? p.key.value;
      if (Object.hasOwn(result, key))
        throw new Fatal("Duplicate meta property");
      result[key] = literal(p.value);
    }
    return result;
  }
  throw new Fatal("meta must be pure literal");
}
function compile(source) {
  if (
    typeof source !== "string" ||
    !source.trim() ||
    Buffer.byteLength(source) > 512 * 1024
  )
    throw new Fatal("Expected nonempty workflow script, at most 512 KiB");
  let ast;
  try {
    ast = parse(source, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
    });
  } catch (error) {
    throw new Fatal(`Invalid workflow script: ${error.message}`);
  }
  const first = ast.body[0];
  const declaration = first?.declaration;
  const binding = declaration?.declarations?.[0];
  if (
    first?.type !== "ExportNamedDeclaration" ||
    declaration?.type !== "VariableDeclaration" ||
    declaration.kind !== "const" ||
    declaration.declarations.length !== 1 ||
    binding?.id.type !== "Identifier" ||
    binding.id.name !== "meta" ||
    binding.init?.type !== "ObjectExpression"
  )
    throw new Fatal("First statement must be export const meta = {...}");
  const meta = literal(binding.init);
  for (const statement of ast.body) {
    if (statement.type === "ExportNamedDeclaration" && statement !== first)
      throw new Fatal("Only the first meta declaration may be exported");
    if (
      statement.type === "ExportDefaultDeclaration" ||
      statement.type === "ImportDeclaration"
    )
      throw new Fatal(
        "Imports and default exports are unavailable; use a statement body",
      );
  }
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "ImportExpression")
      throw new Fatal("Dynamic imports are unavailable");
    for (const value of Object.values(node))
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") walk(value);
  };
  walk(ast);
  for (const key of ["name", "description"])
    if (typeof meta[key] !== "string" || !meta[key].trim())
      throw new Fatal(`meta.${key} must be a nonempty string`);
  if (meta.phases !== undefined && !Array.isArray(meta.phases))
    throw new Fatal("meta.phases must be a pure-literal array");
  source = source.slice(0, first.start) + source.slice(declaration.start);
  return { source, meta };
}

// A shared service semaphore bounds workflows together. The manager may queue
// these children again; no worktree, manager scheduling or manager cancellation
// ownership is duplicated here.
export class WorkflowService {
  constructor({
    cwd,
    agentDir,
    sessionId,
    runAgent,
    notify = () => {},
    onUpdate = () => {},
  }) {
    if (typeof runAgent !== "function")
      throw new TypeError("runAgent callback is required");
    this.cwd = path.resolve(cwd);
    this.agentDir = path.resolve(agentDir);
    this.sessionId = sessionId;
    this.runAgent = runAgent;
    this.notify = notify;
    this.onUpdate = onUpdate;
    this.records = new Map();
    this.states = new Map();
    this.disposed = false;
    this.active = 0;
    this.queue = [];
    this.cap = Math.max(1, Math.min(16, os.cpus().length - 2));
    this.ajv = new Ajv({ strict: false, allErrors: true });
    this.directory = fs
      .mkdtemp(path.join(os.tmpdir(), "pi-workflows-"))
      .then(async (dir) => {
        await fs.chmod(dir, 0o700);
        return dir;
      });
  }
  get(id) {
    return this.records.get(id);
  }
  list() {
    return [...this.records.values()];
  }
  async resolve(params) {
    if (!plain(params))
      throw new Fatal("Workflow parameters must be an object");
    let filename, script;
    if (params.scriptPath !== undefined) {
      if (typeof params.scriptPath !== "string" || !params.scriptPath)
        throw new Fatal("Invalid scriptPath");
      filename = path.resolve(this.cwd, params.scriptPath);
      script = await fs.readFile(filename, "utf8");
    } else if (params.script !== undefined) {
      script = params.script;
    } else if (params.name !== undefined) {
      if (!safeName(params.name)) throw new Fatal("Unsafe workflow name");
      for (const dir of [
        path.join(this.cwd, ".pi/workflows"),
        path.join(this.cwd, ".agents/workflows"),
        path.join(this.agentDir, "workflows"),
      ]) {
        for (const extension of [".js", ".mjs"]) {
          const candidate = path.join(dir, params.name + extension);
          try {
            script = await fs.readFile(candidate, "utf8");
            filename = candidate;
            break;
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
        }
        if (filename) break;
      }
      if (!filename) throw new Fatal(`Workflow not found: ${params.name}`);
    } else throw new Fatal("Specify scriptPath, script or name");
    return {
      ...compile(script),
      original: script,
      filename,
      args: params.args === undefined ? undefined : jsonArgs(params.args),
    };
  }
  async start(params) {
    if (this.disposed) throw new Error("Workflow service disposed");
    if (!plain(params))
      throw new Fatal("Workflow parameters must be an object");
    let replay = [],
      prior;
    if (params.resumeFromRunId !== undefined) {
      prior = this.states.get(params.resumeFromRunId);
      if (!prior || prior.sessionId !== this.sessionId || !prior.settled)
        throw new Fatal("Replay requires a settled run in the same session");
      params = { ...params };
      if (
        ["scriptPath", "script", "name"].every(
          (key) => params[key] === undefined,
        )
      )
        params.scriptPath = prior.ownScriptPath;
      if (params.args === undefined) params.args = prior.args;
      if (prior.journal.some((e) => e.childResume))
        throw new Fatal("Cannot replay a journal containing child resume");
      // Only a successful unchanged invocation prefix is eligible; failed calls
      // are never replayed, even when the script itself handled their null value.
      for (const entry of prior.journal) {
        if (!entry || !entry.ok) break;
        replay.push(json(entry));
      }
    }
    const prepared = await this.resolve(params);
    const dir = await this.directory;
    if (this.disposed) throw new Error("Workflow service disposed");
    const id = `wf_${randomUUID().replaceAll("-", "")}`;
    const scriptPath = path.join(dir, `${id}.js`),
      journalPath = path.join(dir, `${id}.jsonl`);
    await fs.writeFile(scriptPath, prepared.original, { mode: 0o600 });
    await fs.writeFile(journalPath, "", { mode: 0o600 });
    if (this.disposed) throw new Error("Workflow service disposed");
    const record = {
      id,
      name: prepared.meta.name ?? params.name ?? id,
      description: prepared.meta.description ?? "",
      status: "running",
      scriptPath: prepared.filename ?? scriptPath,
      journalPath,
      startedAt: Date.now(),
      result: undefined,
      error: undefined,
      promise: undefined,
    };
    const state = {
      record,
      sessionId: this.sessionId,
      ownScriptPath: scriptPath,
      source: prepared.original,
      args: prepared.args,
      controller: new AbortController(),
      tasks: new Set(),
      workers: new Set(),
      journal: [],
      replay,
      replayOrder: [...replay].sort((a, b) =>
        prior?.source === prepared.original &&
        canonical(prior.args) === canonical(prepared.args)
          ? (a.completion ?? a.index) - (b.completion ?? b.index)
          : a.index - b.index,
      ),
      replayPending: new Map(),
      completed: 0,
      cursor: 0,
      labels: new Map(),
      total: 0,
      nested: 0,
      usage: {},
      settled: false,
      write: Promise.resolve(),
      fatal: null,
    };
    this.records.set(id, record);
    this.states.set(id, state);
    record.promise = this.execute(state, prepared)
      .then(
        (result) => {
          if (!state.controller.signal.aborted) {
            record.result = result;
            state.outcome = "completed";
          }
        },
        (error) => {
          record.error = state.fatal ?? error.message;
          state.outcome = state.stopped ? "cancelled" : "failed";
        },
      )
      .finally(async () => {
        state.controller.abort();
        await Promise.allSettled(
          [...state.workers].map((worker) => worker.terminate()),
        );
        while (state.tasks.size) await Promise.allSettled([...state.tasks]);
        record.status = state.outcome ?? "failed";
        try {
          await state.write;
        } catch (error) {
          record.status = "failed";
          record.error = error.message;
        }
        if (state.stopped) record.status = "cancelled";
        if (state.fatal && record.status !== "cancelled") {
          record.status = "failed";
          record.error = state.fatal;
        }
        record.endedAt = Date.now();
        state.settled = true;
        this.emit(this.onUpdate, record);
        this.emit(this.notify, record);
      })
      .then(() => record);
    this.emit(this.onUpdate, record);
    return record;
  }
  emit(fn, value) {
    if (!this.disposed) {
      try {
        Promise.resolve(fn(value)).catch(() => {});
      } catch {
        /* UI callbacks cannot own the run. */
      }
    }
  }
  async acquire(signal) {
    if (signal.aborted) throw new Error("Workflow cancelled");
    if (this.active < this.cap) {
      this.active++;
      return;
    }
    await new Promise((resolve, reject) => {
      const entry = {
        resolve: () => {
          signal.removeEventListener("abort", abort);
          resolve();
        },
      };
      const abort = () => {
        const i = this.queue.indexOf(entry);
        if (i >= 0) this.queue.splice(i, 1);
        reject(new Error("Workflow cancelled"));
      };
      signal.addEventListener("abort", abort, { once: true });
      this.queue.push(entry);
    });
  }
  release() {
    const next = this.queue.shift();
    if (next) next.resolve();
    else this.active--;
  }
  persist(state) {
    const text = state.journal
      .filter(Boolean)
      .map((entry) => JSON.stringify(entry))
      .join("\n");
    state.write = state.write.then(() =>
      fs.writeFile(state.record.journalPath, text ? text + "\n" : "", {
        mode: 0o600,
      }),
    );
    return state.write;
  }
  validateAgent(data) {
    if (
      !plain(data) ||
      typeof data.prompt !== "string" ||
      !data.prompt.trim() ||
      !plain(data.options)
    )
      throw new Fatal("Invalid agent prompt/options");
    const allowed = new Set([
      "label",
      "phase",
      "agentType",
      "model",
      "effort",
      "schema",
      "resume",
      "gate",
    ]);
    for (const key of Object.keys(data.options)) {
      if (key === "isolation")
        throw new Fatal(
          "options.isolation is unsupported; workflows share cwd",
        );
      if (!allowed.has(key)) throw new Fatal(`Unknown agent option: ${key}`);
      if (
        key !== "schema" &&
        (typeof data.options[key] !== "string" || !data.options[key])
      )
        throw new Fatal(`Invalid agent option: ${key}`);
    }
    if (
      data.options.resume &&
      ["agentType", "model", "effort", "schema", "gate"].some(
        (k) => data.options[k] !== undefined,
      )
    )
      throw new Fatal(
        "resume is incompatible with agentType, model, effort, schema and gate",
      );
    if (data.options.schema !== undefined) {
      try {
        this.ajv.compile(data.options.schema);
      } catch (error) {
        throw new Fatal(`Invalid schema: ${error.message}`);
      }
    }
  }
  async agent(state, data) {
    this.validateAgent(data);
    if (++state.total > MAX_AGENTS) throw new Fatal("Total agent cap is 1000");
    const index = state.cursor++,
      key = canonical(data),
      options = { ...data.options };
    const previous = state.replay[index];
    if (previous && previous.key === key) {
      return new Promise((resolve, reject) => {
        const signal = state.controller.signal;
        const abort = () => {
          state.replayPending.delete(index);
          reject(new Error("Workflow cancelled"));
        };
        if (signal.aborted) return abort();
        signal.addEventListener("abort", abort, { once: true });
        state.replayPending.set(index, {
          resolve: (value) => {
            signal.removeEventListener("abort", abort);
            resolve(value);
          },
          reject: (error) => {
            signal.removeEventListener("abort", abort);
            reject(error);
          },
        });
        this.flushReplay(state);
      });
    }
    if (previous) {
      // An edit ends the reusable prefix. Already matched calls still settle in
      // their original completion order; all subsequent invocations run live.
      state.replay = [];
      state.replayOrder = state.replayOrder.filter((entry) =>
        state.replayPending.has(entry.index),
      );
      this.flushReplay(state);
    }
    let schema = options.schema;
    if (options.resume) {
      const prior = state.labels.get(options.resume);
      if (!prior) throw new Fatal(`Unknown resume label: ${options.resume}`);
      if (prior.replayed)
        throw new Fatal(
          `Cannot resume replayed label '${options.resume}' from another workflow run; rerun without resumeFromRunId`,
        );
      options.resume = prior.id;
      schema = prior.schema;
    }
    const entry = {
      index,
      key,
      ok: false,
      childResume: Boolean(options.resume),
      value: null,
    };
    state.journal[index] = entry;
    await this.persist(state);
    const signal = state.controller.signal;
    await this.acquire(signal);
    try {
      if (signal.aborted) throw new Error("Workflow cancelled");
      const gate = options.gate;
      delete options.gate;
      const child = await this.runAgent({
        prompt: data.prompt,
        options,
        signal,
        workflowId: state.record.id,
      });
      if (!child || typeof child.id !== "string")
        throw new Error("Invalid child result");
      entry.childId = child.id;
      if (options.label)
        state.labels.set(options.label, {
          id: child.id,
          schema,
        }); // Retain even if validation or gate fails.
      if (signal.aborted) throw new Error("Workflow cancelled");
      const value = json(child.value);
      if (schema !== undefined) {
        if (!this.ajv.validate(schema, value))
          throw new Error("Child result failed schema validation");
      } else if (typeof value !== "string")
        throw new Error("Structured child values require a schema");
      if (child.usage && plain(child.usage))
        for (const [key, value] of Object.entries(child.usage))
          if (typeof value === "number" && Number.isFinite(value))
            state.usage[key] = (state.usage[key] ?? 0) + value;
      if (gate && !(await runGate(gate, this.cwd, signal)))
        throw new Error("Gate failed");
      if (signal.aborted) throw new Error("Workflow cancelled");
      entry.ok = true;
      entry.value = value;
      return value;
    } catch (error) {
      entry.error = String(error.message ?? error);
      return null;
    } finally {
      this.release();
      entry.completion = state.completed++;
      await this.persist(state);
      this.emit(this.onUpdate, state.record);
    }
  }
  flushReplay(state) {
    while (state.replayOrder.length) {
      const entry = state.replayOrder[0];
      const pending = state.replayPending.get(entry.index);
      if (!pending) break;
      state.replayOrder.shift();
      state.replayPending.delete(entry.index);
      state.journal[entry.index] = { ...entry, completion: state.completed++ };
      const options = JSON.parse(entry.key).options;
      if (options.label && entry.childId)
        state.labels.set(options.label, {
          id: entry.childId,
          schema: options.schema,
          replayed: true,
        });
      this.persist(state).then(
        () => pending.resolve(entry.value),
        pending.reject,
      );
    }
  }
  execute(state, prepared, depth = 0) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(
        new URL("./workflow-worker.mjs", import.meta.url),
        {
          workerData: {
            source: prepared.source,
            args: prepared.args,
            filename: prepared.filename ?? state.record.scriptPath,
          },
          resourceLimits: { maxOldGenerationSizeMb: 64, stackSizeMb: 4 },
        },
      );
      state.workers.add(worker);
      let done = false,
        lastHeartbeat = Date.now();
      const finish = (error, value) => {
        if (done) return;
        done = true;
        clearInterval(watchdog);
        state.controller.signal.removeEventListener("abort", abort);
        // Keep the worker tracked until terminate actually resolves.
        const termination = worker
          .terminate()
          .finally(() => state.workers.delete(worker));
        termination.then(
          () => (error ? reject(error) : resolve(value)),
          reject,
        );
      };
      const abort = () =>
        finish(new Error(state.fatal ?? "Workflow cancelled"));
      const watchdog = setInterval(() => {
        if (Date.now() - lastHeartbeat > 5000) {
          state.fatal = "Workflow worker is unresponsive";
          state.controller.abort();
        }
      }, 500);
      state.controller.signal.addEventListener("abort", abort, { once: true });
      if (state.controller.signal.aborted) {
        abort();
        return;
      }
      worker.on("error", (error) => finish(error));
      worker.on("exit", (code) => {
        if (!done) finish(new Error(`Workflow worker exited (${code})`));
      });
      worker.on("message", (text) => {
        if (done) return;
        let message;
        try {
          if (typeof text !== "string" || text.length > 2 * 1024 * 1024)
            throw new Error("Invalid worker message");
          message = JSON.parse(text);
        } catch (error) {
          finish(error);
          return;
        }
        lastHeartbeat = Date.now();
        if (message.kind === "heartbeat") return;
        if (message.kind === "failed") {
          if (message.fatal) {
            state.fatal = message.error;
            state.controller.abort();
          }
          finish(new Error(message.error));
          return;
        }
        if (message.kind === "done") {
          finish(null, message.value);
          return;
        }
        if (message.kind === "log") {
          this.emit(this.onUpdate, { ...state.record, log: message.data });
          return;
        }
        const task = (async () => {
          let value;
          if (message.kind === "agent")
            value = await this.agent(state, message.data);
          else if (message.kind === "budget")
            value = {
              agents: state.total,
              remaining: MAX_AGENTS - state.total,
              concurrency: this.cap,
              usage: { ...state.usage },
            };
          else if (message.kind === "workflow") {
            if (depth >= 1)
              throw new Fatal("Nested workflows are single-level only");
            if (++state.nested > MAX_NESTED)
              throw new Fatal("Nested workflow cap is 256");
            try {
              const ref = message.data.name;
              let params;
              if (typeof ref === "string" && safeName(ref))
                params = { name: ref };
              else if (
                plain(ref) &&
                Object.keys(ref).length === 1 &&
                typeof ref.scriptPath === "string" &&
                ref.scriptPath
              )
                params = { scriptPath: ref.scriptPath };
              else
                throw new Error(
                  "Invalid workflow reference: expected name or {scriptPath}",
                );
              const nested = await this.resolve({
                ...params,
                args: message.data.args,
              });
              value = await this.execute(state, nested, depth + 1);
            } catch (error) {
              if (state.fatal || state.controller.signal.aborted) throw error;
              if (!done)
                worker.postMessage(
                  JSON.stringify({ id: message.id, error: error.message }),
                );
              return;
            }
          } else throw new Fatal("Unknown workflow hook");
          if (!done)
            worker.postMessage(
              JSON.stringify({
                id: message.id,
                value,
                spent: state.usage.output ?? 0,
              }),
            );
        })()
          .catch((error) => {
            // Validation, caps and journal IO are fatal even when workflow
            // JavaScript attempts to catch their rejected promise.
            state.fatal = error.message;
            state.controller.abort();
          })
          .finally(() => state.tasks.delete(task));
        state.tasks.add(task);
      });
    });
  }
  async stop(id) {
    const state = this.states.get(id);
    if (!state) return undefined;
    if (!state.settled) {
      state.stopped = true;
      state.record.status = "stopping";
      state.controller.abort();
    }
    return state.record.promise;
  }
  async waitForAll() {
    return Promise.all(this.list().map((record) => record.promise));
  }
  async dispose() {
    this.disposed = true;
    await Promise.all(this.list().map((record) => this.stop(record.id)));
    await fs.rm(await this.directory, { recursive: true, force: true });
  }
}

function runGate(command, cwd, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Gate cancelled"));
      return;
    }
    const child = spawn(command, {
      cwd,
      shell: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks = [];
    let size = 0,
      overflow = false,
      spawnError,
      killTimer;
    const kill = (sig) => {
      try {
        if (process.platform !== "win32" && child.pid)
          process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        /* already gone */
      }
    };
    const abort = () => {
      kill("SIGTERM");
      killTimer ??= setTimeout(() => kill("SIGKILL"), 250);
    };
    const output = (chunk) => {
      const available = 64 * 1024 - size;
      if (available > 0) chunks.push(chunk.subarray(0, available));
      size += chunk.length;
      if (size > 64 * 1024) {
        overflow = true;
        abort();
      }
    };
    child.stdout.on("data", output);
    child.stderr.on("data", output);
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", (code, exitSignal) => {
      signal.removeEventListener("abort", abort);
      clearTimeout(killTimer);
      if (!spawnError && !signal.aborted && !overflow && code === 0)
        resolve(true);
      else {
        const reason =
          spawnError?.message ??
          (signal.aborted
            ? "cancelled"
            : overflow
              ? "output exceeded 64 KiB"
              : "failed");
        reject(
          new Error(
            `Gate ${reason} (exit code ${code}, signal ${exitSignal ?? "none"})\n${Buffer.concat(chunks).toString("utf8")}`,
          ),
        );
      }
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
