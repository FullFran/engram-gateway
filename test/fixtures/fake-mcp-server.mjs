// Tiny stdio MCP server used by the bridge unit tests.
// FAKE_PID_FILE / FAKE_ENV_FILE: write the pid / the whole environment there on start;
// FAKE_SPAWN_LOG: append one byte per start.
// Tools: echo (ok), fail (isError), crash (exits the process), slow (never answers),
// mem_save (returns the arguments it received, so tests can see what reached the server),
// mem_search (returns `text` as stored memory, with structured content).
import { appendFileSync, writeFileSync } from 'node:fs';
import { TOOLS } from './fake-tools.mjs';
import { Server } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

const factory = () => {
  const server = new Server(
    { name: 'fake-engram', version: '9.9.9' },
    { capabilities: { tools: {} }, instructions: 'Fake instructions: save things.' }
  );
  server.setRequestHandler('tools/list', async () => ({ tools: TOOLS }));
  server.setRequestHandler('tools/call', async request => {
    const { name, arguments: args } = request.params;
    if (name === 'echo') return { content: [{ type: 'text', text: args.text }], structuredContent: { echoed: args.text } };
    if (name === 'fail') return { content: [{ type: 'text', text: 'boom' }], isError: true };
    if (name === 'crash') process.exit(3);
    if (name === 'mem_save') return { content: [{ type: 'text', text: JSON.stringify(args) }], structuredContent: { received: args } };
    if (name === 'mem_search') return { content: [{ type: 'text', text: args.text }], structuredContent: { results: [{ id: 1, content: args.text }] } };
    if (name === 'slow') return new Promise(() => {});
    return { content: [{ type: 'text', text: `unknown tool ${name}` }], isError: true };
  });
  return server;
};

if (process.env.FAKE_PID_FILE) writeFileSync(process.env.FAKE_PID_FILE, String(process.pid));
if (process.env.FAKE_SPAWN_LOG) appendFileSync(process.env.FAKE_SPAWN_LOG, 'x');
if (process.env.FAKE_ENV_FILE) writeFileSync(process.env.FAKE_ENV_FILE, JSON.stringify(process.env));
serveStdio(factory);
process.stdin.on('end', () => process.exit(0));
