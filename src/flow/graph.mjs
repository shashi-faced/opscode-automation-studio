// Flow graph format v2.
//
// A flow keeps its nodes in `steps` (so the compiler, healer and step drawer keep working) and
// links them with `edges`:
//   { id, source, target, kind: 'next' | 'yes' | 'no', label? }
// A node (= step) has: id, action, label, description, selectorSet (target), value / key / url
// (inputs), page { url, title } (where it happened), result { url, title } (where it led),
// source ('user' | 'agent'), and for a decision node a `condition` { type, value }.
// Old flows with only a flat `steps` list load as a straight line.

export const FLOW_VERSION = 2;

const EDGE_KINDS = new Set(['next', 'yes', 'no']);

export function nodeIdFor(index) {
  return `n${index + 1}`;
}

/** Give every step an id and, when the flow has no edges, link the steps in order. Mutates and returns `flow`. */
export function ensureFlowGraph(flow) {
  if (!flow || typeof flow !== 'object') return flow;
  if (!Array.isArray(flow.steps)) flow.steps = [];
  const used = new Set();
  flow.steps.forEach((s, i) => {
    if (!s.id || used.has(s.id)) {
      let id = nodeIdFor(i);
      let n = i;
      while (used.has(id)) id = nodeIdFor(++n);
      s.id = id;
    }
    used.add(s.id);
    if (!s.label) s.label = defaultLabel(s);
  });
  if (!Array.isArray(flow.edges) || flow.edges.length === 0) {
    flow.edges = [];
    for (let i = 1; i < flow.steps.length; i++) {
      flow.edges.push(makeEdge(flow.steps[i - 1].id, flow.steps[i].id, 'next'));
    }
  } else {
    flow.edges = flow.edges.filter((e) => used.has(e.source) && used.has(e.target));
    for (const e of flow.edges) {
      if (!EDGE_KINDS.has(e.kind)) e.kind = 'next';
      if (!e.id) e.id = edgeId(e.source, e.target, e.kind);
    }
  }
  if (!flow.entry || !used.has(flow.entry)) flow.entry = flow.steps[0]?.id || null;
  flow.version = FLOW_VERSION;
  flow.stepCount = flow.steps.length;
  return flow;
}

export function edgeId(source, target, kind) {
  return `e-${source}-${target}${kind && kind !== 'next' ? `-${kind}` : ''}`;
}

export function makeEdge(source, target, kind = 'next') {
  const e = { id: edgeId(source, target, kind), source, target, kind };
  if (kind === 'yes') e.label = 'yes';
  if (kind === 'no') e.label = 'no';
  return e;
}

export function getNode(flow, id) {
  return (flow.steps || []).find((s) => s.id === id) || null;
}

export function outgoing(flow, id) {
  return (flow.edges || []).filter((e) => e.source === id);
}

/**
 * The node to run after `id`. For a decision node pass its outcome (true/false); it follows the
 * `yes` or `no` edge, and a missing branch ends the flow. Other nodes follow their `next` edge.
 */
export function nextNodeId(flow, id, outcome) {
  const out = outgoing(flow, id);
  const node = getNode(flow, id);
  if (node && node.action === 'decision') {
    const kind = outcome ? 'yes' : 'no';
    return out.find((e) => e.kind === kind)?.target || null;
  }
  return (out.find((e) => e.kind === 'next') || out[0])?.target || null;
}

/**
 * Builder used while recording. Adds nodes after a cursor; after a decision node the cursor moves
 * onto that decision's yes/no branch (which branch depends on the outcome seen while recording).
 */
export class FlowBuilder {
  constructor(flow = {}, cursor = null) {
    this.flow = ensureFlowGraph({ ...flow, steps: [...(flow.steps || [])], edges: [...(flow.edges || [])] });
    const last = this.flow.steps[this.flow.steps.length - 1];
    this.cursor = cursor || (last ? cursorAfter(last) : null);
    this.counter = this.flow.steps.length;
  }

  newId() {
    let id;
    do { id = nodeIdFor(this.counter++); } while (getNode(this.flow, id));
    return id;
  }

