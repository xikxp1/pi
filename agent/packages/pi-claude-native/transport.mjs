import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  convertMessages,
  transcript,
  systemPrompt,
  toolDefinitions,
  ResponseDecoder,
  emptyMessage,
  wireName,
} from "./protocol.mjs";

const schemaServer = fileURLToPath(
  new URL("./mcp-schema-server.mjs", import.meta.url),
);
const MAX_LINE = 32 * 1024 * 1024;

export function childEnvironment(options = {}) {
  const env = { ...process.env };
  // This provider specifically uses Claude Max, never accidental API billing or
  // a nested Claude/SDK process's routing and identity.
  for (const key of Object.keys(env)) {
    if (
      /^(ANTHROPIC_|CLAUDE_CODE_(OAUTH_TOKEN|USE_|SESSION|PARENT|ENTRYPOINT)|CLAUDE_AGENT_SDK|CLAUDECODE$)/.test(
        key,
      )
    )
      delete env[key];
  }
  Object.assign(env, {
    ENABLE_CLAUDEAI_MCP_SERVERS: "0",
    DISABLE_AUTO_COMPACT: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(options.maxTokens ?? 32000),
  });
  if (options.reasoning === undefined || options.reasoning === "off")
    env.MAX_THINKING_TOKENS = "0";
  else delete env.MAX_THINKING_TOKENS;
  return env;
}

export function commandArgs({
  model,
  options,
  config,
  directory,
  hasHistory,
  hasTools,
}) {
  const args = [
    "-p",
    "--verbose",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--input-format",
    "stream-json",
    "--no-session-persistence",
    "--tools",
    "",
    "--strict-mcp-config",
    "--setting-sources",
    "",
    "--disable-slash-commands",
    "--permission-mode",
    "dontAsk",
    "--permission-prompts",
    "none",
    "--system-prompt-file",
    join(directory, "system.txt"),
    "--system-prompt-snapshot",
    "off",
    "--model",
    config.modelIds?.[model.id] ?? model.id,
    "--settings",
    JSON.stringify({
      disableAllHooks: true,
      autoMemoryEnabled: false,
      claudeMdExcludes: ["**/CLAUDE.md", "**/.claude/rules/**"],
    }),
  ];
  if (hasHistory) args.push("--resume", join(directory, "history.jsonl"));
  if (hasTools) args.push("--mcp-config", join(directory, "mcp.json"));
  if (options.reasoning && options.reasoning !== "off") {
    const effort =
      model.thinkingLevelMap?.[options.reasoning] ??
      { minimal: "low" }[options.reasoning] ??
      options.reasoning;
    if (!["low", "medium", "high", "xhigh", "max"].includes(effort))
      throw new Error(`Unsupported Claude effort: ${effort}`);
    args.push("--effort", effort, "--thinking-display", "summarized");
  }
  return args;
}

/** One OS process group per model call. No singleton queries, result routing,
 * prompt capture cache, shared transcript, or conversation-length heuristics. */
