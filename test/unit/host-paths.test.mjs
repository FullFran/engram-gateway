// Host path arguments (#6 follow-up): `cwd` and `directory` name a path on the
// machine that runs `engram`, which for a remote client is the gateway host.
// Engram would probe it (project detection reads the directory and its git
// remote), so the gateway strips both from every tool call before forwarding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAuditStage, createToolCallPipeline, passResult, runToolCall, HOST_PATH_ARGUMENTS } from '../../dist/pipeline/index.js';

function capture() {
  const forwarded = [];
  const audited = [];
  const pipeline = createToolCallPipeline({ wrap: passResult, audit: createAuditStage({ record: call => audited.push(call) }) });
  const forward = async request => { forwarded.push(request); return { content: [] }; };
  return { pipeline, forward, forwarded, audited };
}

test('the stripped arguments are exactly cwd and directory', () => {
  assert.deepEqual([...HOST_PATH_ARGUMENTS].sort(), ['cwd', 'directory']);
});

test('mem_current_project is forwarded without cwd or directory, and the audit counts them', async () => {
  const { pipeline, forward, forwarded, audited } = capture();
  await runToolCall(pipeline, { name: 'mem_current_project', arguments: { cwd: '/etc', directory: '/root/.ssh' } }, forward);
  assert.deepEqual(forwarded, [{ name: 'mem_current_project', arguments: {} }]);
  assert.equal(audited[0].meta.hostPathArguments, 2);
});

test('every tool loses cwd and directory and keeps its other arguments', async () => {
  const { pipeline, forward, forwarded } = capture();
  await runToolCall(pipeline, { name: 'mem_save_prompt', arguments: { content: 'hello', cwd: '/srv', directory: '/srv/app', session_id: 's1' } }, forward);
  await runToolCall(pipeline, { name: 'mem_session_start', arguments: { id: 's1', directory: '/home/someone' } }, forward);
  assert.deepEqual(forwarded.map(request => request.arguments), [{ content: 'hello', session_id: 's1' }, { id: 's1' }]);
});

test('pinned: calls without host path arguments are forwarded unchanged and record no count', async () => {
  const { pipeline, forward, forwarded, audited } = capture();
  await runToolCall(pipeline, { name: 'mem_search', arguments: { query: 'directory layout', project: 'p' } }, forward);
  await runToolCall(pipeline, { name: 'mem_current_project' }, forward);
  assert.deepEqual(forwarded, [{ name: 'mem_search', arguments: { query: 'directory layout', project: 'p' } }, { name: 'mem_current_project' }]);
  assert.equal(audited[0].meta.hostPathArguments, undefined);
});
