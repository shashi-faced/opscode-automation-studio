// Part 3 tools: negative tests, data sets, cleanup, GitHub issues, run history, explore, export.
// runTool in tools.mjs hands these names here with helpers (resolveFlowPath, browser session).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runFlow } from './runner/executor.mjs';
import { compileFlowToSpec } from './runner/compiler.mjs';
import { getBrowserSession, closeSession } from './cdp/session.mjs';
import { ensureFlowGraph, getNode, outgoing } from './flow/graph.mjs';
import { negativeCases, acceptancePoint, judgeCase } from './data/negative.mjs';
import { readHistory, createdValues } from './data/runData.mjs';
import { recordFinding, resolveFinding, loadIssues, saveIssues, updateIssue, issuesMarkdown } from './issues/tracker.mjs';
import { loadProject, saveProject } from './graph/project.mjs';

export const MORE_TOOL_DEFS = [
  {
    name: 'automation_flow_negative',
    description: 'Negative and boundary tests of a flow\'s form: for each field it tries wrong values (invalid email, short phone, letters in numbers, impossible dates, empty required fields, too long text, a script tag) and checks the app refuses them at the step that sends the form. A value the app accepts where it should not becomes an issue (validation-missing); a script that runs becomes a high issue (script-injection). Other fields get fresh data, so only the tested value is wrong.',
    parameters: {
      type: 'object',
      properties: {
        flow: { type: 'string', description: 'Flow ID, name or path to flow.json' },
        fields: { type: 'array', items: { type: 'string' }, description: 'Only these fields (node ids or field names); default all generated fields' },
        cases: { type: 'array', items: { type: 'string' }, description: 'Only these case ids (e.g. "email-no-at", "empty", "too-long", "script")' },
        maxCases: { type: 'number', description: 'At most this many cases (default 24)' },
      },
      required: ['flow'],
    },
  },
  {
    name: 'automation_cleanup',
    description: 'Delete the test records that replays created (the generated values in automation/data/history.json that are not cleaned yet), so test data does not pile up. Either through a recorded cleanup flow (it gets each value as {{var:cleanup.value}}) or an HTTP request template ({value} is replaced). Use dryRun to see what would be deleted first.',
    parameters: {
      type: 'object',
      properties: {
        flow: { type: 'string', description: 'The flow whose created records to clean (e.g. "Register customer")' },
        field: { type: 'string', description: 'Which field identifies a record (node id or field name); default the first generated email field' },
        cleanupFlow: { type: 'string', description: 'A flow that deletes one record, using {{var:cleanup.value}}' },
        request: { type: 'object', description: 'Instead of a flow: { method: "DELETE", url: "http://app/api/customers?email={value}", headers? }' },
        limit: { type: 'number', description: 'At most this many records (default 20)' },
        dryRun: { type: 'boolean', description: 'Only list what would be deleted' },
      },
      required: ['flow'],
    },
  },
  {
    name: 'automation_issue_export',
    description: 'Open a GitHub issue for a tracked issue (with the error, what the page said, failed requests, data used and how to reproduce), using the GitHub CLI (gh). This publishes to GitHub: ask the user first. The link is saved on the issue.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Issue id, e.g. ISS-0003' },
        repo: { type: 'string', description: 'owner/name (default: the workspace\'s GitHub repository)' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Labels to add (must exist in the repository)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'automation_issue_sync',
    description: 'Check the GitHub issues opened by automation_issue_export: a closed GitHub issue marks the tracked issue fixed (the next passing run closes it); a reopened one reopens it.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'automation_run_history',
    description: 'History of replays: per flow the pass rate, the last runs, flaky steps (failed sometimes and passed other times) and the slowest steps.',
    parameters: {
      type: 'object',
      properties: {
        flow: { type: 'string', description: 'Only this flow (id or name)' },
        feature: { type: 'string', description: 'Only flows of this feature' },
        limit: { type: 'number', description: 'Newest runs to read (default 200)' },
      },
      required: [],
    },
  },
  {
    name: 'automation_explore',
    description: 'Explore a web app from a URL: visit same-site pages by their links (in a new tab), list each page\'s forms (fields, buttons) and actions, and propose features and flows to automate. With apply: true the proposal is laid out with automation_module_plan.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Start URL (e.g. the dashboard after sign-in)' },
        maxPages: { type: 'number', description: 'Pages to visit (default 15, max 50)' },
        apply: { type: 'boolean', description: 'Lay out the proposed features and flows' },
        module: { type: 'string', description: 'Module name for the plan' },
      },
      required: ['url'],
    },
  },
  {
    name: 'automation_export',
    description: 'Export the flows as a Playwright test project (config, one test per flow and per branch path, new test data each run, files for uploads, a GitHub Actions workflow), so they run in CI on every pull request.',
    parameters: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Output folder in the workspace (default automation/playwright)' },
        feature: { type: 'string', description: 'Only flows of this feature' },
        baseUrl: { type: 'string', description: 'Base URL for the config (default the project\'s)' },
      },
      required: [],
    },
  },
];