  add(step) {
    const node = { ...step };
    if (!node.id || getNode(this.flow, node.id)) node.id = this.newId();
    if (!node.label) node.label = defaultLabel(node);
    this.flow.steps.push(node);
    if (this.cursor) {
      this.flow.edges.push(makeEdge(this.cursor.id, node.id, this.cursor.kind));
    } else if (!this.flow.entry) {
      this.flow.entry = node.id;
    }
    this.cursor = cursorAfter(node);
    this.flow.stepCount = this.flow.steps.length;
    return node;
  }

  /** Remove the last added node and the edges into and out of it (widget Undo). */
  undo() {
    const node = this.flow.steps.pop();
    if (!node) return null;
    const into = this.flow.edges.find((e) => e.target === node.id);
    this.flow.edges = this.flow.edges.filter((e) => e.source !== node.id && e.target !== node.id);
    this.cursor = into ? { id: into.source, kind: into.kind } : null;
    if (this.flow.entry === node.id) this.flow.entry = this.flow.steps[0]?.id || null;
    this.flow.stepCount = this.flow.steps.length;
    return node;
  }

  /** Link the current cursor to an existing node (a branch that rejoins the main path). */
  rejoin(targetId) {
    if (!this.cursor || !getNode(this.flow, targetId)) return false;
    this.flow.edges.push(makeEdge(this.cursor.id, targetId, this.cursor.kind));
    this.cursor = null;
    return true;
  }
}

function cursorAfter(node) {
  if (node.action === 'decision') return { id: node.id, kind: node.outcome === false ? 'no' : 'yes' };
  return { id: node.id, kind: 'next' };
}

export function defaultLabel(step) {
  const a = step.action || 'step';
  const t = step.selectorSet?.textSelector || step.selectorSet?.ariaSelector?.name || step.selectorSet?.domContext?.label || step.fieldName;
  switch (a) {
    case 'goto':
    case 'navigate': return `Open ${shortUrl(step.url || step.value)}`;
    case 'click': return t ? `Click "${clip(t)}"` : 'Click';
    case 'fill': return `Fill ${t ? `"${clip(t)}"` : 'field'}`;
    case 'select': return `Select ${step.value != null ? `"${clip(String(step.value))}"` : 'option'}`;
    case 'check': return `Check ${t ? `"${clip(t)}"` : 'box'}`;
    case 'uncheck': return `Uncheck ${t ? `"${clip(t)}"` : 'box'}`;
    case 'press': return `Press ${step.key || 'Enter'}`;
    case 'hover': return t ? `Hover "${clip(t)}"` : 'Hover';
    case 'upload': return `Upload ${clip((step.files || []).join(', ') || 'file')}`;
    case 'drag': return `Drag ${t ? `"${clip(t)}"` : 'item'}${step.to?.textSelector ? ` to "${clip(step.to.textSelector)}"` : ''}`;
    case 'extract': return `Read "${clip(String(step.name || 'value'))}"`;
    case 'dialog': return `${step.accept === false ? 'Dismiss' : 'Accept'} ${step.dialogType || 'dialog'}`;
    case 'decision': return `If ${describeCondition(step.condition)}`;
    case 'assert_text': return `Expect text "${clip(String(step.value || ''))}"`;
    case 'assert_url': return `Expect URL ${clip(String(step.value || ''))}`;
    case 'assert':
    case 'assert_visible': return t ? `Expect "${clip(t)}" visible` : 'Expect visible';
    default: return step.description ? clip(step.description, 40) : a;
  }
}

export function describeCondition(c) {
  if (!c) return 'condition';
  const v = clip(String(c.value ?? ''), 30);
  switch (c.type) {
    case 'url': return `URL contains "${v}"`;
    case 'text': return `page shows "${v}"`;
    case 'visible': return `"${v}" is visible`;
    default: return `${c.type} ${v}`;
  }
}

function clip(s, n = 28) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function shortUrl(u) {
  try {
    const x = new URL(u);
    return (x.pathname && x.pathname !== '/' ? x.host + x.pathname : x.host) || u;
  } catch {
    return String(u || '');
  }
}

