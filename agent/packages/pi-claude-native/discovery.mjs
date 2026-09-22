import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { childEnvironment } from "./transport.mjs";

const MAX_BYTES = 1024 * 1024;
const strings = ["value", "resolvedModel", "displayName", "description"];
const booleans = ["supportsEffort", "supportsAdaptiveThinking"];
// Reject rather than repair IDs: these strings are passed back to the CLI.
const invalidIdentifier = /[\s\p{Cc}\p{Cf}]/u;
const unsafeDisplayCharacters = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

// Deliberately never retain the initialization envelope (account/auth metadata).
function cleanModels(models) {
  if (!Array.isArray(models) || !models.length || models.length > 512)
    throw new Error("Invalid or empty Claude model discovery response");
  return models.map((model) => {
    if (
      !model ||
      typeof model !== "object" ||
      Array.isArray(model) ||
      typeof model.value !== "string" ||
      !model.value.trim()
    )
      throw new Error("Invalid Claude model record");
    const result = {};
    for (const key of strings) {
      if (model[key] === undefined) continue;
      if (typeof model[key] !== "string" || model[key].length > 8192)
        throw new Error("Invalid Claude model string");
      if (key === "value" || key === "resolvedModel") {
        if (!model[key] || invalidIdentifier.test(model[key]))
          throw new Error("Invalid Claude model identifier");
        result[key] = model[key];
      } else {
        // Keep labels readable without emitting terminal controls or bidi overrides.
        result[key] = model[key].replace(unsafeDisplayCharacters, " ");
      }
    }
    for (const key of booleans) {
      if (model[key] === undefined) continue;
      if (typeof model[key] !== "boolean")
        throw new Error("Invalid Claude model capability");
      result[key] = model[key];
    }
    if (model.supportedEffortLevels !== undefined) {
      if (
        !Array.isArray(model.supportedEffortLevels) ||
        model.supportedEffortLevels.length > 32 ||
        model.supportedEffortLevels.some(
          (v) => typeof v !== "string" || !v || v.length > 64,
        )
      )
        throw new Error("Invalid Claude effort levels");
      result.supportedEffortLevels = [...model.supportedEffortLevels];
    }
    return result;
  });
}

function duration(value, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0 || value > 2147483647)
    throw new Error("Invalid Claude discovery timeout configuration");
  return value;
}

