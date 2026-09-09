import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertMessages, transcript, wireName, wireId, toolDefinitions, systemPrompt, ResponseDecoder, emptyMessage } from '../protocol.mjs';
import { buildModels } from '../models.mjs';
const model = { id: 'claude-fable-5-1', provider: 'claude-native', api: 'claude-native' };
const user = content => ({ role: 'user', content });
const tool = { name: 'Ask User.special', description: 'Exact description', parameters: { type: 'object', properties: { x: { anyOf: [{ type: 'string' }, { type: 'null' }] } }, required: ['x'], additionalProperties: false } };
const assistant = content => ({ role: 'assistant', provider: model.provider, model: model.id, content });
const result = (id, content) => ({ role: 'toolResult', toolCallId: id, toolName: tool.name, content, isError: true });

test('system prompt preserves all Pi text and schemas without reconstruction', () => {
  const prompt = 'Available tools:\n- ask_user: snippet\nGuidelines:\n- guideline\nAGENTS\nSkills\nLATE_HOOK\n';
  assert.ok(systemPrompt(prompt, [tool]).startsWith(prompt));
  const defs = toolDefinitions([tool]);
  assert.deepEqual(defs[0].inputSchema, tool.parameters);
  assert.equal(defs[0].description, 'Pi tool: Ask User.special\nExact description');
  assert.notEqual(wireName('Ask'), wireName('ask'));
  assert.notEqual(wireName('a.b'), wireName('a_b'));
  assert.throws(() => toolDefinitions([tool, tool]), /Duplicate/);
});

test('catalog is open-ended, includes Fable 5.1, and keeps thinking capabilities', () => {
  const models = buildModels([{ ...model, name: 'Fable 5.1', reasoning: true, input: ['text', 'image'], contextWindow: 1000000, maxTokens: 128000, thinkingLevelMap: { off: null, xhigh: 'xhigh', max: 'max' } }, { ...model, id: 'claude-future-9', contextWindow: 1000000, maxTokens: 128000 }]);
  assert.equal(models.length, 2); assert.equal(models[0].id, 'claude-fable-5-1');
  assert.equal(models[0].contextWindow, 200000); assert.equal(models[0].maxTokens, 32000);
  assert.equal(models[0].thinkingLevelMap.max, 'max');
});

test('parallel tool results preserve pairing, schemas, errors, images and Unicode', () => {
  const id = 'foreign|call/\ud83d\ude00';
  const messages = [user('😀\u2028\u2029'), assistant([
    { type: 'toolCall', id, name: tool.name, arguments: { x: '😀' } },
    { type: 'toolCall', id: 'second', name: 'b', arguments: {} },
  ]), result('second', 'second result'), result(id, [{ type: 'text', text: 'first result' }, { type: 'image', mimeType: 'image/png', data: 'YWJj' }])];
  const snapshot = JSON.stringify(messages);
  const out = convertMessages(messages, model);
  assert.equal(out[0].content[0].text, '😀\u2028\u2029');
  assert.equal(out[1].content[0].id, wireId(id));
  assert.equal(out[1].content[0].name, wireName(tool.name));
  assert.equal(out[2].content[1].tool_use_id, wireId(id));
  assert.equal(out[2].content[1].is_error, true);
  assert.equal(out[2].content[1].content[1].source.media_type, 'image/png');
  assert.equal(JSON.stringify(messages), snapshot);
});

test('missing results are repaired and orphaned results are retained', () => {
  const out = convertMessages([user('a'), assistant([{ type: 'toolCall', id: 'x', name: 'read', arguments: {} }]), user('steer'), result('unknown', 'important orphan data')], model);
  assert.equal(out[2].content[0].tool_use_id, 'x');
  assert.equal(out[2].content[0].is_error, true);
  assert.match(JSON.stringify(out), /important orphan data/);
  assert.equal(out[2].content[1].text, 'steer');
});

test('cross-provider thinking signatures are dropped, native signatures retained', () => {
  const thinking = { type: 'thinking', thinking: '', thinkingSignature: 'signed' };
  const messages = [user('a'), { ...assistant([thinking, { type: 'text', text: 'x' }]), provider: 'other' }, user('b'), assistant([thinking, { type: 'text', text: 'y' }]), user('c')];
  const out = convertMessages(messages, model);
  assert.equal(out[1].content.length, 1); assert.equal(out[3].content[0].signature, 'signed');
  assert.throws(() => convertMessages([user([{ type: 'audio' }])], model), /Unsupported/);
});

test('transcript parent chains are request-local and complete', () => {
  const messages = convertMessages([user('a'), assistant([{ type: 'text', text: 'b' }]), user('c')], model);
  const records = transcript(messages, 'session', '/temp', model.id).trim().split('\n').map(JSON.parse);
  assert.equal(records[0].parentUuid, null);
  assert.equal(records[1].parentUuid, records[0].uuid);
  assert.equal(records[2].parentUuid, records[1].uuid);
  assert.ok(records.every(r => r.sessionId === 'session'));
});

function decoder() {
  const output = emptyMessage(model), events = [];
  return { d: new ResponseDecoder(output, [tool], e => events.push(e)), output, events };
}
test('stream consumes exact block events, incremental usage and terminal reason', () => {
  const { d, output, events } = decoder();
  d.event({ type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30 } } });
  d.event({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'x', name: wireName(tool.name), input: {} } });
  d.event({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"x":' } });
  d.event({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"😀"}' } });
  d.event({ type: 'content_block_stop', index: 0 });
  d.event({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } });
  d.event({ type: 'message_stop' });
  assert.equal(d.done, true); assert.equal(output.stopReason, 'toolUse');
  assert.equal(output.usage.totalTokens, 67); assert.equal(output.usage.input, 10);
  assert.deepEqual(output.content[0].arguments, { x: '😀' });
  assert.deepEqual(events.map(e => e.type), ['toolcall_start', 'toolcall_delta', 'toolcall_delta', 'toolcall_end']);
});

test('unknown tools, malformed arguments and incomplete streams fail closed', () => {
  let { d } = decoder();
  d.event({ type: 'message_start', message: {} });
  assert.throws(() => d.event({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'Bash' } }), /unadvertised/);
  ({ d } = decoder());
  d.event({ type: 'message_start', message: {} });
  d.event({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: wireName(tool.name), id: 'x' } });
  d.event({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{broken' } });
  assert.throws(() => d.event({ type: 'content_block_stop', index: 0 }));
  ({ d } = decoder());
  assert.throws(() => d.event({ type: 'message_stop' }), /Incomplete/);
});
