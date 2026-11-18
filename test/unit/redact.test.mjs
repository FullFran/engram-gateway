// Secret redaction (#9). Fake secrets are assembled at runtime so no
// secret-shaped literal lives in the repository (push protection, scanners).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redactSecrets, redactValue, createRedactStage, REDACTED_TOOLS } from '../../dist/pipeline/index.js';

const chars = (n, alphabet = 'aB3dE5gH7jK9mN1pQ2') => Array.from({ length: n }, (_, i) => alphabet[i % alphabet.length]).join('');
const upper = n => chars(n, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567');

const SECRETS = [
  { kind: 'anthropic', value: 'sk-' + 'ant-api03-' + chars(40) },
  { kind: 'openai', value: 'sk-' + 'proj-' + chars(48) },
  { kind: 'openai', value: 'sk-' + chars(48) },
  { kind: 'github', value: 'gh' + 'p_' + chars(36) },
  { kind: 'github', value: 'gh' + 's_' + chars(36) },
  { kind: 'github', value: 'github' + '_pat_' + chars(22) + '_' + chars(59) },
  { kind: 'aws', value: 'AK' + 'IA' + upper(16) },
  { kind: 'stripe', value: 'sk' + '_live_' + chars(24) },
  { kind: 'stripe', value: 'rk' + '_test_' + chars(24) },
  { kind: 'jwt', value: 'ey' + 'J' + chars(20) + '.ey' + 'J' + chars(30) + '.' + chars(43) },
  {
    kind: 'private-key',
    value: '-----BEGIN ' + 'RSA PRIVATE KEY-----\n' + chars(64) + '\n' + chars(64) + '\n-----END ' + 'RSA PRIVATE KEY-----'
  },
  { kind: 'private-key', value: '-----BEGIN ' + 'PRIVATE KEY-----\n' + chars(64) + '\n-----END ' + 'PRIVATE KEY-----' }
];

for (const { kind, value } of SECRETS) {
  test(`redacts ${kind} secret ${value.slice(0, 12)}...`, () => {
    const { text, counts } = redactSecrets(`before ${value} after`);
    assert.equal(text, `before [secret removed:${kind}] after`);
    assert.deepEqual(counts, { [kind]: 1 });
    assert.ok(!text.includes(value));
  });
}

test('redacts the password in a URL and keeps scheme, user and host readable', () => {
  const { text, counts } = redactSecrets('db at postgres://app:' + 'hunter2' + '@db.internal:5432/x');
  assert.equal(text, 'db at postgres://app:[secret removed:url-password]@db.internal:5432/x');
  assert.deepEqual(counts, { 'url-password': 1 });
});

const SURVIVORS = [
  ['git SHA', 'commit 16ec70d4b1e8f0c2a9d7e6b5c4a3f2e1d0c9b8a7 fixed it'],
  ['short git SHA', 'see 16ec70d'],
  ['UUID', 'id 123e4567-e89b-12d3-a456-426614174000'],
  ['kebab slug starting with sk-', 'the sk-learn-pipeline-for-classification-stuff note'],
  ['word ending in sk', 'task-management-and-planning-for-everyone'],
  ['URL without password', 'https://user@example.com/path and https://example.com:8080/a'],
  ['public certificate', '-----BEGIN ' + 'CERTIFICATE-----\nabc\n-----END ' + 'CERTIFICATE-----'],
  ['plain prose', 'We decided to use SQLite for gateway state.']
];

for (const [label, input] of SURVIVORS) {
  test(`leaves ${label} untouched`, () => {
    const { text, counts } = redactSecrets(input);
    assert.equal(text, input);
    assert.deepEqual(counts, {});
  });
}

test('counts several secrets of several kinds', () => {
  const gh = 'gh' + 'p_' + chars(36);
  const { text, counts } = redactSecrets(`${gh} and ${gh} and ${'AK' + 'IA' + upper(16)}`);
  assert.equal(text, '[secret removed:github] and [secret removed:github] and [secret removed:aws]');
  assert.deepEqual(counts, { github: 2, aws: 1 });
});

test('redactValue walks objects and arrays, touching only strings', () => {
  const gh = 'gh' + 'p_' + chars(36);
  const input = { title: 't', content: `token ${gh}`, n: 3, ok: true, none: null, tags: ['a', gh], nested: { deep: [{ s: gh }] } };
  const { value, counts } = redactValue(input);
  assert.deepEqual(value, {
    title: 't',
    content: 'token [secret removed:github]',
    n: 3,
    ok: true,
    none: null,
    tags: ['a', '[secret removed:github]'],
    nested: { deep: [{ s: '[secret removed:github]' }] }
  });
  assert.deepEqual(counts, { github: 3 });
  assert.equal(input.content, `token ${gh}`, 'input is not mutated');
});

test('the redact stage covers the write tools from #9 only', () => {
  assert.deepEqual([...REDACTED_TOOLS].sort(), ['mem_capture_passive', 'mem_save', 'mem_save_prompt', 'mem_session_summary', 'mem_update']);
});

test('the redact stage rewrites write-tool arguments and records counts in meta, not the secret', async () => {
  const gh = 'gh' + 'p_' + chars(36);
  const stage = createRedactStage();
  const ctx = await stage({ request: { name: 'mem_save', arguments: { content: gh } }, meta: {} });
  assert.deepEqual(ctx.request.arguments, { content: '[secret removed:github]' });
  assert.deepEqual(ctx.meta.redactions, { github: 1 });
  assert.ok(!JSON.stringify(ctx).includes(gh));
});

test('the redact stage leaves read tools and disabled stages untouched', async () => {
  const gh = 'gh' + 'p_' + chars(36);
  const read = await createRedactStage()({ request: { name: 'mem_search', arguments: { query: gh } }, meta: {} });
  assert.deepEqual(read.request.arguments, { query: gh });
  assert.equal(read.meta.redactions, undefined);
  const off = await createRedactStage({ enabled: false })({ request: { name: 'mem_save', arguments: { content: gh } }, meta: {} });
  assert.deepEqual(off.request.arguments, { content: gh });
});
