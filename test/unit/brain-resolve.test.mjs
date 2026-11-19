import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBrainResolveTool, matchRemote, normalizeRemote, parseRemoteMapping } from '../../dist/gateway-tools/index.js';
import { requiredRole } from '../../dist/authz/index.js';
import { resolveGatewayConfig } from '../../dist/config.js';

test('normalizeRemote: https, ssh, scp-like and .git forms of one repository are the same key, with no credentials', () => {
  for (const raw of [
    'https://github.com/hagalink/engram-gateway.git',
    'https://github.com/hagalink/engram-gateway',
    'https://user:secret-token@github.com/HagaLink/engram-gateway/',
    'http://github.com/hagalink/engram-gateway.git',
    'git@github.com:hagalink/engram-gateway.git',
    'ssh://git@github.com/hagalink/engram-gateway.git',
    'ssh://git@github.com:22/hagalink/engram-gateway',
    'git://github.com/hagalink/engram-gateway.git',
    'github.com/hagalink/engram-gateway',
    '  GitHub.com/hagalink/engram-gateway.git  '
  ]) {
    assert.equal(normalizeRemote(raw), 'github.com/hagalink/engram-gateway', raw);
  }
  assert.equal(normalizeRemote('git@gitlab.com:group/sub/project.git'), 'gitlab.com/group/sub/project');
});

test('normalizeRemote: anything that is not a remote with a host and a path is no key', () => {
  for (const raw of ['', '   ', 'not a url', '/srv/git/repo.git', './repo', 'file:///srv/git/repo.git', 'https://github.com/', 'https://github.com', 'github.com', 42, undefined, null, {}]) {
    assert.equal(normalizeRemote(raw), undefined, String(raw));
  }
});

test('parseRemoteMapping: exact remotes and org-wide patterns, written in any remote form', () => {
  assert.deepEqual(parseRemoteMapping(''), []);
  assert.deepEqual(parseRemoteMapping(undefined), []);
  assert.deepEqual(parseRemoteMapping(' git@github.com:hagalink/engram-gateway.git = alpha , github.com/hagalink/* =beta,https://gitlab.com/group/*=gamma '), [
    { pattern: 'github.com/hagalink/engram-gateway', brain: 'alpha' },
    { pattern: 'github.com/hagalink/*', brain: 'beta' },
    { pattern: 'gitlab.com/group/*', brain: 'gamma' }
  ]);
});

test('parseRemoteMapping: a bad entry is a startup error naming it', () => {
  for (const [raw, message] of [
    ['github.com/hagalink/x', /remote=brain/],
    ['github.com/hagalink/x=', /remote=brain/],
    ['github.com/hagalink/x=Not A Slug', /brain name/],
    ['not a remote=alpha', /remote/],
    ['github.com/*/x=alpha', /\*/],
    ['*=alpha', /\*/],
    ['github.com/hagalink/x=alpha,github.com/hagalink/x.git=beta', /twice/]
  ]) {
    assert.throws(() => parseRemoteMapping(raw), message, raw);
  }
});

test('matchRemote: an exact remote wins over a pattern, and the longest pattern wins over a shorter one', () => {
  const rules = parseRemoteMapping('github.com/*=wide,github.com/hagalink/*=org,github.com/hagalink/engram-gateway=exact');
  assert.equal(matchRemote(rules, 'github.com/hagalink/engram-gateway'), 'exact');
  assert.equal(matchRemote(rules, 'github.com/hagalink/other'), 'org');
  assert.equal(matchRemote(rules, 'github.com/hagalink/group/nested'), 'org');
  assert.equal(matchRemote(rules, 'github.com/someone/else'), 'wide');
  assert.equal(matchRemote(rules, 'gitlab.com/hagalink/x'), undefined);
  const org = parseRemoteMapping('github.com/hagalink/*=org');
  assert.equal(matchRemote(org, 'github.com/hagalinker/x'), undefined, 'a pattern matches whole path segments');
  assert.equal(matchRemote(org, 'github.com/hagalink'), undefined, 'the org itself is not one of its repositories');
});

test('BRAIN_REMOTES configures the mapping; a bad value stops startup naming the variable', () => {
  assert.deepEqual(resolveGatewayConfig({}).brainRemotes, []);
  assert.deepEqual(resolveGatewayConfig({ BRAIN_REMOTES: 'github.com/hagalink/*=work' }).brainRemotes, [{ pattern: 'github.com/hagalink/*', brain: 'work' }]);
  assert.throws(() => resolveGatewayConfig({ BRAIN_REMOTES: 'github.com/hagalink/*' }), /BRAIN_REMOTES/);
});

test('brain_resolve is a reader tool (GATEWAY_TOOL_ROLES)', () => {
  assert.equal(requiredRole('brain_resolve'), 'reader');
});