export const MORE_TOOL_NAMES = new Set(MORE_TOOL_DEFS.map((t) => t.name));

const readJson = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x';

function loadFlow(cwd, resolveFlowPath, name) {
  const fp = resolveFlowPath(cwd, name);
  if (!fp) throw new Error(`Flow not found: ${name}`);
  return { fp, flow: ensureFlowGraph(JSON.parse(fs.readFileSync(fp, 'utf8'))) };
}

function startUrlOf(flow) {
  const u = flow.startUrl || flow.steps?.[0]?.url;
  return u && /^https?:/i.test(u) ? u : undefined;
}

async function withSession(url, fn) {
  const session = await getBrowserSession({ headless: false, url });
  try {
    return await fn(session);
  } finally {
    if (!session.isCdp) await closeSession(session);
  }
}

function findField(fields, key) {
  const k = String(key).toLowerCase();
  return fields.find((s) => s.id.toLowerCase() === k) || fields.find((s) => String(s.fieldName || s.label || '').toLowerCase() === k)
    || fields.find((s) => String(s.fieldName || s.label || '').toLowerCase().includes(k));
}

// ------------------------------------------------------------------------------------------------
// Negative tests

async function negative(params, cwd, ctx) {
  const { fp, flow } = loadFlow(cwd, ctx.resolveFlowPath, params.flow);
  let fields = flow.steps.filter((s) => s.action === 'fill');
  if (Array.isArray(params.fields) && params.fields.length) fields = params.fields.map((f) => findField(fields, f)).filter(Boolean);
  const plan = [];
  const skipped = [];
  for (const f of fields) {
    const accept = acceptancePoint(flow, f.id);
    let cases = negativeCases(f);
    if (Array.isArray(params.cases) && params.cases.length) cases = cases.filter((c) => params.cases.includes(c.id));
    if (!cases.length) continue;
    if (!accept) { skipped.push(`${f.id} ${f.fieldName || f.label}: no later step sends the form or checks the result`); continue; }
    for (const c of cases) plan.push({ field: f, accept, c });
  }
  const max = Math.max(1, Math.min(60, Number(params.maxCases) || 24));
  const todo = plan.slice(0, max);
  if (!todo.length) return { ok: true, text: `No negative cases for "${flow.name}".${skipped.length ? `\nSkipped: ${skipped.join('; ')}` : ''} Fields need a "generate" data rule (see automation_flow_data).`, data: { results: [] } };

  const results = [];
  await withSession(startUrlOf(flow), async (session) => {
    for (const { field, accept, c } of todo) {
      if (startUrlOf(flow)) await session.page.goto(startUrlOf(flow), { waitUntil: 'domcontentloaded' }).catch(() => {});
      const run = await runFlow(session, fp, {
        cwd,
        dataMode: 'fresh',
        overrides: { [field.id]: c.value },
        overrideSource: 'negative',
        untilNode: c.expect === 'no-script' ? null : accept.nodeId,
        continueOnError: c.expect === 'no-script',
        trackIssues: false,
        timeout: 4000,
      });
      const v = judgeCase(c, run, field.id, accept);
      const label = field.fieldName || field.label || field.id;
      const r = { nodeId: field.id, field: label, case: c.id, caseLabel: c.label, value: c.value.length > 40 ? `${c.value.slice(0, 37)}...` : c.value, strict: c.strict, verdict: v.verdict, message: v.message, runId: run.runId };
      const key = `negative:${c.id}`;
      const bad = (v.verdict === 'accepted' && c.strict) || v.verdict === 'script-ran';
      if (bad) {
        const f = recordFinding(cwd, flow, {
          nodeId: field.id, label: `Fill "${label}"`, action: 'fill', key,
          category: v.verdict === 'script-ran' ? 'script-injection' : 'validation-missing',
          severity: v.verdict === 'script-ran' ? 'high' : 'medium',
          title: v.verdict === 'script-ran' ? `${flow.name}: a script typed into "${label}" ran` : `${flow.name}: "${label}" accepts ${c.label}`,
          hint: v.verdict === 'script-ran' ? 'The value is put into the page as HTML. Escape it.' : `The app accepted ${c.label} ("${r.value}"). Add validation (client and server).`,
          error: v.message, runId: run.runId, runDir: run.runDir, flowPath: fp,
          dataUsed: run.dataUsed, reproduce: `automation_flow_negative { "flow": "${flow.id}", "fields": ["${field.id}"], "cases": ["${c.id}"] }`,
        });
        r.issue = f.id;
        r.issueOpened = f.opened;
      } else if (v.verdict === 'rejected' || v.verdict === 'blocked' || v.verdict === 'safe') {
        const closed = resolveFinding(cwd, flow.id, field.id, c.expect === 'no-script' ? 'script-injection' : 'validation-missing', key, run.runId);
        if (closed) r.issue = closed;
      }
      results.push(r);
    }
  });
  const icon = { rejected: '✔', blocked: '✔', safe: '✔', accepted: '✖', 'script-ran': '✖', error: '?' };
  const lines = results.map((r) => `${icon[r.verdict]} ${r.field} · ${r.caseLabel}: ${r.verdict === 'accepted' && !r.strict ? 'accepted (check if allowed)' : r.verdict}${r.message ? ` — ${r.message}` : ''}${r.issue ? ` [${r.issue}]` : ''}`);
  const bad = results.filter((r) => (r.verdict === 'accepted' && r.strict) || r.verdict === 'script-ran');
  return {
    ok: bad.length === 0,
    text: `Negative tests of "${flow.name}": ${results.length} cases, ${bad.length} problem(s)${plan.length > todo.length ? ` (${plan.length - todo.length} more cases not run: raise maxCases)` : ''}.\n${lines.join('\n')}${skipped.length ? `\nSkipped: ${skipped.join('; ')}` : ''}`,
    data: { flowId: flow.id, results, problems: bad.length, skipped },
  };
}

