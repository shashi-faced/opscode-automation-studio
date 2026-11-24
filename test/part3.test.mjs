import test from 'node:test';
import assert from 'node:assert/strict';
import { negativeCases, acceptancePoint, judgeCase } from '../src/data/negative.mjs';
import { parseCsv, mapColumns, flowPaths, issueBody } from '../src/moreTools.mjs';
import { checkStepRequests } from '../src/runner/executor.mjs';
import { extractFrom } from '../src/data/vars.mjs';
import { resolveValue, defaultLabel, ensureFlowGraph } from '../src/flow/graph.mjs';
import { planRunData, stepForRun } from '../src/data/runData.mjs';
import { suggestRule, normalizeRule, describeRule } from '../src/data/generate.mjs';
import { compileFlowToSpec } from '../src/runner/compiler.mjs';
import { requestPattern } from '../src/recorder/recorder.mjs';

const fill = (id, value, kind, extra = {}) => ({ id, action: 'fill', value, fieldName: extra.label || id, data: { mode: 'generate', kind }, page: { url: 'http://a/form' }, selectorSet: { domContext: { maxLength: extra.maxLength, required: extra.required } } });

test('negative cases per kind', () => {
  const email = negativeCases(fill('n1', 'a@b.io', 'email'));
  assert.deepEqual(email.map((c) => c.id), ['email-no-at', 'email-no-domain', 'empty', 'spaces', 'too-long', 'script']);
  assert.equal(email.find((c) => c.id === 'empty').strict, false);
  const name = negativeCases(fill('n2', 'Asha', 'fullName', { required: true, maxLength: 20 }));
  assert.deepEqual(name.map((c) => c.id), ['empty', 'spaces', 'too-long', 'script']);
  assert.equal(name[0].strict, true);
  assert.equal(name[2].value.length, 21);
  assert.equal(name[3].expect, 'no-script');
  assert.deepEqual(negativeCases({ ...fill('n3', 'x', 'email'), data: { mode: 'fixed' } }), []);
});

test('where a form is accepted', () => {
  const flow = ensureFlowGraph({ steps: [
    { id: 'n1', action: 'goto', url: 'http://a/form' },
    fill('n2', 'a@b.io', 'email'),
    { id: 'n3', action: 'click', page: { url: 'http://a/form' }, result: { url: 'http://a/done', observed: true } },
  ] });
  assert.deepEqual(acceptancePoint(flow, 'n2'), { nodeId: 'n3', how: 'page' });
  const spa = ensureFlowGraph({ steps: [fill('n1', 'x', 'text'), { id: 'n2', action: 'click', requests: [{ method: 'POST', pattern: '/api/x', status: 201 }] }] });
  assert.deepEqual(acceptancePoint(spa, 'n1'), { nodeId: 'n2', how: 'request' });
  const none = ensureFlowGraph({ steps: [fill('n1', 'x', 'text'), { id: 'n2', action: 'click' }] });
  assert.equal(acceptancePoint(none, 'n1'), null);
  const c = { expect: 'reject', strict: true };
  assert.equal(judgeCase(c, { results: [{ status: 'passed' }] }, 'n1', { nodeId: 'n2' }).verdict, 'accepted');
  assert.equal(judgeCase(c, { results: [{ nodeId: 'n2', status: 'failed', error: 'x', pageMessages: ['Bad email'] }] }, 'n1', { nodeId: 'n2' }).message, 'Bad email');
  assert.equal(judgeCase(c, { results: [{ nodeId: 'n1', status: 'failed', error: 'no' }] }, 'n1', { nodeId: 'n2' }).verdict, 'blocked');
  assert.equal(judgeCase({ expect: 'no-script' }, { results: [], unexpectedDialogs: [{ message: '1' }] }, 'n1', { nodeId: 'n2' }).verdict, 'script-ran');
});

test('CSV data sets', () => {
  const { headers, records } = parseCsv('Full name,Email,expect\r\n"Rao, Asha",a@b.io,pass\n"He said ""hi""",c@d.io,fail\n\n');
  assert.deepEqual(headers, ['Full name', 'Email', 'expect']);
  assert.equal(records[0]['Full name'], 'Rao, Asha');
  assert.equal(records[1]['Full name'], 'He said "hi"');
  const flow = { steps: [fill('n2', 'x', 'fullName', { label: 'Full name' }), fill('n3', 'y', 'email', { label: 'Email' })] };
  assert.deepEqual(mapColumns(flow, ['Full name', 'n3', 'Phone', 'expect', 'var:x']), { map: { 'Full name': 'n2', n3: 'n3' }, unknown: ['Phone'], varCols: ['var:x'] });
});