const RULES = parseRemoteMapping('github.com/hagalink/engram-gateway=alpha,github.com/hagalink/*=beta,github.com/elsewhere/*=gamma');
const VIEW = {
  connection: 'c', defaultBrain: 'alpha',
  brains: [{ brain: 'alpha', role: 'reader', effectiveRole: 'reader' }, { brain: 'beta', role: 'writer', effectiveRole: 'writer' }, { brain: 'lost', role: 'owner', effectiveRole: null }]
};
const tool = (rules = RULES, views = { 7: VIEW }) => createBrainResolveTool({ rules, connections: { describe: id => views[id] } });
const resolve = async (t, args, ctx) => {
  const result = await t.call(args, ctx);
  assert.ok(!result.isError, JSON.stringify(result));
  return JSON.parse(result.content[0].text);
};
const onConnection = { brain: 'alpha', caller: { login: 'owner-o', connectionId: 7 } };

test('brain_resolve on a connection: the mapped brain when the connection can use it', async () => {
  assert.deepEqual(await resolve(tool(), { remote: 'git@github.com:hagalink/engram-gateway.git' }, onConnection), { brain: 'alpha', source: 'mapping', remote: 'github.com/hagalink/engram-gateway' });
  assert.deepEqual(await resolve(tool(), { remote: 'https://github.com/hagalink/website' }, onConnection), { brain: 'beta', source: 'mapping', remote: 'github.com/hagalink/website' });
});

test('brain_resolve fails open: unmapped, unusable or garbage remotes get the default brain, never an error', async () => {
  // Mapped to a brain the connection does not have.
  assert.deepEqual(await resolve(tool(), { remote: 'github.com/elsewhere/x' }, onConnection), { brain: 'alpha', source: 'default', remote: 'github.com/elsewhere/x' });
  // Mapped to a brain whose grant the owner lost.
  assert.deepEqual(await resolve(tool(parseRemoteMapping('github.com/a/b=lost')), { remote: 'github.com/a/b' }, onConnection), { brain: 'alpha', source: 'default', remote: 'github.com/a/b' });
  assert.deepEqual(await resolve(tool(), { remote: 'github.com/nobody/x' }, onConnection), { brain: 'alpha', source: 'default', remote: 'github.com/nobody/x' });
  for (const args of [{ remote: 'not a remote' }, { remote: 3 }, {}, undefined]) {
    assert.deepEqual(await resolve(tool(), args, onConnection), { brain: 'alpha', source: 'default', remote: null }, JSON.stringify(args));
  }
  assert.deepEqual(await resolve(tool([]), { remote: 'github.com/hagalink/engram-gateway' }, onConnection), { brain: 'alpha', source: 'default', remote: 'github.com/hagalink/engram-gateway' });
});

test('brain_resolve: no default brain (or a default the connection cannot use) is brain null', async () => {
  const noDefault = { ...VIEW, defaultBrain: null };
  assert.deepEqual(await resolve(tool(RULES, { 7: noDefault }), { remote: 'github.com/nobody/x' }, onConnection), { brain: null, source: 'none', remote: 'github.com/nobody/x' });
  const lostDefault = { ...VIEW, defaultBrain: 'lost' };
  assert.deepEqual(await resolve(tool(RULES, { 7: lostDefault }), { remote: 'github.com/nobody/x' }, onConnection), { brain: null, source: 'none', remote: 'github.com/nobody/x' });
  // A connection deleted since the token was issued.
  assert.deepEqual(await resolve(tool(RULES, {}), { remote: 'github.com/hagalink/engram-gateway' }, onConnection), { brain: null, source: 'none', remote: 'github.com/hagalink/engram-gateway' });
});

test('brain_resolve without a connection (/mcp/<brain>, or auth off): only the brain the call is on', async () => {
  const onBeta = { brain: 'beta', caller: { login: 'owner-o' } };
  assert.deepEqual(await resolve(tool(), { remote: 'github.com/hagalink/website' }, onBeta), { brain: 'beta', source: 'mapping', remote: 'github.com/hagalink/website' });
  assert.deepEqual(await resolve(tool(), { remote: 'github.com/hagalink/engram-gateway' }, onBeta), { brain: 'beta', source: 'default', remote: 'github.com/hagalink/engram-gateway' });
  assert.deepEqual(await resolve(tool(), { remote: 'github.com/hagalink/engram-gateway' }, { brain: 'alpha' }), { brain: 'alpha', source: 'mapping', remote: 'github.com/hagalink/engram-gateway' });
  assert.deepEqual(await resolve(tool(), { remote: 'github.com/hagalink/engram-gateway' }, { brain: null }), { brain: null, source: 'none', remote: 'github.com/hagalink/engram-gateway' });
});

test('brain_resolve never echoes credentials from the remote', async () => {
  const text = (await tool().call({ remote: 'https://user:ghp_secretvalue@github.com/hagalink/engram-gateway.git' }, onConnection)).content[0].text;
  assert.ok(!text.includes('ghp_secretvalue') && !text.includes('user'), text);
});
