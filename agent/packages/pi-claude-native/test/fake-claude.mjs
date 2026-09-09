#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const args = process.argv.slice(2);
const arg = name => args[args.indexOf(name) + 1];
const prompt = readFileSync(arg('--system-prompt-file'), 'utf8');
const send = r => process.stdout.write(JSON.stringify(r) + '\n');
if (prompt.startsWith('fake:hang')) { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); }
else if (prompt.startsWith('fake:exit')) process.exit(7);
else if (prompt.startsWith('fake:malformed')) { process.stdout.write('{invalid\n'); setInterval(() => {}, 1000); }
else if (prompt.startsWith('fake:error')) send({ type: 'result', subtype: 'success', is_error: true, result: 'Prompt is too long' });
else if (prompt.startsWith('fake:permissions')) send({ type: 'control_request', request: { subtype: 'can_use_tool' } });
else if (prompt.startsWith('fake:unexpected-tool')) send({ type: 'system', subtype: 'init', tools: ['Bash'] });
else {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => input += chunk);
  process.stdin.on('end', () => {
    const parsed = JSON.parse(input);
    let history;
    if (args.includes('--resume')) history = readFileSync(arg('--resume'), 'utf8').trim().split('\n').map(JSON.parse);
    if (prompt.startsWith('fake:inspect')) {
      const dest = prompt.split('\n')[1];
      writeFileSync(dest, JSON.stringify({ args, input: parsed, history, prompt, cwd: process.cwd(), env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, CLAUDECODE: process.env.CLAUDECODE } }));
    }
    if (prompt.startsWith('fake:grandchild')) {
      const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { stdio: 'ignore' });
      writeFileSync(prompt.split('\n')[1], String(child.pid));
    }
    const stream = event => send({ type: 'stream_event', event });
    stream({ type: 'message_start', message: { usage: { input_tokens: 10 } } });
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'héllo 😀\u2028world\u2029' } });
    // Native CLI emits per-block assistant mirrors BEFORE block_stop.
    send({ type: 'assistant', message: { content: [{ type: 'text', text: 'must not duplicate' }] } });
    stream({ type: 'content_block_stop', index: 0 });
    stream({ type: 'message_delta', delta: { stop_reason: prompt.startsWith('fake:length') ? 'max_tokens' : 'end_turn' }, usage: { output_tokens: 8 } });
    stream({ type: 'message_stop' });
    setInterval(() => {}, 1000);
  });
}
