import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { getModels } from '@earendil-works/pi-ai/compat';
import { getAgentDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { runRequest } from './transport.mjs';
import { buildModels } from './models.mjs';

// Provider only: no AskClaude tool, tool overrides, compaction takeovers,
// environment mutations, or global registration/session-state guards.
export default function (pi: ExtensionAPI) {
  const configPath = join(getAgentDir(), 'claude-native.json');
  let config: Record<string, any> = {};
  try { config = JSON.parse(readFileSync(configPath, 'utf8')); }
  catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error(`Invalid configuration: ${configPath}`);
  const allowed = new Set(['executable', 'idleTimeoutMs', 'requestTimeoutMs', 'killGraceMs', 'modelIds', 'modelOverrides']);
  for (const key of Object.keys(config)) if (!allowed.has(key)) throw new Error(`Unknown claude-native setting: ${key}`);
  for (const key of ['idleTimeoutMs', 'requestTimeoutMs', 'killGraceMs']) {
    if (config[key] !== undefined && (!Number.isSafeInteger(config[key]) || config[key] <= 0)) throw new Error(`${key} must be a positive integer`);
  }
  if (config.executable !== undefined && (typeof config.executable !== 'string' || !config.executable)) throw new Error('executable must be a nonempty string');
  if (config.modelIds && Object.values(config.modelIds).some(v => typeof v !== 'string' || !v)) throw new Error('modelIds values must be nonempty strings');
  let models = buildModels(getModels('anthropic'), config.modelOverrides);
  const register = () => pi.registerProvider('claude-native', {
    name: 'Claude Max (Pi Native)', baseUrl: 'claude-native', apiKey: 'claude-code-login', api: 'claude-native',
    models,
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      void runRequest(model, context, options, config, event => stream.push(event))
        .finally(() => stream.end());
      return stream;
    },
  });
  register();
  // The runtime may have a newer persisted Anthropic catalog than pi-ai's
  // bundled compat list. No model-name allowlist and no network/auth refresh.
  pi.on('session_start', (_event, ctx) => {
    const catalog = ctx.modelRegistry.getAll().filter(m => m.provider === 'anthropic');
    if (catalog.length) { models = buildModels(catalog, config.modelOverrides); register(); }
  });
  pi.registerCommand('claude-native-status', {
    description: 'Show Claude transport configuration (no prompts or credentials)',
    handler: async (_args, ctx) => {
      const info = [
        `Provider: claude-native (${models.length} models)`,
        `CLI: ${config.executable ?? 'claude'}; authentication: Claude Code login`,
        `Idle timeout: ${config.idleTimeoutMs ?? 120000}ms; deadline: ${config.requestTimeoutMs ?? 600000}ms`,
        'One response per process; Pi owns all tools, questions, subagents and compaction.',
        'Default limits: 200K context / 32K output. Larger limits require explicit modelOverrides/modelIds.',
        `Config: ${configPath}`,
      ].join('\n');
      ctx.ui.notify(info, 'info');
    },
  });
}
