// End to end for part 3 tools: negative tests, CSV data sets, cleanup, run history, explore,
// export, and GitHub issues (with a stand-in gh), in a real headless Chrome.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHarness, tool, CHROME } from './fixtures/harness.mjs';

const FAKE_GH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-gh.mjs');

test('E2E part 3 tools: negative tests, data sets, cleanup, history, explore, export, GitHub', { skip: !CHROME && 'no Chrome/Chromium installed' }, async (t) => {
  const h = await startHarness();
  const { site, ws } = h;
  const env = { ...h.env, OPSCODE_GH: FAKE_GH, FAKE_GH_LOG: path.join(h.tmp, 'gh.log') };
  const step = async (s) => { const r = await tool(env, ws, 'automation_step', s); assert.equal(r.ok, true, r.text); };
  try {
    await t.test('record "Register customer" and a cleanup flow "Remove customer"', async () => {
      assert.equal((await tool(env, ws, 'automation_record_start', { url: `${site.url}/customers/new`, flowName: 'Register customer', featureName: 'Customers' })).ok, true);
      await step({ action: 'fill', target: 'label=Full name', value: 'Asha Rao' });
      await step({ action: 'fill', target: 'label=Email', value: 'asha@acme.io' });
      await step({ action: 'fill', target: 'label=Mobile', value: '9876543210' });
      await step({ action: 'fill', target: 'label=Company', value: 'Acme Pvt Ltd' });
      await step({ action: 'click', target: 'text=Save customer' });
      await step({ action: 'assert_text', value: 'Asha Rao' });
      assert.equal((await tool(env, ws, 'automation_record_stop')).ok, true);

      assert.equal((await tool(env, ws, 'automation_record_start', { url: `${site.url}/customers/remove`, flowName: 'Remove customer', featureName: 'Customers' })).ok, true);
      await step({ action: 'fill', target: 'label=Email', value: '{{var:cleanup.value}}', description: 'The customer to remove' });
      await step({ action: 'click', target: { role: 'button', name: 'Remove' } });
      assert.equal((await tool(env, ws, 'automation_record_stop')).ok, true);
    });

    await t.test('negative tests: the app refuses bad values; one it accepts becomes an issue, fixed and verified', async () => {
      const run = await tool(env, ws, 'automation_flow_negative', { flow: 'Register customer', fields: ['Email', 'Mobile'], cases: ['email-no-at', 'phone-short', 'phone-letters'] });
      assert.equal(run.ok, true, run.text);
      assert.deepEqual(run.data.results.map((r) => [r.case, r.verdict]), [['email-no-at', 'rejected'], ['phone-short', 'rejected'], ['phone-letters', 'rejected']]);
      assert.match(run.data.results[1].message, /valid mobile number/);

      site.bugs.acceptsBadPhone = true;
      const bad = await tool(env, ws, 'automation_flow_negative', { flow: 'Register customer', fields: ['Mobile'], cases: ['phone-short'] });
      site.bugs.acceptsBadPhone = false;
      assert.equal(bad.ok, false);
      const r = bad.data.results[0];
      assert.equal(r.verdict, 'accepted');
      const issue = await tool(env, ws, 'automation_issues', { id: r.issue });
      assert.equal(issue.data.category, 'validation-missing');
      assert.match(issue.data.title, /"Mobile" accepts phone too short/);

      await tool(env, ws, 'automation_issue_update', { id: r.issue, status: 'fixed' });
      const verify = await tool(env, ws, 'automation_flow_negative', { flow: 'Register customer', fields: ['Mobile'], cases: ['phone-short'] });
      assert.equal(verify.ok, true, verify.text);
      assert.equal((await tool(env, ws, 'automation_issues', { id: r.issue })).data.status, 'closed');
    });

    await t.test('a script typed into a field that the app puts into the page as HTML is reported', async () => {
      const safe = await tool(env, ws, 'automation_flow_negative', { flow: 'Register customer', fields: ['Full name'], cases: ['script'] });
      assert.equal(safe.data.results[0].verdict, 'safe', safe.text);
      site.bugs.unescapedNames = true;
      const xss = await tool(env, ws, 'automation_flow_negative', { flow: 'Register customer', fields: ['Full name'], cases: ['script'] });
      site.bugs.unescapedNames = false;
      assert.equal(xss.data.results[0].verdict, 'script-ran', xss.text);
      const issue = await tool(env, ws, 'automation_issues', { id: xss.data.results[0].issue });
      assert.equal(issue.data.category, 'script-injection');
      assert.equal(issue.data.severity, 'high');
    });

    await t.test('a CSV data set runs once per row, with expected failures', async () => {
      fs.writeFileSync(path.join(ws, 'customers.csv'), 'Full name,Email,Mobile,expect\nRavi Nair,ravi.n@acme.io,9123456780,pass\n"Nair, Ravi",ravi.n@acme.io,9123456781,fail\nMeera Iyer,meera@acme.io,123,fail\n');
      const run = await tool(env, ws, 'automation_flow_run', { flow: 'Register customer', dataset: 'customers.csv' });
      assert.equal(run.ok, true, run.text);
      assert.equal(run.data.results.length, 3);
      assert.deepEqual(run.data.results.map((r) => r.ran), ['passed', 'failed', 'failed']);
      assert.ok(site.customers.some((c) => c.name === 'Ravi Nair' && c.email === 'ravi.n@acme.io'));
    });

    await t.test('cleanup deletes what the runs created: by HTTP request, then by a cleanup flow', async () => {
      for (let i = 0; i < 2; i++) assert.equal((await tool(env, ws, 'automation_flow_run', { flow: 'Register customer' })).ok, true);
      const created = (await tool(env, ws, 'automation_cleanup', { flow: 'Register customer', dryRun: true })).data.pending;
      assert.ok(created.length >= 2, JSON.stringify(created));
      const before = site.customers.length;
      const req = await tool(env, ws, 'automation_cleanup', { flow: 'Register customer', request: { method: 'DELETE', url: `${site.url}/api/customers?email={value}` }, limit: 1 });
      assert.equal(req.ok, true, req.text);
      assert.equal(site.customers.length, before - 1);
      const viaFlow = await tool(env, ws, 'automation_cleanup', { flow: 'Register customer', cleanupFlow: 'Remove customer' });
      assert.equal(viaFlow.ok, true, viaFlow.text);
      for (const v of created) assert.ok(!site.customers.some((c) => c.email === v), `${v} still there; created ${JSON.stringify(created)}; ${req.text}\n${viaFlow.text}`);
      const again = await tool(env, ws, 'automation_cleanup', { flow: 'Register customer', dryRun: true });
      assert.match(again.text, /Nothing to clean/);
    });

    await t.test('run history: pass rate, last runs, failing and flaky steps', async () => {
      const hist = await tool(env, ws, 'automation_run_history', { flow: 'Register customer' });
      assert.equal(hist.ok, true, hist.text);
      const f = hist.data.flows[0];
      assert.equal(f.flowName, 'Register customer');
      assert.ok(f.runs >= 3);
      assert.ok(f.passRate > 0 && f.passRate < 100, String(f.passRate));
      assert.match(f.last, /^[PF]+$/);
      assert.ok(f.flaky.length >= 1, JSON.stringify(f));
    });

    await t.test('explore proposes features and flows from the pages it finds, and lays them out', async () => {
      const ex = await tool(env, ws, 'automation_explore', { url: `${site.url}/dashboard`, maxPages: 12, apply: true, module: 'Shop' });
      assert.equal(ex.ok, true, ex.text);
      const paths = ex.data.pages.map((p) => p.path);
      for (const p of ['/dashboard', '/orders', '/customers', '/customers/new', '/notes']) assert.ok(paths.includes(p), `${p} in ${paths}`);
      const cust = ex.data.proposal.find((f) => f.name === 'Customers');
      assert.ok(cust.flows.some((x) => /Save Customer/i.test(x.name)), JSON.stringify(cust.flows));
      const graph = await tool(env, ws, 'automation_graph_get');
      assert.ok(graph.data.features.some((f) => f.name === 'Notes'));
    });

    await t.test('export writes a Playwright project with fresh test data and a CI workflow', async () => {
      const ex = await tool(env, ws, 'automation_export', { feature: 'Customers' });
      assert.equal(ex.ok, true, ex.text);
      const dir = path.join(ws, ex.data.dir);
      for (const f of ['package.json', 'playwright.config.ts', 'README.md', '.github/workflows/automation-tests.yml']) assert.ok(fs.existsSync(path.join(dir, f)), f);
      const spec = fs.readFileSync(path.join(dir, 'tests', 'customers', 'register-customer.spec.ts'), 'utf8');
      assert.match(spec, /DATA\["asha@acme\.io"\]/);
      assert.match(spec, /test\("Register customer"/);
      const rm = fs.readFileSync(path.join(dir, 'tests', 'customers', 'remove-customer.spec.ts'), 'utf8');
      assert.match(rm, /process\.env\.VAR_CLEANUP_VALUE/);
      assert.match(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), /VAR_CLEANUP_VALUE/);
    });

    await t.test('an issue is sent to GitHub, and closing it there marks it fixed here', async () => {
      const list = await tool(env, ws, 'automation_issues', {});
      const id = list.data.issues.find((i) => i.status === 'open').id;
      const ex = await tool(env, ws, 'automation_issue_export', { id });
      assert.equal(ex.ok, true, ex.text);
      assert.equal(ex.data.url, 'https://github.com/acme/shop/issues/42');
      const calls = fs.readFileSync(env.FAKE_GH_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      const create = calls.find((c) => c.args[1] === 'create');
      assert.deepEqual(create.args.slice(0, 4), ['issue', 'create', '--repo', 'acme/shop']);
      assert.match(create.input, /Reproduce/);
      const sync = await tool({ ...env, FAKE_GH_STATE: 'CLOSED' }, ws, 'automation_issue_sync');
      assert.equal(sync.ok, true, sync.text);
      assert.equal((await tool(env, ws, 'automation_issues', { id })).data.status, 'fixed');
    });
  } finally {
    await h.close();
  }
});
