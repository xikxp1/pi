import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRequest, childEnvironment, commandArgs } from '../transport.mjs';
const executable = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));
await chmod(executable, 0o755);
const model = { id: 'claude-fable-5-1', provider: 'claude-native', api: 'claude-native', maxTokens: 32000, thinkingLevelMap: { xhigh: 'xhigh', max: 'max' } };
const context = systemPrompt => ({ systemPrompt, messages: [{ role: 'user', content: 'hi' }], tools: [] });
const config = { executable, killGraceMs: 25, idleTimeoutMs: 1000, requestTimeoutMs: 2000 };
const text = r => r.content.filter(b => b.type === 'text').map(b => b.text).join('');

test('one terminal event, Unicode LF framing, mirror dedup and process cleanup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-native-test-'));
  try {
    const events = [];
    const out = await runRequest(model, context('fake:ok'), {}, { ...config, tempRoot: dir }, e => events.push(e));
    assert.equal(out.stopReason, 'stop', out.errorMessage);
    assert.equal(text(out), 'héllo 😀\u2028world\u2029');
    assert.equal(out.usage.totalTokens, 18);
    assert.equal(events.filter(e => ['done', 'error'].includes(e.type)).length, 1);
    assert.equal(events[0].type, 'start'); assert.equal(events.at(-1).type, 'done');
    assert.deepEqual(await readdir(dir), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('all failure paths terminate, errors normalize and abort stays abort', async () => {
  for (const mode of ['exit', 'malformed', 'error', 'permissions', 'unexpected-tool', 'hang']) {
    const events = [];
    const out = await runRequest(model, context(`fake:${mode}`), {}, { ...config, idleTimeoutMs: 100 }, e => events.push(e));
    assert.equal(out.stopReason, 'error', mode);
    assert.equal(events.filter(e => ['done', 'error'].includes(e.type)).length, 1);
    if (mode === 'error') assert.match(out.errorMessage, /context_length_exceeded/);
  }
  const pre = await runRequest(model, context('fake:hang'), { signal: AbortSignal.abort() }, config);
  assert.equal(pre.stopReason, 'aborted');
  const out = await runRequest(model, context('fake:hang'), { signal: AbortSignal.timeout(80) }, config);
  assert.equal(out.stopReason, 'aborted');
  const deadline = await runRequest(model, context('fake:hang'), {}, { ...config, requestTimeoutMs: 80 });
  assert.equal(deadline.stopReason, 'error'); assert.match(deadline.errorMessage, /deadline/);
  const missing = await runRequest(model, context('fake:ok'), {}, { ...config, executable: '/no/such/claude' });
  assert.equal(missing.stopReason, 'error');
  const length = await runRequest(model, context('fake:length'), {}, config);
  assert.equal(length.stopReason, 'length');
});

test('payload hook edits reach the transport, including tool-result replay', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-native-test-'));
  try {
    const dest = join(dir, 'capture');
    const input = context('original');
    input.messages.push({ role: 'assistant', provider: 'other', model: 'other', content: [{ type: 'toolCall', id: 'x', name: 'probe', arguments: {} }] }, { role: 'toolResult', toolCallId: 'x', toolName: 'probe', content: [{ type: 'text', text: 'PI_RESULT_123' }], isError: false });
    const out = await runRequest(model, input, { onPayload: p => ({ ...p, systemPrompt: `fake:inspect\n${dest}\nPi snippets\nPi guidelines\nLATE_HOOK` }) }, config);
    assert.equal(out.stopReason, 'stop', out.errorMessage);
    const capture = JSON.parse(await readFile(dest, 'utf8'));
    assert.match(capture.prompt, /Pi snippets\nPi guidelines\nLATE_HOOK/);
    assert.match(JSON.stringify(capture.history), /PI_RESULT_123/);
    assert.ok(capture.input.message.content.every(b => b.type !== 'tool_result'));
    assert.notEqual(capture.cwd, process.cwd());
    assert.equal(capture.args[capture.args.indexOf('--tools') + 1], '');
    assert.equal(capture.args[capture.args.indexOf('--system-prompt-snapshot') + 1], 'off');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('cancellation also bounds a stuck request hook', async () => {
  const out = await runRequest(model, context('fake:ok'), { onPayload: () => new Promise(() => {}) }, { ...config, requestTimeoutMs: 30 });
  assert.equal(out.stopReason, 'error'); assert.match(out.errorMessage, /deadline/);
});

test('concurrent calls and child processes are isolated and terminated', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-native-test-'));
  try {
    const dest = join(dir, 'pid');
    const [a, b] = await Promise.all([
      runRequest(model, context(`fake:grandchild\n${dest}`), {}, config),
      runRequest(model, context('fake:hang'), { signal: AbortSignal.timeout(100) }, config),
    ]);
    assert.equal(a.stopReason, 'stop'); assert.equal(b.stopReason, 'aborted');
    const pid = Number(await readFile(dest, 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('reasoning mapping, auth isolation, and no global environment mutations', () => {
  const before = { ...process.env };
  process.env.ANTHROPIC_API_KEY = 'test-secret'; process.env.CLAUDECODE = 'nested';
  try {
    const env = childEnvironment({ reasoning: 'off' });
    assert.equal(env.ANTHROPIC_API_KEY, undefined); assert.equal(env.CLAUDECODE, undefined);
    assert.equal(env.MAX_THINKING_TOKENS, '0'); assert.equal(process.env.ANTHROPIC_API_KEY, 'test-secret');
    for (const level of ['xhigh', 'max']) {
      const args = commandArgs({ model, options: { reasoning: level }, config: {}, directory: '/tmp/request', hasHistory: false, hasTools: false });
      assert.equal(args[args.indexOf('--effort') + 1], level);
    }
  } finally {
    for (const k of ['ANTHROPIC_API_KEY', 'CLAUDECODE']) { if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k]; }
  }
});
