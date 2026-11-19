#!/usr/bin/env node
// Claude Code SessionStart hook (#12): asks the Engram gateway which brain
// this repository's memory belongs to (`brain_resolve`) and prints one line
// that Claude Code adds to the session context.
//
// Fails open: no repository, no origin remote, no gateway URL, a gateway that
// is down, slow, refuses the token or has no mapping all print nothing and
// exit 0, so the session always starts.
//
// Environment:
//   ENGRAM_GATEWAY_URL         the gateway's MCP endpoint, e.g. https://memory.example.com/mcp
//   ENGRAM_GATEWAY_TOKEN       a bearer token for it (a connection token, #7/#27)
//   ENGRAM_GATEWAY_TIMEOUT_MS  give up after this long (default 3000)
import { execFileSync } from 'node:child_process';

const PROTOCOL_VERSION = '2026-07-28';

async function main() {
  const url = process.env.ENGRAM_GATEWAY_URL;
  if (!url) return;
  const timeoutMs = Number(process.env.ENGRAM_GATEWAY_TIMEOUT_MS) || 3000;
  const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  let remote;
  try {
    remote = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: timeoutMs }).trim();
  } catch {
    return;
  }
  if (!remote) return;
  // Credentials in the remote URL never leave this machine.
  remote = remote.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, '$1');

  const response = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': PROTOCOL_VERSION,
      'mcp-method': 'tools/call',
      'mcp-name': 'brain_resolve',
      ...(process.env.ENGRAM_GATEWAY_TOKEN ? { authorization: `Bearer ${process.env.ENGRAM_GATEWAY_TOKEN}` } : {})
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: {
        name: 'brain_resolve', arguments: { remote },
        _meta: {
          'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
          'io.modelcontextprotocol/clientCapabilities': {},
          'io.modelcontextprotocol/clientInfo': { name: 'engram-session-start', version: '1.0.0' }
        }
      }
    })
  });
  if (!response.ok) return;
  const body = await response.text();
  const messages = (response.headers.get('content-type') ?? '').includes('text/event-stream')
    ? body.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5).trim()))
    : [JSON.parse(body)].flat();
  const result = messages.find(message => message?.id === 1)?.result;
  if (!result || result.isError) return;
  // The gateway wraps tool results as delimited data (<memory-data nonce=...>):
  // read the JSON object inside, not the whole text.
  const text = (result.content ?? []).map(part => part?.text ?? '').join('\n');
  const brain = /\{"brain":"([a-z0-9][a-z0-9-]{0,39})","source":"(?:mapping|default)"/.exec(text)?.[1];
  if (!brain) return;
  process.stdout.write(`Engram memory for this repository is in brain "${brain}": pass brain: "${brain}" to the Engram memory tools.\n`);
}

main().catch(() => {}).finally(() => process.exit(0));
