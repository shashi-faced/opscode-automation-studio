#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTool, TOOL_DEFS } from '../src/tools.mjs';

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
  audit [url]                  WCAG 2.1 accessibility compliance check`;

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
        const r = await runTool('automation_flow_compile', { flow: pos[0], out: flags.out });
        return done(r, r.ok ? 0 : 1);
      }

      case 'run': {
        const r = await runTool('automation_flow_run', { flow: pos[0], continueOnError: !!flags.continue, headless: !!flags.headless }, { onProgress: progress });
        return done(r, r.ok ? 0 : 1);
      }

      case 'diff': {
        const r = await runTool('automation_visual_diff', { baseline: pos[0], current: pos[1], outDiff: flags.out, threshold: flags.threshold ? +flags.threshold : undefined });
        return done(r, r.ok ? 0 : 1);
      }

      case 'audit': {
        const r = await runTool('automation_audit', { url: pos[0] });
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
