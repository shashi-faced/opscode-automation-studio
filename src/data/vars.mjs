// Variables shared between steps and flows: a fill publishes its value (exportAs), an extract step
// reads text from the page, and any value can use {{var:name}}. Kept in automation/data/vars.json
// with where each came from, so "Create order" can use the customer "Register customer" made.
import fs from 'node:fs';
import path from 'node:path';

export function varsPath(cwd) {
  return path.join(cwd, 'automation', 'data', 'vars.json');
}

/** { name: { value, flowId, runId, at } } */
export function readVarsFile(cwd) {
  try {
    return JSON.parse(fs.readFileSync(varsPath(cwd), 'utf8')) || {};
  } catch {
    return {};
  }
}

/** { name: value } */
export function readVars(cwd) {
  const out = {};
  for (const [k, v] of Object.entries(readVarsFile(cwd))) out[k] = v && typeof v === 'object' && 'value' in v ? v.value : v;
  return out;
}

export function saveVars(cwd, values, { flowId, runId } = {}) {
  const names = Object.keys(values || {});
  if (!names.length) return;
  const file = readVarsFile(cwd);
  const at = new Date().toISOString();
  for (const n of names) file[n] = { value: String(values[n]), flowId: flowId || null, runId: runId || null, at };
  fs.mkdirSync(path.dirname(varsPath(cwd)), { recursive: true });
  fs.writeFileSync(varsPath(cwd), JSON.stringify(file, null, 2), 'utf8');
}

/** Pull a value out of a text: the first capture group of `pattern` (a regex string), or the whole match. */
export function extractFrom(text, pattern) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!pattern) return t;
  let re;
  try {
    re = new RegExp(pattern, 'i');
  } catch (e) {
    throw new Error(`Bad pattern ${pattern}: ${e.message}`);
  }
  const m = re.exec(t);
  if (!m) throw new Error(`"${pattern}" not found in "${t.slice(0, 120)}"`);
  return m[1] !== undefined ? m[1] : m[0];
}