/** URL path with numbers and ids replaced by `*`, for comparing "same page" between runs. */
export function pagePattern(url) {
  try {
    const u = new URL(url);
    const segs = u.pathname.split('/').map((s) => (/^\d+$/.test(s) || /^[0-9a-f-]{16,}$/i.test(s) ? '*' : s));
    return u.host + segs.join('/');
  } catch {
    return String(url || '');
  }
}

export function samePage(a, b) {
  return pagePattern(a) === pagePattern(b);
}

/**
 * Move typed passwords and other sensitive values out of the flow. The flow keeps
 * `{{secret:<name>}}`; the values go into the returned map (saved to automation/.secrets.json).
 */
export function extractSecrets(flow, flowId) {
  const secrets = {};
  for (const s of flow.steps || []) {
    if (!s.sensitive || s.value == null) continue;
    if (/^\{\{(secret|input):[^}]+\}\}$/.test(String(s.value))) continue;
    const base = String(s.fieldName || s.selectorSet?.domContext?.label || 'password').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'password';
    let name = `${flowId}.${base}`;
    let n = 2;
    while (name in secrets) name = `${flowId}.${base}_${n++}`;
    secrets[name] = String(s.value);
    s.value = `{{secret:${name}}}`;
  }
  return secrets;
}

/** Replace {{secret:x}}, {{input:x}} and {{var:x}} in a value. Unknown names are left as they are. */
export function resolveValue(value, { inputs = {}, secrets = {}, vars = {} } = {}) {
  if (typeof value !== 'string') return value;
  const has = (o, k) => o && Object.prototype.hasOwnProperty.call(o, k);
  return value.replace(/\{\{(secret|input|var):([^}]+)\}\}/g, (m, kind, name) => {
    // inputs given for a run win over saved secrets and variables (e.g. replay with a wrong password)
    if (has(inputs, name)) return String(inputs[name]);
    if (kind === 'secret' && has(secrets, name)) return String(secrets[name]);
    if (kind === 'var' && has(vars, name)) return String(vars[name]);
    return m;
  });
}

/** Small summary of a flow's graph for tool results (kept short: the app keeps only 64 KB of output). */
export function summarizeFlowGraph(flow) {
  return {
    entry: flow.entry,
    nodes: (flow.steps || []).map((s) => ({
      id: s.id,
      action: s.action,
      label: s.label || defaultLabel(s),
      description: s.description || '',
      target: targetSummary(s),
      inputs: inputSummary(s),
      page: s.page?.url || s.url || null,
      result: s.result || null,
      condition: s.condition || undefined,
      source: s.source || 'user',
      data: s.data ? { mode: s.data.mode, kind: s.data.kind, pattern: s.data.pattern, values: s.data.values, why: s.data.why, name: s.data.name } : undefined,
      exportAs: s.exportAs || undefined,
      requests: Array.isArray(s.requests) && s.requests.length ? s.requests.map((r) => ({ method: r.method, pattern: r.pattern, status: r.status })) : undefined,
      frame: s.frame || undefined,
    })),
    edges: (flow.edges || []).map((e) => ({ id: e.id, source: e.source, target: e.target, kind: e.kind, label: e.label })),
  };
}

function targetSummary(s) {
  const set = s.selectorSet;
  if (!set) return null;
  return set.primarySelector || (set.ariaSelector ? `role=${set.ariaSelector.role}[name="${set.ariaSelector.name}"]` : null) || (set.textSelector ? `text=${set.textSelector}` : null) || set.cssSelector || null;
}

function inputSummary(s) {
  const out = {};
  if (s.value != null && s.action !== 'decision') out.value = s.sensitive ? '••••' : s.value;
  if (s.key) out.key = s.key;
  if (s.action === 'upload' && s.files) out.files = s.files;
  if (s.action === 'extract') { out.name = s.name; if (s.pattern) out.pattern = s.pattern; }
  if (s.action === 'dialog') out.accept = s.accept !== false;
  if ((s.action === 'goto' || s.action === 'navigate') && s.url) out.url = s.url;
  return Object.keys(out).length ? out : undefined;
}
