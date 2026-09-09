import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRequest } from '../transport.mjs';
import { toolDefinitions, ResponseDecoder, emptyMessage, convertMessages } from '../protocol.mjs';
const model = { id: 'claude-fable-5-1', provider: 'claude-native', api: 'claude-native', maxTokens: 32000 };
const executable = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));
await chmod(executable, 0o755);
const tool = { name: 'probe', parameters: { type: 'object', properties: {} } };

test('toolChoice none excludes schemas even when request hook adds tools', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-native-options-'));
  try {
    const capture = join(dir, 'capture');
    const out = await runRequest(model, { systemPrompt: `fake:inspect\n${capture}`, messages: [{ role: 'user', content: 'hi' }], tools: [tool] }, { toolChoice: 'none', onPayload: p => ({ ...p, tools: [tool] }) }, { executable, killGraceMs: 25 });
    assert.equal(out.stopReason, 'stop', out.errorMessage);
    const data = JSON.parse(await readFile(capture, 'utf8'));
    assert.ok(!data.args.includes('--mcp-config'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('unsupported forced sampling fails rather than silently weakening guarantees', () => {
  assert.throws(() => toolDefinitions([{ ...tool, constrainedSampling: { type: 'json_schema', strict: 'require' } }]), /strict sampling/);
  assert.equal(toolDefinitions([{ ...tool, constrainedSampling: { type: 'json_schema', strict: 'prefer' } }]).length, 1);
});

test('redacted reasoning payload round trips without exposing opaque data as text', () => {
  const out = emptyMessage(model), decoder = new ResponseDecoder(out, [], () => {});
  decoder.event({ type: 'message_start', message: {} });
  decoder.event({ type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking', data: 'opaque' } });
  decoder.event({ type: 'content_block_stop', index: 0 });
  decoder.event({ type: 'message_delta', delta: { stop_reason: 'end_turn' } });
  decoder.event({ type: 'message_stop' });
  assert.equal(out.content[0].redacted, true);
  assert.equal(out.content[0].thinking, '[Reasoning redacted]');
  const history = convertMessages([{ role: 'user', content: 'hi' }, out, { role: 'user', content: 'next' }], model);
  assert.deepEqual(history[1].content[0], { type: 'redacted_thinking', data: 'opaque' });
});
