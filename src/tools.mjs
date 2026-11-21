import path from 'node:path';
import fs from 'node:fs';
import { getBrowserSession, closeSession } from './cdp/session.mjs';
import { startRecordingDaemon, stopRecording, getRecordingStatus } from './recorder/recorder.mjs';
import { performStep, STEP_ACTIONS } from './recorder/stepTool.mjs';
import { applyDataRules, normalizeRule, describeRule, DATA_KINDS, DATA_MODES } from './data/generate.mjs';
import { planRunData, readHistory } from './data/runData.mjs';
import { listIssues, updateIssue, issueLine, ISSUE_STATUSES } from './issues/tracker.mjs';
import { ensureFlowGraph, summarizeFlowGraph, getNode } from './flow/graph.mjs';
import { runFlow } from './runner/executor.mjs';
import { compileFlowFile, compileFlowToSpec } from './runner/compiler.mjs';
import { commitHealedFlow } from './runner/autoUpdater.mjs';
import { compareImages } from './runner/visual.mjs';
import { auditPage } from './runner/audit.mjs';
import { runDoctor } from './doctor.mjs';
import {
  loadProject,
  saveProject,
  updateCanvasLayout,
  createFeature,
  createFlow,
  matchFlow,
  batchRunFlows,
} from './graph/project.mjs';

// Browser session kept for the audit tool within one process
let activeBrowserSession = null;

