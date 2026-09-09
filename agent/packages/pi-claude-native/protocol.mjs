import { createHash, randomUUID } from "node:crypto";

export const PROVIDER = "claude-native";
const hash = (s) => createHash("sha256").update(s).digest("hex");
// Hash every name: no alias collisions, case folding, truncation or fuzzy matching.
export const toolAlias = (name) => `t_${hash(name).slice(0, 32)}`;
export const wireName = (name) => `mcp__pi__${toolAlias(name)}`;
export const wireId = (id) =>
  /^[a-zA-Z0-9_-]{1,64}$/.test(id) ? id : `toolu_${hash(id).slice(0, 48)}`;

export function toolDefinitions(tools = []) {
  const names = new Set();
  return tools
    .map((tool) => {
      if (!tool.name || names.has(tool.name))
        throw new Error(`Duplicate or empty tool name: ${tool.name}`);
      names.add(tool.name);
      if (
        tool.constrainedSampling?.type === "json_schema" &&
        tool.constrainedSampling.strict === "require"
      )
        throw new Error(
          `Claude Code transport cannot guarantee strict sampling for ${tool.name}`,
        );
      return {
        name: toolAlias(tool.name),
        description: `Pi tool: ${tool.name}\n${tool.description ?? ""}`,
        inputSchema: tool.parameters,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function systemPrompt(prompt, tools = []) {
  // Do not reconstruct Pi's prompt. This includes guidelines, snippets, skills,
  // context files and ALL late before_agent_start modifications verbatim.
  const mapping = tools
    .map((t) => `- ${t.name}: ${wireName(t.name)}`)
    .sort()
    .join("\n");
  return (
    (prompt ?? "") +
    (mapping
      ? "\n\n## Pi transport tool names\nYou are running in the Pi harness. The instructions above use Pi tool names. Call their exact transport equivalents below. All tool execution, user questions and subagent delegation are handled by Pi, not Claude Code.\n" +
        mapping
      : "")
  );
}

function contentBlocks(content) {
  if (typeof content === "string")
    return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content))
    throw new Error("Expected text or a content block array");
  return content
    .map((b) => {
      if (b.type === "text") return { type: "text", text: b.text };
      if (b.type === "image") {
        // Pi currently supports both legacy and source-shaped image content.
        const source = b.source ?? {
          type: "base64",
          mediaType: b.mimeType,
          data: b.data,
        };
        if (source.type === "url")
          return { type: "image", source: { type: "url", url: source.url } };
        const media = source.mediaType ?? source.media_type;
        if (!media || !source.data)
          throw new Error("Image is missing media type or data");
        return {
          type: "image",
          source: { type: "base64", media_type: media, data: source.data },
        };
      }
      throw new Error(`Unsupported content block: ${b.type}`);
    })
    .filter((b) => b.type !== "text" || b.text.length > 0);
}

/** Convert current Pi history, never a cached/shadow conversation. */
export function convertMessages(messages, model) {
  const out = [];
  let pending = new Map();
  const seenIds = new Set();
  const append = (role, content) => {
    if (!content.length) return;
    if (out.at(-1)?.role === role) out.at(-1).content.push(...content);
    else out.push({ role, content });
  };
  const closeMissing = () => {
    for (const id of pending.keys())
      append("user", [
        {
          type: "tool_result",
          tool_use_id: id,
          is_error: true,
          content: "Tool execution was interrupted; no result is available.",
        },
      ]);
    pending = new Map();
  };
  for (const msg of messages) {
    if (msg.role === "toolResult") {
      const id = wireId(msg.toolCallId);
      const content = contentBlocks(msg.content);
      if (pending.has(id)) {
        append("user", [
          {
            type: "tool_result",
            tool_use_id: id,
            content: content.length ? content : "(empty tool result)",
            is_error: Boolean(msg.isError),
          },
        ]);
        pending.delete(id);
      } else {
        // Compaction/handoff can leave an orphan. Preserve its data without
        // producing an invalid tool_result or silently ending the Pi turn.
        append("user", [
          {
            type: "text",
            text: `Historical tool result (${msg.toolName}, ${msg.toolCallId}, error=${Boolean(msg.isError)}):`,
          },
          ...content,
        ]);
      }
      continue;
    }
    closeMissing();
    if (msg.role === "user") {
      append("user", contentBlocks(msg.content));
    } else if (msg.role === "assistant") {
      const blocks = [];
      for (const b of msg.content) {
        if (b.type === "text" && b.text)
          blocks.push({ type: "text", text: b.text });
        else if (b.type === "thinking") {
          // Signatures are bound to the model/provider. Never forward another
          // provider's opaque signatures (or turn private reasoning into text).
          if (
            msg.provider === PROVIDER &&
            msg.model === model.id &&
            b.thinkingSignature
          ) {
            blocks.push(
              b.redacted
                ? { type: "redacted_thinking", data: b.thinkingSignature }
                : {
                    type: "thinking",
                    thinking: b.thinking ?? "",
                    signature: b.thinkingSignature,
                  },
            );
          }
        } else if (b.type === "toolCall") {
          const id = wireId(b.id);
          if (seenIds.has(id))
            throw new Error(`Duplicate tool call ID in history: ${b.id}`);
          seenIds.add(id);
          pending.set(id, true);
          blocks.push({
            type: "tool_use",
            id,
            name: wireName(b.name),
            input: b.arguments,
          });
        } else if (b.type !== "text")
          throw new Error(`Unsupported assistant block: ${b.type}`);
      }
      append("assistant", blocks);
    } else throw new Error(`Unsupported message role: ${msg.role}`);
  }
  closeMissing();
  if (!out.length) throw new Error("Claude request has no messages");
  if (out[0].role !== "user")
    out.unshift({
      role: "user",
      content: [
        { type: "text", text: "[Conversation continued from Pi history.]" },
      ],
    });
  // Claude's stream-json input expects a user message. Only synthesize a
  // continuation when Pi has explicitly asked for assistant-prefill continuation.
  if (out.at(-1).role !== "user")
    out.push({
      role: "user",
      content: [{ type: "text", text: "[Continue.]" }],
    });
  return out;
}

export function transcript(messages, sessionId, cwd, modelId) {
  let parentUuid = null;
  return (
    messages
      .map((message, index) => {
        const uuid = randomUUID();
        const record = {
          type: message.role,
          uuid,
          parentUuid,
          sessionId,
          cwd,
          timestamp: new Date(index).toISOString(),
          isSidechain: false,
          userType: "external",
          version: "2.1.266",
          message:
            message.role === "assistant"
              ? {
                  ...message,
                  id: `msg_${uuid}`,
                  type: "message",
                  model: modelId,
                  stop_reason: message.content.some(
                    (b) => b.type === "tool_use",
                  )
                    ? "tool_use"
                    : "end_turn",
                  stop_sequence: null,
                  usage: { input_tokens: 0, output_tokens: 0 },
                }
              : message,
        };
        parentUuid = uuid;
        return JSON.stringify(record);
      })
      .join("\n") + "\n"
  );
}

export function emptyMessage(model) {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "pending",
    timestamp: Date.now(),
  };
}

/** Strict adapter for one complete Anthropic response; no second agent loop. */
export class ResponseDecoder {
  constructor(output, tools, emit) {
    this.output = output;
    this.emit = emit;
    this.blocks = new Map();
    this.tools = new Map(tools.map((t) => [wireName(t.name), t.name]));
    this.started = false;
    this.done = false;
  }
  usage(u) {
    const usage = this.output.usage;
    for (const [source, target] of Object.entries({
      input_tokens: "input",
      output_tokens: "output",
      cache_read_input_tokens: "cacheRead",
      cache_creation_input_tokens: "cacheWrite",
    })) {
      if (typeof u?.[source] === "number") usage[target] = u[source];
    }
    usage.totalTokens =
      usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  }
  event(e) {
    if (this.done) return;
    const output = this.output;
    const push = (event) => this.emit({ ...event, partial: output });
    if (e.type === "message_start") {
      if (this.started)
        throw new Error("Claude attempted a second model response outside Pi");
      this.started = true;
      this.usage(e.message?.usage);
    } else if (e.type === "content_block_start") {
      if (!this.started || this.blocks.has(e.index))
        throw new Error("Invalid content block ordering");
      const b = e.content_block;
      let block;
      if (b.type === "text") block = { type: "text", text: b.text ?? "" };
      else if (b.type === "thinking")
        block = {
          type: "thinking",
          thinking: b.thinking ?? "",
          thinkingSignature: b.signature ?? "",
        };
      else if (b.type === "redacted_thinking")
        block = {
          type: "thinking",
          thinking: "[Reasoning redacted]",
          thinkingSignature: b.data,
          redacted: true,
        };
      else if (b.type === "tool_use") {
        const name = this.tools.get(b.name);
        if (!name)
          throw new Error(`Claude requested an unadvertised tool: ${b.name}`);
        block = { type: "toolCall", id: b.id, name, arguments: b.input ?? {} };
      } else throw new Error(`Unsupported Claude content block: ${b.type}`);
      const index = output.content.push(block) - 1;
      this.blocks.set(e.index, { index, block, json: "", closed: false });
      push({
        type: `${block.type === "toolCall" ? "toolcall" : block.type}_start`,
        contentIndex: index,
      });
    } else if (e.type === "content_block_delta") {
      const state = this.blocks.get(e.index);
      if (!state || state.closed)
        throw new Error("Delta without an open content block");
      const { block, index } = state;
      const d = e.delta;
      if (d.type === "text_delta" && block.type === "text") {
        block.text += d.text;
        push({ type: "text_delta", contentIndex: index, delta: d.text });
      } else if (d.type === "thinking_delta" && block.type === "thinking") {
        block.thinking += d.thinking;
        push({
          type: "thinking_delta",
          contentIndex: index,
          delta: d.thinking,
        });
      } else if (d.type === "signature_delta" && block.type === "thinking")
        block.thinkingSignature += d.signature;
      else if (d.type === "input_json_delta" && block.type === "toolCall") {
        state.json += d.partial_json;
        try {
          block.arguments = JSON.parse(state.json);
        } catch {
          /* incomplete JSON */
        }
        push({
          type: "toolcall_delta",
          contentIndex: index,
          delta: d.partial_json,
        });
      } else throw new Error(`Unexpected delta: ${d.type}`);
    } else if (e.type === "content_block_stop") {
      const state = this.blocks.get(e.index);
      if (!state || state.closed)
        throw new Error("Stop without an open content block");
      state.closed = true;
      const { block, index } = state;
      if (block.type === "toolCall") {
        if (state.json) block.arguments = JSON.parse(state.json);
        if (
          !block.arguments ||
          typeof block.arguments !== "object" ||
          Array.isArray(block.arguments)
        )
          throw new Error("Tool arguments must be an object");
        push({ type: "toolcall_end", contentIndex: index, toolCall: block });
      } else
        push({
          type: `${block.type}_end`,
          contentIndex: index,
          content: block.text ?? block.thinking,
        });
    } else if (e.type === "message_delta") {
      this.usage(e.usage);
      const reason = e.delta?.stop_reason;
      if (reason) {
        const mapped = {
          end_turn: "stop",
          stop_sequence: "stop",
          tool_use: "toolUse",
          max_tokens: "length",
          refusal: "stop",
        }[reason];
        if (!mapped)
          throw new Error(`Unsupported Claude stop reason: ${reason}`);
        output.stopReason = mapped;
      }
    } else if (e.type === "message_stop") {
      if (
        !this.started ||
        output.stopReason === "pending" ||
        [...this.blocks.values()].some((b) => !b.closed)
      )
        throw new Error("Incomplete Claude response");
      const hasTools = output.content.some((b) => b.type === "toolCall");
      if (hasTools !== (output.stopReason === "toolUse"))
        throw new Error("Tool calls and stop reason disagree");
      this.done = true;
    } else if (e.type === "error")
      throw new Error(e.error?.message ?? "Claude stream error");
    else if (e.type !== "ping")
      throw new Error(`Unsupported Claude stream event: ${e.type}`);
  }
}
