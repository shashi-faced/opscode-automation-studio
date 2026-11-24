// automation_step: the agent acts in the browser. While a recording is running, each step is
// recorded as a flow node (with the agent's description) by the recorder daemon.
import { getBrowserSession, closeSession } from '../cdp/session.mjs';
import { readRecordingSession } from './recorder.mjs';
import { locatorFromTarget, evaluateCondition } from '../flow/targets.mjs';
import { defaultLabel } from '../flow/graph.mjs';
import { robustClick, robustFill, robustPress } from '../flow/input.mjs';
import { normalizeRule } from '../data/generate.mjs';
import { scopeFor, resolveUploadFiles } from '../flow/frames.mjs';
import { readVars, saveVars, extractFrom } from '../data/vars.mjs';
import { resolveValue } from '../flow/graph.mjs';

export const STEP_ACTIONS = ['goto', 'click', 'fill', 'select', 'check', 'uncheck', 'press', 'hover', 'upload', 'drag', 'extract', 'assert_visible', 'assert_text', 'assert_url', 'wait', 'decision'];

function pickPage(session, url) {
  let pages = [];
  try {
    pages = session.context.pages().filter((p) => {
      const u = p.url();
      return !p.isClosed() && !u.startsWith('chrome://') && !u.startsWith('devtools://');
    });
  } catch {}
  if (url) {
    const exact = pages.find((p) => p.url() === url);
    if (exact) return exact;
  }
  const nonBlank = pages.filter((p) => p.url() && p.url() !== 'about:blank');
  return nonBlank[nonBlank.length - 1] || pages[pages.length - 1] || session.page;
}

/** Send a node to the recorder (if this page is being recorded) and mute the page's own capture. */
async function announce(page, node, mute) {
  // the recorder also runs inside iframes: mute it there too while the agent acts
  if (mute) {
    for (const f of page.frames()) {
      if (f === page.mainFrame()) continue;
      await f.evaluate(() => { window.__opscodeRecorderMuted = true; }).catch(() => {});
    }
  }
  try {
    return await page.evaluate(async ({ n, mute }) => {
      if (mute) window.__opscodeRecorderMuted = true;
      if (typeof window.opscodeRecordStep !== 'function') return false;
      await window.opscodeRecordStep(n);
      return true;
    }, { n: node, mute });
  } catch {
    return false;
  }
}

async function unmute(page) {
  for (const f of page.frames()) {
    try {
      await f.evaluate(() => {
        // Values the agent typed are already in its node: do not record them again on blur.
        document.querySelectorAll('input, textarea').forEach((el) => { el.__opscodeLastRecordedValue = el.value; });
        window.__opscodeRecorderMuted = false;
      });
    } catch {}
  }
}

async function describeElement(locator) {
  try {
    return await locator.evaluate((el) => (window.__opscodeDescribe ? window.__opscodeDescribe(el) : null));
  } catch {
    return null;
  }
}