test('variables', () => {
  assert.equal(extractFrom('Saved note #123: x', '#(\\d+)'), '123');
  assert.equal(extractFrom('  a   b ', null), 'a b');
  assert.throws(() => extractFrom('nothing', 'id (\\d+)'), /not found/);
  assert.equal(resolveValue('/api/{{var:id}}/{{input:x}}', { vars: { id: '7' }, inputs: { x: 'y' } }), '/api/7/y');
  assert.deepEqual(suggestRule({ action: 'fill', value: '{{var:customer.email}}' }), { mode: 'var', name: 'customer.email', why: 'value from another step or flow', source: 'auto' });
  assert.equal(describeRule(normalizeRule('var:a.b')), 'from variable a.b');
  const flow = { id: 'f', steps: [{ id: 'n1', action: 'fill', value: 'x', data: { mode: 'var', name: 'a.b' } }] };
  const plan = planRunData(flow, { seed: 1 });
  assert.equal(stepForRun(flow.steps[0], plan).value, '{{var:a.b}}');
  const ov = planRunData(flow, { seed: 1, overrides: { n1: 'bad' }, overrideSource: 'negative' });
  assert.deepEqual(ov.values.n1, { value: 'bad', source: 'negative' });
});

test('server checks match the recorded request', async () => {
  assert.equal(requestPattern('http://h/api/orders/42/items/9f8e7d6c5b4a3f2e1d0c'), '/api/orders/:id/items/:id');
  const step = { requests: [{ method: 'POST', pattern: '/api/notes', status: 201 }] };
  const ok = await checkStepRequests(step, [{ timestamp: 10, method: 'POST', url: 'http://h/api/notes', status: 201 }], 5);
  assert.deepEqual(ok, [{ method: 'POST', pattern: '/api/notes', status: 201 }]);
  await assert.rejects(checkStepRequests(step, [{ timestamp: 10, method: 'POST', url: 'http://h/api/notes', status: 500 }], 5), /POST \/api\/notes -> 500/);
  await assert.rejects(checkStepRequests(step, [], 5, { timeoutMs: 100 }), /no such request was made/);
  assert.deepEqual(await checkStepRequests({ requests: [{ method: 'POST', pattern: '/x', status: 500 }] }, [], 0), []);
});

test('labels, paths and spec for new actions', () => {
  assert.equal(defaultLabel({ action: 'upload', files: ['a.pdf'] }), 'Upload a.pdf');
  assert.equal(defaultLabel({ action: 'extract', name: 'id' }), 'Read "id"');
  assert.equal(defaultLabel({ action: 'dialog', accept: false, dialogType: 'confirm' }), 'Dismiss confirm');
  const flow = ensureFlowGraph({ steps: [{ id: 'n1', action: 'click' }, { id: 'n2', action: 'decision', label: 'OK?' }, { id: 'n3', action: 'click' }, { id: 'n4', action: 'click' }],
    edges: [{ source: 'n1', target: 'n2', kind: 'next' }, { source: 'n2', target: 'n3', kind: 'yes' }, { source: 'n2', target: 'n4', kind: 'no' }] });
  assert.deepEqual(flowPaths(flow).map((p) => [p.nodes.join(','), p.labels.join()]), [['n1,n2,n3', 'OK?: yes'], ['n1,n2,n4', 'OK?: no']]);
  const spec = compileFlowToSpec({ name: 'x', steps: [
    { id: 'n1', action: 'upload', files: ['automation/files/a.pdf'], selectorSet: { cssSelector: '#f' } },
    { id: 'n2', action: 'drag', selectorSet: { cssSelector: '#a' }, to: { cssSelector: '#b' } },
    { id: 'n3', action: 'hover', selectorSet: { cssSelector: '#m' } },
  ] }, { testTitle: 'T' });
  assert.match(spec, /setInputFiles\(\["files\/a\.pdf"\]\)/);
  assert.match(spec, /locator\("#a"\)\.dragTo\(page\.locator\("#b"\)\)/);
  assert.match(spec, /\.hover\(\)/);
  assert.match(spec, /test\("T"/);
});

test('GitHub issue body', () => {
  const body = issueBody({ id: 'ISS-0001', category: 'server-error', severity: 'high', flow: { name: 'F', feature: 'Feat' }, node: { id: 'n3', label: 'Save', action: 'click' }, error: 'boom\nstack', hint: 'h', pageMessages: ['Oops'], failedRequests: [{ method: 'POST', url: '/x', status: 500 }], dataUsed: [{ field: 'Email', value: 'a@b', source: 'generated' }, { field: 'Pw', value: '••', source: 'secret' }], occurrences: 2, firstSeen: 'a', lastSeen: 'b', reproduce: 'automation_flow_run {}' });
  assert.match(body, /Feat › F › step n3 "Save"/);
  assert.match(body, /`POST \/x → 500`/);
  assert.match(body, /- Email: `a@b`/);
  assert.doesNotMatch(body, /Pw/);
  assert.match(body, /automation_flow_run \{\}/);
});
