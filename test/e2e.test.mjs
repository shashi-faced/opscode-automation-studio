// End to end: a real headless Chrome, the 4-page fixture site, and the CLI called the way the
// Opscode app calls it (`node bin/opscode-automation.mjs tool <name> --b64 <json> --cwd <ws>`),
// one process per call. The "user" clicks and types through raw CDP, like the app's Browser tab;
// the agent acts through automation_step.
//
// Skipped when no Chrome/Chromium is installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startHarness, tool, rawPage, CHROME } from './fixtures/harness.mjs';

test('E2E: record a multi-page feature, see it as a graph, replay it, branch it', { skip: !CHROME && 'no Chrome/Chromium installed' }, async (t) => {
  const { site, port, ws, env, close } = await startHarness();

  try {
    await t.test('the user records "Create order" across 4 pages; every action becomes a node', async () => {
      const start = await tool(env, ws, 'automation_record_start', { url: `${site.url}/login`, flowName: 'Create order', featureName: 'Orders' });
      assert.equal(start.ok, true, start.text);
      assert.equal(start.data.browser, 'opscode-cdp');

      const page = await rawPage(port, '/login');
      await page.type('#email', 'a@b.co');
      await page.type('#password', 'secret');
      await page.click('[data-testid=login-submit]');
      await page.waitFor('/dashboard');
      page.close();

      // Live status while recording: the graph grows
      const mid = await tool(env, ws, 'automation_record_status');
      assert.equal(mid.data.isRecording, true);
      assert.ok(mid.data.graph.nodes.length >= 4, JSON.stringify(mid.data.lastSteps));

      const p2 = await rawPage(port, '/dashboard');
      await p2.click('a[aria-label="New order"]');
      await p2.waitFor('/orders/new');
      p2.close();
      const p3 = await rawPage(port, '/orders/new');
      await p3.type('#customer', 'Acme');
      // choose "Pro" the way a dropdown change reaches the page
      await p3.evaluate(`(() => { const s = document.querySelector('#plan'); s.value = 'pro'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await p3.click('#rush');
      await p3.click('button[type=submit]');
      await p3.waitFor(/\/orders$/);
      p3.close();
      assert.equal(site.orders.length, 1);

      const stop = await tool(env, ws, 'automation_record_stop');
      assert.equal(stop.ok, true, stop.text);
      const flow = JSON.parse(fs.readFileSync(stop.data.flowFile, 'utf8'));
      const actions = flow.steps.map((s) => s.action);
      assert.deepEqual(actions, ['goto', 'fill', 'fill', 'click', 'click', 'fill', 'select', 'check', 'click']);
      // linked in order
      assert.equal(flow.edges.length, flow.steps.length - 1);
      flow.edges.forEach((e, i) => assert.deepEqual([e.source, e.target, e.kind], [flow.steps[i].id, flow.steps[i + 1].id, 'next']));
      // each node says what it does, its input, target and where it led
      const signIn = flow.steps[3];
      assert.equal(signIn.label, 'Click "Sign in"');
      assert.equal(signIn.selectorSet.primarySelector, '[data-testid="login-submit"]');
      assert.match(signIn.page.url, /\/login$/);
      assert.match(signIn.result.url, /\/dashboard$/);
      assert.equal(flow.steps[6].value, 'pro');
      // the password is not in flow.json
      assert.equal(flow.steps[2].value, '{{secret:flow-create-order.password}}');
      const secrets = JSON.parse(fs.readFileSync(path.join(ws, 'automation', '.secrets.json'), 'utf8'));
      assert.equal(secrets['flow-create-order.password'], 'secret');
      assert.ok(fs.readFileSync(path.join(ws, 'automation', '.gitignore'), 'utf8').includes('.secrets.json'));
    });

    await t.test('the flow is in the module graph and readable as nodes and edges', async () => {
      const graph = await tool(env, ws, 'automation_graph_get');
      const feat = graph.data.features.find((f) => f.name === 'Orders');
      assert.ok(feat);
      assert.equal(feat.flows[0].stepCount, 9);
      const fg = await tool(env, ws, 'automation_flow_get', { flow: 'Create order' });
      assert.equal(fg.ok, true);
      assert.equal(fg.data.nodes.length, 9);
      assert.equal(fg.data.nodes[2].inputs.value, '••••');
    });

    await t.test('replay creates the order again and checks each page change', async () => {
      const run = await tool(env, ws, 'automation_flow_run', { flow: 'Create order' });
      assert.equal(run.ok, true, run.text);
      assert.equal(run.data.path.length, 9);
      assert.equal(site.orders.length, 2);
      // the customer name is new test data; plan and rush are as recorded
      assert.notEqual(site.orders[1].customer, 'Acme');
      assert.deepEqual({ ...site.orders[1], customer: 'x' }, { customer: 'x', plan: 'pro', rush: true });
      const customer = run.data.dataUsed.find((d) => d.field === 'Customer');
      assert.equal(customer.source, 'generated');
      assert.equal(customer.value, site.orders[1].customer);
      // the sign-in email stays as recorded, the password comes from the secrets file
      assert.deepEqual(run.data.dataUsed.slice(0, 2).map((d) => [d.value, d.source]), [['a@b.co', 'recorded'], ['••••', 'secret']]);
      // data:"recorded" types what was recorded
      const rec = await tool(env, ws, 'automation_flow_run', { flow: 'Create order', data: 'recorded' });
      assert.equal(rec.ok, true, rec.text);
      assert.equal(site.orders[2].customer, 'Acme');
    });

    await t.test('replay fails at the right node when the page does not go where it went before', async () => {
      const run = await tool(env, ws, 'automation_flow_run', { flow: 'Create order', inputs: { 'flow-create-order.password': 'wrong' } });
      assert.equal(run.ok, false);
      const failed = run.data.results.find((r) => r.status === 'failed');
      assert.equal(failed.nodeId, 'n4');
      assert.match(failed.error, /Expected this step to lead to .*\/dashboard/);
    });

    await t.test('the agent records "Sign in" with automation_step, including a decision', async () => {
      const start = await tool(env, ws, 'automation_record_start', { url: `${site.url}/login`, flowName: 'Sign in', featureName: 'Authentication' });
      assert.equal(start.ok, true, start.text);
      const steps = [
        { action: 'fill', target: 'label=Email', value: 'a@b.co', description: 'Enter the account email' },
        { action: 'fill', target: '#password', value: 'secret', sensitive: true, description: 'Enter the password' },
        { action: 'click', target: { role: 'button', name: 'Sign in' }, description: 'Submit the sign-in form' },
        { action: 'decision', condition: { type: 'url', value: '/dashboard' }, description: 'Did sign-in succeed?' },
        { action: 'assert_text', value: 'Welcome back', description: 'Dashboard greets the user' },
      ];
      for (const s of steps) {
        const r = await tool(env, ws, 'automation_step', s);
        assert.equal(r.ok, true, `${s.action}: ${r.text}`);
        assert.equal(r.data.recorded, true);
      }
      const stop = await tool(env, ws, 'automation_record_stop');
      assert.equal(stop.ok, true, stop.text);
      const flow = JSON.parse(fs.readFileSync(stop.data.flowFile, 'utf8'));
      assert.deepEqual(flow.steps.map((s) => s.action), ['goto', 'fill', 'fill', 'click', 'decision', 'assert_text']);
      assert.equal(flow.steps[1].description, 'Enter the account email');
      assert.equal(flow.steps[1].source, 'agent');
      assert.equal(flow.steps[2].value, '{{secret:flow-sign-in.password}}');
      const yes = flow.edges.find((e) => e.source === 'n5');
      assert.equal(yes.kind, 'yes');
      assert.equal(yes.target, 'n6');
    });

    await t.test('record the "no" branch (wrong password), then replay takes the right branch', async () => {
      // Put the browser in the state before the decision, with a wrong password
      const pre = await tool(env, ws, 'automation_flow_run', { flow: 'Sign in', untilNode: 'n4', inputs: { 'flow-sign-in.password': 'wrong' } });
      assert.equal(pre.ok, false); // n4 expected the dashboard: that is the point
      const start = await tool(env, ws, 'automation_record_start', { branchOf: { flow: 'Sign in', node: 'n5', when: 'no' } });
      assert.equal(start.ok, true, start.text);
      const r = await tool(env, ws, 'automation_step', { action: 'assert_text', value: 'Wrong password', description: 'Error is shown' });
      assert.equal(r.ok, true, r.text);
      const stop = await tool(env, ws, 'automation_record_stop');
      assert.equal(stop.ok, true, stop.text);

      const fg = await tool(env, ws, 'automation_flow_get', { flow: 'Sign in' });
      const kinds = fg.data.edges.filter((e) => e.source === 'n5').map((e) => e.kind).sort();
      assert.deepEqual(kinds, ['no', 'yes']);

      const good = await tool(env, ws, 'automation_flow_run', { flow: 'Sign in' });
      assert.equal(good.ok, true, good.text);
      assert.deepEqual(good.data.path, ['n1', 'n2', 'n3', 'n4', 'n5', 'n6']);
      assert.equal(good.data.results.find((x) => x.nodeId === 'n5').outcome, true);
    });

    await t.test('the agent records "Register customer"; each field gets a test data rule', async () => {
      const start = await tool(env, ws, 'automation_record_start', { url: `${site.url}/customers/new`, flowName: 'Register customer', featureName: 'Customers' });
      assert.equal(start.ok, true, start.text);
      const steps = [
        { action: 'fill', target: 'label=Full name', value: 'Asha Rao', description: 'Customer name' },
        { action: 'fill', target: 'label=Email', value: 'asha@acme.io', description: 'Customer email (must be unique)' },
        { action: 'fill', target: 'label=Mobile', value: '9876543210', description: 'Mobile number' },
        { action: 'fill', target: 'label=Company', value: 'Acme Pvt Ltd', description: 'Company' },
        { action: 'click', target: 'text=Save customer', description: 'Save the customer' },
        { action: 'assert_text', value: 'Asha Rao', description: 'The new customer is in the list' },
      ];
      for (const s of steps) {
        const r = await tool(env, ws, 'automation_step', s);
        assert.equal(r.ok, true, `${s.action}: ${r.text}`);
      }
      const stop = await tool(env, ws, 'automation_record_stop');
      assert.equal(stop.ok, true, stop.text);
      assert.equal(site.customers.length, 1);
      const data = await tool(env, ws, 'automation_flow_data', { flow: 'Register customer' });
      assert.equal(data.ok, true, data.text);
      const kinds = data.data.fields.map((f) => [f.field, f.rule.mode, f.rule.kind]);
      assert.deepEqual(kinds, [['Full name', 'generate', 'fullName'], ['Email', 'generate', 'email'], ['Mobile', 'generate', 'phone'], ['Company', 'generate', 'company']]);
      assert.match(data.text, /new email each run/);
    });

    let serverErrorIssue;
    await t.test('replaying with the recorded data fails ("Email already registered") and opens an issue', async () => {
      const run = await tool(env, ws, 'automation_flow_run', { flow: 'Register customer', data: 'recorded' });
      assert.equal(run.ok, false);
      const failed = run.data.results.find((r) => r.status === 'failed');
      assert.equal(failed.nodeId, 'n6');
      assert.deepEqual(failed.pageMessages, ['Email already registered']);
      assert.match(run.text, /Page said: "Email already registered"/);
      assert.equal(run.data.issues.opened.length, 1);
      const issues = await tool(env, ws, 'automation_issues', { flow: 'Register customer' });
      assert.equal(issues.data.issues[0].category, 'app-rejected-input');
      assert.equal(issues.data.issues[0].dataUsed.find((d) => d.field === 'Email').value, 'asha@acme.io');
    });

    await t.test('fresh data: 3 runs in a row pass, each with new values, and the check follows the new name', async () => {
      const run = await tool(env, ws, 'automation_flow_run', { flow: 'Register customer', times: 3 });
      assert.equal(run.ok, true, run.text);
      assert.equal(site.customers.length, 4);
      const emails = site.customers.slice(1).map((c) => c.email);
      assert.equal(new Set(emails).size, 3);
      for (const c of site.customers.slice(1)) {
        assert.notEqual(c.name, 'Asha Rao');
        assert.match(c.phone, /^[6-9]\d{9}$/);
      }
      assert.match(run.text, /3\/3 runs passed with different data/);
      const history = JSON.parse(fs.readFileSync(path.join(ws, 'automation', 'data', 'history.json'), 'utf8'));
      assert.equal(history['flow-register-customer'].n3.length, 3);
    });

    await t.test('a server bug becomes a tracked issue; fixed + a passing run with the same data closes it', async () => {
      site.bugs.customerServerError = true;
      const bad = await tool(env, ws, 'automation_flow_run', { flow: 'Register customer' });
      assert.equal(bad.ok, false);
      assert.equal(bad.data.issues.opened.length, 1);
      serverErrorIssue = bad.data.issues.opened[0];
      const one = await tool(env, ws, 'automation_issues', { id: serverErrorIssue });
      assert.equal(one.data.category, 'server-error', JSON.stringify(one.data));
      assert.equal(one.data.severity, 'high');
      assert.ok(one.data.failedRequests.some((r) => r.status === 500 && r.url.includes('/customers/create')));
      assert.match(one.data.reproduce, new RegExp(`"replayRun": "${bad.data.runId}"`));

      // a developer fixes it
      site.bugs.customerServerError = false;
      const upd = await tool(env, ws, 'automation_issue_update', { id: serverErrorIssue, status: 'fixed', note: 'null check in create' });
      assert.equal(upd.ok, true, upd.text);
      const verify = await tool(env, ws, 'automation_flow_run', { flow: 'Register customer', replayRun: bad.data.runId });
      assert.equal(verify.ok, true, verify.text);
      assert.deepEqual(verify.data.dataUsed.map((d) => d.value), bad.data.dataUsed.map((d) => d.value));
      assert.deepEqual(verify.data.issues.closed, [serverErrorIssue]);
      const md = fs.readFileSync(path.join(ws, 'automation', 'issues', 'ISSUES.md'), 'utf8');
      assert.match(md, new RegExp(`${serverErrorIssue} · CLOSED`));
      assert.match(md, /Email already registered/);
    });

    await t.test('the bug coming back reopens the issue as a regression', async () => {
      site.bugs.customerServerError = true;
      const again = await tool(env, ws, 'automation_flow_run', { flow: 'Register customer' });
      site.bugs.customerServerError = false;
      assert.equal(again.ok, false);
      assert.deepEqual(again.data.issues.reopened, [serverErrorIssue]);
      assert.match(again.text, /REOPENED \(regression\)/);
    });

    await t.test('a module is laid out as features and flows with an order between them', async () => {
      const res = await tool(env, ws, 'automation_module_plan', {
        module: 'Orders',
        features: [{ name: 'Order list', flows: ['Filter by plan', { name: 'Open an order', description: 'Click an order in the list' }] }],
        dependsOn: [['Sign in', 'Create order'], ['Create order', 'Filter by plan']],
      });
      assert.equal(res.ok, true, res.text);
      assert.equal(res.data.dependencies, 2);
      const graph = await tool(env, ws, 'automation_graph_get');
      assert.deepEqual(graph.data.features.map((f) => f.name).sort(), ['Authentication', 'Customers', 'Order list', 'Orders']);
      const deps = graph.data.canvasLayout.edges.filter((e) => e.type === 'depends-on');
      assert.equal(deps.length, 2);
    });
  } finally {
    await close();
  }
});
