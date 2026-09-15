import { setTimeout as delay } from 'node:timers/promises'
import { emptyUsage } from '../runner.mjs'

const mode = process.argv[2]
const emit = event => process.stdout.write(JSON.stringify(event) + '\n')
const assistant = (text, stopReason = 'stop', errorMessage) => ({ role: 'assistant', content: [{ type: 'thinking', thinking: 'PRIVATE_REASONING' }, { type: 'text', text }], stopReason, errorMessage, usage: { ...emptyUsage(), input: 10, output: 5, totalTokens: 15 } })
let input = ''
for await (const chunk of process.stdin) input += chunk
if (mode === 'inspect') {
  emit({ type: 'message_end', message: assistant(JSON.stringify({ args: process.argv.slice(3), env: process.env, input, cwd: process.cwd() })) })
} else if (mode === 'hang' || mode === 'stubborn') {
  if (mode === 'stubborn') process.on('SIGTERM', () => {})
  emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'READY' } })
  setInterval(() => {}, 1000)
} else if (mode === 'malformed') {
  process.stdout.write('not json\n')
  setInterval(() => {}, 1000)
} else if (mode === 'exit') {
  process.stderr.write('configuration broken')
  process.exitCode = 7
} else if (mode === 'silent') {
  emit({ type: 'agent_end', messages: [] })
} else if (mode === 'error' || mode === 'aborted') {
  emit({ type: 'message_end', message: assistant('', mode, 'Provider failed') })
} else {
  emit({ type: 'message_start', message: { role: 'user', content: 'PRIVATE_PROMPT' } })
  emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'PRIVATE_REASONING' } })
  emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Live output' } })
  await delay(300)
  emit({ type: 'message_end', message: assistant('Live output', 'toolUse') })
  emit({ type: 'tool_execution_start', toolName: 'read', toolCallId: 't', args: { path: 'example.txt' } })
  emit({ type: 'tool_execution_update', toolName: 'read', partialResult: { content: [{ type: 'text', text: 'partial tool output' }] } })
  emit({ type: 'tool_execution_end', toolName: 'read', result: { content: [{ type: 'text', text: 'File contents' }] } })
  const answer = mode === 'large' ? '🙂'.repeat(80000) + '\nFINAL' : 'Done 🙂\u2028still one record\u2029end'
  const message = assistant(answer)
  // Split a UTF-8 sequence across writes; the runner must use a streaming decoder.
  const bytes = Buffer.from(JSON.stringify({ type: 'message_end', message }))
  const split = bytes.indexOf(Buffer.from('🙂')) + 1
  process.stdout.write(bytes.subarray(0, split))
  await delay(10)
  process.stdout.write(bytes.subarray(split)) // deliberately no trailing LF
}
