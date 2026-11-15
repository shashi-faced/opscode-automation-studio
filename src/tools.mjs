import path from 'node:path';
import fs from 'node:fs';
import { getBrowserSession, closeSession } from './cdp/session.mjs';
import { startRecording, stopRecording, getRecordingStatus } from './recorder/recorder.mjs';
import { runFlow } from './runner/executor.mjs';
import { compileFlowFile } from './runner/compiler.mjs';
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

// Active session holder for interactive recording
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
      },
      required: ['url'],
    },
  },
  {
    name: 'automation_record_stop',
    description: 'Conclude the active recording session, save the captured steps to automation/<flow>/flow.json, and automatically compile an idiomatic, standalone Playwright test spec (.spec.ts).',
    parameters: {
      type: 'object',
      properties: {
        flowName: { type: 'string', description: 'Optional flow name override' },
      },
      required: [],
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
      },
      required: ['flow'],
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
      },
      required: [],
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
      if (!params.url) {
        return { ok: false, text: 'Missing required parameter "url".' };
      }

      if (!activeBrowserSession) {
        activeBrowserSession = await getBrowserSession({
          url: params.url,
          headless: false,
          persistent: true,
        });
      }

      const res = await startRecording(activeBrowserSession, {
        flowName: params.flowName,
        startUrl: params.url,
        cwd,
      });

      if (!res.ok) {
        return { ok: false, text: `Failed to start recording: ${res.error}` };
      }

      return {
        ok: true,
        text: `🔴 Recording started for flow "${res.flowName}" at ${res.startUrl}.\n\nThe Opscode in-page recorder widget is active with Pause, Undo, and Stop buttons.\nPerform your actions in the browser, then call automation_record_stop when finished.`,
        data: res,
      };
    }

    case 'automation_record_stop': {
      const res = await stopRecording({ cwd, session: activeBrowserSession });
      activeBrowserSession = null;
      if (!res.ok) {
        return { ok: false, text: `Stop recording failed: ${res.error}` };
      }

      // Auto-register flow under project graph if project exists or create default
      try {
        const project = loadProject(cwd);
        let defaultFeat = project.features[0];
        if (!defaultFeat) {
          const featRes = createFeature(cwd, { name: 'General', description: 'Core user flows' });
          defaultFeat = featRes.feature;
        }
        const relFlowPath = path.relative(cwd, res.flowFile);
        const relSpecPath = path.relative(cwd, res.specFile);
        const flowId = `flow-${res.flowName.toLowerCase().replace(/[^a-z0-9_-]+/g, '-')}`;

        const existingFlow = defaultFeat.flows.find(f => f.flowPath === relFlowPath || f.id === flowId);
        if (!existingFlow) {
          defaultFeat.flows.push({
            id: flowId,
            name: res.flowName,
            description: `Recorded journey at ${res.startUrl || ''}`,
            flowPath: relFlowPath,
            specPath: relSpecPath,
            stepCount: res.stepCount,
            lastRunStatus: 'idle',
            lastRunDurationMs: 0,
            lastRunAt: null,
          });
          saveProject(cwd, project);
        }
      } catch {}

      return {
        ok: true,
        text: `⏹ Recording concluded for flow "${res.flowName}".\n- Steps recorded: ${res.stepCount}\n- Flow JSON: ${path.relative(cwd, res.flowFile)}\n- Playwright Spec: ${path.relative(cwd, res.specFile)}\n\nYou can now run this flow with automation_flow_run or inspect it on the graph.`,
        data: res,
      };
    }

    case 'automation_record_status': {
      const status = await getRecordingStatus({ session: activeBrowserSession });
      if (!status.isRecording) {
        return { ok: true, text: 'No active recording session is currently in progress.', data: status };
      }

      const recent = (status.lastSteps || []).map((s, i) => `${i + 1}. [${s.action}] ${s.description || ''}`).join('\n');
      return {
        ok: true,
        text: `🔴 Recording in progress:\n- Flow: ${status.flowName}\n- URL: ${status.startUrl}\n- Steps: ${status.stepCount}\n- Status: ${status.isPaused ? 'Paused' : 'Recording'}\n\nRecent steps:\n${recent || '(none yet)'}`,
        data: status,
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

      let session;
      try {
        session = await getBrowserSession({
          headless: params.headless ?? false,
        });
      } catch (err) {
        return { ok: false, text: `Failed to connect to browser session: ${err.message}` };
      }

      try {
        const res = await runFlow(session, flowPath, {
          cwd,
          continueOnError: !!params.continueOnError,
          onProgress: context.onProgress,
        });

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
              }
            }
          }
          saveProject(cwd, project);
        } catch {}

        const stepSummary = res.results.map(r => `  - Step ${r.stepIndex} [${r.action}]: ${r.status.toUpperCase()} (${r.durationMs}ms)${r.healed ? ' [Self-Healed: ' + r.healedStrategy + ']' : ''}${r.error ? ' -> ' + r.error : ''}`).join('\n');

        return {
          ok: res.ok,
          text: `Test Run ${res.ok ? 'PASSED' : 'FAILED'}: ${res.summary}\n\nStep breakdown:\n${stepSummary}`,
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

    case 'automation_batch_run': {
      const res = await batchRunFlows(cwd, {
        featureId: params.featureId,
        flowIds: params.flowIds,
        followDependencies: params.followDependencies ?? true,
        continueOnError: params.continueOnError ?? false,
        headless: params.headless ?? false,
        onProgress: context.onProgress,
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
