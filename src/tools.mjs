import path from 'node:path';
import fs from 'node:fs';
import { getBrowserSession, closeSession } from './cdp/session.mjs';
import { startRecording, stopRecording, getRecordingStatus } from './recorder/recorder.mjs';
import { runFlow } from './runner/executor.mjs';
import { compileFlowFile } from './runner/compiler.mjs';
import { compareImages } from './runner/visual.mjs';
import { auditPage } from './runner/audit.mjs';
import { runDoctor } from './doctor.mjs';

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
        flow: { type: 'string', description: 'Path to flow.json or flow name' },
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
];

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
        });
      }

      const res = await startRecording(activeBrowserSession, {
        flowName: params.flowName,
        startUrl: params.url,
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
      const res = await stopRecording({ cwd });
      if (!res.ok) {
        return { ok: false, text: `Stop recording failed: ${res.error}` };
      }

      return {
        ok: true,
        text: `⏹ Recording concluded for flow "${res.flowName}".\n- Steps recorded: ${res.stepCount}\n- Flow JSON: ${path.relative(cwd, res.flowFile)}\n- Playwright Spec: ${path.relative(cwd, res.specFile)}\n\nYou can now run this flow with automation_flow_run or edit the generated spec.`,
        data: res,
      };
    }

    case 'automation_record_status': {
      const status = getRecordingStatus();
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
        return { ok: false, text: 'Missing required parameter "flow" (path to flow.json or flow name).' };
      }

      let flowPath = path.resolve(cwd, params.flow);
      if (!fs.existsSync(flowPath)) {
        const candidate = path.resolve(cwd, 'automation', params.flow, 'flow.json');
        if (fs.existsSync(candidate)) {
          flowPath = candidate;
        } else {
          return { ok: false, text: `Flow file not found: ${params.flow}. Looked at ${flowPath} and ${candidate}.` };
        }
      }

      const session = await getBrowserSession({
        headless: params.headless ?? false,
      });

      try {
        const res = await runFlow(session, flowPath, {
          cwd,
          continueOnError: !!params.continueOnError,
          onProgress: context.onProgress,
        });

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

      let flowPath = path.resolve(cwd, params.flow);
      if (!fs.existsSync(flowPath)) {
        const candidate = path.resolve(cwd, 'automation', params.flow, 'flow.json');
        if (fs.existsSync(candidate)) flowPath = candidate;
        else return { ok: false, text: `Flow file not found: ${params.flow}` };
      }

      const res = compileFlowFile(flowPath, params.out ? path.resolve(cwd, params.out) : undefined);
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

    default:
      return { ok: false, text: `Unknown tool "${name}".` };
  }
}