// ------------------------------------------------------------------------------------------------
// Data sets (CSV)

export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  const s = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',' || ch === ';' && !s.slice(0, s.indexOf('\n')).includes(',')) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c !== '')) rows.push(row);
  if (!rows.length) return { headers: [], records: [] };
  const headers = rows[0].map((h) => h.trim());
  return { headers, records: rows.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()]))) };
}

/** Map CSV columns to node ids (by id, field name, or a variable name); returns { map, unknown, varCols }. */
export function mapColumns(flow, headers) {
  const fields = flow.steps.filter((s) => s.action === 'fill' || s.action === 'select');
  const map = {}, unknown = [], varCols = [];
  for (const h of headers) {
    if (/^(expect|note|notes|#)$/i.test(h)) continue;
    if (/^var:/i.test(h)) { varCols.push(h); continue; }
    const n = findField(fields, h);
    if (n && !Object.values(map).includes(n.id)) map[h] = n.id; else unknown.push(h);
  }
  return { map, unknown, varCols };
}

export async function runDataset(params, cwd, ctx) {
  const { fp, flow } = loadFlow(cwd, ctx.resolveFlowPath, params.flow);
  const file = path.resolve(cwd, params.dataset);
  if (!fs.existsSync(file)) return { ok: false, text: `Data set not found: ${params.dataset}` };
  const { headers, records } = parseCsv(fs.readFileSync(file, 'utf8'));
  if (!records.length) return { ok: false, text: `${params.dataset} has no rows (first row = column names: field names or node ids).` };
  const { map, unknown, varCols } = mapColumns(flow, headers);
  if (!Object.keys(map).length && !varCols.length) return { ok: false, text: `No column of ${params.dataset} matches a field of "${flow.name}". Columns: ${headers.join(', ')}. Fields: ${flow.steps.filter((s) => s.action === 'fill' || s.action === 'select').map((s) => `${s.id} ${s.fieldName || s.label}`).join(', ')}` };
  const rows = records.slice(0, Math.max(1, Math.min(200, Number(params.maxRows) || 50)));
  const results = [];
  await withSession(startUrlOf(flow), async (session) => {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (startUrlOf(flow)) await session.page.goto(startUrlOf(flow), { waitUntil: 'domcontentloaded' }).catch(() => {});
      const overrides = {};
      for (const [col, id] of Object.entries(map)) if (row[col] !== '' && row[col] != null) overrides[id] = row[col];
      const vars = {};
      for (const c of varCols) vars[c.slice(4)] = row[c];
      const run = await runFlow(session, fp, { cwd, dataMode: 'fresh', overrides, overrideSource: `row ${i + 1}`, vars, inputs: params.inputs || {} });
      const expect = String(row.expect || row.Expect || 'pass').toLowerCase();
      const wantFail = /fail|reject|error/.test(expect);
      const failed = run.results.find((r) => r.status === 'failed');
      results.push({ row: i + 1, values: row, ok: wantFail ? !run.ok : run.ok, ran: run.ok ? 'passed' : 'failed', expected: wantFail ? 'fail' : 'pass', failedAt: failed?.nodeId, error: failed?.error, pageMessages: failed?.pageMessages, runId: run.runId, issues: run.issues });
    }
  });
  const okCount = results.filter((r) => r.ok).length;
  const lines = results.map((r) => `${r.ok ? '✔' : '✖'} row ${r.row} (${Object.entries(r.values).slice(0, 3).map(([k, v]) => `${k}=${v}`).join(', ')}): ${r.ran}${r.expected === 'fail' ? ' (expected to fail)' : ''}${!r.ok && r.failedAt ? ` at ${r.failedAt}: ${String(r.error || '').split('\n')[0].slice(0, 120)}` : ''}`);
  return {
    ok: okCount === results.length,
    text: `Data set ${path.basename(file)} on "${flow.name}": ${okCount}/${results.length} rows as expected.${unknown.length ? ` Columns not used: ${unknown.join(', ')}.` : ''}\n${lines.join('\n')}`,
    data: { flowId: flow.id, columns: map, unknown, results },
  };
}

// ------------------------------------------------------------------------------------------------
// Cleanup

const cleanedPath = (cwd) => path.join(cwd, 'automation', 'data', 'cleaned.json');

async function cleanup(params, cwd, ctx) {
  const { flow } = loadFlow(cwd, ctx.resolveFlowPath, params.flow);
  const fields = flow.steps.filter((s) => s.action === 'fill');
  const field = params.field ? findField(fields, params.field) : (fields.find((s) => s.data?.mode === 'generate' && s.data.kind === 'email') || fields.find((s) => s.data?.mode === 'generate'));
  if (!field) return { ok: false, text: `No generated field to identify records in "${flow.name}". Give "field".` };
  const hist = createdValues(cwd, flow.id, field.id);
  const cleaned = readJson(cleanedPath(cwd), {});
  const done = new Set(cleaned[flow.id]?.[field.id] || []);
  const todo = hist.filter((v) => !done.has(v)).slice(0, Math.max(1, Math.min(200, Number(params.limit) || 20)));
  const label = field.fieldName || field.label || field.id;
  if (!todo.length) return { ok: true, text: `Nothing to clean: every "${label}" value created by "${flow.name}" is cleaned already (${done.size}).`, data: { cleaned: [], pending: 0 } };
  if (params.dryRun || (!params.cleanupFlow && !params.request)) {
    return { ok: true, text: `${todo.length} record(s) created by "${flow.name}" (by ${label}):\n${todo.map((v) => `- ${v}`).join('\n')}${!params.cleanupFlow && !params.request ? '\n\nGive cleanupFlow (a flow that deletes one record using {{var:cleanup.value}}) or request { method, url with {value} } to delete them.' : ''}`, data: { pending: todo } };
  }
  const results = [];
  if (params.request) {
    const method = String(params.request.method || 'DELETE').toUpperCase();
    for (const v of todo) {
      const url = String(params.request.url || '').replace(/\{value\}/g, encodeURIComponent(v));
      try {
        const res = await fetch(url, { method, headers: params.request.headers || {} });
        results.push({ value: v, ok: res.ok || res.status === 404, status: res.status });
      } catch (e) {
        results.push({ value: v, ok: false, error: e.message });
      }
    }
  } else {
    const cf = loadFlow(cwd, ctx.resolveFlowPath, params.cleanupFlow);
    await withSession(startUrlOf(cf.flow), async (session) => {
      for (const v of todo) {
        if (startUrlOf(cf.flow)) await session.page.goto(startUrlOf(cf.flow), { waitUntil: 'domcontentloaded' }).catch(() => {});
        const run = await runFlow(session, cf.fp, { cwd, dataMode: 'fresh', vars: { 'cleanup.value': v }, trackIssues: false });
        const failed = run.results.find((r) => r.status === 'failed');
        results.push({ value: v, ok: run.ok, error: failed?.error, runId: run.runId });
      }
    });
  }
  const ok = results.filter((r) => r.ok).map((r) => r.value);
  if (ok.length) {
    cleaned[flow.id] = cleaned[flow.id] || {};
    cleaned[flow.id][field.id] = [...done, ...ok];
    fs.mkdirSync(path.dirname(cleanedPath(cwd)), { recursive: true });
    fs.writeFileSync(cleanedPath(cwd), JSON.stringify(cleaned, null, 2), 'utf8');
  }
  return {
    ok: ok.length === results.length,
    text: `Cleaned ${ok.length}/${results.length} record(s) created by "${flow.name}".\n${results.map((r) => `${r.ok ? '✔' : '✖'} ${r.value}${r.ok ? '' : ` — ${String(r.error || r.status || '').split('\n')[0].slice(0, 120)}`}`).join('\n')}`,
    data: { results, remaining: hist.length - done.size - ok.length },
  };
}

// ------------------------------------------------------------------------------------------------
// GitHub

function gh(args, cwd, input) {
  return execFileSync(process.env.OPSCODE_GH || 'gh', args, { cwd, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], timeout: 60000 }).trim();
}

