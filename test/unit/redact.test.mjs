// Secret redaction (#9). Fake secrets are assembled at runtime so no
// secret-shaped literal lives in the repository (push protection, scanners).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redactSecrets, redactValue, createRedactStage, REDACTION_EXEMPT_TOOLS } from '../../dist/pipeline/index.js';

const chars = (n, alphabet = 'aB3dE5gH7jK9mN1pQ2') => Array.from({ length: n }, (_, i) => alphabet[i % alphabet.length]).join('');
const letters = n => chars(n, 'aBcDeFgHiJkLmNoPqRsT');
const upper = n => chars(n, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567');
const gh = () => 'gh' + 'p_' + chars(36);

const SECRETS = [
  { kind: 'anthropic', value: 'sk-' + 'ant-api03-' + chars(40) },
  { kind: 'openai', value: 'sk-' + 'proj-' + chars(48) },
  { kind: 'openai', value: 'sk-' + 'proj-' + letters(40) + '_' + letters(20) },
  { kind: 'openai', value: 'sk-' + chars(48) },
  { kind: 'github', value: gh() },
  { kind: 'github', value: 'gh' + 's_' + chars(36) },
  { kind: 'github', value: 'github' + '_pat_' + chars(22) + '_' + chars(59) },
  { kind: 'aws', value: 'AK' + 'IA' + upper(16) },
  { kind: 'aws-secret', value: chars(36, 'wJalrXUtnFEMIK7MDENGbPxRfiCY') + '/K7M' },
  { kind: 'stripe', value: 'sk' + '_live_' + chars(24) },
  { kind: 'stripe', value: 'rk' + '_test_' + chars(24) },
  { kind: 'slack', value: 'xo' + 'xb-' + '1234567890-' + chars(24) },
  { kind: 'slack', value: 'xo' + 'xp-' + chars(30) },
  { kind: 'google', value: 'AI' + 'za' + chars(35) },
  { kind: 'npm', value: 'np' + 'm_' + chars(36) },
  { kind: 'engram-gateway', value: 'egw' + '_pat_' + chars(43) },
  { kind: 'jwt', value: 'ey' + 'J' + chars(20) + '.ey' + 'J' + chars(30) + '.' + chars(43) },
  { kind: 'jwt', value: 'ey' + 'Jhb' + '.ey' + 'Jzd' + '.' + 'c2ln' },
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

test('a PEM private key without an END line is redacted to the end of the string', () => {
  const { text, counts } = redactSecrets('key:\n-----BEGIN ' + 'OPENSSH PRIVATE KEY-----\n' + chars(64) + '\n' + chars(30));
  assert.equal(text, 'key:\n[secret removed:private-key]');
  assert.deepEqual(counts, { 'private-key': 1 });
});

const URLS = [
  ['password in a URL', 'postgres://app:' + 'hunter2' + '@db.internal:5432/x', 'postgres://app:[secret removed:url-password]@db.internal:5432/x'],
  ['URL with an empty user', 'redis://:' + 'pw' + 'Secret1@cache:6379', 'redis://:[secret removed:url-password]@cache:6379'],
  ['password containing @', 'postgres://user:p' + '@ss@host/db', 'postgres://user:[secret removed:url-password]@host/db']
];

for (const [label, input, expected] of URLS) {
  test(`redacts the ${label} and keeps scheme, user and host readable`, () => {
    const { text, counts } = redactSecrets(`db at ${input} ok`);
    assert.equal(text, `db at ${expected} ok`);
    assert.deepEqual(counts, { 'url-password': 1 });
  });
}

const ASSIGNMENTS = [
  ['.env line', 'DATABASE_PASSWORD=' + 'hunter2', 'DATABASE_PASSWORD=[secret removed:credential]'],
  ['AWS secret in .env', 'AWS_SECRET_ACCESS_KEY=' + 'abc/def+ghi', 'AWS_SECRET_ACCESS_KEY=[secret removed:credential]'],
  ['bare TOKEN', 'TOKEN: ' + 'abc123', 'TOKEN: [secret removed:credential]'],
  ['password=', 'password=' + 'hunter2', 'password=[secret removed:credential]'],
  ['api_key:', 'api_key: "' + 'k3y value' + '"', 'api_key: [secret removed:credential]'],
  ['client_secret', 'client_secret = ' + 'abc', 'client_secret = [secret removed:credential]'],
  ['Authorization header', 'Authorization: Bearer ' + 'opaque.Token-value_42', 'Authorization: Bearer [secret removed:bearer]'],
  ['bare bearer token', 'curl -H "Bearer ' + 'a1b2c3d4e5f6g7h8i9"', 'curl -H "Bearer [secret removed:bearer]"']
];

for (const [label, input, expected] of ASSIGNMENTS) {
  test(`redacts the value of a ${label}`, () => {
    const { text } = redactSecrets(input);
    assert.equal(text, expected);
  });
}

test('an assignment whose value is a known secret is counted once, by its specific kind', () => {
  const { text, counts } = redactSecrets(`GITHUB_TOKEN=${gh()}`);
  assert.equal(text, 'GITHUB_TOKEN=[secret removed:github]');
  assert.deepEqual(counts, { github: 1 });
});

test('zero-width characters inside a secret do not hide it', () => {
  const token = gh();
  const hidden = token.slice(0, 2) + '\u200B' + token.slice(2, 10) + '\u2060\u200D' + token.slice(10);
  const { text, counts } = redactSecrets(`t ${hidden} t`);
  assert.equal(text, 't [secret removed:github] t');
  assert.deepEqual(counts, { github: 1 });
});

test('zero-width joiners inside emoji survive', () => {
  const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
  assert.equal(redactSecrets(`team ${family}`).text, `team ${family}`);
});

const SURVIVORS = [
  ['git SHA', 'commit 16ec70d4b1e8f0c2a9d7e6b5c4a3f2e1d0c9b8a7 fixed it'],
  ['short git SHA', 'see 16ec70d'],
  ['UUID', 'id 123e4567-e89b-12d3-a456-426614174000'],
  ['kebab slug starting with sk-', 'the sk-learn-pipeline-for-classification-stuff note'],
  ['word ending in sk', 'task-management-and-planning-for-everyone'],
  ['URL without password', 'https://user@example.com/path and https://example.com:8080/a'],
  ['public certificate', '-----BEGIN ' + 'CERTIFICATE-----\nabc\n-----END ' + 'CERTIFICATE-----'],
  ['topic key', 'topic_key: engram-gateway/9'],
  ['prose about keys', 'The primary key: id. The token: see the docs.'],
  ['prose about bearer auth', 'Bearer authentication is described in RFC 6750.'],
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
  const token = gh();
  const { text, counts } = redactSecrets(`${token} and ${token} and ${'AK' + 'IA' + upper(16)}`);
  assert.equal(text, '[secret removed:github] and [secret removed:github] and [secret removed:aws]');
  assert.deepEqual(counts, { github: 2, aws: 1 });
});

const ADVERSARIAL = [
  ['long run before ://', 'a'.repeat(200000) + '://'],
  ['sk- then a long run', 'sk-' + 'a'.repeat(200000)],
  ['repeated sk-', 'sk-'.repeat(66667)],
  ['repeated eyJ.', 'eyJa.'.repeat(40000)],
  ['long base64 run', 'aB3+'.repeat(50000)],
  ['repeated BEGIN', '-----BEGIN '.repeat(18000)],
  ['repeated KEY=', 'KEY_'.repeat(50000) + '='],
  ['repeated user:', 'x://u:'.repeat(33000)],
  ['zero-width run', '\u200B'.repeat(200000) + 'a'],
  ['repeated Bearer', 'Bearer '.repeat(28000)]
];

for (const [label, input] of ADVERSARIAL) {
  test(`redacting a 200k-char adversarial string (${label}) stays under 200 ms`, () => {
    const started = performance.now();
    redactSecrets(input);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 200, `took ${Math.round(elapsed)} ms`);
  });
}

