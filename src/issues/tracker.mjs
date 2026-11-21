// Failures of replays become issues a developer can track: one issue per failing node and error
// shape, with what the page said, failed requests, the data used, a screenshot and how to
// reproduce. Status: open -> fixed (developer) -> closed (a later run passed); a failure after
// "fixed" or "closed" reopens the issue as a regression.

import fs from 'node:fs';
import path from 'node:path';

export const ISSUE_STATUSES = ['open', 'fixed', 'closed', 'wont_fix'];

export function issuesDir(cwd) {
  return path.join(cwd, 'automation', 'issues');
}

export function loadIssues(cwd) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(issuesDir(cwd), 'issues.json'), 'utf8'));
    return { version: 1, nextNumber: 1, issues: [], ...data };
  } catch {
    return { version: 1, nextNumber: 1, issues: [] };
  }
}

export function saveIssues(cwd, store) {
  fs.mkdirSync(issuesDir(cwd), { recursive: true });
  fs.writeFileSync(path.join(issuesDir(cwd), 'issues.json'), JSON.stringify(store, null, 2), 'utf8');
  fs.writeFileSync(path.join(issuesDir(cwd), 'ISSUES.md'), issuesMarkdown(store), 'utf8');
}

/** Error text with run-specific parts (numbers, ids, quoted values, hosts) removed. */
export function errorShape(error) {
  return String(error || '')
    .split('\n')[0]
    .replace(/https?:\/\/[^\s"')]+/g, (u) => {
      try { return new URL(u).pathname.replace(/\d+/g, '#'); } catch { return '<url>'; }
    })
    .replace(/"[^"]*"/g, '"…"')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

/** Same flow, node, error shape and cause = same issue. */
export function fingerprint(flowId, nodeId, error, category = '') {
  return `${flowId}|${nodeId}|${category}|${errorShape(error)}`;
}

/** Sort a failure into a category a developer can act on. */
export function categorize({ error, pageMessages = [], failedRequests = [], action }) {
  const e = String(error || '');
  if (/^Missing value/.test(e)) return { category: 'missing-data', hint: 'Test setup: a secret or input value is missing; not an app bug.' };
  if (failedRequests.some((r) => r.status >= 500 || r.status === 0)) {
    const r = failedRequests.find((x) => x.status >= 500 || x.status === 0);
    return { category: 'server-error', hint: `The server failed: ${r.method} ${r.url} -> ${r.status || r.errorText || 'no response'}.` };
  }
  if (/Expected this step to lead to/.test(e)) {
    if (pageMessages.length) return { category: 'app-rejected-input', hint: `The app stayed on the page and said: "${pageMessages[0]}". Check the data used (duplicate or invalid value?) or the validation.` };
    if (failedRequests.length) return { category: 'server-error', hint: `A request failed: ${failedRequests[0].method} ${failedRequests[0].url} -> ${failedRequests[0].status}.` };
    return { category: 'wrong-result', hint: 'The action did not lead to the page it led to when recorded.' };
  }
  if (/Assertion failed/.test(e)) return { category: 'wrong-result', hint: 'The page does not show what the flow expects.' };
  if (/net::|ERR_|Navigation|goto|ECONNREFUSED/i.test(e)) return { category: 'page-load', hint: 'The page did not load: is the app running?' };
  if (/not visible|waitFor|Timeout|locate|no element|resolve|not found|has no size/i.test(e)) {
    return { category: 'element-not-found', hint: `The ${action === 'fill' ? 'field' : 'element'} was not found: the UI changed, or the page before it did not load as expected.` };
  }
  return { category: 'other', hint: '' };
}

function severityOf(category) {
  if (category === 'server-error' || category === 'page-load') return 'high';
  if (category === 'missing-data') return 'low';
  return 'medium';
}

const rel = (cwd, p) => (p ? path.relative(cwd, p) : null);

/**
 * Update the issue list after a run. Returns { opened, updated, reopened, closed } as issue ids.
 * `run` is the run summary of executor.runFlow (with results, dataUsed, runId, runDir).
 */
export function recordRunIssues(cwd, flow, run) {
  const store = loadIssues(cwd);
  const now = new Date().toISOString();
  const flowId = flow.id || run.flowId;
  const out = { opened: [], updated: [], reopened: [], closed: [] };
  const failed = (run.results || []).filter((r) => r.status === 'failed');
  const passedNodes = new Set((run.results || []).filter((r) => r.status === 'passed' || r.status === 'healed').map((r) => r.nodeId));
  const dataUsed = (run.dataUsed || []).map((d) => ({ nodeId: d.nodeId, field: d.field, value: d.value, source: d.source }));
  const reproduce = `automation_flow_run { "flow": "${flowId}", "replayRun": "${run.runId}" }`;

  const failedPrints = new Set();
  for (const r of failed) {
    const failedRequests = (r.failedRequests || []).slice(0, 5);
    const pageMessages = (r.pageMessages || []).slice(0, 5);
    const { category, hint } = categorize({ error: r.error, pageMessages, failedRequests, action: r.action });
    const fp = fingerprint(flowId, r.nodeId, r.error, category);
    failedPrints.add(fp);
    const runRef = { runId: run.runId, at: now, status: 'fail', runDir: rel(cwd, run.runDir), screenshot: rel(cwd, r.failureScreenshot), dataMode: run.dataMode };
    let issue = store.issues.find((i) => i.fingerprint === fp);
    if (issue) {
      const wasDone = issue.status === 'fixed' || issue.status === 'closed';
      issue.occurrences = (issue.occurrences || 1) + 1;
      issue.lastSeen = now;
      issue.lastRun = runRef;
      issue.runs = [...(issue.runs || []), runRef].slice(-20);
      issue.pageMessages = pageMessages.length ? pageMessages : issue.pageMessages;
      issue.failedRequests = failedRequests.length ? failedRequests : issue.failedRequests;
      issue.dataUsed = dataUsed;
      issue.reproduce = reproduce;
      issue.category = category;
      issue.hint = hint;
      if (wasDone) {
        issue.history.push({ at: now, status: 'open', by: 'run', note: `Failed again in ${run.runId} after it was marked ${issue.status}: regression.` });
        issue.status = 'open';
        issue.regression = true;
        out.reopened.push(issue.id);
      } else if (issue.status === 'wont_fix') {
        out.updated.push(issue.id);
      } else {
        out.updated.push(issue.id);
      }
      continue;
    }
    const id = `ISS-${String(store.nextNumber++).padStart(4, '0')}`;
    issue = {
      id,
      fingerprint: fp,
      status: 'open',
      severity: severityOf(category),
      category,
      title: `${flow.name || flowId}: "${r.label || r.description || r.nodeId}" failed`,
      hint,
      flow: { id: flowId, name: flow.name || flowId, feature: flow.feature || null, path: rel(cwd, run.flowPath) },
      node: { id: r.nodeId, label: r.label || '', action: r.action, description: r.description || '' },
      error: String(r.error || '').slice(0, 600),
      pageUrl: r.pageUrl || null,
      pageMessages,
      failedRequests,
      consoleErrors: (r.consoleErrorTexts || []).slice(0, 5),
      aiDiagnosis: r.aiDiagnosis?.explanation ? String(r.aiDiagnosis.explanation).slice(0, 400) : undefined,
      dataUsed,
      reproduce,
      firstSeen: now,
      lastSeen: now,
      occurrences: 1,
      lastRun: runRef,
      runs: [runRef],
      assignee: null,
      history: [{ at: now, status: 'open', by: 'run', note: `Opened by ${run.runId}` }],
    };
    store.issues.push(issue);
    out.opened.push(id);
  }

  // A run that passes a node again: a "fixed" issue there is verified and closed.
  for (const issue of store.issues) {
    if (issue.flow.id !== flowId || !passedNodes.has(issue.node.id)) continue;
    if (failedPrints.has(issue.fingerprint)) continue;
    if (issue.status === 'fixed') {
      issue.status = 'closed';
      issue.closedAt = now;
      issue.history.push({ at: now, status: 'closed', by: 'run', note: `Verified: ${run.runId} passed this step.` });
      out.closed.push(issue.id);
    } else if (issue.status === 'open') {
      issue.lastPassed = { runId: run.runId, at: now };
      if (!issue.history.some((h) => h.note?.startsWith('Passed again'))) {
        issue.history.push({ at: now, status: 'open', by: 'run', note: `Passed again in ${run.runId} without a fix: flaky, or depends on the data used.` });
      }
    }
  }

  if (failed.length || out.closed.length || store.issues.some((i) => i.lastPassed?.runId === run.runId)) saveIssues(cwd, store);
  return out;
}

export function listIssues(cwd, { status, flow, all = false } = {}) {
  const store = loadIssues(cwd);
  let list = store.issues;
  if (status && status !== 'all') list = list.filter((i) => i.status === status);
  else if (!all && !status) list = list.filter((i) => i.status === 'open' || i.status === 'fixed');
  if (flow) {
    const f = String(flow).toLowerCase();
    list = list.filter((i) => i.flow.id.toLowerCase() === f || i.flow.name.toLowerCase() === f || (i.flow.path || '').toLowerCase().includes(f));
  }
  return list;
}

export function updateIssue(cwd, id, { status, note, assignee, by = 'user' } = {}) {
  const store = loadIssues(cwd);
  const issue = store.issues.find((i) => i.id.toLowerCase() === String(id).toLowerCase());
  if (!issue) throw new Error(`Issue ${id} not found.`);
  const now = new Date().toISOString();
  if (status) {
    if (!ISSUE_STATUSES.includes(status)) throw new Error(`Unknown status "${status}". Use ${ISSUE_STATUSES.join(', ')}.`);
    issue.status = status;
    if (status === 'closed') issue.closedAt = now;
    if (status === 'open') delete issue.closedAt;
  }
  if (assignee !== undefined) issue.assignee = assignee || null;
  issue.history.push({ at: now, status: issue.status, by, note: note || (status ? `Marked ${status}` : assignee !== undefined ? `Assigned to ${assignee || 'nobody'}` : 'Note') });
  saveIssues(cwd, store);
  return issue;
}

export function issueLine(i) {
  return `${i.id} [${i.status}${i.regression ? ', regression' : ''}] ${i.severity} ${i.category}: ${i.flow.name} › ${i.node.label || i.node.id} (${i.occurrences}×) ${i.hint || i.error.split('\n')[0]}`;
}

export function issuesMarkdown(store) {
  const order = { open: 0, fixed: 1, wont_fix: 2, closed: 3 };
  const list = [...store.issues].sort((a, b) => (order[a.status] - order[b.status]) || b.lastSeen.localeCompare(a.lastSeen));
  const lines = ['# Automation issues', '', 'Written by Automation Studio after each replay. Mark an issue fixed with', '`automation_issue_update { "id": "ISS-0001", "status": "fixed" }` (or in the Graph tab); the next', 'passing run closes it, a failing one reopens it.', ''];
  const open = list.filter((i) => i.status === 'open').length;
  lines.push(`Open: ${open} · Fixed, waiting for a run: ${list.filter((i) => i.status === 'fixed').length} · Closed: ${list.filter((i) => i.status === 'closed').length}`, '');
  for (const i of list) {
    lines.push(`## ${i.id} · ${i.status.toUpperCase()}${i.regression ? ' (regression)' : ''} · ${i.title}`, '');
    lines.push(`- **Where:** ${i.flow.feature ? `${i.flow.feature} › ` : ''}${i.flow.name} › ${i.node.id} ${i.node.label} (${i.node.action})`);
    lines.push(`- **Category:** ${i.category} (${i.severity})${i.hint ? `: ${i.hint}` : ''}`);
    lines.push(`- **Error:** ${i.error.split('\n')[0]}`);
    if (i.pageUrl) lines.push(`- **Page:** ${i.pageUrl}`);
    if (i.pageMessages?.length) lines.push(`- **Page said:** ${i.pageMessages.map((m) => `"${m}"`).join(', ')}`);
    if (i.failedRequests?.length) lines.push(`- **Failed requests:** ${i.failedRequests.map((r) => `${r.method} ${r.url} → ${r.status || r.errorText}`).join('; ')}`);
    if (i.consoleErrors?.length) lines.push(`- **Console:** ${i.consoleErrors.join(' | ')}`);
    if (i.dataUsed?.length) lines.push(`- **Data used:** ${i.dataUsed.map((d) => `${d.field || d.nodeId} = ${d.value}`).join(', ')}`);
    if (i.lastRun?.screenshot) lines.push(`- **Screenshot:** ${i.lastRun.screenshot}`);
    lines.push(`- **Seen:** ${i.occurrences}× (first ${i.firstSeen.slice(0, 16).replace('T', ' ')}, last ${i.lastSeen.slice(0, 16).replace('T', ' ')})${i.assignee ? ` · assigned to ${i.assignee}` : ''}`);
    lines.push(`- **Reproduce:** \`${i.reproduce}\``);
    const notes = i.history.filter((h) => h.by !== 'run' || h.status !== 'open' || /Passed again|regression/.test(h.note));
    if (notes.length) lines.push(`- **History:** ${notes.map((h) => `${h.at.slice(0, 16).replace('T', ' ')} ${h.note}`).join('; ')}`);
    lines.push('');
  }
  return lines.join('\n');
}