export function issueBody(i) {
  const lines = [
    `**Found by Opscode Automation Studio** (${i.id}, ${i.category}, ${i.severity})`,
    '',
    `**Where:** ${i.flow.feature ? `${i.flow.feature} › ` : ''}${i.flow.name} › step ${i.node.id} "${i.node.label}" (${i.node.action})`,
    `**Error:** ${String(i.error || '').split('\n')[0]}`,
  ];
  if (i.hint) lines.push(`**Likely cause:** ${i.hint}`);
  if (i.pageUrl) lines.push(`**Page:** ${i.pageUrl}`);
  if (i.pageMessages?.length) lines.push(`**The page said:** ${i.pageMessages.map((m) => `"${m}"`).join(', ')}`);
  if (i.failedRequests?.length) lines.push(`**Failed requests:** ${i.failedRequests.map((r) => `\`${r.method} ${r.url} → ${r.status || r.errorText}\``).join(', ')}`);
  if (i.consoleErrors?.length) lines.push(`**Console:** ${i.consoleErrors.map((c) => `\`${c}\``).join(' ')}`);
  const data = (i.dataUsed || []).filter((d) => d.source !== 'secret');
  if (data.length) lines.push('', '**Data used:**', ...data.map((d) => `- ${d.field || d.nodeId}: \`${d.value}\``));
  lines.push('', `**Seen:** ${i.occurrences}× (first ${i.firstSeen}, last ${i.lastSeen})`);
  if (i.lastRun?.screenshot) lines.push(`**Screenshot (in the workspace):** \`${i.lastRun.screenshot}\``);
  lines.push('', '**Reproduce** (in Opscode, Automation Studio):', '```', i.reproduce, '```');
  return lines.join('\n');
}

