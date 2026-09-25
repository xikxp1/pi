import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const MAX_TEXT = 64 * 1024;
export const MAX_RECORD = 16 * 1024 * 1024;
export const BLOCKED_TOOLS = new Set([
  "subagent",
  "agent",
  "ask_user",
  "ask_question",
  "askuserquestion",
]);
export const childTools = (tools) =>
  [...new Set(tools)].filter((name) => !BLOCKED_TOOLS.has(name.toLowerCase()));
export const bounded = (text, limit = MAX_TEXT) => {
  const notice = "[Earlier output truncated; see outputFile.]\n";
  if (text.length <= limit) return text;
  let start = text.length - (limit - notice.length);
  // Do not split a UTF-16 surrogate pair when keeping the tail.
  if (/[\uDC00-\uDFFF]/.test(text[start])) start++;
  return notice + text.slice(start);
};
const textContent = (content) =>
  Array.isArray(content)
    ? content
        .filter(
          (block) => block?.type === "text" && typeof block.text === "string",
        )
        .map((block) => block.text)
        .join("\n")
    : typeof content === "string"
      ? content
      : "";

export function childEnvironment(env, tools) {
  const result = {
    ...env,
    PI_SUBAGENT_CHILD: "1",
    PI_SUBAGENT_TOOLS: JSON.stringify(childTools(tools)),
    PI_ACP_SUBAGENTS: "0",
    PI_ACP_SUBAGENT_SESSIONS: "0",
    PI_ACP_TERMINAL: "0",
    PI_OFFLINE: "1",
  };
  // Keep the ACP filesystem socket/capabilities, but never inherit parent identity.
  for (const key of [
    "PI_SESSION_ID",
    "PI_SESSION_FILE",
    "PI_PROVIDER",
    "PI_MODEL",
    "PI_REASONING_LEVEL",
  ])
    delete result[key];
  return result;
}

export function childArguments({ model, thinking, tools, trusted, extension }) {
  const allowed = childTools(tools);
  const slash = model.indexOf("/");
  if (slash < 1 || slash === model.length - 1)
    throw new Error("Expected an exact provider/model-id");
  return [
    "--mode",
    "json",
    "--print",
    "--offline",
    trusted ? "--approve" : "--no-approve",
    "-e",
    extension,
    // Explicit provider avoids CLI inference choosing a different provider for
    // model IDs that themselves contain slashes.
    "--provider",
    model.slice(0, slash),
    "--model",
    model.slice(slash + 1),
    "--thinking",
    thinking,
    ...(allowed.length ? ["--tools", allowed.join(",")] : ["--no-tools"]),
    "--append-system-prompt",
    "You are a delegated subagent. Complete only the task supplied by your parent. You do not have the parent conversation. Do not delegate, ask interactive questions, or commit changes. If blocked or a decision is needed, explain it in your final answer. Return concise findings, changes, and validation results. Other agents may share this directory; do not overwrite unrelated work.",
  ];
}

export function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}
function addUsage(total, usage) {
  if (!usage) return;
  for (const key of [
    "input",
    "output",
    "cacheRead",
    "cacheWrite",
    "totalTokens",
  ]) {
    if (Number.isFinite(usage[key]) && usage[key] >= 0)
      total[key] += usage[key];
  }
  for (const key of Object.keys(total.cost)) {
    if (Number.isFinite(usage.cost?.[key]) && usage.cost[key] >= 0)
      total.cost[key] += usage.cost[key];
  }
}

