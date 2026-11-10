// Tool definitions served by fake-mcp-server.mjs, shared with the tests.
export const TOOLS = [
  {
    name: 'echo',
    title: 'Echo',
    description: 'Echoes text back.',
    inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'what to echo' } }, required: ['text'], additionalProperties: false },
    outputSchema: { type: 'object', properties: { echoed: { type: 'string' } }, required: ['echoed'] },
    annotations: { readOnlyHint: true, idempotentHint: true }
  },
  { name: 'fail', description: 'Always reports a tool error.', inputSchema: { type: 'object', properties: {} } },
  { name: 'crash', description: 'Kills the server process.', inputSchema: { type: 'object', properties: {} } },
  { name: 'slow', description: 'Never answers.', inputSchema: { type: 'object', properties: {} } }
];