async function issueExport(params, cwd) {
  const store = loadIssues(cwd);
  const i = store.issues.find((x) => x.id.toLowerCase() === String(params.id).toLowerCase());
  if (!i) return { ok: false, text: `Issue ${params.id} not found.` };
  if (i.external?.url) return { ok: true, text: `${i.id} is already on GitHub: ${i.external.url}`, data: i.external };
  let repo = params.repo;
  try {
    if (!repo) repo = gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], cwd);
  } catch (e) {
    return { ok: false, text: `No GitHub repository: give "repo" (owner/name). ${String(e.stderr || e.message).split('\n')[0]}` };
  }
  const args = ['issue', 'create', '--repo', repo, '--title', `[Automation] ${i.title}`, '--body-file', '-'];
  for (const l of params.labels || []) args.push('--label', l);
  let url;
  try {
    url = gh(args, cwd, issueBody(i)).split('\n').pop();
  } catch (e) {
    return { ok: false, text: `gh issue create failed: ${String(e.stderr || e.message).split('\n')[0]}` };
  }
  const num = Number(/\/issues\/(\d+)/.exec(url)?.[1]) || null;
  i.external = { system: 'github', repo, number: num, url, state: 'OPEN', at: new Date().toISOString() };
  i.history.push({ at: new Date().toISOString(), status: i.status, by: 'agent', note: `Sent to GitHub: ${url}` });
  saveIssues(cwd, store);
  return { ok: true, text: `${i.id} → ${url}`, data: i.external };
}

async function issueSync(params, cwd) {
  const store = loadIssues(cwd);
  const linked = store.issues.filter((i) => i.external?.system === 'github' && i.external.number);
  if (!linked.length) return { ok: true, text: 'No issues are linked to GitHub yet (automation_issue_export).', data: { changed: [] } };
  const changed = [], errors = [];
  for (const i of linked) {
    let state;
    try {
      state = gh(['issue', 'view', String(i.external.number), '--repo', i.external.repo, '--json', 'state', '-q', '.state'], cwd).toUpperCase();
    } catch (e) {
      errors.push(`${i.id}: ${String(e.stderr || e.message).split('\n')[0]}`);
      continue;
    }
    const was = i.external.state;
    i.external.state = state;
    if (state === 'CLOSED' && (i.status === 'open')) {
      i.status = 'fixed';
      i.history.push({ at: new Date().toISOString(), status: 'fixed', by: 'github', note: `GitHub issue #${i.external.number} closed: marked fixed, verify with a run` });
      changed.push(`${i.id} fixed (GitHub #${i.external.number} closed)`);
    } else if (state === 'OPEN' && was === 'CLOSED' && (i.status === 'fixed' || i.status === 'closed')) {
      i.status = 'open';
      i.history.push({ at: new Date().toISOString(), status: 'open', by: 'github', note: `GitHub issue #${i.external.number} reopened` });
      changed.push(`${i.id} reopened (GitHub #${i.external.number} reopened)`);
    }
  }
  saveIssues(cwd, store);
  const verify = store.issues.filter((i) => i.status === 'fixed').map((i) => i.reproduce).filter(Boolean);
  return {
    ok: errors.length === 0,
    text: `${linked.length} linked issue(s) checked. ${changed.length ? changed.join('; ') : 'No change.'}${errors.length ? `\nErrors: ${errors.join('; ')}` : ''}${verify.length ? `\nVerify the fixed ones:\n${verify.join('\n')}` : ''}`,
    data: { changed, errors },
  };
}

// ------------------------------------------------------------------------------------------------
// Run history