// Only visible assistant text and executed tools enter the transcript. JSON mode's
// agent_end duplicates history, and thinking/user messages must not be displayed.
export class Transcript {
  text = "";
  streaming = "";
  toolProgress = "";
  result = "";
  toolUses = 0;
  usage = emptyUsage();
  stopReason = undefined;
  error = undefined;
  assistantEnded = false;
  constructor(append = () => {}) {
    this.append = append;
  }
  commit(text) {
    if (!text) return;
    this.append(text + "\n\n");
    this.text = bounded(this.text + (this.text ? "\n\n" : "") + text);
  }
  event(event) {
    if (
      event?.type === "message_start" &&
      event.message?.role === "assistant"
    ) {
      this.streaming = "";
    } else if (event?.type === "message_update") {
      const delta = event.assistantMessageEvent;
      if (delta?.type === "text_delta" && typeof delta.delta === "string") {
        this.streaming = bounded(this.streaming + delta.delta);
      }
    } else if (event?.type === "message_end") {
      const message = event.message;
      if (message?.role === "assistant") {
        const text = textContent(message.content);
        this.commit(text);
        this.result = bounded(text);
        this.streaming = "";
        this.assistantEnded = true;
        this.stopReason = message.stopReason;
        this.error =
          typeof message.errorMessage === "string"
            ? bounded(message.errorMessage)
            : undefined;
        addUsage(this.usage, message.usage);
      } else if (message?.role === "toolResult") {
        addUsage(this.usage, message.usage);
      }
    } else if (event?.type === "tool_execution_start") {
      this.toolUses++;
      this.commit(
        `Tool: ${event.toolName}\n${JSON.stringify(event.args ?? {})}`,
      );
    } else if (event?.type === "tool_execution_update") {
      this.toolProgress = bounded(
        textContent(event.partialResult?.content),
        8192,
      );
    } else if (event?.type === "tool_execution_end") {
      this.toolProgress = "";
      this.commit(
        `${event.isError ? "Tool error" : "Tool result"}: ${event.toolName}\n${textContent(event.result?.content)}`,
      );
    }
  }
  visible() {
    return bounded(
      [this.text, this.streaming, this.toolProgress]
        .filter(Boolean)
        .join("\n\n"),
    );
  }
}

/** Strict LF framing: Unicode separators and CR inside JSON strings are not records. */
export class JsonLines {
  buffer = "";
  constructor(onEvent, maxRecord = MAX_RECORD) {
    this.onEvent = onEvent;
    this.maxRecord = maxRecord;
  }
  line(line) {
    if (line.length > this.maxRecord)
      throw new Error("Subagent JSON record exceeded the size limit");
    if (!line.trim()) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw new Error("Invalid JSON from Pi subagent stdout");
    }
    this.onEvent(event);
  }
  push(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.line(line);
    }
    if (this.buffer.length > this.maxRecord)
      throw new Error("Subagent JSON record exceeded the size limit");
  }
  end() {
    if (this.buffer) this.line(this.buffer);
    this.buffer = "";
  }
}

/**
 * Run one foreground child. invocation contains an executable and optional CLI prefix.
 * @param {{
 *   invocation: { command: string, args?: string[] }, args: string[], task: string,
 *   cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal, timeout?: number,
 *   onUpdate?: (snapshot: { version: number, agentId: string, runId: string,
 *     title: string, status: string, text: string, outputFile: string, toolUses: number }) => void,
 *   onBridge?: (event: object) => void,
 *   onRegister?: (descriptor: object) => void, parentToolCallId?: string, title?: string,
 *   parentPiSessionId?: string, parentSessionFile?: string,
 *   killGraceMs?: number, outputDir?: string
 * }} options
 */