test('redactValue walks objects and arrays, redacting string values and keys', () => {
  const token = gh();
  const input = { title: 't', content: `token ${token}`, n: 3, ok: true, none: null, tags: ['a', token], nested: { deep: [{ s: token }] }, [token]: 1 };
  const { value, counts } = redactValue(input);
  assert.deepEqual(value, {
    title: 't',
    content: 'token [secret removed:github]',
    n: 3,
    ok: true,
    none: null,
    tags: ['a', '[secret removed:github]'],
    nested: { deep: [{ s: '[secret removed:github]' }] },
    '[secret removed:github]': 1
  });
  assert.deepEqual(counts, { github: 4 });
  assert.equal(input.content, `token ${token}`, 'input is not mutated');
});

test('only read-only tools whose arguments are never stored are exempt from redaction', () => {
  assert.deepEqual([...REDACTION_EXEMPT_TOOLS].sort(), [
    'mem_context',
    'mem_current_project',
    'mem_doctor',
    'mem_get_observation',
    'mem_list_projects',
    'mem_search',
    'mem_search_prompts',
    'mem_stats',
    'mem_suggest_topic_key',
    'mem_timeline'
  ]);
});

test('the redact stage rewrites arguments of any non-exempt tool and records counts in meta, not the secret', async () => {
  const token = gh();
  const stage = createRedactStage();
  for (const [name, args, expected] of [
    ['mem_save', { content: token }, { content: '[secret removed:github]' }],
    ['mem_session_end', { summary: token }, { summary: '[secret removed:github]' }],
    ['mem_judge', { evidence: token, reason: 'r' }, { evidence: '[secret removed:github]', reason: 'r' }],
    ['mem_judge_many', { judgments: [{ evidence: token }] }, { judgments: [{ evidence: '[secret removed:github]' }] }],
    ['some_future_tool', { note: token }, { note: '[secret removed:github]' }]
  ]) {
    const ctx = await stage({ request: { name, arguments: args }, meta: {} });
    assert.deepEqual(ctx.request.arguments, expected, name);
    assert.deepEqual(ctx.meta.redactions, { github: 1 }, name);
    assert.ok(!JSON.stringify(ctx).includes(token), name);
  }
});

test('the redact stage leaves exempt read tools and disabled stages untouched', async () => {
  const token = gh();
  const read = await createRedactStage()({ request: { name: 'mem_search', arguments: { query: token } }, meta: {} });
  assert.deepEqual(read.request.arguments, { query: token });
  assert.equal(read.meta.redactions, undefined);
  const off = await createRedactStage({ enabled: false })({ request: { name: 'mem_save', arguments: { content: token } }, meta: {} });
  assert.deepEqual(off.request.arguments, { content: token });
});