export function runHistory(cwd, { flow, feature, limit = 200 } = {}) {
  const dir = path.join(cwd, 'automation', 'runs');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.startsWith('run-')); } catch {}
  names.sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  const runs = [];
  for (const n of names.slice(0, Math.max(1, Math.min(1000, Number(limit) || 200)))) {
    const s = readJson(path.join(dir, n, 'run-summary.json'));
    if (s) runs.push(s);
  }
  let project = null;
  try { project = loadProject(cwd); } catch {}
  const featureOf = (id) => project?.features.find((f) => (f.flows || []).some((x) => x.id === id))?.name || null;
  const want = (s) => (!flow || [s.flowId, s.flowName].some((x) => String(x || '').toLowerCase() === String(flow).toLowerCase()))
    && (!feature || String(featureOf(s.flowId) || '').toLowerCase() === String(feature).toLowerCase());
  const byFlow = new Map();
  for (const s of runs.filter(want)) {
    if (!byFlow.has(s.flowId)) byFlow.set(s.flowId, []);
    byFlow.get(s.flowId).push(s);
  }
  const flows = [];
  for (const [id, list] of byFlow) {
    const nodes = new Map();
    for (const s of list) {
      for (const r of s.results || []) {
        if (!r.nodeId) continue;
        const n = nodes.get(r.nodeId) || { nodeId: r.nodeId, label: r.label || r.description || '', passed: 0, failed: 0, durations: [] };
        if (r.status === 'failed') n.failed++; else n.passed++;
        if (Number.isFinite(r.durationMs)) n.durations.push(r.durationMs);
        nodes.set(r.nodeId, n);
      }
    }
    const nodeList = [...nodes.values()].map((n) => ({ ...n, avgMs: n.durations.length ? Math.round(n.durations.reduce((a, b) => a + b, 0) / n.durations.length) : 0, durations: undefined }));
    const passed = list.filter((s) => s.ok).length;
    flows.push({
      flowId: id,
      flowName: list[0].flowName,
      feature: featureOf(id),
      runs: list.length,
      passed,
      passRate: Math.round((passed / list.length) * 100),
      last: list.slice(0, 10).map((s) => (s.ok ? 'P' : 'F')).join(''),
      lastRunAt: list[0].timestamp,
      avgDurationMs: Math.round(list.reduce((a, s) => a + (s.durationMs || 0), 0) / list.length),
      flaky: nodeList.filter((n) => n.failed && n.passed).sort((a, b) => b.failed - a.failed).slice(0, 5),
      failing: nodeList.filter((n) => n.failed && !n.passed).slice(0, 5),
      slowest: [...nodeList].sort((a, b) => b.avgMs - a.avgMs).slice(0, 3),
    });
  }
  flows.sort((a, b) => a.passRate - b.passRate || b.runs - a.runs);
  return { totalRuns: runs.length, flows };
}

// ------------------------------------------------------------------------------------------------
// Explore

async function explore(params, cwd, ctx) {
  if (!params.url) return { ok: false, text: 'Missing "url".' };
  const start = /^https?:/i.test(params.url) ? params.url : `https://${params.url}`;
  const origin = new URL(start).origin;
  const maxPages = Math.max(1, Math.min(50, Number(params.maxPages) || 15));
  const session = await getBrowserSession({ headless: false });
  const page = session.context?.newPage ? await session.context.newPage() : session.page;
  const pages = [];
  const queue = [start];
  const seen = new Set();
  const key = (u) => { try { const x = new URL(u); return x.origin + x.pathname.replace(/\/\d+(?=\/|$)/g, '/:id'); } catch { return u; } };
  try {
    while (queue.length && pages.length < maxPages) {
      const url = queue.shift();
      if (seen.has(key(url))) continue;
      seen.add(key(url));
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(300);
      } catch (e) {
        pages.push({ url, error: e.message.split('\n')[0] });
        continue;
      }
      const info = await page.evaluate(() => {
        const text = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 60);
        const labelOf = (el) => (el.labels && el.labels[0] ? text(el.labels[0]) : '') || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.name || el.id || '';
        const forms = [...document.querySelectorAll('form')].map((f) => ({
          fields: [...f.querySelectorAll('input, select, textarea')].filter((e) => !['hidden', 'submit', 'button'].includes(e.type)).map((e) => ({ label: labelOf(e), type: e.type || e.tagName.toLowerCase(), required: !!e.required })).slice(0, 20),
          submit: text(f.querySelector('button[type=submit], button:not([type]), input[type=submit]') || f) || 'Submit',
        }));
        const loose = [...document.querySelectorAll('input, select, textarea')].filter((e) => !e.closest('form') && !['hidden', 'submit', 'button'].includes(e.type));
        if (loose.length) forms.push({ fields: loose.map((e) => ({ label: labelOf(e), type: e.type || e.tagName.toLowerCase(), required: !!e.required })).slice(0, 20), submit: text(document.querySelector('button') || document.body).slice(0, 40), loose: true });
        return {
          title: document.title,
          heading: text(document.querySelector('h1') || document.body).slice(0, 60),
          forms,
          buttons: [...document.querySelectorAll('button, [role=button]')].map(text).filter(Boolean).slice(0, 15),
          links: [...document.querySelectorAll('a[href]')].map((a) => ({ href: a.href, text: text(a) })).slice(0, 200),
        };
      });
      pages.push({ url, path: new URL(url).pathname, title: info.title, heading: info.heading, forms: info.forms, buttons: info.buttons });
      for (const l of info.links) {
        try {
          const u = new URL(l.href);
          if (u.origin !== origin || /logout|sign-?out/i.test(u.pathname + l.text) || /\.(pdf|zip|png|jpe?g|csv|xlsx?)$/i.test(u.pathname)) continue;
          u.hash = '';
          if (!seen.has(key(u.href))) queue.push(u.href);
        } catch {}
      }
    }
  } finally {
    if (page !== session.page) await page.close().catch(() => {});
    if (!session.isCdp) await closeSession(session);
  }
  // Proposal: a feature per first path segment; a flow per form, and one to open each page.
  const features = new Map();
  const cap = (s) => String(s || 'Home').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  for (const p of pages.filter((x) => !x.error)) {
    const seg = (p.path || '/').split('/').filter(Boolean)[0] || 'home';
    const fname = cap(seg);
    if (!features.has(fname)) features.set(fname, { name: fname, flows: [] });
    const f = features.get(fname);
    for (const form of p.forms) {
      if (!form.fields.length) continue;
      const name = `${cap(form.submit).slice(0, 40)} (${p.heading || p.title || p.path})`.slice(0, 70);
      if (!f.flows.some((x) => x.name === name)) f.flows.push({ name, url: p.url, description: `Fill ${form.fields.map((x) => x.label || x.type).slice(0, 6).join(', ')} and press "${form.submit}"` });
    }
    if (!p.forms.some((x) => x.fields.length)) {
      const name = `Open ${p.heading || p.title || p.path}`.slice(0, 70);
      if (!f.flows.some((x) => x.name === name)) f.flows.push({ name, url: p.url, description: `Open ${p.path} and check it shows "${p.heading || p.title}"` });
    }
  }
  const proposal = [...features.values()].filter((f) => f.flows.length);
  let applied = null;
  if (params.apply && proposal.length) {
    applied = await ctx.runTool('automation_module_plan', { module: params.module || new URL(start).host, baseUrl: origin, features: proposal });
  }
  const outline = proposal.map((f) => `- ${f.name}: ${f.flows.map((x) => x.name).join('; ')}`).join('\n');
  const pageLines = pages.map((p) => p.error ? `✖ ${p.url}: ${p.error}` : `${p.path} "${p.heading || p.title}"${p.forms.length ? ` · ${p.forms.length} form(s): ${p.forms.map((f) => `${f.fields.length} fields → ${f.submit}`).join('; ')}` : ''}`).join('\n');
  return {
    ok: true,
    text: `Explored ${pages.length} page(s) of ${origin}${queue.length ? ` (more links not visited: raise maxPages)` : ''}:\n${pageLines}\n\nProposed features and flows:\n${outline || '(none)'}${applied ? `\n\n${applied.text.split('\n')[0]}` : '\n\nCall again with apply: true to lay these out, then record each flow.'}`,
    data: { pages, proposal, applied: applied?.data || null },
  };
}