export async function performStep(params = {}, context = {}) {
  const action = String(params.action || '').toLowerCase();
  if (!STEP_ACTIONS.includes(action)) {
    return { ok: false, text: `Unknown action "${params.action}". Use one of: ${STEP_ACTIONS.join(', ')}.` };
  }
  const timeout = Number(params.timeoutMs) || 10000;
  const rec = readRecordingSession();
  const recording = !!(rec && rec.isRecording && rec.status === 'recording');

  let session;
  try {
    session = await getBrowserSession({ port: recording ? rec.port || undefined : undefined, persistent: true });
  } catch (err) {
    return { ok: false, text: `Could not reach the browser: ${err.message}` };
  }
  const page = pickPage(session, recording ? rec.currentUrl : null);

  const base = {
    action,
    description: params.description || '',
    label: params.label || undefined,
    source: 'agent',
    timestamp: Date.now(),
    url: page.url(),
    pageTitle: await page.title().catch(() => ''),
  };

  let node = null;
  let recorded = false;
  let outcome;
  let extracted;
  let dialogNode = null;
  const cwd = context.cwd || process.cwd();
  const vars = readVars(cwd);
  // {{var:name}} in a value: typed resolved, recorded as written (so replays use the variable)
  const typed = (v) => resolveValue(String(v ?? ''), { vars });
  try {
    const scope = params.frame ? await scopeFor(page, params.frame, { timeout }) : page;
    if (params.frame) base.frame = typeof params.frame === 'string' ? (/^[#.[]|^iframe/i.test(params.frame) ? { selector: params.frame } : { name: params.frame, url: undefined, hint: params.frame }) : params.frame;
    // A dialog this action opens: answer it as asked (default accept) and record it after the action.
    if (params.dialog != null) {
      const want = typeof params.dialog === 'object' ? params.dialog : { accept: params.dialog !== 'dismiss' && params.dialog !== false };
      page.once('dialog', async (d) => {
        dialogNode = { action: 'dialog', accept: want.accept !== false, text: want.text, dialogType: d.type(), message: d.message().slice(0, 200), description: `${want.accept !== false ? 'Accept' : 'Dismiss'} ${d.type()} "${d.message().slice(0, 40)}"`, source: 'agent', timestamp: Date.now() };
        try { if (want.accept !== false) await d.accept(want.text != null ? String(want.text) : undefined); else await d.dismiss(); } catch {}
      });
    }
    switch (action) {
      case 'goto': {
        let url = params.url || params.value;
        if (!url) throw new Error('goto needs "url".');
        if (!/^https?:\/\//i.test(url) && !url.startsWith('file://') && url !== 'about:blank') url = 'https://' + url;
        node = { ...base, url, description: base.description || `Navigate to ${url}` };
        recorded = await announce(page, node, false);
        await page.goto(typed(url), { waitUntil: 'domcontentloaded', timeout: 30000 });
        break;
      }
      case 'extract': {
        if (!params.name) throw new Error('extract needs "name" (the variable to set), and "target" and/or "pattern".');
        const loc = params.target ? locatorFromTarget(scope, params.target) : scope.locator('body');
        await loc.waitFor({ state: 'visible', timeout });
        const selectorSet = params.target ? await describeElement(loc) : null;
        extracted = extractFrom(await loc.innerText({ timeout }), params.pattern);
        node = { ...base, selectorSet: selectorSet || (params.target ? { cssSelector: typeof params.target === 'string' ? params.target : null } : null), target: params.target, pattern: params.pattern || undefined, name: params.name, description: base.description || `Read ${params.name}` };
        if (!node.label) node.label = `Read "${params.name}"`;
        recorded = await announce(page, node, false);
        saveVars(cwd, { [params.name]: extracted });
        break;
      }
      case 'drag': {
        const from = locatorFromTarget(scope, params.target);
        const to = locatorFromTarget(scope, params.to);
        await from.waitFor({ state: 'visible', timeout });
        await to.waitFor({ state: 'visible', timeout });
        node = { ...base, selectorSet: await describeElement(from), to: await describeElement(to), target: params.target };
        if (!node.label) node.label = defaultLabel(node);
        recorded = await announce(page, node, true);
        await from.dragTo(to, { timeout });
        break;
      }
      case 'click':
      case 'fill':
      case 'select':
      case 'check':
      case 'uncheck':
      case 'press':
      case 'hover':
      case 'upload':
      case 'assert_visible': {
        const loc = locatorFromTarget(scope, params.target);
        if (action === 'upload') await loc.waitFor({ state: 'attached', timeout });
        else await loc.waitFor({ state: 'visible', timeout });
        const selectorSet = await describeElement(loc);
        node = {
          ...base,
          selectorSet: selectorSet || { cssSelector: typeof params.target === 'string' ? params.target : null },
          target: params.target,
        };
        if (action === 'fill' || action === 'select') node.value = String(params.value ?? '');
        if (action === 'press') node.key = params.key || 'Enter';
        if (action === 'fill' && params.sensitive) node.sensitive = true;
        if (action === 'fill') node.fieldName = params.fieldName || selectorSet?.domContext?.label || undefined;
        if ((action === 'fill' || action === 'select') && params.data != null) node.data = normalizeRule(params.data);
        if ((action === 'fill' || action === 'select') && params.exportAs) node.exportAs = String(params.exportAs);
        if (action === 'upload') node.files = (Array.isArray(params.files) ? params.files : [params.files || params.value]).filter(Boolean).map(String);
        if (!node.label) node.label = defaultLabel(node);
        recorded = await announce(page, node, true);
        if (action === 'click') await robustClick(page, loc, { timeout });
        else if (action === 'fill') await robustFill(loc, typed(params.value), { timeout });
        else if (action === 'select') await loc.selectOption(typed(params.value), { timeout });
        else if (action === 'hover') await loc.hover({ timeout });
        else if (action === 'upload') {
          if (!node.files.length) throw new Error('upload needs "files": file names in automation/files/ or paths.');
          await loc.setInputFiles(resolveUploadFiles(cwd, node.files).paths, { timeout });
        }
        else if (action === 'check' || action === 'uncheck') {
          const want = action === 'check';
          if ((await loc.isChecked()) !== want) await robustClick(page, loc, { timeout });
          if ((await loc.isChecked()) !== want) throw new Error(`The box did not become ${want ? 'checked' : 'unchecked'}.`);
        }
        else if (action === 'press') await robustPress(page, loc, params.key || 'Enter', { timeout });
        break;
      }
      case 'assert_text': {
        if (!params.value) throw new Error('assert_text needs "value".');
        await page.getByText(String(params.value)).first().waitFor({ state: 'visible', timeout });
        node = { ...base, value: String(params.value) };
        recorded = await announce(page, node, false);
        break;
      }
      case 'assert_url': {
        if (!params.value) throw new Error('assert_url needs "value" (text the URL must contain).');
        const end = Date.now() + timeout;
        while (!page.url().includes(String(params.value))) {
          if (Date.now() > end) throw new Error(`URL ${page.url()} does not contain "${params.value}"`);
          await new Promise((r) => setTimeout(r, 150));
        }
        node = { ...base, value: String(params.value) };
        recorded = await announce(page, node, false);
        break;
      }
      case 'wait': {
        const ms = Math.min(Number(params.ms || params.value) || 1000, 60000);
        await page.waitForTimeout(ms);
        node = { ...base, ms };
        recorded = await announce(page, node, false);
        break;
      }
      case 'decision': {
        const condition = params.condition || null;
        outcome = await evaluateCondition(page, condition, Number(params.timeoutMs) || 1500);
        node = { ...base, condition, outcome };
        recorded = await announce(page, node, false);
        break;
      }
    }
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(300);
    if (dialogNode) await announce(page, dialogNode, false);
    // a value this fill publishes is usable at once by later steps
    if (node?.exportAs && params.value != null) saveVars(cwd, { [node.exportAs]: typed(params.value) });
  } catch (err) {
    await unmute(page);
    return { ok: false, text: `Step "${action}" failed: ${err.message}`, data: { action, url: page.url(), recorded } };
  } finally {
    if (session && !session.isCdp) await closeSession(session);
  }
  await unmute(page);

  const label = node?.label || defaultLabel(node || { action });
  const where = page.url();
  const parts = [`${recorded ? 'Recorded' : 'Did'}: ${label}${node?.description && node.description !== label ? ` (${node.description})` : ''}`];
  if (action === 'decision') parts.push(`Condition is ${outcome ? 'TRUE' : 'FALSE'}: the next steps go on the "${outcome ? 'yes' : 'no'}" branch.`);
  if (action === 'extract') parts.push(`${params.name} = "${extracted}" (use it as {{var:${params.name}}})`);
  if (dialogNode) parts.push(`Dialog: ${dialogNode.description}`);
  parts.push(`Page now: ${where}`);
  if (!recording) parts.push('(No recording is running, so this step was not saved. Start one with automation_record_start.)');
  return {
    ok: true,
    text: parts.join('\n'),
    data: { action, label, recorded, outcome, value: extracted, dialog: dialogNode || undefined, url: where, title: await page.title().catch(() => '') },
  };
}
