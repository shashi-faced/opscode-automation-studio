// The values one run types into forms: made from each node's data rule, unique against earlier
// runs, saved with the run (dataUsed) so a failure can be replayed with the same values.

import fs from 'node:fs';
import path from 'node:path';
import { makeRandom, generateValue, fieldInfo } from './generate.mjs';

const HISTORY_KEEP = 300;

export function historyPath(cwd) {
  return path.join(cwd, 'automation', 'data', 'history.json');
}

export function readHistory(cwd) {
  try {
    return JSON.parse(fs.readFileSync(historyPath(cwd), 'utf8')) || {};
  } catch {
    return {};
  }
}

export function writeHistory(cwd, history) {
  try {
    fs.mkdirSync(path.dirname(historyPath(cwd)), { recursive: true });
    fs.writeFileSync(historyPath(cwd), JSON.stringify(history, null, 2), 'utf8');
  } catch {}
}

/** Values used by an earlier run (from its run-summary.json), by node id. */
export function readRunValues(cwd, runId) {
  const file = path.join(cwd, 'automation', 'runs', String(runId).replace(/[^a-zA-Z0-9_.-]/g, ''), 'run-summary.json');
  let summary;
  try {
    summary = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`Run ${runId} not found (looked for ${path.relative(cwd, file)}).`);
  }
  const out = {};
  for (const d of summary.dataUsed || []) if (d.source !== 'secret' && d.value != null) out[d.nodeId] = d.value;
  return out;
}

const SUBSTITUTABLE = new Set(['email', 'fullName', 'firstName', 'lastName', 'username', 'phone', 'company', 'street', 'url', 'sentence', 'text', 'pattern', 'zip']);

/**
 * Plan the values of one run.
 * mode "fresh": nodes with a generate/list rule get new values; "recorded": every node keeps its value.
 * replayValues: { nodeId: value } from an earlier run (wins over generated values).
 */
export function planRunData(flow, { mode = 'fresh', seed, history = {}, replayValues = null, overrides = null, overrideSource = 'given' } = {}) {
  const runSeed = seed ?? ((Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) >>> 0);
  const rng = makeRandom(runSeed);
  const runTag = rng.tag(4);
  const values = {}; // nodeId -> { value, source }
  const subs = []; // [recordedValue, newValue]
  const byRecorded = new Map();
  const flowHist = history[flow.id || flow.name] || {};
  const used = new Set(Object.values(flowHist).flat().map(String));

  for (const s of flow.steps || []) {
    if (s.action !== 'fill' && s.action !== 'select') continue;
    const rule = s.data || null;
    const recorded = s.value;
    if (overrides && Object.prototype.hasOwnProperty.call(overrides, s.id)) {
      values[s.id] = { value: String(overrides[s.id]), source: overrideSource };
    } else if (rule?.mode === 'var' && rule.name) {
      values[s.id] = { value: `{{var:${rule.name}}}`, source: `var:${rule.name}` };
    } else if (replayValues && Object.prototype.hasOwnProperty.call(replayValues, s.id)) {
      values[s.id] = { value: String(replayValues[s.id]), source: 'replay' };
    } else if (mode === 'fresh' && rule && (rule.mode === 'generate' || rule.mode === 'list')) {
      const same = recorded != null && byRecorded.get(String(recorded));
      if (same) {
        values[s.id] = { value: same.value, source: `same as ${same.nodeId}` };
        continue;
      }
      const info = fieldInfo(s);
      let v;
      for (let tries = 0; tries < 12; tries++) {
        v = generateValue(rule, rng, { sample: recorded ?? '', runTag: tries ? rng.tag(4) : runTag, maxLength: info.maxLength });
        if (rule.mode === 'list' || !used.has(v)) break;
      }
      values[s.id] = { value: v, source: rule.mode === 'list' ? 'list' : 'generated', kind: rule.kind };
      if (recorded != null && String(recorded) !== v) {
        byRecorded.set(String(recorded), { value: v, nodeId: s.id });
        if (String(recorded).length >= 4 && SUBSTITUTABLE.has(rule.kind || 'text')) subs.push([String(recorded), v]);
      }
    } else if (mode === 'fresh' && rule?.mode === 'any' && s.action === 'select') {
      values[s.id] = { value: null, source: 'any' };
    }
  }
  // Longest first so "Acme Corp Ltd" is replaced before "Acme Corp".
  subs.sort((a, b) => b[0].length - a[0].length);
  return { seed: runSeed, runTag, mode, values, subs, rng };
}

function replaceAll(str, subs) {
  let out = str;
  for (const [from, to] of subs) if (out.includes(from)) out = out.split(from).join(to);
  return out;
}

function deepReplace(value, subs) {
  if (!subs.length || value == null) return value;
  if (typeof value === 'string') return replaceAll(value, subs);
  if (Array.isArray(value)) return value.map((v) => deepReplace(v, subs));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = k === 'boundingBox' ? v : deepReplace(v, subs);
    return out;
  }
  return value;
}

/**
 * The step to execute in this run: its own planned value, and every recorded value that was
 * replaced elsewhere (assert texts, link names, selectors) swapped for the new one.
 */
export function stepForRun(step, plan) {
  if (!plan) return step;
  const own = plan.values[step.id];
  const out = { ...step };
  if (plan.subs.length) {
    if (!own && typeof out.value === 'string') out.value = replaceAll(out.value, plan.subs);
    if (out.selectorSet) out.selectorSet = deepReplace(out.selectorSet, plan.subs);
    if (out.condition) out.condition = deepReplace(out.condition, plan.subs);
    if (out.target) out.target = deepReplace(out.target, plan.subs);
    if (typeof out.description === 'string') out.description = replaceAll(out.description, plan.subs);
  }
  if (own) {
    if (own.source === 'any') out.pickAnyOption = true;
    else out.value = own.value;
  }
  return out;
}

/** Remember the generated values of a finished run, so later runs avoid them. */
export function rememberValues(cwd, flowId, dataUsed, { created = false } = {}) {
  const generated = (dataUsed || []).filter((d) => d.source === 'generated' && d.value != null);
  if (!generated.length) return;
  const history = readHistory(cwd);
  const h = history[flowId] || {};
  for (const d of generated) {
    const list = h[d.nodeId] || [];
    list.push(String(d.value));
    h[d.nodeId] = list.slice(-HISTORY_KEEP);
  }
  history[flowId] = h;
  // values of runs that went all the way through: records that now exist in the app (for cleanup)
  if (created) {
    const c = (history.__created ||= {});
    const ch = (c[flowId] ||= {});
    for (const d of generated) ch[d.nodeId] = [...(ch[d.nodeId] || []), String(d.value)].slice(-HISTORY_KEEP);
  }
  writeHistory(cwd, history);
}

/** Values of runs that completed (records the app now has), by node. */
export function createdValues(cwd, flowId, nodeId) {
  return readHistory(cwd).__created?.[flowId]?.[nodeId] || [];
}