export async function runSubagent({
  invocation,
  args,
  task,
  cwd,
  env,
  signal,
  timeout,
  onUpdate,
  onBridge,
  onRegister,
  parentToolCallId,
  parentPiSessionId,
  parentSessionFile,
  title = "Subagent",
  killGraceMs = 1500,
  outputDir = tmpdir(),
}) {
  if (signal?.aborted) throw new Error("Subagent cancelled before launch");
  const runId = randomUUID();
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(outputDir, "pi-subagent-"));
  const outputFile = join(directory, "output.txt");
  const sessionFile = join(directory, "session.jsonl");
  const eventsFile = join(directory, "events.jsonl");
  const stateFile = join(directory, "state.json");
  const cancelFile = join(directory, `cancel-${randomUUID()}`);
  const descriptor = {
    version: 2,
    runId,
    parentToolCallId,
    parentPiSessionId,
    title,
    sessionFile,
    eventsFile,
    outputFile,
  };
  writeFileSync(outputFile, "", { mode: 0o600 });
  writeFileSync(
    sessionFile,
    JSON.stringify({
      type: "session",
      version: 3,
      id: runId,
      timestamp: new Date().toISOString(),
      cwd,
      piSubagent: true,
      ...(parentSessionFile ? { parentSession: parentSessionFile } : {}),
    }) + "\n",
    { mode: 0o600 },
  );
  writeFileSync(eventsFile, "", { mode: 0o600 });
  let sequence = 0;
  const bridge = (event) => {
    try {
      onBridge?.(event);
    } catch {
      /* Inspection detachment must not affect execution. */
    }
  };
  const transcript = new Transcript((text) => {
    try {
      appendFileSync(outputFile, text, "utf8");
    } catch (error) {
      stop(`Subagent persistence: ${error.message}`);
    }
  });
  let status = "pending";
  let failure;
  let lastSnapshot;
  const snapshot = () => ({
    version: 1,
    agentId: runId,
    runId,
    title,
    sessionFile,
    eventsFile,
    status,
    text: transcript.visible(),
    outputFile,
  });
  const saveState = () => {
    const state = {
      ...descriptor,
      status,
      ...(failure ? { error: failure } : {}),
    };
    writeFileSync(stateFile + ".tmp", JSON.stringify(state), { mode: 0o600 });
    renameSync(stateFile + ".tmp", stateFile);
  };
  let publishedStatus;
  const publish = (persist = true) => {
    if (publishedStatus !== status) {
      if (persist) saveState();
      publishedStatus = status;
      bridge({
        version: 2,
        type: "status",
        runId,
        status,
        ...(failure ? { error: failure } : {}),
      });
    }
    const value = snapshot();
    const encoded = JSON.stringify(value);
    if (encoded === lastSnapshot) return;
    lastSnapshot = encoded;
    try {
      onUpdate?.({ ...value, toolUses: transcript.toolUses });
    } catch {
      /* UI detachment must not affect execution. */
    }
  };
  let stderr = "";
  let child;
  let exitCode = null;
  let exitSignal = null;
  let escalation;
  let deadline;
  let drainTimer;
  let ticker;
  let exited;
  let finished = false;
  const kill = (force) => {
    if (!child?.pid) return;
    // Pi handles SIGTERM and cleans up its tracked (detached) shell children.
    // Force the child's process group only if graceful teardown stalls.
    try {
      if (force && process.platform !== "win32")
        process.kill(-child.pid, "SIGKILL");
      else child.kill(force ? "SIGKILL" : "SIGTERM");
    } catch {
      /* already exited */
    }
  };
  const stop = (message) => {
    if (failure) return;
    failure = message;
    if (!finished && child?.pid) {
      kill(false);
      escalation = setTimeout(() => kill(true), killGraceMs);
    }
  };
  const onAbort = () => stop("Subagent cancelled");
  bridge({ ...descriptor, type: "register", cancelFile });
  try {
    onRegister?.(descriptor);
    publish();
    ticker = setInterval(() => {
      try {
        if (existsSync(cancelFile)) stop("Subagent cancelled");
        publish();
      } catch (error) {
        stop(`Subagent persistence: ${error.message}`);
      }
    }, 250);
    ticker.unref();
    child = spawn(
      invocation.command,
      [...(invocation.args ?? []), ...args, "--session", sessionFile],
      {
        cwd,
        env,
        shell: false,
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const decoder = new JsonLines((event) => {
      transcript.event(event);
      // agent_end repeats the entire history. Keep the linear event stream only.
      if (
        [
          "message_start",
          "message_update",
          "message_end",
          "tool_execution_start",
          "tool_execution_update",
          "tool_execution_end",
        ].includes(event?.type)
      ) {
        const record = {
          version: 2,
          type: "event",
          runId,
          sequence: sequence++,
          event,
        };
        try {
          appendFileSync(eventsFile, JSON.stringify(record) + "\n", "utf8");
        } finally {
          // Even a full disk must not hide output already received from Pi.
          bridge(record);
        }
      }
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (failure) return;
      try {
        decoder.push(chunk);
      } catch (error) {
        stop(error.message);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = bounded(stderr + chunk, 8192);
    });
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") stop(`Subagent stdin: ${error.message}`);
    });
    exited = new Promise((resolve) => {
      child.once("error", (error) => {
        failure ??= `Cannot launch Pi subagent: ${error.message}`;
        resolve();
      });
      child.once("exit", (code, sig) => {
        exitCode = code;
        exitSignal = sig;
        // A detached descendant may retain stdio. Drain ordinary buffered output,
        // but do not wait forever for inherited pipe handles to close.
        drainTimer = setTimeout(resolve, 200);
      });
      child.once("close", resolve);
    });
    status = "in_progress";
    publish();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    if (timeout !== undefined)
      deadline = setTimeout(
        () => stop(`Subagent timed out after ${timeout} seconds`),
        timeout * 1000,
      );
    // stdin avoids shell/CLI interpolation and argv size limits. Prefix prevents
    // delegated text starting with '/' from being dispatched as a Pi command.
    child.stdin.end(`Delegated task:\n\n${task}`);
    await exited;
    if (!failure) {
      try {
        decoder.end();
      } catch (error) {
        failure = error.message;
      }
    }
    if (!failure && (exitCode !== 0 || exitSignal))
      failure = `Pi subagent exited ${exitSignal ?? exitCode}${stderr ? `:\n${stderr}` : ""}`;
    if (!failure && ["error", "aborted"].includes(transcript.stopReason))
      failure = transcript.error || `Subagent ${transcript.stopReason}`;
    if (!failure && !transcript.assistantEnded)
      failure = `Subagent produced no assistant response${stderr ? `:\n${stderr}` : ""}`;
    if (!failure && transcript.stopReason === "toolUse")
      failure = "Subagent stopped before completing its tool calls";
  } catch (error) {
    failure ??= error instanceof Error ? error.message : String(error);
    kill(true);
    if (exited) await exited;
  } finally {
    finished = true;
    clearInterval(ticker);
    clearTimeout(deadline);
    clearTimeout(escalation);
    clearTimeout(drainTimer);
    signal?.removeEventListener("abort", onAbort);
    child?.stdin.destroy();
    child?.stdout.destroy();
    child?.stderr.destroy();
  }
  status = failure ? "failed" : "completed";
  try {
    saveState();
  } catch (error) {
    const diagnostic = `Subagent persistence: ${error.message}`;
    failure = failure ? `${failure}\n${diagnostic}` : diagnostic;
    status = "failed";
    try {
      saveState();
    } catch (stateError) {
      console.error(`Cannot save failed subagent state: ${stateError.message}`);
    }
  }
  if (failure) {
    // The in-memory transcript remains usable even when its file cannot grow.
    transcript.commit(
      [transcript.streaming, transcript.toolProgress]
        .filter(Boolean)
        .join("\n\n"),
    );
    transcript.streaming = "";
    transcript.toolProgress = "";
    transcript.commit(failure);
  }
  // Terminal delivery must not depend on the filesystem being writable.
  publish(false);
  return {
    ...snapshot(),
    result: transcript.result,
    error: failure,
    toolUses: transcript.toolUses,
    usage: transcript.usage,
    exitCode,
    exitSignal,
  };
}
