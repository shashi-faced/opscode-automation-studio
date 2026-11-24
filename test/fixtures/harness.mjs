// Shared e2e harness: a real headless Chrome with the Opscode browser's switches, the fixture
// site, the CLI called the way the app calls it, and a raw CDP "user".
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startFixtureSite } from './site.mjs';
import { findSystemBrowserExecutable } from '../../src/cdp/session.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(ROOT, 'bin', 'opscode-automation.mjs');
export const CHROME = findSystemBrowserExecutable();

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run one tool the way the app does and return the last JSON line. */
export function tool(env, cwd, name, params = {}) {
  return new Promise((resolve) => {
    const b64 = Buffer.from(JSON.stringify(params)).toString('base64');
    execFile(process.execPath, [BIN, 'tool', name, '--b64', b64, '--cwd', cwd, '--quiet'], { env, timeout: 120000, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      const lines = String(stdout).trim().split('\n').reverse();
      for (const l of lines) {
        try {
          return resolve(JSON.parse(l));
        } catch {}
      }
      resolve({ ok: false, text: `no JSON: ${stderr || err?.message}` });
    });
  });
}

/** Minimal raw CDP client on one page target: what the Opscode Browser tab does. */
export async function rawPage(port, urlPart) {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    target = list.find((t) => t.type === 'page' && t.url.includes(urlPart));
    if (!target) await sleep(100);
  }
  if (!target) throw new Error(`no page with ${urlPart}`);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) {
      pending.get(d.id)(d);
      pending.delete(d.id);
    }
  };
  await new Promise((r) => (ws.onopen = r));
  const send = (method, params = {}) => new Promise((r) => {
    const i = ++id;
    pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
  const api = {
    evaluate,
    url: () => evaluate('location.href'),
    // Click like a person: once the page is loaded and painted, with real mouse events. Headless
    // Chrome 157 sometimes drops all CDP mouse input to a page reached by a redirect (seen with no
    // agent attached at all, see docs/PLAN.md); after 3 lost clicks the "person" clicks in the page
    // (element.click()), which the recorder records the same way.
    async click(selector) {
      for (let i = 0, lost = 0; i < 50; i++) {
        if (lost >= 3) {
          const done = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return false; e.click(); return true; })()`);
          if (done) { api.lostClicks = (api.lostClicks || 0) + 1; return; }
        }
        const pt = await evaluate(`new Promise((done) => {
          const go = () => requestAnimationFrame(() => requestAnimationFrame(() => {
            const e = document.querySelector(${JSON.stringify(selector)});
            if (!e) return done(null);
            window.__e2ePressed = false;
            if (!window.__e2eProbe) { window.__e2eProbe = true; document.addEventListener('pointerdown', () => { window.__e2ePressed = true; }, true); }
            const r = e.getBoundingClientRect();
            done({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
          }));
          if (document.readyState === 'complete') go(); else addEventListener('load', go, { once: true });
        })`);
        if (pt) {
          const before = await api.url();
          for (const type of ['mousePressed', 'mouseReleased']) {
            await send('Input.dispatchMouseEvent', { type, x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
          }
          await sleep(150);
          let seen;
          try { seen = (await api.url()) !== before || (await evaluate('window.__e2ePressed')) !== false; } catch { seen = true; }
          if (seen) return;
          lost++;
        }
        await sleep(100);
      }
      throw new Error(`not found or not clickable: ${selector}`);
    },
    async type(selector, text) {
      await api.click(selector);
      const sel = JSON.stringify(selector);
      await evaluate(`document.querySelector(${sel}).focus()`);
      await send('Input.insertText', { text });
      await sleep(50);
      // keys lost like the clicks above: type in the page (input + change events, as typing would)
      if ((await evaluate(`document.querySelector(${sel}).value`)) !== text) {
        api.lostKeys = (api.lostKeys || 0) + 1;
        await evaluate(`(() => { const e = document.querySelector(${sel}); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(e, ${JSON.stringify(text)}); e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      }
    },
    async waitFor(urlPart) {
      for (let i = 0; i < 100; i++) {
        try {
          const u = String(await api.url());
          if (urlPart instanceof RegExp ? urlPart.test(u) : u.includes(urlPart)) return;
        } catch {}
        await sleep(100);
      }
      throw new Error(`page did not reach ${urlPart}`);
    },
    close: () => ws.close(),
  };
  return api;
}

/** Start the site and a headless Chrome; returns { site, port, tmp, ws, env, close }. */
export async function startHarness() {
  const site = await startFixtureSite();
  const port = await freePort();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oas-e2e-'));
  const ws = path.join(tmp, 'ws');
  fs.mkdirSync(ws);
  // Same switches as the Opscode browser (back/forward cache off, headless)
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(tmp, 'profile')}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-dev-shm-usage',
    '--disable-features=Translate,MediaRouter,PaintHolding,OptimizationHints,BackForwardCache',
    '--window-size=1100,800', 'about:blank',
  ], { stdio: 'ignore' });
  const env = { ...process.env, OPSCODE_AUTOMATION_CDP_PORT: String(port), OPSCODE_AUTOMATION_RUN_DIR: path.join(tmp, 'run'), HOME: tmp };
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break;
    } catch {}
    await sleep(150);
  }

  const close = async () => {
    // OAS_E2E_KEEP=<dir> keeps the recorded workspace (to look at the flows afterwards)
    if (process.env.OAS_E2E_KEEP) {
      fs.cpSync(ws, process.env.OAS_E2E_KEEP, { recursive: true });
      try { fs.cpSync(path.join(tmp, 'run'), path.join(process.env.OAS_E2E_KEEP, '_run'), { recursive: true }); } catch {}
    }
    const exited = new Promise((r) => { if (chrome.exitCode !== null) r(); else chrome.once('exit', r); });
    chrome.kill('SIGKILL');
    await Promise.race([exited, sleep(5000)]);
    await site.close();
    // Chrome's helper processes may still be writing the profile for a moment
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  };
  return { site, port, tmp, ws, env, close };
}