// ------------------------------------------------------------------------------------------------
// Export to a Playwright project

/** Paths through a flow graph from its entry (each decision splits); at most `max`. */
export function flowPaths(flow, max = 8) {
  const out = [];
  const walk = (id, acc, labels, seen) => {
    if (out.length >= max) return;
    if (!id || seen.has(id)) { out.push({ nodes: acc, labels }); return; }
    const n = getNode(flow, id);
    if (!n) { out.push({ nodes: acc, labels }); return; }
    const next = [...acc, id];
    const s2 = new Set(seen).add(id);
    const outs = outgoing(flow, id);
    if (!outs.length) { out.push({ nodes: next, labels }); return; }
    if (n.action === 'decision') {
      for (const e of outs.sort((a, b) => (a.kind === 'yes' ? -1 : b.kind === 'yes' ? 1 : 0))) walk(e.target, next, [...labels, `${n.label || n.id}: ${e.kind}`], s2);
    } else {
      walk((outs.find((e) => e.kind === 'next') || outs[0]).target, next, labels, s2);
    }
  };
  walk(flow.entry || flow.steps?.[0]?.id, [], [], new Set());
  return out;
}

async function exportProject(params, cwd) {
  const project = loadProject(cwd);
  const outDir = path.resolve(cwd, params.dir || 'automation/playwright');
  const feats = project.features.filter((f) => !params.feature || f.name.toLowerCase() === String(params.feature).toLowerCase() || f.id === params.feature);
  const written = [];
  const notes = [];
  fs.mkdirSync(path.join(outDir, 'tests'), { recursive: true });
  for (const f of feats) {
    for (const fl of f.flows || []) {
      const fp = path.resolve(cwd, fl.flowPath || '');
      const raw = readJson(fp);
      if (!raw || !raw.steps?.length) { notes.push(`${fl.name}: no steps (not recorded yet)`); continue; }
      const flow = ensureFlowGraph(raw);
      const paths = flowPaths(flow);
      const specs = paths.map((p, i) => {
        const title = p.labels.length ? `${flow.name} — ${p.labels.join(', ')}` : flow.name;
        const spec = compileFlowToSpec(flow, { path: p.nodes, testTitle: title });
        // only keep the test body for paths after the first, in one file
        return i === 0 ? spec : spec.slice(spec.indexOf(`  test(`), spec.lastIndexOf('});'));
      });
      let file = specs[0];
      if (specs.length > 1) {
        const tail = specs.slice(1).map((s) => s.replace(/^  test\(/, '  test.skip(!process.env.RUN_BRANCHES, \'set RUN_BRANCHES=1 and the inputs this branch needs\');\n  test(')).join('');
        file = file.slice(0, file.lastIndexOf('});')) + tail + '});\n';
      }
      if (flow.steps.some((s) => /\{\{var:/.test(JSON.stringify(s.value || s.url || '')))) notes.push(`${flow.name}: uses variables from other flows; set VAR_<NAME> environment variables or run the flows in order`);
      const rel = path.join('tests', slug(f.name), `${slug(flow.name)}.spec.ts`);
      fs.mkdirSync(path.dirname(path.join(outDir, rel)), { recursive: true });
      fs.writeFileSync(path.join(outDir, rel), file, 'utf8');
      written.push(rel);
    }
  }
  // files for uploads
  const filesSrc = path.join(cwd, 'automation', 'files');
  if (fs.existsSync(filesSrc)) fs.cpSync(filesSrc, path.join(outDir, 'files'), { recursive: true });
  const baseUrl = params.baseUrl || project.baseUrl || '';
  fs.writeFileSync(path.join(outDir, 'package.json'), JSON.stringify({ name: `${slug(project.name || 'app')}-automation-tests`, private: true, scripts: { test: 'playwright test', report: 'playwright show-report' }, devDependencies: { '@playwright/test': '^1.48.0' } }, null, 2) + '\n');
  fs.writeFileSync(path.join(outDir, 'playwright.config.ts'), `import { defineConfig, devices } from '@playwright/test';

// Exported by Opscode Automation Studio. Secrets and inputs come from environment variables
// (process.env.<NAME>); see README.md.
export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.BASE_URL || ${JSON.stringify(baseUrl)},
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
`);
  fs.mkdirSync(path.join(outDir, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(outDir, '.github', 'workflows', 'automation-tests.yml'), `# Copy to .github/workflows/ at the root of your repository (adjust working-directory).
name: Automation tests
on: [pull_request, workflow_dispatch]
jobs:
  test:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: ${path.relative(cwd, outDir) || '.'}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm install
      - run: npx playwright install --with-deps chromium
      - run: npx playwright test
        env:
          BASE_URL: \${{ vars.BASE_URL }}
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: playwright-report
          path: ${path.relative(cwd, outDir) || '.'}/playwright-report
`);
  const envNames = new Set();
  for (const rel of written) for (const m of fs.readFileSync(path.join(outDir, rel), 'utf8').matchAll(/process\.env\.([A-Z0-9_]+)/g)) envNames.add(m[1]);
  fs.writeFileSync(path.join(outDir, 'README.md'), `# Automation tests (exported)

Exported by Opscode Automation Studio from \`automation/\`. Each flow is a test; a flow with
decisions has one test per path (branches after the first run with \`RUN_BRANCHES=1\`). Form fields
with a "generate" data rule get new values on every run.

\`\`\`bash
npm install
npx playwright install chromium
BASE_URL=http://localhost:3000 npx playwright test
\`\`\`

Environment variables used: ${[...envNames].filter((n) => n !== 'BASE_URL').join(', ') || 'none'}.
${notes.length ? `\nNotes:\n${notes.map((n) => `- ${n}`).join('\n')}\n` : ''}`);
  return {
    ok: true,
    text: `Exported ${written.length} test file(s) to ${path.relative(cwd, outDir)}/ (config, README, CI workflow${fs.existsSync(path.join(outDir, 'files')) ? ', upload files' : ''}).\n${written.map((w) => `- ${w}`).join('\n')}${notes.length ? `\nNotes:\n${notes.map((n) => `- ${n}`).join('\n')}` : ''}`,
    data: { dir: path.relative(cwd, outDir), files: written, env: [...envNames], notes },
  };
}

// ------------------------------------------------------------------------------------------------

export async function runMoreTool(name, params, cwd, ctx) {
  switch (name) {
    case 'automation_flow_negative': return negative(params, cwd, ctx);
    case 'automation_cleanup': return cleanup(params, cwd, ctx);
    case 'automation_issue_export': return issueExport(params, cwd);
    case 'automation_issue_sync': return issueSync(params, cwd);
    case 'automation_run_history': {
      const h = runHistory(cwd, params);
      if (!h.flows.length) return { ok: true, text: 'No runs yet.', data: h };
      const lines = h.flows.map((f) => `${f.flowName}${f.feature ? ` (${f.feature})` : ''}: ${f.passRate}% of ${f.runs} runs passed, last ${f.last} (newest first), avg ${(f.avgDurationMs / 1000).toFixed(1)}s${f.flaky.length ? `; flaky: ${f.flaky.map((n) => `${n.nodeId} ${n.label} (${n.failed}/${n.failed + n.passed} failed)`).join(', ')}` : ''}${f.failing.length ? `; always failing: ${f.failing.map((n) => n.nodeId).join(', ')}` : ''}${f.slowest[0]?.avgMs > 1000 ? `; slowest: ${f.slowest[0].nodeId} ${(f.slowest[0].avgMs / 1000).toFixed(1)}s` : ''}`);
      return { ok: true, text: `${h.totalRuns} runs read.\n${lines.join('\n')}`, data: h };
    }
    case 'automation_explore': return explore(params, cwd, ctx);
    case 'automation_export': return exportProject(params, cwd);
    default: return { ok: false, text: `Unknown tool "${name}".` };
  }
}
