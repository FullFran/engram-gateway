// Tiny stdio MCP server used by the bridge unit tests.
// Tools: echo (ok), fail (isError), crash (exits the process), slow (never answers).
import { writeFileSync } from 'node:fs';
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
    if (name === 'slow') return new Promise(() => {});
    return { content: [{ type: 'text', text: `unknown tool ${name}` }], isError: true };
  });
  return server;
};

if (process.env.FAKE_PID_FILE) writeFileSync(process.env.FAKE_PID_FILE, String(process.pid));
serveStdio(factory);
process.stdin.on('end', () => process.exit(0));
