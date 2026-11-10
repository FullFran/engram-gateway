// Dependency rule of the hexagon: the auth domain imports nothing outside
// itself (and no Node/Express), application only its domain and ports, and
// the auth context never imports the http layer or the bridge (main.ts wires them).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = resolve(dirname(fileURLToPath(import.meta.url)), '../../src');

function files(dir) {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : [];
  });
}

function imports(file) {
  return [...readFileSync(file, 'utf8').matchAll(/(?:import|export)[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)]
    .map(match => match[1] ?? match[2]);
}

function target(file, specifier) {
  return specifier.startsWith('.') ? relative(src, resolve(dirname(file), specifier)) : specifier;
}

test('auth: domain is pure', () => {
  for (const file of files(join(src, 'auth', 'domain'))) {
    for (const spec of imports(file)) {
      assert.ok(target(file, spec).startsWith('auth/domain/'), `${relative(src, file)} imports ${spec}`);
    }
  }
});

test('auth: application depends only on its domain, its ports and shared', () => {
  for (const file of files(join(src, 'auth', 'application'))) {
    for (const spec of imports(file)) {
      const to = target(file, spec);
      assert.ok(to.startsWith('auth/domain/') || to.startsWith('auth/application/') || to.startsWith('shared/'), `${relative(src, file)} imports ${spec}`);
    }
  }
});

test('auth never imports the http layer or the bridge; the bridge never imports auth or http', () => {
  const forbidden = { auth: ['http/', 'bridge/'], bridge: ['auth/', 'http/'] };
  for (const [from, others] of Object.entries(forbidden)) {
    const dir = join(src, from);
    if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) continue;
    for (const file of files(dir)) {
      for (const spec of imports(file)) {
        for (const other of others) assert.ok(!target(file, spec).startsWith(other), `${relative(src, file)} imports ${spec}`);
      }
    }
  }
});

test('only the bridge knows the MCP client package', () => {
  for (const file of files(src)) {
    const rel = relative(src, file);
    for (const spec of imports(file)) {
      if (spec.startsWith('@modelcontextprotocol/client')) assert.ok(rel.startsWith('bridge/'), `${rel} imports ${spec}`);
    }
  }
});