/** Returns {models}; model aliases and resolved IDs are preserved, not inferred. */
export async function discoverModels(config = {}) {
  if (process.platform === "win32")
    throw new Error("Claude discovery requires POSIX process groups");
  const timeout = duration(config.discoveryTimeoutMs, 10000);
  const grace = duration(config.killGraceMs, 250);
  const directory = await mkdtemp(join(tmpdir(), "pi-claude-discovery-"));
  let child;
  let closed;
  let timer;
  const kill = (signal) => {
    if (!child?.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") {
        try {
          child.kill(signal);
        } catch {}
      }
    }
  };
  try {
    const requestId = randomUUID();
    child = spawn(
      config.executable ?? "claude",
      [
        "-p",
        "--verbose",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--no-session-persistence",
        "--tools",
        "",
        "--strict-mcp-config",
        "--mcp-config",
        '{"mcpServers":{}}',
        "--setting-sources",
        "",
        "--disable-slash-commands",
        "--permission-mode",
        "dontAsk",
        "--permission-prompts",
        "none",
        "--system-prompt",
        "",
        "--system-prompt-snapshot",
        "off",
        "--settings",
        JSON.stringify({
          disableAllHooks: true,
          autoMemoryEnabled: false,
          claudeMdExcludes: ["**/CLAUDE.md", "**/.claude/rules/**"],
        }),
      ],
      {
        cwd: directory,
        env: childEnvironment(),
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    closed = new Promise((resolve) => child.once("close", resolve));
    return await new Promise((resolve, reject) => {
      let settled = false;
      let buffer = "";
      let bytes = 0;
      const finish = (error, models) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve({ models });
      };
      const fail = (message) => finish(new Error(message));
      const line = (text) => {
        if (!text.trim() || settled) return;
        let message;
        try {
          message = JSON.parse(text);
        } catch {
          return fail("Malformed Claude discovery output");
        }
        if (
          message?.type !== "control_response" ||
          message.response?.request_id !== requestId
        )
          return;
        if (message.response.subtype !== "success")
          return fail("Claude model discovery rejected initialization");
        try {
          finish(null, cleanModels(message.response.response?.models));
        } catch (error) {
          finish(error);
        }
      };
      const count = (chunk) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_BYTES) fail("Claude discovery output limit exceeded");
      };
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        if (settled) return;
        count(chunk);
        if (settled) return;
        buffer += chunk;
        let end;
        while (!settled && (end = buffer.indexOf("\n")) !== -1) {
          const text = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          line(text);
        }
      });
      child.stdout.on("end", () => {
        if (buffer) line(buffer);
      });
      child.stderr.on("data", (chunk) => {
        if (!settled) count(chunk);
      });
      child.on("error", () => fail("Unable to start Claude model discovery"));
      child.stdin.on("error", () =>
        fail("Claude discovery input closed unexpectedly"),
      );
      child.on("close", () =>
        fail("Claude exited without a model discovery response"),
      );
      timer = setTimeout(
        () => fail("Claude model discovery timed out"),
        timeout,
      );
      // Keep stdin open: EOF can end the CLI before initialization is answered.
      child.stdin.write(
        JSON.stringify({
          type: "control_request",
          request_id: requestId,
          request: { subtype: "initialize" },
        }) + "\n",
      );
    });
  } finally {
    clearTimeout(timer);
    kill("SIGTERM");
    if (child?.pid) {
      // Never cancel escalation when the group leader exits first.
      await new Promise((resolve) => setTimeout(resolve, grace));
      kill("SIGKILL");
    }
    if (closed) await closed;
    await rm(directory, { recursive: true, force: true });
  }
}

async function readCache(cachePath, executable) {
  if ((await stat(cachePath)).size > MAX_BYTES)
    throw new Error("Oversized model cache");
  const data = JSON.parse(await readFile(cachePath, "utf8"));
  if (
    data.schemaVersion !== 1 ||
    data.executable !== executable ||
    typeof data.checkedAt !== "string" ||
    !Number.isFinite(Date.parse(data.checkedAt))
  )
    throw new Error("Invalid model cache metadata");
  return { models: cleanModels(data.models), checkedAt: data.checkedAt };
}

async function writeCache(cachePath, data) {
  const directory = dirname(cachePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // Do not chmod a caller's shared directory (e.g. /tmp or their home).
  if ((await stat(directory)).mode & 0o077)
    throw new Error("Cache directory must be private");
  const temporary = join(directory, `.claude-models-${randomUUID()}.tmp`);
  try {
    const text = JSON.stringify(data) + "\n";
    if (Buffer.byteLength(text) > MAX_BYTES)
      throw new Error("Oversized model cache");
    await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
    await rename(temporary, cachePath);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** cachePath is optional; omit it to disable persistence. Errors are sanitized strings. */
export async function loadDiscoveredModels({ config = {}, cachePath } = {}) {
  const executable = config.executable ?? "claude";
  let live;
  try {
    live = await discoverModels(config);
  } catch (error) {
    if (cachePath) {
      try {
        return {
          ...(await readCache(cachePath, executable)),
          source: "cache",
          error: error.message,
        };
      } catch (cacheError) {
        return {
          models: [],
          source: "none",
          error: error.message,
          cacheError:
            cacheError.code === "ENOENT"
              ? "Model cache not found"
              : "Unable to read valid model cache",
        };
      }
    }
    return { models: [], source: "none", error: error.message };
  }
  const checkedAt = new Date().toISOString();
  const result = { ...live, source: "live", checkedAt };
  if (cachePath) {
    try {
      await writeCache(cachePath, {
        schemaVersion: 1,
        executable,
        checkedAt,
        models: live.models,
      });
    } catch {
      result.cacheError = "Unable to write private model cache";
    }
  }
  return result;
}
