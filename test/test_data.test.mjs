import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeRandom, generateValue, suggestRule, applyDataRules, normalizeRule, describeRule } from '../src/data/generate.mjs';
import { planRunData, stepForRun, rememberValues, readHistory, readRunValues } from '../src/data/runData.mjs';
import { recordRunIssues, loadIssues, updateIssue, listIssues, errorShape, categorize } from '../src/issues/tracker.mjs';
import { compileFlowToSpec } from '../src/runner/compiler.mjs';
import { runTool } from '../src/tools.mjs';

const fill = (id, value, ctx = {}, extra = {}) => ({
  id, action: 'fill', value, fieldName: ctx.label, page: { url: ctx.url || 'http://app.test/customers/new' },
  selectorSet: { cssSelector: `#${id}`, domContext: { label: ctx.label, inputType: ctx.type, name: ctx.name, maxLength: ctx.maxLength } }, ...extra,
});

test('test data generator', async (t) => {
  await t.test('the same seed gives the same values; different seeds differ', () => {
    const rule = { mode: 'generate', kind: 'email' };
    const a = generateValue(rule, makeRandom(42), { sample: 'x@acme.io' });
    const b = generateValue(rule, makeRandom(42), { sample: 'x@acme.io' });
    const c = generateValue(rule, makeRandom(43), { sample: 'x@acme.io' });
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.match(a, /^[a-z]+\.[a-z]+\.[0-9a-z]{4}@acme\.io$/);
  });

  await t.test('values keep the recorded format', () => {
    const rng = makeRandom(7);
    assert.match(generateValue({ mode: 'generate', kind: 'phone' }, rng, { sample: '+91 98765-43210' }), /^\+91 [6-9]\d{4}-\d{5}$/);
    assert.match(generateValue({ mode: 'generate', kind: 'phone' }, rng, { sample: '9876543210' }), /^[6-9]\d{9}$/);
    assert.match(generateValue({ mode: 'generate', kind: 'zip' }, rng, { sample: '110001' }), /^[1-9]\d{5}$/);
    assert.match(generateValue({ mode: 'generate', kind: 'date' }, rng, { sample: '2025-01-31' }), /^\d{4}-\d{2}-\d{2}$/);
    assert.match(generateValue({ mode: 'generate', kind: 'date' }, rng, { sample: '31/01/2025' }), /^\d{2}\/\d{2}\/\d{4}$/);
    const n = Number(generateValue({ mode: 'generate', kind: 'number', min: 2, max: 4 }, rng, { sample: '3' }));
    assert.ok(n >= 2 && n <= 4);
    assert.match(generateValue({ mode: 'generate', kind: 'pattern', pattern: 'ORD-{n:5}' }, rng, {}), /^ORD-[1-9]\d{4}$/);
    assert.match(generateValue({ mode: 'generate', kind: 'text' }, rng, { sample: 'Blue widget', runTag: 'ab12' }), /^Blue widget ab12$/);
    assert.equal(generateValue({ mode: 'generate', kind: 'text' }, rng, { sample: 'Blue widget', runTag: 'ab12', maxLength: 8 }).length <= 8, true);
    const bday = generateValue({ mode: 'generate', kind: 'date', range: 'birth' }, rng, { sample: '1990-05-01' });
    assert.ok(Number(bday.slice(0, 4)) <= new Date().getFullYear() - 19);
    assert.ok(['a', 'b'].includes(generateValue({ mode: 'list', values: ['a', 'b'] }, rng, {})));
  });

  await t.test('rules are suggested from the field: sign-in and search stay fixed, the rest is generated', () => {
    const flow = {
      steps: [
        fill('n1', 'demo@x.test', { label: 'Email', type: 'email', url: 'http://app.test/login' }),
        fill('n2', '{{secret:f.password}}', { label: 'Password', type: 'password', url: 'http://app.test/login' }, { sensitive: true }),
        fill('n3', 'Asha Rao', { label: 'Full name' }),
        fill('n4', 'asha@acme.io', { label: 'Email', type: 'email' }),
        fill('n5', '9876543210', { label: 'Mobile', type: 'tel' }),
        fill('n6', 'widgets', { label: 'Search orders', url: 'http://app.test/orders' }),
        fill('n7', '3', { label: 'Quantity', type: 'number' }),
        { id: 'n8', action: 'select', value: 'pro', selectorSet: {} },
        fill('n9', 'Acme Pvt Ltd', { label: 'Company' }),
      ],
    };
    applyDataRules(flow);
    const r = Object.fromEntries(flow.steps.map((s) => [s.id, s.data]));
    assert.equal(r.n1.mode, 'fixed');
    assert.match(r.n1.why, /sign-in/);
    assert.equal(r.n2.mode, 'secret');
    assert.deepEqual([r.n3.mode, r.n3.kind], ['generate', 'fullName']);
    assert.deepEqual([r.n4.mode, r.n4.kind], ['generate', 'email']);
    assert.deepEqual([r.n5.mode, r.n5.kind], ['generate', 'phone']);
    assert.equal(r.n6.mode, 'fixed');
    assert.deepEqual([r.n7.mode, r.n7.kind], ['generate', 'number']);
    assert.equal(r.n8.mode, 'fixed');
    assert.deepEqual([r.n9.mode, r.n9.kind], ['generate', 'company']);
  });

  await t.test('a sign-up form with a password is not a sign-in form', () => {
    const flow = { steps: [
      fill('n1', 'a@b.io', { label: 'Email', type: 'email', url: 'http://app.test/signup' }),
      fill('n2', 'x', { label: 'Password', type: 'password', url: 'http://app.test/signup' }, { sensitive: true }),
      fill('n3', 'x', { label: 'Confirm password', type: 'password', url: 'http://app.test/signup' }, { sensitive: true }),
    ] };
    applyDataRules(flow);
    assert.equal(flow.steps[0].data.mode, 'generate');
  });

  await t.test('rules given by the agent are normalised', () => {
    assert.deepEqual(normalizeRule('fixed'), { mode: 'fixed', source: 'ai' });
    assert.deepEqual(normalizeRule('email'), { mode: 'generate', kind: 'email', source: 'ai' });
    assert.deepEqual(normalizeRule('INV-{n:6}'), { mode: 'generate', kind: 'pattern', pattern: 'INV-{n:6}', source: 'ai' });
    assert.equal(normalizeRule({ values: ['a', 'b'] }).mode, 'list');
    assert.throws(() => normalizeRule('banana'), /Unknown data rule/);
    assert.equal(describeRule({ mode: 'generate', kind: 'email' }), 'new email each run');
  });
});

