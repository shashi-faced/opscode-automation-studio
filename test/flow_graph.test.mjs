import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureFlowGraph, FlowBuilder, nextNodeId, extractSecrets, resolveValue, pagePattern, samePage,
  summarizeFlowGraph, defaultLabel,
} from '../src/flow/graph.mjs';

test('flow graph v2', async (t) => {
  await t.test('an old flat flow loads as a straight line of nodes', () => {
    const flow = ensureFlowGraph({ steps: [{ action: 'goto', url: 'https://a.test/' }, { action: 'click' }, { action: 'fill', value: 'x' }] });
    assert.deepEqual(flow.steps.map((s) => s.id), ['n1', 'n2', 'n3']);
    assert.deepEqual(flow.edges.map((e) => [e.source, e.target, e.kind]), [['n1', 'n2', 'next'], ['n2', 'n3', 'next']]);
    assert.equal(flow.entry, 'n1');
    assert.equal(flow.version, 2);
  });

  await t.test('edges to missing nodes are dropped and duplicate ids are renamed', () => {
    const flow = ensureFlowGraph({ steps: [{ id: 'a', action: 'click' }, { id: 'a', action: 'click' }], edges: [{ source: 'a', target: 'zz' }] });
    assert.notEqual(flow.steps[0].id, flow.steps[1].id);
    assert.equal(flow.edges.length, 0);
  });

  await t.test('a decision sends the next nodes onto its yes or no branch', () => {
    const b = new FlowBuilder();
    b.add({ action: 'click' });
    b.add({ action: 'decision', condition: { type: 'url', value: '/x' }, outcome: false });
    const n3 = b.add({ action: 'assert_text', value: 'Error' });
    assert.deepEqual(b.flow.edges.at(-1), { id: 'e-n2-n3-no', source: 'n2', target: n3.id, kind: 'no', label: 'no' });
    // continue the other branch later
    const b2 = new FlowBuilder(b.flow, { id: 'n2', kind: 'yes' });
    const n4 = b2.add({ action: 'click' });
    assert.equal(n4.id, 'n4');
    assert.equal(nextNodeId(b2.flow, 'n2', true), 'n4');
    assert.equal(nextNodeId(b2.flow, 'n2', false), 'n3');
    assert.equal(nextNodeId(b2.flow, 'n1'), 'n2');
    assert.equal(nextNodeId(b2.flow, 'n4'), null);
  });

  await t.test('undo removes the last node and moves the cursor back; rejoin links to an existing node', () => {
    const b = new FlowBuilder();
    b.add({ action: 'goto', url: 'https://a.test' });
    b.add({ action: 'click' });
    b.undo();
    assert.equal(b.flow.steps.length, 1);
    assert.equal(b.flow.edges.length, 0);
    const n = b.add({ action: 'fill', value: 'v' });
    assert.equal(b.flow.edges[0].target, n.id);
    const b2 = new FlowBuilder(b.flow, { id: 'n1', kind: 'next' });
    b2.add({ action: 'click' });
    assert.equal(b2.rejoin(n.id), true);
    assert.equal(b2.flow.edges.filter((e) => e.target === n.id).length, 2);
  });

  await t.test('passwords move out of the flow; run inputs can override them', () => {
    const flow = { steps: [{ action: 'fill', value: 'hunter2', sensitive: true, fieldName: 'Password' }, { action: 'fill', value: 'bob' }] };
    const secrets = extractSecrets(flow, 'flow-login');
    assert.deepEqual(secrets, { 'flow-login.password': 'hunter2' });
    assert.equal(flow.steps[0].value, '{{secret:flow-login.password}}');
    assert.equal(flow.steps[1].value, 'bob');
    assert.equal(resolveValue(flow.steps[0].value, { secrets }), 'hunter2');
    assert.equal(resolveValue(flow.steps[0].value, { secrets, inputs: { 'flow-login.password': 'wrong' } }), 'wrong');
    assert.equal(resolveValue('{{input:customer}}', {}), '{{input:customer}}');
    assert.equal(summarizeFlowGraph(ensureFlowGraph(flow)).nodes[0].inputs.value, '••••');
  });

  await t.test('same page ignores ids in the path', () => {
    assert.equal(pagePattern('https://a.test/orders/123/edit?x=1'), 'a.test/orders/*/edit');
    assert.ok(samePage('https://a.test/orders/1', 'https://a.test/orders/99'));
    assert.ok(!samePage('https://a.test/login', 'https://a.test/dashboard'));
  });

  await t.test('labels say what a node does', () => {
    assert.equal(defaultLabel({ action: 'click', selectorSet: { textSelector: 'Save' } }), 'Click "Save"');
    assert.equal(defaultLabel({ action: 'decision', condition: { type: 'text', value: 'Welcome' } }), 'If page shows "Welcome"');
    assert.equal(defaultLabel({ action: 'goto', url: 'https://a.test/orders' }), 'Open a.test/orders');
  });
});