export const TOOL_DEFS = [
  {
    name: 'automation_record_start',
    description: 'Start an interactive recording session on a URL in Opscode\'s internal browser. Injects an in-page floating widget with pause, undo, and stop buttons, capturing all clicks, inputs, navigation, and multi-layer selectors.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The web page URL to record (e.g. "https://news.ycombinator.com" or "http://localhost:5173")' },
        flowName: { type: 'string', description: 'A descriptive name for the test flow (e.g. "login-flow", "checkout-journey")' },
        featureName: { type: 'string', description: 'Optional feature group name to assign this flow under' },
        featureId: { type: 'string', description: 'Optional feature group ID to assign this flow under' },
        branchOf: {
          type: 'object',
          description: 'Record a branch of an existing flow instead of a new flow: { flow, node, when: "yes" | "no" | "next" }. Get the browser to that node first (automation_flow_run with untilNode). url is then optional.',
        },
      },
      required: [],
    },
  },
  {
    name: 'automation_record_stop',
    description: 'Conclude the active recording session, save the captured steps to automation/<flow>/flow.json, and automatically compile an idiomatic, standalone Playwright test spec (.spec.ts).',
    parameters: {
      type: 'object',
      properties: {
        flowName: { type: 'string', description: 'Optional flow name override' },
        featureName: { type: 'string', description: 'Optional feature group name to assign this flow under' },
        featureId: { type: 'string', description: 'Optional feature group ID to assign this flow under' },
        rejoin: { type: 'string', description: 'When recording a branch: node id the branch joins back into (e.g. "n7")' },
      },
      required: [],
    },
  },
  {
    name: 'automation_step',
    description: 'Do one action in the browser yourself. While a recording is running, the action is recorded as a node of the flow with your description. Use it to automate a feature step by step. Actions: goto (url), click / check / uncheck / assert_visible (target), fill (target, value), select (target, value), press (target, key), assert_text (value), assert_url (value), wait (ms), decision (condition): a branch point; the following steps go on its yes or no branch depending on the condition now.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: STEP_ACTIONS, description: 'What to do' },
        target: { description: 'Element: CSS selector string, "text=Save", "label=Email", "placeholder=Search", "testid=submit", or an object { role, name } / { label } / { text } / { selector } / { testId }' },
        value: { type: 'string', description: 'Text to type, option to select, or text/URL part to check' },
        url: { type: 'string', description: 'URL for goto' },
        key: { type: 'string', description: 'Key for press (default Enter)' },
        ms: { type: 'number', description: 'Milliseconds for wait' },
        condition: { type: 'object', description: 'For decision: { type: "url" | "text" | "visible", value } (visible takes a target in value or target)' },
        description: { type: 'string', description: 'What this step does for the feature, in plain words (shown on the node)' },
        label: { type: 'string', description: 'Short node title (optional)' },
        sensitive: { type: 'boolean', description: 'fill only: the value is a password or secret; it is stored outside flow.json' },
        data: { description: 'fill/select only: test data rule for replays. "fixed" (always this value), a kind ("email", "fullName", "phone", "company", "number", "date", ...: a new realistic value every run), a pattern ("ORD-{n:5}", "{firstName} QA {tag}"), or an object { mode: "generate"|"fixed"|"list"|"any", kind, pattern, values, min, max }. Omit it and a rule is suggested when the flow is saved.' },
        timeoutMs: { type: 'number', description: 'How long to wait for the element (default 10000)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'automation_flow_get',
    description: 'Get a saved flow as a graph: its nodes (action, label, target, inputs, page, result) and edges (next, yes, no), plus its last run.',
    parameters: {
      type: 'object',
      properties: {
        flow: { type: 'string', description: 'Flow ID, name or path to flow.json' },
      },
      required: ['flow'],
    },
  },
  {
    name: 'automation_module_plan',
    description: 'Lay out a big module as features and flows in one call, before recording them. Example: { module: "Orders", features: [{ name: "Create order", flows: ["Create basic order", "Create rush order"] }, { name: "Order list", flows: ["Filter by status"] }], dependsOn: [["Login", "Create basic order"]] }. Empty flows are placeholders you then record one by one.',
    parameters: {
      type: 'object',
      properties: {
        module: { type: 'string', description: 'Module name (used as a prefix in descriptions)' },
        baseUrl: { type: 'string', description: 'Base URL of the app' },
        features: { type: 'array', description: 'List of { name, description?, flows: [string | { name, description, url }] }' },
        dependsOn: { type: 'array', description: 'Optional list of [beforeFlowName, afterFlowName] pairs: the first must run before the second' },
      },
      required: ['features'],
    },
  },
  {
    name: 'automation_record_status',
    description: 'Check whether a browser recording session is currently active, elapsed time, captured step count, and recently recorded actions.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'automation_flow_run',
    description: 'Replay a recorded test flow (flow.json) in the browser using the 5-layer self-healing engine and deterministic DOM scanning. Returns pass/fail status and step timings.',
    parameters: {
      type: 'object',
      properties: {
        flow: { type: 'string', description: 'Path to flow.json, flow ID or flow name' },
        continueOnError: { type: 'boolean', description: 'Whether to continue running remaining steps after a failure' },
        headless: { type: 'boolean', description: 'Run headlessly (default: false to view execution)' },
        inputs: { type: 'object', description: 'Values for {{input:name}} placeholders and overrides for {{secret:name}}' },
        untilNode: { type: 'string', description: 'Stop after this node id (to put the browser in that state, e.g. before recording a branch)' },
        fromNode: { type: 'string', description: 'Start at this node id instead of the start' },
        data: { type: 'string', enum: ['fresh', 'recorded'], description: 'Form data: "fresh" (default) makes new values from each field\'s data rule so repeated runs do not clash; "recorded" types the recorded values' },
        times: { type: 'number', description: 'Run the flow this many times in a row, each with different data (1-20, default 1)' },
        replayRun: { type: 'string', description: 'Run id of an earlier run: replay with exactly the data that run used (to reproduce a failure or verify a fix)' },
      },
      required: ['flow'],
    },
  },
  {
    name: 'automation_flow_data',
    description: 'Show or change the test data rules of a flow\'s form fields. Each fill/select node has a rule: generate (a new realistic value of a kind every run: ' + DATA_KINDS.join(', ') + '), fixed (the recorded value: sign-in, search, codes), list (one of given values), any (select: a random option), secret. Without "rules" it lists every field with its rule, reason and sample values for the next run. Use it after recording to check the suggested rules and fix them.',
    parameters: {
      type: 'object',
      properties: {
        flow: { type: 'string', description: 'Flow ID, name or path to flow.json' },
        rules: { type: 'object', description: 'Changes: { <node id or field name>: rule }. A rule is "fixed", "any", a kind ("email", "phone", ...), a pattern ("INV-{n:6}", "{company} {tag}"), or { mode, kind, pattern, values, min, max, range: "future"|"past"|"birth" }' },
        reset: { type: 'boolean', description: 'Throw away all rules and suggest them again' },
        samples: { type: 'number', description: 'How many sample runs to preview (default 2, max 5)' },
      },
      required: ['flow'],
    },
  },
  {
    name: 'automation_issues',
    description: 'List tracked failures (issues) from replays: each failing node of a flow becomes an issue with the error, what the page said, failed requests, the data used, a screenshot and how to reproduce. Default: open and fixed issues. Also written to automation/issues/ISSUES.md for developers.',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: [...ISSUE_STATUSES, 'all'], description: 'Filter by status (default: open + fixed)' },
        flow: { type: 'string', description: 'Only issues of this flow (id or name)' },
        id: { type: 'string', description: 'Show one issue in full' },
      },
      required: [],
    },
  },
  {
    name: 'automation_issue_update',
    description: 'Change an issue: status "fixed" when a developer fixed it (the next passing run closes it, a failing one reopens it), "wont_fix", "open", or "closed"; add a note or an assignee.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Issue id, e.g. ISS-0001' },
        status: { type: 'string', enum: ISSUE_STATUSES },
        note: { type: 'string', description: 'What was done or found' },
        assignee: { type: 'string', description: 'Who works on it' },
      },
      required: ['id'],
    },
  },
  {
    name: 'automation_flow_compile',
    description: 'Compile a recorded flow.json file into a clean, human-readable Playwright test file (.spec.ts) with expect() assertions and selector fallbacks.',
    parameters: {
      type: 'object',
      properties: {
        flow: { type: 'string', description: 'Path to flow.json' },
        out: { type: 'string', description: 'Optional target path for output .spec.ts' },
      },
      required: ['flow'],
    },
  },
  {
    name: 'automation_visual_diff',
    description: 'Perform pixel-level visual regression comparison between baseline and current screenshots using pixelmatch, reporting mismatch percentage and saving diff highlighting.',
    parameters: {
      type: 'object',
      properties: {
        baseline: { type: 'string', description: 'Path to baseline reference screenshot PNG' },
        current: { type: 'string', description: 'Path to current screenshot PNG' },
        outDiff: { type: 'string', description: 'Optional path where diff image with highlighted changes will be saved' },
        threshold: { type: 'number', description: 'Matching sensitivity threshold between 0.0 and 1.0 (default 0.1)' },
      },
      required: ['baseline', 'current'],
    },
  },
  {
    name: 'automation_audit',
    description: 'Run an in-page WCAG 2.1 accessibility compliance check with axe-core on the current browser page or specified URL. Reports score, violation impacts, and remediation advice.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Optional URL to navigate to and audit. Defaults to active page.' },
      },
      required: [],
    },
  },
  {
    name: 'automation_doctor',
    description: 'Diagnose the browser automation environment: checks Node.js runtime, Opscode DevToolsActivePort CDP connection, Chrome/Chromium installation, and test packages.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'automation_graph_get',
    description: 'Retrieve the project automation hierarchy, features, flows, and interactive canvas layout from automation/project.json.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'automation_graph_save',
    description: 'Save canvas viewport coordinates, node layout positions, and dependency edges to automation/project.json.',
    parameters: {
      type: 'object',
      properties: {
        canvasLayout: {
          type: 'object',
          description: 'Layout object containing viewport, node positions, and depends-on edges',
        },
      },
      required: ['canvasLayout'],
    },
  },
  {
    name: 'automation_feature_create',
    description: 'Add a new feature node to the project automation graph (e.g. "Authentication", "Catalog", "Checkout").',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the feature' },
        description: { type: 'string', description: 'Optional descriptive summary of the feature' },
      },
      required: ['name'],
    },
  },
  {
    name: 'automation_flow_create',
    description: 'Create and link a new modular test flow under a feature, generating automation/features/<feature>/<flow>/flow.json and its Playwright spec.',
    parameters: {
      type: 'object',
      properties: {
        featureId: { type: 'string', description: 'ID or name of the parent feature' },
        name: { type: 'string', description: 'Name of the test flow' },
        description: { type: 'string', description: 'Optional description of the test flow' },
        url: { type: 'string', description: 'Starting URL for this flow' },
        steps: { type: 'array', description: 'Optional initial step definitions' },
      },
      required: ['featureId', 'name'],
    },
  },
  {
    name: 'automation_flow_match',
    description: 'Fuzzy and semantic matching of user intent against saved features and flows. Returns confidence score (0.0 to 1.0) and top matching flow for deterministic reuse.',
    parameters: {
      type: 'object',
      properties: {
        intent: { type: 'string', description: 'User prompt or intent describing what to test or automate' },
      },
      required: ['intent'],
    },
  },
  {
    name: 'automation_batch_run',
    description: 'Execute a batch of automation flows across features or following "depends-on" dependency edges, updating status and reporting step results.',
    parameters: {
      type: 'object',
      properties: {
        featureId: { type: 'string', description: 'Optional feature ID to run all flows under that feature' },
        flowIds: { type: 'array', items: { type: 'string' }, description: 'Optional array of specific flow IDs to execute' },
        followDependencies: { type: 'boolean', description: 'Whether to execute flows in topological dependency order (default: true)' },
        continueOnError: { type: 'boolean', description: 'Whether to continue running subsequent flows if one fails (default: false)' },
        headless: { type: 'boolean', description: 'Run headlessly (default: false)' },
        data: { type: 'string', enum: ['fresh', 'recorded'], description: 'Form data for the flows: fresh (default) or recorded' },
      },
      required: [],
    },
  },
  {
    name: 'automation_flow_accept_fix',
    description: 'Permanently apply an AI-healed or fallback selector to a step in flow.json and recompile the Playwright test spec (.spec.ts).',
    parameters: {
      type: 'object',
      properties: {
        flow: { type: 'string', description: 'Path to flow.json, flow ID or flow name' },
        stepIndex: { type: 'number', description: 'Step index to update (1-based)' },
        healedSelector: { type: 'string', description: 'The verified healed selector string' },
        strategy: { type: 'string', description: 'Healing strategy applied (e.g. AI_REASONING, DOM_SCAN)' },
        explanation: { type: 'string', description: 'Optional explanation of why the fix was applied' },
      },
      required: ['flow', 'stepIndex', 'healedSelector'],
    },
  },
];

