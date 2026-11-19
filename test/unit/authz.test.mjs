// Roles and grants per brain (#6): the tool-to-role table, the pure role
// decision, the grants repository and its startup sync, and the access policy
// the OAuth server asks before issuing or refreshing a token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TOOL_ROLES, GrantAccessPolicy, SqliteGrantRepository, bootstrapAccess, brainOfResource, createToolAccess, decideTool,
  effectiveRole, parseBrainGrants, requiredRole
} from '../../dist/authz/index.js';
import { SqliteBrainRepository } from '../../dist/brains/index.js';
import { DENY_REASONS } from '../../dist/audit/index.js';
import { openGatewayDatabase } from '../../dist/shared/gateway-database.js';
import { ENGRAM_TOOLS } from '../fixtures/engram-tools.mjs';


function scratchDb(t) {
  const dir = mkdtempSync(join(tmpdir(), 'engram-gateway-authz-'));
  const db = openGatewayDatabase(join(dir, 'gateway.db'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return db;
}

function withBrains(db, slugs) {
  const brains = new SqliteBrainRepository(db);
  for (const slug of slugs) brains.ensure(slug, `/data/brains/${slug}`);
  return slugs;
}

test('tool table: every engram tool has a role, and nothing else does', () => {
  assert.deepEqual(Object.keys(TOOL_ROLES).sort(), [...ENGRAM_TOOLS].sort());
  assert.equal(requiredRole('mem_search'), 'reader');
  assert.equal(requiredRole('mem_save'), 'writer');
  assert.equal(requiredRole('mem_session_end'), 'writer');
  assert.equal(requiredRole('mem_delete'), 'owner');
  assert.equal(requiredRole('mem_merge_projects'), 'owner');
  for (const name of ['mem_brand_new', 'toString', '__proto__', 'constructor', '']) assert.equal(requiredRole(name), undefined, name);
});

test('decision: reader < writer < owner, unmapped tools and missing grants are denied', () => {
  assert.deepEqual(decideTool({ user: 'reader' }, 'mem_search'), { allowed: true, role: 'reader' });
  assert.deepEqual(decideTool({ user: 'reader' }, 'mem_save'), { allowed: false, reason: 'insufficient_role', role: 'reader', required: 'writer' });
  assert.deepEqual(decideTool({ user: 'writer' }, 'mem_save'), { allowed: true, role: 'writer' });
  assert.deepEqual(decideTool({ user: 'writer' }, 'mem_delete'), { allowed: false, reason: 'insufficient_role', role: 'writer', required: 'owner' });
  assert.deepEqual(decideTool({ user: 'owner' }, 'mem_delete'), { allowed: true, role: 'owner' });
  assert.deepEqual(decideTool({ user: 'owner' }, 'mem_brand_new'), { allowed: false, reason: 'unknown_tool', role: 'owner' });
  assert.deepEqual(decideTool({}, 'mem_search'), { allowed: false, reason: 'no_grant' });
});

test('decision: the connection layer (#27) caps the user role; absent, it is the user role', () => {
  assert.equal(effectiveRole({ user: 'owner' }), 'owner');
  assert.equal(effectiveRole({ user: 'owner', connection: 'reader' }), 'reader');
  assert.equal(effectiveRole({ user: 'reader', connection: 'owner' }), 'reader');
  assert.equal(effectiveRole({ user: 'owner', connection: null }), undefined);
  assert.equal(effectiveRole({ connection: 'owner' }), undefined);
  assert.deepEqual(decideTool({ user: 'owner', connection: 'reader' }, 'mem_save'), { allowed: false, reason: 'insufficient_role', role: 'reader', required: 'writer' });
});

test('BRAIN_GRANTS parses login:brain:role entries and rejects malformed ones', () => {
  assert.deepEqual(parseBrainGrants(undefined), []);
  assert.deepEqual(parseBrainGrants(' alice:work:reader , Bob:default:writer,, '), [
    { login: 'alice', brain: 'work', role: 'reader' },
    { login: 'Bob', brain: 'default', role: 'writer' }
  ]);
  assert.throws(() => parseBrainGrants('alice:work'), /BRAIN_GRANTS: .*login:brain:role/);
  assert.throws(() => parseBrainGrants('alice:work:admin'), /BRAIN_GRANTS: .*role/);
  assert.throws(() => parseBrainGrants('bad login!:work:reader'), /BRAIN_GRANTS: .*GitHub login/);
  assert.throws(() => parseBrainGrants('alice:Work:reader'), /BRAIN_GRANTS: .*brain slug/);
  assert.throws(() => parseBrainGrants('alice:work:reader,ALICE:work:writer'), /BRAIN_GRANTS: .*twice/);
});

test('startup sync: admins own every brain, BRAIN_GRANTS rows exist, nothing else does', t => {
  const db = scratchDb(t);
  const brains = withBrains(db, ['default', 'work', 'team']);
  const repo = new SqliteGrantRepository(db);
  bootstrapAccess(repo, { admins: ['FullFran'], grants: [{ login: 'alice', brain: 'work', role: 'reader' }], brains });
  assert.equal(repo.roleOf('fullfran', 'default'), 'owner', 'logins compare case-insensitively');
  assert.equal(repo.roleOf('FullFran', 'team'), 'owner');
  assert.equal(repo.roleOf('alice', 'work'), 'reader');
  assert.equal(repo.roleOf('alice', 'team'), undefined);
  assert.equal(repo.isAdmin('FullFran'), true);
  assert.equal(repo.isAdmin('alice'), false);
  assert.equal(repo.hasAccess('alice'), true);
  assert.equal(repo.hasAccess('FullFran'), true);
  assert.equal(repo.hasAccess('mallory'), false);
  // The audit log (#8) adds a users row for every caller; a row alone grants nothing.
  db.prepare("INSERT INTO users (github_login) VALUES ('dave')").run();
  assert.equal(repo.hasAccess('dave'), false);

  // Next start: alice left BRAIN_GRANTS and FullFran left ALLOWED_GITHUB_LOGINS.
  bootstrapAccess(repo, { admins: ['carol'], grants: [{ login: 'bob', brain: 'team', role: 'writer' }], brains });
  assert.equal(repo.roleOf('alice', 'work'), undefined, 'a grant removed from BRAIN_GRANTS is revoked');
  assert.equal(repo.roleOf('FullFran', 'default'), undefined, 'a former admin loses the owner grants');
  assert.equal(repo.isAdmin('FullFran'), false);
  assert.equal(repo.roleOf('carol', 'work'), 'owner');
  assert.equal(repo.roleOf('bob', 'team'), 'writer');
  const users = db.prepare('SELECT github_login FROM users ORDER BY github_login').all().map(row => row.github_login);
  assert.deepEqual(users, ['alice', 'bob', 'carol', 'dave', 'FullFran'], 'users rows are kept (history), only grants and the admin flag change');
});

test('startup sync rewrites only configuration grants: an API grant survives a restart (#10)', t => {
  const db = scratchDb(t);
  const brains = withBrains(db, ['default', 'work', 'team']);
  const repo = new SqliteGrantRepository(db);
  bootstrapAccess(repo, { admins: ['FullFran'], grants: [{ login: 'alice', brain: 'work', role: 'reader' }], brains });
  // What the admin API writes: a user and a grant marked `api`.
  db.prepare("INSERT INTO users (github_login) VALUES ('erin')").run();
  db.prepare("INSERT INTO grants (user_id, brain_id, role, source) SELECT u.id, b.id, 'writer', 'api' FROM users u, brains b WHERE u.github_login = 'erin' AND b.slug = 'team'").run();
  db.prepare("INSERT INTO grants (user_id, brain_id, role, source) SELECT u.id, b.id, 'owner', 'api' FROM users u, brains b WHERE u.github_login = 'alice' AND b.slug = 'team'").run();

  bootstrapAccess(repo, { admins: ['FullFran'], grants: [{ login: 'alice', brain: 'work', role: 'writer' }], brains });
  assert.equal(repo.roleOf('erin', 'team'), 'writer', 'an API grant survives the restart');
  assert.equal(repo.roleOf('alice', 'team'), 'owner', 'an API grant of a configured user survives too');
  assert.equal(repo.roleOf('alice', 'work'), 'writer', 'configuration grants follow BRAIN_GRANTS');
  const sources = db.prepare(`SELECT u.github_login AS login, b.slug AS brain, g.source FROM grants g JOIN users u ON u.id = g.user_id JOIN brains b ON b.id = g.brain_id
    WHERE u.github_login IN ('alice', 'erin') ORDER BY login, brain`).all().map(row => `${row.login}:${row.brain}:${row.source}`);
  assert.deepEqual(sources, ['alice:team:api', 'alice:work:config', 'erin:team:api']);

  // A BRAIN_GRANTS entry for the same login and brain takes the row over: configuration wins.
  bootstrapAccess(repo, { admins: ['FullFran'], grants: [{ login: 'erin', brain: 'team', role: 'reader' }], brains });
  assert.equal(repo.roleOf('erin', 'team'), 'reader');
  assert.equal(db.prepare("SELECT g.source FROM grants g JOIN users u ON u.id = g.user_id WHERE u.github_login = 'erin'").get().source, 'config');
  assert.equal(repo.roleOf('alice', 'work'), undefined, 'a configuration grant removed from BRAIN_GRANTS is still revoked');
});

test('startup sync fails loudly on an unknown brain or a grant for an admin, and changes nothing', t => {
  const db = scratchDb(t);
  const brains = withBrains(db, ['default']);
  const repo = new SqliteGrantRepository(db);
  bootstrapAccess(repo, { admins: ['FullFran'], grants: [], brains });
  assert.throws(() => bootstrapAccess(repo, { admins: ['FullFran'], grants: [{ login: 'alice', brain: 'ghost', role: 'reader' }], brains }), /BRAIN_GRANTS names an unknown brain: "ghost"/);
  assert.throws(() => bootstrapAccess(repo, { admins: ['FullFran'], grants: [{ login: 'fullfran', brain: 'default', role: 'reader' }], brains }), /fullfran.*admin/);
  assert.equal(repo.roleOf('FullFran', 'default'), 'owner', 'the failed sync rolled back');
});

test('a suspended user has no role and may not sign in', t => {
  const db = scratchDb(t);
  const brains = withBrains(db, ['default']);
  const repo = new SqliteGrantRepository(db);
  bootstrapAccess(repo, { admins: [], grants: [{ login: 'alice', brain: 'default', role: 'writer' }], brains });
  db.prepare("UPDATE users SET status = 'suspended' WHERE github_login = 'alice'").run();
  assert.equal(repo.roleOf('alice', 'default'), undefined);
  assert.equal(repo.hasAccess('alice'), false);
});

test('revocation takes effect on the next check: no cached authorization', t => {
  const db = scratchDb(t);
  const brains = withBrains(db, ['default']);
  const repo = new SqliteGrantRepository(db);
  bootstrapAccess(repo, { admins: [], grants: [{ login: 'alice', brain: 'default', role: 'writer' }], brains });
  const access = createToolAccess(repo);
  assert.equal(access.check({ login: 'alice' }, 'default', 'mem_save').allowed, true);
  db.prepare('DELETE FROM grants').run();
  assert.equal(access.check({ login: 'alice' }, 'default', 'mem_save').allowed, false);
  assert.equal(access.check(undefined, 'default', 'mem_search').allowed, false, 'no caller, no access');
  assert.equal(access.check({ login: 'alice' }, null, 'mem_search').allowed, false, 'no brain, no access');
});

test('every reason the access check gives is one the audit log keeps', t => {
  const db = scratchDb(t);
  const brains = withBrains(db, ['default']);
  const repo = new SqliteGrantRepository(db);
  bootstrapAccess(repo, { admins: [], grants: [{ login: 'alice', brain: 'default', role: 'reader' }], brains });
  const access = createToolAccess(repo);
  const reasons = [
    access.check(undefined, 'default', 'mem_search'),
    access.check({ login: 'bob' }, 'default', 'mem_search'),
    access.check({ login: 'alice' }, 'default', 'mem_brand_new'),
    access.check({ login: 'alice' }, 'default', 'mem_save')
  ].map(verdict => verdict.reason);
  assert.deepEqual(reasons, ['no_caller', 'no_grant', 'unknown_tool', 'insufficient_role']);
  // `connection_kind` comes from the connection tool check (#27, src/connections), not from this access check.
  assert.deepEqual([...DENY_REASONS].sort(), [...reasons, 'connection_kind'].sort());
});

const RESOURCE = 'https://memory.example.com/mcp';

test('resources map to brains: /mcp is the default brain, /mcp/<slug> that brain', () => {
  assert.equal(brainOfResource(RESOURCE, RESOURCE), 'default');
  assert.equal(brainOfResource(`${RESOURCE}/default`, RESOURCE), 'default');
  assert.equal(brainOfResource(`${RESOURCE}/work`, RESOURCE), 'work');
  assert.equal(brainOfResource(`${RESOURCE}/work/x`, RESOURCE), undefined);
  assert.equal(brainOfResource('https://other.example.com/mcp', RESOURCE), undefined);
});

test('access policy: sign-in needs an active user, a token needs a grant on its brain', t => {
  const db = scratchDb(t);
  const brains = withBrains(db, ['default', 'work']);
  const repo = new SqliteGrantRepository(db);
  bootstrapAccess(repo, { admins: ['FullFran'], grants: [{ login: 'alice', brain: 'work', role: 'reader' }], brains });
  const resources = [RESOURCE, `${RESOURCE}/default`, `${RESOURCE}/work`];
  const policy = new GrantAccessPolicy(repo, resources);
  assert.equal(policy.maySignIn('FullFran'), true);
  assert.equal(policy.maySignIn('alice'), true, 'a user with grants signs in without being an admin');
  assert.equal(policy.maySignIn('mallory'), false);
  db.prepare("INSERT INTO users (github_login) VALUES ('dave')").run();
  assert.equal(policy.maySignIn('dave'), false, 'a users row without any grant does not sign in');
  assert.equal(policy.mayUse('alice', `${RESOURCE}/work`), true);
  assert.equal(policy.mayUse('alice', `${RESOURCE}/default`), false, 'no token for a brain without a grant');
  // The bare /mcp resource makes a connection (#27) over the brains alice holds; each call is checked per brain.
  assert.equal(policy.mayUse('alice', RESOURCE), true, 'the bare resource needs any grant');
  assert.equal(policy.mayUse('dave', RESOURCE), false, 'and no grant at all means no token');
  assert.equal(policy.mayUse('FullFran', RESOURCE), true);
  assert.equal(policy.mayUse('FullFran', 'https://memory.example.com/elsewhere'), false);
  assert.deepEqual(policy.describeResource(`${RESOURCE}/work`), { name: 'Engram memory' });
  assert.equal(policy.describeResource('https://memory.example.com/elsewhere'), undefined);
});
