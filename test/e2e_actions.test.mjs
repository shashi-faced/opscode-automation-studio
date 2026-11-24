// End to end for part 3: server-call checks, variables (extract, exportAs, between flows),
// dialogs, upload, drag and drop, hover and iframes, in a real headless Chrome.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startHarness, tool, rawPage, CHROME } from './fixtures/harness.mjs';

const steps = async (env, ws, list) => {
  for (const s of list) {
    const r = await tool(env, ws, 'automation_step', s);
    assert.equal(r.ok, true, `${s.action} ${JSON.stringify(s.target || s.url || '')}: ${r.text}`);
  }
};
const record = async (env, ws, flowName, url, list, featureName = 'Part 3') => {
  const start = await tool(env, ws, 'automation_record_start', { url, flowName, featureName });
  assert.equal(start.ok, true, start.text);
  await steps(env, ws, list);
  const stop = await tool(env, ws, 'automation_record_stop');
  assert.equal(stop.ok, true, stop.text);
  return JSON.parse(fs.readFileSync(stop.data.flowFile, 'utf8'));
};

test('E2E part 3: server checks, variables, dialogs, upload, drag, hover, iframe', { skip: !CHROME && 'no Chrome/Chromium installed' }, async (t) => {
  const { site, port, ws, env, close } = await startHarness();
  try {
    await t.test('a saved note: the POST is kept on the Save node, the new id is read into a variable', async () => {
      const flow = await record(env, ws, 'Write note', `${site.url}/notes`, [
        { action: 'fill', target: 'label=Title', value: 'Groceries list', description: 'Note title' },
        { action: 'click', target: 'text=Save note', description: 'Save' },
        { action: 'extract', target: '#status', pattern: '#(\\d+)', name: 'note.id', description: 'New note id' },
        { action: 'goto', url: `${site.url}/api/notes/{{var:note.id}}`, description: 'Open the note' },
        { action: 'assert_visible', target: '#note-title', description: 'The note exists' },
      ]);
      const save = flow.steps.find((s) => s.action === 'click');
      assert.deepEqual(save.requests.map((r) => [r.method, r.pattern, r.status]), [['POST', '/api/notes', 201]]);
      const ex = flow.steps.find((s) => s.action === 'extract');
      assert.equal(ex.name, 'note.id');
      assert.equal(flow.steps.find((s) => s.action === 'goto' && s.url.includes('{{var:note.id}}')).url, `${site.url}/api/notes/{{var:note.id}}`);
      const vars = JSON.parse(fs.readFileSync(path.join(ws, 'automation', 'data', 'vars.json'), 'utf8'));
      assert.equal(vars['note.id'].value, String(site.notes[0].id));

      const run = await tool(env, ws, 'automation_flow_run', { flow: 'Write note' });
      assert.equal(run.ok, true, run.text);
      assert.equal(site.notes.length, 2);
      assert.equal(run.data.varsSet['note.id'], String(site.notes[1].id));
      assert.notEqual(site.notes[1].title, 'Groceries list');
    });

    await t.test('the server call failing on replay fails the Save node with the request and status', async () => {
      site.bugs.notesApiError = true;
      const run = await tool(env, ws, 'automation_flow_run', { flow: 'Write note' });
      site.bugs.notesApiError = false;
      assert.equal(run.ok, false);
      const failed = run.data.results.find((r) => r.status === 'failed');
      assert.equal(failed.action, 'click');
      assert.match(failed.error, /Server call failed: POST \/api\/notes -> 500/);
      const issue = await tool(env, ws, 'automation_issues', { id: run.data.issues.opened[0] });
      assert.equal(issue.data.category, 'server-error');
    });

    await t.test('a confirm dialog: the agent answers it, the node is recorded and replay answers it again', async () => {
      const flow = await record(env, ws, 'Delete note', `${site.url}/notes`, [
        { action: 'fill', target: 'label=Title', value: 'Old draft', description: 'Note title' },
        { action: 'click', target: 'text=Save note' },
        { action: 'click', target: 'text=Delete Old draft', dialog: 'accept', description: 'Delete it' },
        { action: 'assert_text', value: 'Deleted note', description: 'It is gone' },
      ]);
      assert.deepEqual(flow.steps.map((s) => s.action), ['goto', 'fill', 'click', 'click', 'dialog', 'assert_text']);
      assert.equal(flow.steps[4].accept, true);
      const before = site.notes.length;
      const run = await tool(env, ws, 'automation_flow_run', { flow: 'Delete note' });
      assert.equal(run.ok, true, run.text);
      assert.equal(site.notes.length, before, 'created then deleted');
    });

    await t.test('the user deletes a note in the browser: the dialog is accepted and recorded', async () => {
      const start = await tool(env, ws, 'automation_record_start', { url: `${site.url}/notes`, flowName: 'Delete note by hand', featureName: 'Part 3' });
      assert.equal(start.ok, true, start.text);
      const p = await rawPage(port, '/notes');
      await p.type('#title', 'Temp note');
      await p.click('button[type=submit]');
      for (let i = 0; i < 50 && !(await p.evaluate("document.querySelector('#notes button') !== null")); i++) await new Promise((r) => setTimeout(r, 100));
      await p.click('#notes button');
      for (let i = 0; i < 50 && !String(await p.evaluate("document.getElementById('status').textContent")).startsWith('Deleted'); i++) await new Promise((r) => setTimeout(r, 100));
      p.close();
      const stop = await tool(env, ws, 'automation_record_stop');
      assert.equal(stop.ok, true, stop.text);
      const flow = JSON.parse(fs.readFileSync(stop.data.flowFile, 'utf8'));
      assert.ok(flow.steps.some((s) => s.action === 'dialog' && s.dialogType === 'confirm'), JSON.stringify(flow.steps.map((s) => s.action)));
      const run = await tool(env, ws, 'automation_flow_run', { flow: 'Delete note by hand' });
      assert.equal(run.ok, true, run.text);
    });

    await t.test('upload, drag and drop, hover menu and a form inside an iframe', async () => {
      await record(env, ws, 'Upload report', `${site.url}/upload`, [
        { action: 'upload', target: '#file', files: ['report.pdf'], description: 'Attach the report' },
        { action: 'click', target: '#up' },
        { action: 'assert_text', value: 'Uploaded report.pdf' },
      ]);
      assert.ok(fs.existsSync(path.join(ws, 'automation', 'files', 'report.pdf')), 'placeholder file created');
      await record(env, ws, 'Finish task', `${site.url}/board`, [
        { action: 'drag', target: '#task-a', to: '#done', description: 'Move Task A to Done' },
        { action: 'assert_text', value: 'Done: Task A' },
      ]);
      await record(env, ws, 'Open reports', `${site.url}/menu`, [
        { action: 'hover', target: '#more', description: 'Open the More menu' },
        { action: 'click', target: 'text=Reports' },
        { action: 'assert_url', value: '/reports' },
      ]);
      const pay = await record(env, ws, 'Pay', `${site.url}/widget`, [
        { action: 'fill', target: '#card', frame: '#pay', value: 'Asha Rao', data: 'fixed', description: 'Name on card' },
        { action: 'click', target: '#paybtn', frame: '#pay' },
        { action: 'extract', target: '#paid', frame: '#pay', name: 'paid.by', pattern: 'Paid by (.*)' },
      ]);
      assert.equal(pay.steps[1].frame.selector, '#pay');
      for (const f of ['Upload report', 'Finish task', 'Open reports', 'Pay']) {
        const run = await tool(env, ws, 'automation_flow_run', { flow: f });
        assert.equal(run.ok, true, `${f}: ${run.text}`);
      }
      assert.ok(site.uploads.length >= 2);
      const vars = JSON.parse(fs.readFileSync(path.join(ws, 'automation', 'data', 'vars.json'), 'utf8'));
      assert.equal(vars['paid.by'].value, 'Asha Rao');
    });

    await t.test('data between flows: an order uses the customer the previous flow registered', async () => {
      await record(env, ws, 'Register customer', `${site.url}/customers/new`, [
        { action: 'fill', target: 'label=Full name', value: 'Asha Rao', exportAs: 'customer.name' },
        { action: 'fill', target: 'label=Email', value: 'asha@acme.io' },
        { action: 'fill', target: 'label=Mobile', value: '9876543210' },
        { action: 'fill', target: 'label=Company', value: 'Acme Pvt Ltd' },
        { action: 'click', target: 'text=Save customer' },
      ], 'Customers');
      const order = await record(env, ws, 'Order for customer', `${site.url}/orders/new`, [
        { action: 'fill', target: 'label=Customer', value: '{{var:customer.name}}', description: 'The customer just registered' },
        { action: 'click', target: 'text=Create order' },
      ], 'Customers');
      assert.deepEqual(order.steps[1].data, { mode: 'var', name: 'customer.name', why: 'value from another step or flow', source: 'auto' });
      assert.equal(site.orders.at(-1).customer, 'Asha Rao');
      const reg = await tool(env, ws, 'automation_flow_run', { flow: 'Register customer' });
      assert.equal(reg.ok, true, reg.text);
      const newName = site.customers.at(-1).name;
      assert.notEqual(newName, 'Asha Rao');
      const run = await tool(env, ws, 'automation_flow_run', { flow: 'Order for customer' });
      assert.equal(run.ok, true, run.text);
      assert.equal(site.orders.at(-1).customer, newName);
      assert.equal(run.data.dataUsed[0].source, 'var:customer.name');
    });
  } finally {
    await close();
  }
});