test('run data', async (t) => {
  const flow = {
    id: 'flow-register',
    steps: [
      fill('n1', 'Asha Rao', { label: 'Full name' }, { data: { mode: 'generate', kind: 'fullName' } }),
      fill('n2', 'asha@acme.io', { label: 'Email' }, { data: { mode: 'generate', kind: 'email' } }),
      fill('n3', 'asha@acme.io', { label: 'Confirm email' }, { data: { mode: 'generate', kind: 'email' } }),
      { id: 'n4', action: 'click', selectorSet: { textSelector: 'Save' } },
      { id: 'n5', action: 'assert_text', value: 'Welcome, Asha Rao' },
      { id: 'n6', action: 'click', selectorSet: { textSelector: 'Asha Rao', ariaSelector: { role: 'link', name: 'Asha Rao' } } },
      fill('n7', 'demo', { label: 'Search' }, { data: { mode: 'fixed' } }),
    ],
  };

  await t.test('fresh: new values, a copy field gets the same value, later texts and targets follow', () => {
    const plan = planRunData(flow, { seed: 1 });
    const name = plan.values.n1.value;
    const email = plan.values.n2.value;
    assert.notEqual(name, 'Asha Rao');
    assert.notEqual(email, 'asha@acme.io');
    assert.equal(plan.values.n3.value, email);
    assert.match(plan.values.n3.source, /same as n2/);
    assert.equal(stepForRun(flow.steps[4], plan).value, `Welcome, ${name}`);
    const link = stepForRun(flow.steps[5], plan);
    assert.equal(link.selectorSet.textSelector, name);
    assert.equal(link.selectorSet.ariaSelector.name, name);
    assert.equal(stepForRun(flow.steps[6], plan).value, 'demo');
    assert.equal(flow.steps[4].value, 'Welcome, Asha Rao', 'the flow itself is not changed');
  });

  await t.test('recorded mode and replayed values', () => {
    const rec = planRunData(flow, { mode: 'recorded', seed: 1 });
    assert.equal(stepForRun(flow.steps[1], rec).value, 'asha@acme.io');
    const again = planRunData(flow, { seed: 99, replayValues: { n1: 'Old Name', n2: 'old@x.io', n3: 'old@x.io' } });
    assert.equal(again.values.n2.value, 'old@x.io');
    assert.equal(stepForRun(flow.steps[4], again).value, 'Welcome, Asha Rao'.replace('Asha Rao', 'Asha Rao'));
  });

  await t.test('values used before are not used again', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oas-data-'));
    const first = planRunData(flow, { seed: 5 });
    rememberValues(tmp, flow.id, [{ nodeId: 'n2', value: first.values.n2.value, source: 'generated' }]);
    const history = readHistory(tmp);
    assert.deepEqual(history[flow.id].n2, [first.values.n2.value]);
    const second = planRunData(flow, { seed: 5, history });
    assert.notEqual(second.values.n2.value, first.values.n2.value);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  await t.test('readRunValues reads the data of a saved run and skips secrets', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oas-data-'));
    const dir = path.join(tmp, 'automation', 'runs', 'run-1-x');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'run-summary.json'), JSON.stringify({ dataUsed: [{ nodeId: 'n2', value: 'a@b.io', source: 'generated' }, { nodeId: 'n9', value: '••••', source: 'secret' }] }));
    assert.deepEqual(readRunValues(tmp, 'run-1-x'), { n2: 'a@b.io' });
    assert.throws(() => readRunValues(tmp, 'nope'), /not found/);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  await t.test('the Playwright spec gives generated fields a fresh value', () => {
    const spec = compileFlowToSpec({ name: 'x', steps: flow.steps.slice(0, 5) });
    assert.match(spec, /fill\(DATA\["asha@acme\.io"\]\)/);
    assert.match(spec, /getByText\(T\("Welcome, Asha Rao"\)\)/);
  });
});

