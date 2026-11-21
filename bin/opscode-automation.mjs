#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTool, TOOL_DEFS } from '../src/tools.mjs';
import { runRecorderDaemon } from '../src/recorder/recorder.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const cmd = argv[0];
const flags = {};
const pos = [];

for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=');
    flags[k] = v ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true);
  } else {
    pos.push(a);
  }
}

const quiet = !!flags.quiet;
const progress = (p) => {
  if (!quiet) process.stdout.write(JSON.stringify({ progress: p }) + '\n');
};
const done = (obj, code = 0) => {
  process.stdout.write(JSON.stringify(obj) + '\n');
  process.exit(code);
};

const HELP = `opscode-automation — Browser Automation Studio agent CLI

Commands:
  agent-manifest               Output manifest + tools for Opscode Agent Store
  doctor                       Diagnose environment, Chrome, CDP and packages
  tools                        List available tool definitions in JSON
  tool <name> '<json params>'  Execute a tool call safely (supports --b64)
  compile <flow.json>          Compile flow.json into Playwright test (.spec.ts)
  run <flow.json>              Replay flow with 5-layer self-healing and DOM scan
  diff <baseline> <current>    Pixelmatch visual regression diff
  audit [url]                  WCAG 2.1 accessibility compliance check
  graph                        Retrieve project automation graph hierarchy
  match '<intent>'             Fuzzy match user prompt to saved test flows
  batch [--feature=<id>]       Batch run all flows or flows in feature
  recorder-daemon              (internal) background recorder started by automation_record_start`;

async function main() {
  try {
    switch (cmd) {
      case 'agent-manifest': {
        const manifestPath = path.join(ROOT, 'agent', 'manifest.json');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        return done({
          ok: true,
          manifest: {
            ...manifest,
            package: {
              installDir: ROOT,
              entry: 'bin/opscode-automation.mjs',
              runtime: 'node',
              nodePath: process.execPath,
              tools: TOOL_DEFS,
            },
          },
        });
      }

      case 'doctor': {
        const r = await runTool('automation_doctor', {}, { onProgress: progress });
        if (!quiet) process.stderr.write(r.text + '\n');
        return done(r, r.ok ? 0 : 1);
      }

      case 'recorder-daemon': {
        // Started by automation_record_start; keeps running until the recording is stopped.
        await runRecorderDaemon();
        return;
      }

      case 'tools': {
        return done({ ok: true, tools: TOOL_DEFS });
      }

      case 'tool': {
        const name = pos[0];
        let params = {};
        const raw = pos[1] ?? flags.params;
        if (flags.b64) {
          params = JSON.parse(Buffer.from(String(flags.b64), 'base64').toString('utf8'));
        } else if (raw) {
          params = raw.startsWith('@') ? JSON.parse(fs.readFileSync(raw.slice(1), 'utf8')) : JSON.parse(raw);
        }
        const r = await runTool(name, params, { cwd: flags.cwd || process.cwd(), onProgress: progress });
        return done(r, r.ok ? 0 : 1);
      }

      case 'compile': {
        const r = await runTool('automation_flow_compile', { flow: pos[0], out: flags.out }, { cwd: flags.cwd || process.cwd(), onProgress: progress });
        return done(r, r.ok ? 0 : 1);
      }

      case 'run': {
        const r = await runTool('automation_flow_run', {
          flow: pos[0],
          continueOnError: !!flags.continue,
          headless: !!flags.headless,
          autoCommitHealing: !!flags['auto-commit'] || !!flags.autoCommit,
        }, { cwd: flags.cwd || process.cwd(), onProgress: progress });
        return done(r, r.ok ? 0 : 1);
      }

      case 'accept-fix': {
        const r = await runTool('automation_flow_accept_fix', {
          flow: pos[0],
          stepIndex: flags.step || flags.stepIndex,
          healedSelector: flags.selector || flags.healedSelector,
          strategy: flags.strategy,
          explanation: flags.explanation,
        }, { cwd: flags.cwd || process.cwd() });
        return done(r, r.ok ? 0 : 1);
      }

      case 'graph': {
        const r = await runTool('automation_graph_get', {}, { cwd: flags.cwd || process.cwd() });
        return done(r, r.ok ? 0 : 1);
      }

      case 'match': {
        const r = await runTool('automation_flow_match', { intent: pos[0] }, { cwd: flags.cwd || process.cwd() });
        return done(r, r.ok ? 0 : 1);
      }

      case 'batch': {
        const r = await runTool('automation_batch_run', {
          featureId: flags.feature,
          headless: !!flags.headless,
          continueOnError: !!flags.continue,
        }, { cwd: flags.cwd || process.cwd(), onProgress: progress });
        return done(r, r.ok ? 0 : 1);
      }

      case 'diff': {
        const r = await runTool('automation_visual_diff', { baseline: pos[0], current: pos[1], outDiff: flags.out, threshold: flags.threshold ? +flags.threshold : undefined }, { cwd: flags.cwd || process.cwd() });
        return done(r, r.ok ? 0 : 1);
      }

      case 'audit': {
        const r = await runTool('automation_audit', { url: pos[0] }, { cwd: flags.cwd || process.cwd() });
        return done(r, r.ok ? 0 : 1);
      }

      case undefined:
      case 'help':
      case '--help':
      case '-h':
        process.stdout.write(HELP + '\n');
        return done({ ok: true, root: ROOT });

      default:
        return done({ ok: false, error: `Unknown command "${cmd}". Run "opscode-automation help".` }, 1);
    }
  } catch (err) {
    return done({ ok: false, error: err.message, stack: err.stack }, 1);
  }
}

main();