function resolveFlowPath(cwd, input) {
  if (!input) return null;

  // Direct path
  let p = path.resolve(cwd, input);
  if (fs.existsSync(p)) {
    if (fs.statSync(p).isDirectory()) {
      const sub = path.join(p, 'flow.json');
      if (fs.existsSync(sub)) return sub;
    } else {
      return p;
    }
  }

  // Check project.json for registered flow
  try {
    const projPath = path.resolve(cwd, 'automation', 'project.json');
    if (fs.existsSync(projPath)) {
      const proj = JSON.parse(fs.readFileSync(projPath, 'utf8'));
      const inputNorm = String(input).toLowerCase();
      for (const feat of proj.features || []) {
        for (const fl of feat.flows || []) {
          if (fl.id === input || fl.name.toLowerCase() === inputNorm || fl.id.toLowerCase() === inputNorm) {
            const resolvedPath = path.resolve(cwd, fl.flowPath);
            if (fs.existsSync(resolvedPath)) return resolvedPath;
          }
        }
      }
    }
  } catch {}

  // Check candidates under automation
  const candidates = [
    path.resolve(cwd, 'automation', input, 'flow.json'),
    path.resolve(cwd, 'automation', `${input}.json`),
    path.resolve(cwd, `${input}.json`),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      if (fs.statSync(c).isDirectory()) {
        const sub = path.join(c, 'flow.json');
        if (fs.existsSync(sub)) return sub;
      } else {
        return c;
      }
    }
  }

  // Search recursively in automation/features
  try {
    const featuresDir = path.resolve(cwd, 'automation', 'features');
    if (fs.existsSync(featuresDir)) {
      const feats = fs.readdirSync(featuresDir);
      for (const feat of feats) {
        const subDir = path.join(featuresDir, feat, input);
        if (fs.existsSync(subDir)) {
          const fj = path.join(subDir, 'flow.json');
          if (fs.existsSync(fj)) return fj;
        }
      }
    }
  } catch {}

  return null;
}