test('issue tracking', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oas-issues-'));
  const flow = { id: 'flow-register', name: 'Register customer', feature: 'Customers' };
  const failRun = (runId, error = 'Expected this step to lead to 127.0.0.1/customers, but the page is http://127.0.0.1:5555/customers/new', extra = {}) => ({
    runId, runDir: path.join(tmp, 'automation', 'runs', runId), flowPath: path.join(tmp, 'automation', 'features', 'f', 'flow.json'), dataMode: 'fresh',
    dataUsed: [{ nodeId: 'n2', field: 'Email', value: `x.${runId}@example.com`, source: 'generated' }],
    results: [
      { nodeId: 'n1', status: 'passed', action: 'fill' },
      { nodeId: 'n4', label: 'Click Save', action: 'click', status: 'failed', error, pageMessages: ['Email already registered'], failedRequests: [], pageUrl: 'http://127.0.0.1:5555/customers/new', ...extra },
    ],
  });
  const passRun = (runId) => ({ runId, results: [{ nodeId: 'n1', status: 'passed' }, { nodeId: 'n4', status: 'passed' }], dataUsed: [] });

  await t.test('a failure opens one issue; the same failure again adds to it', () => {
    const a = recordRunIssues(tmp, flow, failRun('run-1'));
    assert.deepEqual(a.opened, ['ISS-0001']);
    const b = recordRunIssues(tmp, flow, failRun('run-2', 'Expected this step to lead to 127.0.0.1/customers, but the page is http://127.0.0.1:6000/customers/new'));
    assert.deepEqual(b.updated, ['ISS-0001']);
    const issue = loadIssues(tmp).issues[0];
    assert.equal(issue.occurrences, 2);
    assert.equal(issue.category, 'app-rejected-input');
    assert.deepEqual(issue.pageMessages, ['Email already registered']);
    assert.match(issue.reproduce, /"replayRun": "run-2"/);
    assert.equal(issue.flow.feature, 'Customers');
    const md = fs.readFileSync(path.join(tmp, 'automation', 'issues', 'ISSUES.md'), 'utf8');
    assert.match(md, /ISS-0001 · OPEN/);
    assert.match(md, /Email already registered/);
  });

  await t.test('a different error on the same node is a separate issue; server errors are high severity', () => {
    const r = recordRunIssues(tmp, flow, failRun('run-3', 'Expected this step to lead to x/customers, but the page is http://x/customers/create', { pageMessages: [], failedRequests: [{ method: 'POST', url: 'http://x/api/customers', status: 500 }] }));
    assert.deepEqual(r.opened, ['ISS-0002']);
    const i2 = loadIssues(tmp).issues[1];
    assert.equal(i2.category, 'server-error');
    assert.equal(i2.severity, 'high');
  });

  await t.test('fixed -> a passing run closes it; a later failure reopens it as a regression', () => {
    updateIssue(tmp, 'ISS-0001', { status: 'fixed', note: 'unique check fixed', assignee: 'dev1' });
    updateIssue(tmp, 'ISS-0002', { status: 'wont_fix' });
    const p = recordRunIssues(tmp, flow, passRun('run-4'));
    assert.deepEqual(p.closed, ['ISS-0001']);
    assert.equal(loadIssues(tmp).issues[0].status, 'closed');
    assert.equal(loadIssues(tmp).issues[1].status, 'wont_fix');
    const f = recordRunIssues(tmp, flow, failRun('run-5'));
    assert.deepEqual(f.reopened, ['ISS-0001']);
    const i1 = loadIssues(tmp).issues[0];
    assert.equal(i1.status, 'open');
    assert.equal(i1.regression, true);
    assert.equal(i1.assignee, 'dev1');
    assert.deepEqual(listIssues(tmp).map((i) => i.id), ['ISS-0001']);
  });

  await t.test('an open issue that passes again is marked, not closed', () => {
    recordRunIssues(tmp, flow, passRun('run-6'));
    const i1 = loadIssues(tmp).issues[0];
    assert.equal(i1.status, 'open');
    assert.equal(i1.lastPassed.runId, 'run-6');
  });

  await t.test('error shapes ignore run details; categories', () => {
    assert.equal(errorShape('Timeout 5000ms waiting for "Save #12"'), errorShape('Timeout 3000ms waiting for "Save #99"'));
    assert.equal(categorize({ error: 'Missing value {{secret:x}}' }).category, 'missing-data');
    assert.equal(categorize({ error: 'Assertion failed: text "Saved" is not visible' }).category, 'wrong-result');
    assert.equal(categorize({ error: 'locator.waitFor: Timeout 5000ms exceeded', action: 'fill' }).category, 'element-not-found');
  });

  await t.test('tools: automation_issues and automation_issue_update', async () => {
    const list = await runTool('automation_issues', {}, { cwd: tmp });
    assert.equal(list.ok, true);
    assert.match(list.text, /ISS-0001 \[open, regression\]/);
    assert.equal(list.data.counts.wont_fix, 1);
    const one = await runTool('automation_issues', { id: 'iss-0001' }, { cwd: tmp });
    assert.match(one.text, /Reproduce: automation_flow_run/);
    const upd = await runTool('automation_issue_update', { id: 'ISS-0001', status: 'fixed', note: 'deployed' }, { cwd: tmp });
    assert.equal(upd.ok, true);
    assert.match(upd.text, /Run the flow again to verify/);
    const bad = await runTool('automation_issue_update', { id: 'ISS-0001', status: 'done' }, { cwd: tmp });
    assert.equal(bad.ok, false);
  });

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('automation_flow_data tool', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oas-fd-'));
  const dir = path.join(tmp, 'automation', 'features', 'customers', 'register');
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, 'flow.json');
  fs.writeFileSync(fp, JSON.stringify({ id: 'flow-register', name: 'Register', steps: [
    fill('n1', 'Asha Rao', { label: 'Full name' }),
    fill('n2', 'asha@acme.io', { label: 'Email', type: 'email' }),
    fill('n3', 'GST123', { label: 'Tax id' }),
  ] }));
  fs.writeFileSync(path.join(dir, 'register.spec.ts'), '// old');
  const shown = await runTool('automation_flow_data', { flow: fp }, { cwd: tmp });
  assert.equal(shown.ok, true);
  assert.equal(shown.data.saved, true, 'suggested rules are saved on first look');
  assert.match(shown.text, /n2 Email: new email each run/);
  assert.equal(shown.data.fields[1].samples.length, 2);
  assert.notEqual(shown.data.fields[1].samples[0], shown.data.fields[1].samples[1]);
  const changed = await runTool('automation_flow_data', { flow: fp, rules: { 'tax id': 'GST{n:6}', n1: 'fixed', nothing: 'email' } }, { cwd: tmp });
  assert.equal(changed.ok, false, 'reports the unknown field');
  assert.match(changed.text, /No field "nothing"/);
  const saved = JSON.parse(fs.readFileSync(fp, 'utf8'));
  assert.equal(saved.steps[0].data.mode, 'fixed');
  assert.deepEqual([saved.steps[2].data.kind, saved.steps[2].data.pattern], ['pattern', 'GST{n:6}']);
  assert.match(fs.readFileSync(path.join(dir, 'register.spec.ts'), 'utf8'), /DATA\["asha@acme\.io"\]/);
  fs.rmSync(tmp, { recursive: true, force: true });
});