export async function runRequest(
  model,
  context,
  options = {},
  config = {},
  emit = () => {},
) {
  const output = emptyMessage(model);
  emit({ type: "start", partial: output });
  const abort = new AbortController();
  const onAbort = () =>
    abort.abort(options.signal?.reason ?? new Error("Operation aborted"));
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  const deadline = setTimeout(
    () => abort.abort(new Error("Claude request deadline exceeded")),
    config.requestTimeoutMs ?? 600000,
  );
  let directory;
  let child;
  let idleTimer;
  let killTimer;
  let stopping = false;
  let closed;
  const killGroup = (signal) => {
    if (!child?.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch (e) {
      if (e.code !== "ESRCH") {
        try {
          child.kill(signal);
        } catch {}
      }
    }
  };
  const stop = () => {
    if (stopping) return;
    stopping = true;
    killGroup("SIGTERM");
    // Kill the GROUP even if the leader exits first: MCP children may remain.
    killTimer = setTimeout(
      () => killGroup("SIGKILL"),
      config.killGraceMs ?? 250,
    );
  };
  try {
    abort.signal.throwIfAborted();
    if (process.platform === "win32")
      throw new Error(
        "pi-claude-native currently requires POSIX process groups",
      );
    if (options.deferred)
      throw new Error(
        "Claude Code transport does not support deferred requests",
      );
    if (options.temperature !== undefined || options.samplingParams)
      throw new Error(
        "Claude Code transport does not expose temperature/sampling parameters",
      );
    let payload = {
      systemPrompt: context.systemPrompt ?? "",
      messages: context.messages,
      tools: context.tools ?? [],
    };
    if (options.onPayload) {
      payload = await Promise.race([
        Promise.resolve(options.onPayload(payload, model)).then((p) =>
          p === undefined ? payload : p,
        ),
        new Promise((_, reject) =>
          abort.signal.addEventListener(
            "abort",
            () => reject(abort.signal.reason),
            { once: true },
          ),
        ),
      ]);
    }
    abort.signal.throwIfAborted();
    if (
      !payload ||
      !Array.isArray(payload.messages) ||
      !Array.isArray(payload.tools) ||
      typeof payload.systemPrompt !== "string"
    )
      throw new Error("Invalid Claude payload from before_provider_request");
    if (options.toolChoice === "none") payload = { ...payload, tools: [] };
    const messages = convertMessages(payload.messages, model);
    // Claude's stdin is a user PROMPT, not an API tool-result endpoint. Pending
    // tool results must already be paired in the resumed transcript, otherwise
    // the CLI repairs/drops the pending call before accepting stdin.
    const last = messages.at(-1);
    if (last.content.some((b) => b.type === "tool_result")) {
      messages.push({
        role: "user",
        content: [
          {
            type: "text",
            text: "[Continue from the tool results in the conversation. Follow the current system instructions.]",
          },
        ],
      });
    }
    const tools = toolDefinitions(payload.tools);
    directory = await mkdtemp(
      join(config.tempRoot ?? tmpdir(), "pi-claude-native-"),
    );
    const sessionId = randomUUID();
    const write = (name, text) =>
      writeFile(join(directory, name), text, { mode: 0o600 });
    await Promise.all([
      write("system.txt", systemPrompt(payload.systemPrompt, payload.tools)),
      write("tools.json", JSON.stringify(tools)),
      write(
        "history.jsonl",
        transcript(messages.slice(0, -1), sessionId, directory, model.id),
      ),
      write(
        "mcp.json",
        JSON.stringify({
          mcpServers: {
            pi: {
              type: "stdio",
              command: process.execPath,
              args: [schemaServer, join(directory, "tools.json")],
            },
          },
        }),
      ),
    ]);
    abort.signal.throwIfAborted();
    const decoder = new ResponseDecoder(output, payload.tools, emit);
    const args = commandArgs({
      model,
      options,
      config,
      directory,
      hasHistory: messages.length > 1,
      hasTools: tools.length > 0,
    });
    const env = childEnvironment({
      ...options,
      maxTokens: options.maxTokens ?? Math.min(model.maxTokens, 32000),
    });
    child = spawn(config.executable ?? "claude", args, {
      cwd: directory,
      env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    closed = new Promise((resolve) => child.once("close", resolve));
    await new Promise((resolve, reject) => {
      let settled = false;
      let buffer = "";
      let stderr = "";
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(idleTimer);
        abort.signal.removeEventListener("abort", aborted);
        stop();
        if (error) reject(error);
        else resolve();
      };
      const aborted = () => finish(abort.signal.reason);
      const touch = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(
          () =>
            finish(
              new Error("Claude produced no output before the idle timeout"),
            ),
          options.timeoutMs ?? config.idleTimeoutMs ?? 120000,
        );
      };
      const record = (r) => {
        if (r.parent_tool_use_id)
          throw new Error("Unexpected Claude-owned subagent output");
        if (r.type === "stream_event") {
          decoder.event(r.event);
          if (decoder.done) finish();
        } else if (r.type === "assistant" && r.error) {
          throw new Error(
            r.message?.content
              ?.filter((b) => b.type === "text")
              .map((b) => b.text)
              .join("\n") || r.error,
          );
        } else if (r.type === "result") {
          if (r.is_error || r.subtype !== "success")
            throw new Error((r.errors ?? [r.result ?? r.subtype]).join("\n"));
          // Deliberately do NOT accept result-text-only fallback: missing stream
          // frames could otherwise silently lose tool calls or thinking blocks.
          if (!decoder.done)
            throw new Error(
              "Claude result arrived without a complete response stream",
            );
        } else if (r.type === "system" && r.subtype === "init") {
          const advertised = new Set(
            payload.tools.map((t) => wireName(t.name)),
          );
          if (r.tools?.some((name) => !advertised.has(name)))
            throw new Error("Claude exposed tools outside the Pi allowlist");
          if (
            tools.length &&
            !r.mcp_servers?.some(
              (s) => s.name === "pi" && s.status === "connected",
            )
          )
            throw new Error("Pi schema MCP server failed to connect");
        } else if (r.type === "control_request")
          throw new Error("Unexpected Claude control/permission request");
      };
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        if (settled) return;
        touch();
        buffer += chunk;
        try {
          let end;
          while (!settled && (end = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, end);
            buffer = buffer.slice(end + 1);
            if (line.length > MAX_LINE)
              throw new Error("Claude JSONL record exceeds size limit");
            if (line.trim()) record(JSON.parse(line));
          }
          if (buffer.length > MAX_LINE)
            throw new Error("Claude JSONL record exceeds size limit");
        } catch (error) {
          finish(error);
        }
      });
      child.stderr.on("data", (chunk) => {
        stderr = (stderr + chunk).slice(-4096);
      });
      child.once("error", finish);
      child.stdin.on("error", (error) => {
        if (!settled) finish(error);
      });
      child.once("close", (code, signal) => {
        if (!settled)
          finish(
            new Error(
              `Claude exited before completing its response (code=${code}, signal=${signal}). ${stderr}`,
            ),
          );
      });
      abort.signal.addEventListener("abort", aborted, { once: true });
      touch();
      if (abort.signal.aborted) aborted();
      else
        child.stdin.end(
          JSON.stringify({
            type: "user",
            message: messages.at(-1),
            parent_tool_use_id: null,
            session_id: sessionId,
          }) + "\n",
        );
    });
    options.signal?.throwIfAborted();
  } catch (error) {
    output.stopReason = options.signal?.aborted ? "aborted" : "error";
    output.errorMessage =
      error instanceof Error ? error.message : String(error);
    if (
      /prompt is too long|prompt too long|context window|too many tokens/i.test(
        output.errorMessage,
      )
    )
      output.errorMessage = `context_length_exceeded: ${output.errorMessage}`;
  } finally {
    stop();
    clearTimeout(deadline);
    clearTimeout(idleTimer);
    options.signal?.removeEventListener("abort", onAbort);
    if (child) {
      // Bounded cleanup, including stubborn grandchildren, before Pi executes
      // tools or removes the private request files.
      await new Promise((resolve) =>
        setTimeout(resolve, (config.killGraceMs ?? 250) + 10),
      );
      killGroup("SIGKILL");
      clearTimeout(killTimer);
      await Promise.race([
        closed,
        new Promise((resolve) => setTimeout(resolve, 250)),
      ]);
    } else clearTimeout(killTimer);
    if (directory)
      await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
  if (output.stopReason === "error" || output.stopReason === "aborted")
    emit({ type: "error", reason: output.stopReason, error: output });
  else emit({ type: "done", reason: output.stopReason, message: output });
  return output;
}
