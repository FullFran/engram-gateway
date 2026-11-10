// The auth plugin port: the authenticator asks each enabled identity
// provider in turn, AUTH_PROVIDERS picks them by configuration only, and
// the GitHub adapter stays the default.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpRequestAuthenticator } from '../../dist/auth/presentation/http/request-authenticator.js';
import { resolveAuthConfig, AuthConfigError, AUTH_PLUGINS } from '../../dist/auth/index.js';

const challenge = (resource, error) => `Bearer test="${resource}"${error ? ` error="${error}"` : ''}`;

function provider(id, { bearer, session } = {}) {
  return {
    id,
    bearer: bearer ? (token, target) => bearer(token, target) : undefined,
    session: session ? (cookies, target) => session(cookies, target) : undefined
  };
}

const identity = (provider, subject, extra = {}) => ({ provider, subject, via: 'bearer', scopes: ['memory'], ...extra });

test('the first provider that vouches for a bearer wins; others may not know it', () => {
  const seen = [];
  const a = provider('a', { bearer: (token, target) => { seen.push(['a', token, target]); return { kind: 'none' }; } });
  const b = provider('b', { bearer: token => (token === 'good' ? { kind: 'ok', identity: identity('b', 'person-1') } : { kind: 'invalid', error: 'invalid_token' }) });
  const auth = new HttpRequestAuthenticator([a, b], 'https://memory.example', challenge);
  const result = auth.authenticate({ authorization: 'Bearer good' }, { resource: ['https://memory.example/mcp'], acceptSession: false });
  assert.equal(result.ok, true);
  assert.equal(result.principal.provider, 'b');
  assert.equal(result.principal.login, 'person-1');
  assert.deepEqual(seen[0][2], { resources: ['https://memory.example/mcp'] });
  const bad = auth.authenticate({ authorization: 'Bearer bad' }, { resource: 'https://memory.example/mcp', acceptSession: true });
  assert.deepEqual([bad.ok, bad.status, bad.error], [false, 401, 'invalid_token']);
  assert.equal(bad.challenge, 'Bearer test="https://memory.example/mcp" error="invalid_token"');
});

test('a bearer decides alone: a session cookie never rescues a bad token', () => {
  const sessions = provider('s', { session: cookies => (cookies.get('c') === '1' ? { kind: 'ok', identity: identity('s', 'x', { via: 'session' }) } : { kind: 'none' }) });
  const auth = new HttpRequestAuthenticator([sessions], 'https://memory.example', challenge);
  assert.equal(auth.authenticate({ authorization: 'Bearer nope', cookie: 'c=1' }, { resource: 'r', acceptSession: true }).ok, false);
  assert.equal(auth.authenticate({ cookie: 'c=1' }, { resource: 'r', acceptSession: true }).ok, true);
  assert.equal(auth.authenticate({ cookie: 'c=1' }, { resource: 'r', acceptSession: false }).ok, false);
  const none = auth.authenticate({}, { resource: 'r', acceptSession: true });
  assert.deepEqual([none.status, none.error], [401, 'unauthorized']);
});

test('insufficient scope from any provider is a 403', () => {
  const p = provider('p', { bearer: () => ({ kind: 'invalid', error: 'insufficient_scope' }) });
  const result = new HttpRequestAuthenticator([p], 'https://o', challenge).authenticate({ authorization: 'Bearer t' }, { resource: 'r', acceptSession: false });
  assert.deepEqual([result.status, result.error], [403, 'insufficient_scope']);
});

const dataDir = mkdtempSync(join(tmpdir(), 'engram-gateway-providers-'));
process.on('exit', () => rmSync(dataDir, { recursive: true, force: true }));
const fullEnv = () => ({
  PUBLIC_BASE_URL: 'https://memory.example.com', GITHUB_CLIENT_ID: 'id', ALLOWED_GITHUB_LOGINS: 'FullFran',
  AUTH_SECRET: 'x'.repeat(40), GATEWAY_DATA_DIR: dataDir
});

test('AUTH_PROVIDERS: github by default, unknown ids refused by name', () => {
  assert.ok(AUTH_PLUGINS.github, 'the GitHub adapter is registered');
  const config = resolveAuthConfig('0.0.0.0', fullEnv(), { resourcePaths: ['/mcp'] });
  assert.deepEqual(config.providers.map(p => p.id), ['github']);
  const explicit = resolveAuthConfig('0.0.0.0', { ...fullEnv(), AUTH_PROVIDERS: ' GitHub ' }, { resourcePaths: ['/mcp'] });
  assert.deepEqual(explicit.providers.map(p => p.id), ['github']);
  assert.throws(() => resolveAuthConfig('0.0.0.0', { ...fullEnv(), AUTH_PROVIDERS: 'github,ldap' }, { resourcePaths: ['/mcp'] }),
    error => error instanceof AuthConfigError && /unknown provider "ldap"/.test(error.message));
});

test('GATEWAY_DATA_DIR holds the auth store and is required when auth is on', () => {
  const config = resolveAuthConfig('0.0.0.0', fullEnv(), { resourcePaths: ['/mcp'] });
  assert.equal(config.storePath, join(dataDir, 'auth-store.json'));
  const { GATEWAY_DATA_DIR, ...withoutDir } = fullEnv();
  assert.throws(() => resolveAuthConfig('0.0.0.0', withoutDir, { resourcePaths: ['/mcp'] }),
    error => error instanceof AuthConfigError && /GATEWAY_DATA_DIR/.test(error.message));
});
