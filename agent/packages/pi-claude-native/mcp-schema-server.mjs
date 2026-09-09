// Schema-only MCP endpoint. There is deliberately NO tool execution backend.
// Claude may dispatch a call while its last stream frames are in flight. Leave
// it unanswered until the request's process group is terminated; never execute
// side effects and never feed fabricated results into another Claude turn.
import { readFileSync } from 'node:fs';
const tools = JSON.parse(readFileSync(process.argv[2], 'utf8'));
let buffer = '';
process.stdin.setEncoding('utf8');
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
process.stdin.on('data', chunk => {
  buffer += chunk;
  if (buffer.length > 16 * 1024 * 1024) process.exit(1);
  let end;
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    if (!line.trim()) continue;
    let request;
    try { request = JSON.parse(line); } catch { process.exit(1); }
    if (request.id === undefined) continue;
    if (request.method === 'initialize') send(request.id, {
      protocolVersion: request.params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: {} }, serverInfo: { name: 'pi-schema-only', version: '0.1.0' },
    });
    else if (request.method === 'tools/list') send(request.id, { tools });
    else if (request.method === 'ping') send(request.id, {});
    else if (request.method !== 'tools/call') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }) + '\n');
  }
});
process.stdin.on('end', () => process.exit(0));
process.stdout.on('error', () => process.exit(0));