export async function runTool(name, params = {}, context = {}) {
  const cwd = context.cwd || process.cwd();

  switch (name) {
    case 'automation_record_start': {
      let branchOf = null;
      let branchBaseCount = 0;
      if (params.branchOf && typeof params.branchOf === 'object') {
        const fp = resolveFlowPath(cwd, params.branchOf.flow);
        if (!fp) return { ok: false, text: `Flow to branch from not found: ${params.branchOf.flow}` };
        const flow = ensureFlowGraph(JSON.parse(fs.readFileSync(fp, 'utf8')));
        const nodeId = params.branchOf.node || params.branchOf.nodeId;
        if (!getNode(flow, nodeId)) return { ok: false, text: `Node "${nodeId}" is not in ${path.relative(cwd, fp)}. Nodes: ${flow.steps.map((n) => n.id).join(', ')}` };
        branchOf = { flowFile: fp, nodeId, when: params.branchOf.when || 'next' };
        branchBaseCount = flow.steps.length;
      } else if (!params.url) {
        return { ok: false, text: 'Missing required parameter "url" (or "branchOf" to record a branch of a saved flow).' };
      }

      const res = await startRecordingDaemon({
        flowName: params.flowName || params.name || (branchOf ? path.basename(path.dirname(branchOf.flowFile)) : `flow-${Date.now()}`),
        startUrl: params.url,
        cwd,
        featureName: params.featureName || null,
        featureId: params.featureId || null,
        branchOf,
        branchBaseCount,
      });
      if (!res.ok) {
        return { ok: false, text: `Failed to start recording: ${res.error}` };
      }
      const where = res.browser === 'opscode-cdp' ? "Opscode's browser (Browser tab)" : 'a browser window';
      return {
        ok: true,
        text: branchOf
          ? `🔴 Recording the "${branchOf.when}" branch from ${branchOf.nodeId} of "${res.flowName}" in ${where}.\nDo the branch's actions (or call automation_step), then automation_record_stop (pass rejoin to join the main path again).`
          : `🔴 Recording started for flow "${res.flowName}" at ${res.currentUrl || res.startUrl} in ${where}.\n\nEvery click, typed value, choice and page change is recorded as a node. Do the feature's actions in the browser, or call automation_step for each action. Then call automation_record_stop.`,
        data: res,
      };
    }

    case 'automation_record_stop': {
      const res = await stopRecording({
        cwd,
        featureName: params.featureName || null,
        featureId: params.featureId || null,
        flowName: params.flowName || null,
        rejoin: params.rejoin || null,
      });
      if (!res.ok) {
        return { ok: false, text: `Stop recording failed: ${res.error}` };
      }
      return {
        ok: true,
        text: `⏹ Recording saved: "${res.flowName}"${res.featureName ? ` in feature "${res.featureName}"` : ''}.\n- Nodes: ${res.stepCount}${res.branchCount ? `, branch edges: ${res.branchCount}` : ''}\n- Flow: ${path.relative(cwd, res.flowFile)}\n- Playwright spec: ${path.relative(cwd, res.specFile)}${res.salvaged ? '\n(The recorder had stopped; saved what it had recorded.)' : ''}\n\nReplay it with automation_flow_run, or see it in the Graph tab.`,
        data: res,
      };
    }

    case 'automation_record_status': {
      const status = await getRecordingStatus();
      if (!status.isRecording) {
        return { ok: true, text: `No active recording session is currently in progress.${status.lastSaved ? ` Last saved: "${status.lastSaved.flowName}" (${status.lastSaved.stepCount} nodes).` : ''}`, data: status };
      }

      const recent = (status.lastSteps || []).map((s) => `${s.id}. [${s.action}] ${s.label || s.description || ''}`).join('\n');
      return {
        ok: true,
        text: `🔴 Recording in progress${status.alive ? '' : ' (recorder process is gone: stop to save what was recorded)'}:\n- Flow: ${status.flowName}\n- Page: ${status.currentUrl || status.startUrl}\n- Nodes: ${status.stepCount}\n- Status: ${status.isPaused ? 'Paused' : status.status}\n\nRecent nodes:\n${recent || '(none yet)'}`,
        data: status,
      };
    }

    case 'automation_step': {
      return performStep(params, { cwd });
    }

    case 'automation_flow_get': {
      const fp = resolveFlowPath(cwd, params.flow);
      if (!fp) return { ok: false, text: `Flow not found: ${params.flow}` };
      const flow = ensureFlowGraph(JSON.parse(fs.readFileSync(fp, 'utf8')));
      const graph = summarizeFlowGraph(flow);
      let lastRun = null;
      try {
        const runs = JSON.parse(fs.readFileSync(path.join(cwd, 'automation', 'runs', 'latest-run.json'), 'utf8'));
        if (runs && (runs.flowPath === fp || runs.flowId === flow.id)) {
          lastRun = { ok: runs.ok, at: runs.timestamp, path: runs.path, results: (runs.results || []).map((r) => ({ nodeId: r.nodeId, status: r.status, error: r.error, outcome: r.outcome })) };
        }
      } catch {}
      const lines = graph.nodes.map((n) => {
        const outs = graph.edges.filter((e) => e.source === n.id).map((e) => `${e.kind === 'next' ? '' : e.kind + ':'}${e.target}`).join(', ');
        return `${n.id} [${n.action}] ${n.label}${n.inputs?.value != null ? ` = "${n.inputs.value}"` : ''}${outs ? ` → ${outs}` : ''}`;
      });
      return {
        ok: true,
        text: `Flow "${flow.name}" (${graph.nodes.length} nodes, ${graph.edges.length} edges), file ${path.relative(cwd, fp)}:\n${lines.join('\n')}`,
        data: { id: flow.id, name: flow.name, feature: flow.feature, flowPath: path.relative(cwd, fp), startUrl: flow.startUrl, endUrl: flow.endUrl, ...graph, lastRun },
      };
    }

    case 'automation_module_plan': {
      if (!Array.isArray(params.features) || !params.features.length) {
        return { ok: false, text: 'Missing "features": a list of { name, flows: [...] }.' };
      }
      const created = [];
      const flowIdsByName = new Map();
      let project = loadProject(cwd);
      if (params.baseUrl && !project.baseUrl) {
        project.baseUrl = params.baseUrl;
        saveProject(cwd, project);
      }
      for (const f of params.features) {
        if (!f || !f.name) continue;
        project = loadProject(cwd);
        let feature = project.features.find((x) => x.name.toLowerCase() === String(f.name).toLowerCase());
        if (!feature) {
          feature = createFeature(cwd, { name: f.name, description: f.description || (params.module ? `${params.module} module` : '') }).feature;
        }
        for (const fl of f.flows || []) {
          const spec = typeof fl === 'string' ? { name: fl } : fl;
          if (!spec?.name) continue;
          project = loadProject(cwd);
          const existing = project.features.flatMap((x) => x.flows || []).find((x) => x.name.toLowerCase() === spec.name.toLowerCase());
          if (existing) {
            flowIdsByName.set(spec.name.toLowerCase(), existing.id);
            continue;
          }
          const res = createFlow(cwd, { featureId: feature.id, name: spec.name, description: spec.description || '', url: spec.url || '' });
          flowIdsByName.set(spec.name.toLowerCase(), res.flow.id);
          created.push(`${feature.name} / ${spec.name}`);
        }
      }
      let deps = 0;
      if (Array.isArray(params.dependsOn) && params.dependsOn.length) {
        project = loadProject(cwd);
        const all = project.features.flatMap((x) => x.flows || []);
        const idOf = (n) => flowIdsByName.get(String(n).toLowerCase()) || all.find((x) => x.name.toLowerCase() === String(n).toLowerCase() || x.id === n)?.id;
        const edges = (project.canvasLayout?.edges || []).filter((e) => e.type === 'depends-on');
        for (const pair of params.dependsOn) {
          const [a, b] = Array.isArray(pair) ? pair : [pair?.before, pair?.after];
          const ia = idOf(a), ib = idOf(b);
          if (!ia || !ib) continue;
          const id = `dep-flow:${ia}-flow:${ib}`;
          if (!edges.some((e) => e.id === id)) { edges.push({ id, source: `flow:${ia}`, target: `flow:${ib}`, type: 'depends-on' }); deps++; }
        }
        updateCanvasLayout(cwd, { edges });
      }
      const p2 = loadProject(cwd);
      const outline = p2.features.map((f) => `- ${f.name}: ${(f.flows || []).map((x) => `${x.name} (${x.stepCount || 0} nodes)`).join(', ') || '(no flows)'}`).join('\n');
      return {
        ok: true,
        text: `Module ${params.module ? `"${params.module}" ` : ''}laid out: ${created.length} new flows${deps ? `, ${deps} dependencies` : ''}.\n${outline}\n\nRecord each flow with automation_record_start (flowName and featureName as above).`,
        data: { created, dependencies: deps, features: p2.features.map((f) => ({ id: f.id, name: f.name, flows: (f.flows || []).map((x) => ({ id: x.id, name: x.name, stepCount: x.stepCount })) })) },
      };
    }

    case 'automation_flow_run': {
      if (!params.flow) {
        return { ok: false, text: 'Missing required parameter "flow" (path to flow.json, flow ID, or flow name).' };
      }

      const flowPath = resolveFlowPath(cwd, params.flow);
      if (!flowPath) {
        return { ok: false, text: `Flow file not found: ${params.flow}. Looked under ${cwd} and automation project graph.` };
      }

      const recNow = await getRecordingStatus();
      if (recNow.isRecording && recNow.alive) {
        return { ok: false, text: `A recording ("${recNow.flowName}") is running; replaying now would record the replay. Stop it first (automation_record_stop).` };
      }

      let startUrl;
      try {
        const flowData = JSON.parse(fs.readFileSync(flowPath, 'utf8'));
        startUrl = flowData.startUrl || (flowData.steps && flowData.steps[0] && (flowData.steps[0].url || flowData.steps[0].value));
        if (startUrl && !/^https?:\/\//i.test(startUrl) && startUrl !== 'about:blank' && !startUrl.startsWith('file://')) {
          startUrl = 'https://' + startUrl;
        }
      } catch {}

      let session;
      try {
        session = await getBrowserSession({
          headless: params.headless ?? false,
          url: params.fromNode ? undefined : startUrl,
        });
      } catch (err) {
        return { ok: false, text: `Failed to connect to browser session: ${err.message}` };
      }

      const times = Math.max(1, Math.min(20, Number(params.times) || 1));
      try {
        const runs = [];
        for (let t = 0; t < times; t++) {
          if (t > 0 && startUrl && session.page) {
            await session.page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
          }
          runs.push(await runFlow(session, flowPath, {
            cwd,
            continueOnError: !!params.continueOnError,
            autoCommitHealing: !!params.autoCommitHealing,
            onProgress: context.onProgress,
            inputs: params.inputs || {},
            untilNode: params.untilNode || null,
            fromNode: params.fromNode || null,
            dataMode: params.data === 'recorded' ? 'recorded' : 'fresh',
            replayRun: params.replayRun || null,
          }));
        }
        const res = runs[runs.length - 1];

        // Update project.json run status if registered
        try {
          const project = loadProject(cwd);
          const relPath = path.relative(cwd, flowPath);
          for (const feat of project.features) {
            for (const fl of feat.flows || []) {
              if (fl.flowPath === relPath || fl.id === params.flow || fl.name === params.flow) {
                fl.lastRunStatus = res.ok ? 'pass' : 'fail';
                fl.lastRunDurationMs = res.durationMs;
                fl.lastRunAt = new Date().toISOString();
                fl.lastRunId = res.runId;
                if (res.runDir) {
                  fl.lastRunSummaryPath = path.relative(cwd, path.join(res.runDir, 'run-summary.json'));
                }
              }
            }
          }
          saveProject(cwd, project);
        } catch {}

        const dataLine = (r) => (r.dataUsed || []).filter((d) => d.source !== 'recorded' && d.source !== 'secret').map((d) => `${d.field} = "${d.value}"`).join(', ');
        const issueText = (r) => {
          const i = r.issues || {};
          const parts = [];
          if (i.opened?.length) parts.push(`new issue ${i.opened.join(', ')}`);
          if (i.updated?.length) parts.push(`seen again ${i.updated.join(', ')}`);
          if (i.reopened?.length) parts.push(`REOPENED (regression) ${i.reopened.join(', ')}`);
          if (i.closed?.length) parts.push(`verified fixed and closed ${i.closed.join(', ')}`);
          return parts.length ? `Issues: ${parts.join('; ')}.` : '';
        };
        if (times > 1) {
          const lines = runs.map((r, i) => `  ${i + 1}. ${r.ok ? 'PASS' : 'FAIL'} ${r.runId}${r.ok ? '' : ` at ${(r.results.find((x) => x.status === 'failed') || {}).nodeId}: ${(r.results.find((x) => x.status === 'failed') || {}).error || ''}`}${dataLine(r) ? `\n     data: ${dataLine(r)}` : ''}${issueText(r) ? `\n     ${issueText(r)}` : ''}`);
          const passed = runs.filter((r) => r.ok).length;
          return {
            ok: passed === runs.length,
            text: `${passed}/${runs.length} runs passed with different data:\n${lines.join('\n')}`,
            data: { runs: runs.map((r) => ({ runId: r.runId, ok: r.ok, summary: r.summary, dataUsed: r.dataUsed, issues: r.issues, failed: r.results.filter((x) => x.status === 'failed').map(({ networkCalls, consoleErrors, ...x }) => x) })) },
          };
        }

        const stepSummary = res.results.map(r => `  - ${r.nodeId || 'Step ' + r.stepIndex} [${r.action}] ${r.label || ''}: ${r.status.toUpperCase()} (${r.durationMs}ms)${r.outcome !== undefined ? ` → ${r.outcome ? 'yes' : 'no'}` : ''}${r.healed ? ' [Self-Healed: ' + r.healedStrategy + ']' : ''}${r.error ? ' -> ' + r.error : ''}`).join('\n');
        // Keep the result line small (the app keeps 64 KB of output): drop per-step network logs.
        res.results = res.results.map(({ networkCalls, consoleErrors, ...r }) => ({ ...r, networkCallCount: (networkCalls || []).length, consoleErrorCount: (consoleErrors || []).length }));

        return {
          ok: res.ok,
          text: `Test Run ${res.ok ? 'PASSED' : 'FAILED'}: ${res.summary}\n\nStep breakdown:\n${stepSummary}${dataLine(res) ? `\n\nData used (${res.replayRun ? `same as ${res.replayRun}` : res.dataMode}): ${dataLine(res)}` : ''}${(res.results.find((x) => x.status === 'failed')?.pageMessages || []).length ? `\nPage said: ${res.results.find((x) => x.status === 'failed').pageMessages.map((m) => `"${m}"`).join(', ')}` : ''}${issueText(res) ? `\n${issueText(res)}` : ''}`,
          data: res,
        };
      } finally {
        if (!session.isCdp) {
          await closeSession(session);
        }
      }
    }

    case 'automation_flow_compile': {
      if (!params.flow) {
        return { ok: false, text: 'Missing required parameter "flow" (path to flow.json).' };
      }

      const flowPath = resolveFlowPath(cwd, params.flow);
      if (!flowPath) {
        return { ok: false, text: `Flow file not found: ${params.flow}` };
      }

      const res = compileFlowFile(flowPath, params.out ? path.resolve(cwd, params.out) : undefined, { withFallbacks: true });
      return {
        ok: true,
        text: `Compiled ${res.stepCount} steps into Playwright spec: ${path.relative(cwd, res.specFile)}`,
        data: res,
      };
    }

    case 'automation_flow_accept_fix': {
      if (!params.flow || !params.stepIndex || !params.healedSelector) {
        return { ok: false, text: 'Missing required parameters: flow, stepIndex, and healedSelector.' };
      }
      const flowPath = resolveFlowPath(cwd, params.flow);
      if (!flowPath) {
        return { ok: false, text: `Flow file not found: ${params.flow}` };
      }
      const res = commitHealedFlow(flowPath, Number(params.stepIndex), {
        healedSelector: params.healedSelector,
        strategy: params.strategy || 'AI_REASONING',
        confidence: params.confidence || 0.95,
        explanation: params.explanation,
      });
      return {
        ok: true,
        text: `Applied AI fix to step ${params.stepIndex} and recompiled spec: ${path.relative(cwd, res.specFile || res.flowFilePath)}`,
        data: res,
      };
    }

    case 'automation_visual_diff': {
      if (!params.baseline || !params.current) {
        return { ok: false, text: 'Missing required parameters "baseline" and/or "current".' };
      }

      const baselinePath = path.resolve(cwd, params.baseline);
      const currentPath = path.resolve(cwd, params.current);

      if (!fs.existsSync(baselinePath)) {
        return { ok: false, text: `Baseline file not found: ${baselinePath}` };
      }
      if (!fs.existsSync(currentPath)) {
        return { ok: false, text: `Current file not found: ${currentPath}` };
      }

      const res = await compareImages(baselinePath, currentPath, {
        threshold: params.threshold ?? 0.1,
        outDiffPath: params.outDiff ? path.resolve(cwd, params.outDiff) : undefined,
      });

      return {
        ok: res.ok,
        text: res.message,
        data: res,
      };
    }

    case 'automation_audit': {
      const session = activeBrowserSession || await getBrowserSession({
        url: params.url,
        headless: false,
      });

      try {
        const res = await auditPage(session, { url: params.url });
        const violationDetails = res.violations.map(v => `  - [${v.impact.toUpperCase()}] ${v.rule}: ${v.description} (${v.nodesCount} elements affected)\n    Help: ${v.helpUrl}`).join('\n');

        return {
          ok: true,
          text: `Accessibility Audit Complete:\n${res.summary}\n\nWCAG Rating: ${res.wcagLevel}\nScore: ${res.score}/100\n\nViolations (${res.violationsCount}):\n${violationDetails || '  None! Page passed all checks.'}`,
          data: res,
        };
      } finally {
        if (!activeBrowserSession && !session.isCdp) {
          await closeSession(session);
        }
      }
    }

    case 'automation_doctor': {
      const res = await runDoctor();
      const checkLines = res.checks.map(c => `  ${c.ok ? '✔' : c.isWarning ? '⚠' : '❌'} ${c.name}: ${c.detail}${c.fix ? ` (Fix: ${c.fix})` : ''}`).join('\n');

      return {
        ok: res.ok,
        text: `Automation Studio Doctor Diagnostics:\n\n${checkLines}\n\n${res.summary}`,
        data: res,
      };
    }

    case 'automation_graph_get': {
      const project = loadProject(cwd);
      const totalFlows = project.features.reduce((acc, f) => acc + (f.flows?.length || 0), 0);
      return {
        ok: true,
        text: `Automation Graph loaded:\n- Project: "${project.name}" (ID: ${project.id})\n- Features: ${project.features.length}\n- Flows: ${totalFlows}\n- Canvas nodes: ${project.canvasLayout?.nodes?.length || 0}\n- Canvas edges: ${project.canvasLayout?.edges?.length || 0}`,
        data: project,
      };
    }

    case 'automation_graph_save': {
      if (!params.canvasLayout || typeof params.canvasLayout !== 'object') {
        return { ok: false, text: 'Missing required parameter "canvasLayout".' };
      }
      const project = updateCanvasLayout(cwd, params.canvasLayout);
      return {
        ok: true,
        text: `Canvas layout saved: ${project.canvasLayout?.nodes?.length || 0} nodes, ${project.canvasLayout?.edges?.length || 0} edges.`,
        data: project,
      };
    }

    case 'automation_feature_create': {
      if (!params.name) {
        return { ok: false, text: 'Missing required parameter "name".' };
      }
      const res = createFeature(cwd, { name: params.name, description: params.description });
      return {
        ok: true,
        text: `Feature "${res.feature.name}" (ID: ${res.feature.id}) added to automation graph.`,
        data: res,
      };
    }

    case 'automation_flow_create': {
      if (!params.name || !params.featureId) {
        return { ok: false, text: 'Missing required parameters "featureId" and/or "name".' };
      }
      const res = createFlow(cwd, {
        featureId: params.featureId,
        name: params.name,
        description: params.description,
        steps: params.steps,
        url: params.url,
      });
      return {
        ok: true,
        text: `Flow "${res.flow.name}" (ID: ${res.flow.id}) created under feature "${res.feature.name}".\n- Flow JSON: ${res.flow.flowPath}\n- Spec: ${res.flow.specPath}`,
        data: res,
      };
    }

    case 'automation_flow_match': {
      if (!params.intent) {
        return { ok: false, text: 'Missing required parameter "intent".' };
      }
      const res = matchFlow(cwd, params.intent);
      if (res.matched && res.flow) {
        return {
          ok: true,
          text: `Found existing saved automation "${res.flow.name}" (${res.flow.stepCount} steps, confidence ${res.confidence}). Parent feature: "${res.flow.featureName}".`,
          data: res,
        };
      }
      return {
        ok: true,
        text: `No confident match found (top confidence: ${res.confidence}). Suggested candidate: ${res.flow ? res.flow.name : 'none'}.`,
        data: res,
      };
    }

    case 'automation_flow_data': {
      const fp = resolveFlowPath(cwd, params.flow);
      if (!fp) return { ok: false, text: `Flow not found: ${params.flow}` };
      const flow = ensureFlowGraph(JSON.parse(fs.readFileSync(fp, 'utf8')));
      const fields = flow.steps.filter((s) => s.action === 'fill' || s.action === 'select');
      if (!fields.length) return { ok: true, text: `Flow "${flow.name}" has no form fields.`, data: { fields: [] } };
      let changed = false;
      if (params.reset) {
        for (const s of fields) delete s.data;
        changed = true;
      }
      const before = JSON.stringify(fields.map((s) => s.data || null));
      applyDataRules(flow);
      if (JSON.stringify(fields.map((s) => s.data || null)) !== before) changed = true;
      const errors = [];
      for (const [key, rule] of Object.entries(params.rules || {})) {
        const k = String(key).toLowerCase();
        const node = fields.find((s) => s.id.toLowerCase() === k) || fields.find((s) => String(s.fieldName || s.label || '').toLowerCase() === k)
          || fields.find((s) => String(s.fieldName || s.label || '').toLowerCase().includes(k));
        if (!node) { errors.push(`No field "${key}"`); continue; }
        try {
          node.data = normalizeRule(rule, typeof rule === 'object' ? node.data : {});
          changed = true;
        } catch (e) {
          errors.push(`${key}: ${e.message}`);
        }
      }
      if (changed) {
        fs.writeFileSync(fp, JSON.stringify(flow, null, 2), 'utf8');
        // keep the Playwright spec next to the flow in step with the rules
        try {
          for (const f of fs.readdirSync(path.dirname(fp))) if (f.endsWith('.spec.ts')) fs.writeFileSync(path.join(path.dirname(fp), f), compileFlowToSpec(flow), 'utf8');
        } catch {}
      }
      const nSamples = Math.max(1, Math.min(5, Number(params.samples) || 2));
      const history = readHistory(cwd);
      const samples = Array.from({ length: nSamples }, (_, i) => planRunData(flow, { history, seed: (Date.now() + i * 7919) >>> 0 }));
      const rows = fields.map((s) => {
        const vals = samples.map((p) => p.values[s.id]?.value ?? (p.values[s.id]?.source === 'any' ? '(any option)' : null)).filter((v) => v != null);
        const shown = s.sensitive || s.data?.mode === 'secret' ? '••••' : s.value;
        return { nodeId: s.id, field: s.fieldName || s.label, action: s.action, recorded: shown, rule: s.data, ruleText: describeRule(s.data), why: s.data?.why || '', samples: vals };
      });
      const lines = rows.map((r) => `${r.nodeId} ${r.field}: ${r.ruleText}${r.why ? ` (${r.why})` : ''}; recorded "${r.recorded}"${r.samples.length ? ` → next runs e.g. ${r.samples.map((v) => `"${v}"`).join(', ')}` : ''}`);
      return {
        ok: errors.length === 0,
        text: `Test data of "${flow.name}"${changed ? ' (saved)' : ''}:\n${lines.join('\n')}${errors.length ? `\n\nProblems: ${errors.join('; ')}` : ''}\n\nModes: ${DATA_MODES.join(', ')}. Kinds: ${DATA_KINDS.join(', ')}.`,
        data: { flowId: flow.id, fields: rows, saved: changed },
      };
    }

    case 'automation_issues': {
      if (params.id) {
        const issue = listIssues(cwd, { status: 'all' }).find((i) => i.id.toLowerCase() === String(params.id).toLowerCase());
        if (!issue) return { ok: false, text: `Issue ${params.id} not found.` };
        const { fingerprint, runs, ...rest } = issue;
        return { ok: true, text: `${issueLine(issue)}\nError: ${issue.error}\nReproduce: ${issue.reproduce}`, data: { ...rest, runs: (runs || []).slice(-5) } };
      }
      const list = listIssues(cwd, { status: params.status, flow: params.flow });
      const all = listIssues(cwd, { status: 'all' });
      const count = (st) => all.filter((i) => i.status === st).length;
      return {
        ok: true,
        text: list.length
          ? `${list.length} issue(s) (open ${count('open')}, fixed ${count('fixed')}, closed ${count('closed')}). Details for developers: automation/issues/ISSUES.md\n${list.map(issueLine).join('\n')}`
          : `No ${params.status && params.status !== 'all' ? params.status + ' ' : 'open '}issues${params.flow ? ` for ${params.flow}` : ''}. (closed: ${count('closed')})`,
        data: { counts: { open: count('open'), fixed: count('fixed'), closed: count('closed'), wont_fix: count('wont_fix') }, issues: list.map(({ fingerprint, runs, ...i }) => i) },
      };
    }

    case 'automation_issue_update': {
      try {
        const issue = updateIssue(cwd, params.id, { status: params.status, note: params.note, assignee: params.assignee, by: context.by || 'agent' });
        const next = issue.status === 'fixed' ? ` Run the flow again to verify: ${issue.reproduce} (same data) or automation_flow_run { "flow": "${issue.flow.id}" } (fresh data).` : '';
        return { ok: true, text: `${issueLine(issue)}${next}`, data: { id: issue.id, status: issue.status, assignee: issue.assignee } };
      } catch (e) {
        return { ok: false, text: e.message };
      }
    }

    case 'automation_batch_run': {
      const res = await batchRunFlows(cwd, {
        featureId: params.featureId,
        flowIds: params.flowIds,
        followDependencies: params.followDependencies ?? true,
        continueOnError: params.continueOnError ?? false,
        headless: params.headless ?? false,
        onProgress: context.onProgress,
        dataMode: params.data === 'recorded' ? 'recorded' : 'fresh',
      });
      return {
        ok: res.ok,
        text: res.summary,
        data: res,
      };
    }

    default:
      return { ok: false, text: `Unknown tool "${name}".` };
  }
}
