// Negative and boundary tests: wrong values for each form field, derived from its data rule, and
// where in the flow the app "accepts" the form. A case passes when the app refuses the value.
import { fieldInfo } from './generate.mjs';
import { getNode, nextNodeId } from '../flow/graph.mjs';

const XSS = '<img src=x onerror=alert(1)>';

/**
 * Cases for one fill node. Each: { id, label, value, expect: 'reject' | 'no-script', strict }.
 * strict = an app that accepts it has a bug; not strict = worth a look (e.g. an empty optional field).
 */
export function negativeCases(step) {
  if (!step || step.action !== 'fill') return [];
  const rule = step.data || {};
  if (rule.mode === 'secret' || rule.mode === 'var' || rule.mode === 'fixed') return [];
  const info = fieldInfo(step);
  const required = !!step.selectorSet?.domContext?.required;
  const max = info.maxLength || null;
  const kind = rule.kind || 'text';
  const cases = [];
  const add = (id, label, value, strict, expect = 'reject') => cases.push({ id, label, value, strict, expect });
  switch (kind) {
    case 'email':
      add('email-no-at', 'email without @', 'not-an-email', true);
      add('email-no-domain', 'email without domain', 'user@', true);
      break;
    case 'phone':
      add('phone-short', 'phone too short', '12345', true);
      add('phone-letters', 'phone with letters', 'abcdefghij', true);
      break;
    case 'zip':
      add('zip-short', 'postal code too short', '12', true);
      add('zip-letters', 'postal code with letters', 'ABCDE', true);
      break;
    case 'number': {
      const rec = Number(step.value);
      add('number-negative', 'negative number', '-1', !(Number.isFinite(rec) && rec < 0));
      add('number-text', 'text in a number field', 'abc', true);
      add('number-huge', 'very large number', '999999999999', false);
      break;
    }
    case 'date':
      add('date-invalid', 'impossible date', '2024-13-45', true);
      if (rule.range !== 'past' && rule.range !== 'birth') add('date-past', 'date in the past', '2000-01-01', false);
      break;
    case 'url':
      add('url-invalid', 'not a URL', 'not a url', true);
      break;
    default:
      break;
  }
  add('empty', required ? 'empty required field' : 'empty field', '', required);
  if (!['number', 'date', 'phone', 'zip'].includes(kind)) {
    add('spaces', 'only spaces', '   ', required);
    add('too-long', max ? `longer than ${max} characters` : 'very long text (300 characters)', 'x'.repeat(max ? max + 1 : 300), !!max);
    add('script', 'script in the text (must be shown as text, not run)', XSS, true, 'no-script');
  }
  return cases;
}

/**
 * The node where the form is accepted, after the field `fieldId`: the first later node whose
 * recorded result was a different page, or that sent data to the server, or an assertion.
 * Returns { nodeId, how } or null.
 */
export function acceptancePoint(flow, fieldId) {
  const field = getNode(flow, fieldId);
  const pageOf = (n) => { try { const u = new URL(n.page?.url || ''); return u.pathname; } catch { return null; } };
  const fieldPage = pageOf(field);
  let id = nextNodeId(flow, fieldId, true);
  const seen = new Set();
  while (id && !seen.has(id)) {
    seen.add(id);
    const n = getNode(flow, id);
    if (!n) break;
    if (Array.isArray(n.requests) && n.requests.some((r) => !r.status || r.status < 400)) return { nodeId: n.id, how: 'request' };
    if (n.result?.observed && n.result.url) {
      let to = null;
      try { to = new URL(n.result.url).pathname; } catch {}
      if (to && to !== (pageOf(n) || fieldPage)) return { nodeId: n.id, how: 'page' };
    }
    if (/^assert/.test(n.action || '')) return { nodeId: n.id, how: 'assert' };
    id = nextNodeId(flow, id, true);
  }
  return null;
}

/**
 * The verdict of one case from its run summary.
 * Returns { verdict: 'rejected' | 'accepted' | 'blocked' | 'script-ran' | 'safe' | 'error', message }.
 */
export function judgeCase(c, run, fieldId, accept) {
  const failed = (run.results || []).find((r) => r.status === 'failed');
  if (c.expect === 'no-script') {
    if ((run.unexpectedDialogs || []).length) return { verdict: 'script-ran', message: `A dialog opened: "${run.unexpectedDialogs[0].message}"` };
    return { verdict: 'safe', message: 'Shown as text' };
  }
  if (!failed) return { verdict: 'accepted', message: 'The app accepted the value' };
  const msg = (failed.pageMessages || [])[0] || '';
  if (failed.nodeId === fieldId) return { verdict: 'blocked', message: `The field did not take it: ${String(failed.error).split('\n')[0].slice(0, 120)}` };
  if (failed.nodeId === accept.nodeId) return { verdict: 'rejected', message: msg || String(failed.error).split('\n')[0].slice(0, 160) };
  return { verdict: 'error', message: `Stopped at ${failed.nodeId} before the form was sent: ${String(failed.error).split('\n')[0].slice(0, 140)}` };
}
