// Recorder.
//
// Each agent tool call is a short-lived Node process, but a recording has to stay attached to the
// browser while the user (or the agent) works through many pages. So automation_record_start runs
// a small detached "recorder daemon" (`opscode-automation recorder-daemon`) that holds the CDP
// connection, records every action on every page as a flow node, and keeps the live flow in the
// session file. Status reads that file; stop asks the daemon (through a control file) to flush,
// save the flow and exit.
//
// startRecording / stopRecording also work in-process on a given session (the daemon uses them,
// and so do the unit tests with mock pages).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getSidebarInjectionScript } from './sidebar.mjs';
import { compileFlowToSpec } from '../runner/compiler.mjs';
import { getBrowserSession } from '../cdp/session.mjs';
import { loadProject, saveProject } from '../graph/project.mjs';
import { FlowBuilder, ensureFlowGraph, extractSecrets, summarizeFlowGraph, getNode, outgoing } from '../flow/graph.mjs';
import { applyDataRules } from '../data/generate.mjs';
import { mergeSecrets } from '../flow/secrets.mjs';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'opscode-automation.mjs');

/** Folder for the session, control, result and log files. OPSCODE_AUTOMATION_RUN_DIR overrides it (tests). */
export function runDir() {
  return process.env.OPSCODE_AUTOMATION_RUN_DIR || path.join(os.homedir(), '.opscode', 'run');
}
const sessionFile = () => path.join(runDir(), 'automation-session.json');
const controlFile = () => path.join(runDir(), 'automation-control.json');
const resultFile = () => path.join(runDir(), 'automation-result.json');
export const recorderLogFile = () => path.join(runDir(), 'automation-recorder.log');

/** Actions that change the page; a navigation right after one is that action's result. */
const PAGE_ACTIONS = new Set(['goto', 'navigate', 'click', 'press', 'select', 'check', 'uncheck', 'fill']);
const NAV_RESULT_WINDOW_MS = 4000;

// In-memory active recording (in the daemon, or in-process in tests)
let activeRecording = null;

export function pidAlive(pid) {
  if (!pid || !Number.isFinite(Number(pid))) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export function readRecordingSession() {
  if (activeRecording && activeRecording.isRecording) {
    return snapshot(activeRecording);
  }
  const data = readJson(sessionFile());
  return data && data.isRecording ? data : null;
}

export function writeRecordingSession(data) {
  try {
    // Never write the live Playwright session or the builder (circular, huge)
    const { session, builder, onStopRequested, seen, ...persistable } = data || {};
    writeJsonAtomic(sessionFile(), persistable);
  } catch {}
}

export function deleteRecordingSession() {
  try {
    if (fs.existsSync(sessionFile())) fs.unlinkSync(sessionFile());
  } catch {}
}

function snapshot(rec) {
  const { session, builder, onStopRequested, seen, ...meta } = rec;
  return {
    ...meta,
    pid: process.pid,
    steps: builder ? builder.flow.steps : meta.steps || [],
    edges: builder ? builder.flow.edges : meta.edges || [],
    entry: builder ? builder.flow.entry : meta.entry || null,
    cursor: builder ? builder.cursor : meta.cursor || null,
  };
}

function persist() {
  if (activeRecording) writeRecordingSession(snapshot(activeRecording));
}

/**
 * Returns in-page DOM recorder JavaScript string
 */
export function getRecorderInjectionScript(flowName = '', recId = '') {
  return `
(function() {
  var REC_ID = ${JSON.stringify(recId)};
  if (window.__opscodeRecorderInjected) {
    // Already listening on this page (an earlier recording): switch it to this recording.
    if (REC_ID && window.__opscodeRecId !== REC_ID) {
      window.__opscodeRecId = REC_ID;
      window.__opscodeRecorderMuted = false;
      window.__opscodeRecordingState = { recId: REC_ID, isRecording: true, isPaused: false, flowName: ${JSON.stringify(flowName)}, steps: [], startTime: Date.now() };
    }
    return;
  }
  window.__opscodeRecorderInjected = true;
  window.__opscodeRecId = REC_ID;

  // Initialize or restore in-page state
  if (!window.__opscodeRecordingState) {
    try {
      const saved = sessionStorage.getItem('__opscode_recording_state');
      if (saved) {
        const parsed = JSON.parse(saved);
        // Only keep steps of this recording, never left-overs of an older one.
        if (parsed && (!REC_ID || parsed.recId === REC_ID)) window.__opscodeRecordingState = parsed;
      }
    } catch {}
  }
  if (!window.__opscodeRecordingState) {
    window.__opscodeRecordingState = {
      recId: REC_ID,
      isRecording: true,
      isPaused: false,
      flowName: ${JSON.stringify(flowName)},
      steps: [],
      startTime: Date.now(),
    };
  }

  let lastUrl = location.href;

  function persistState() {
    try {
      sessionStorage.setItem('__opscode_recording_state', JSON.stringify(window.__opscodeRecordingState));
    } catch {}
  }

  function isInsideSidebar(el) {
    if (!el) return false;
    const root = document.getElementById('opscode-recording-sidebar-root');
    if (!root) return false;
    return root.contains(el) || (root.shadowRoot && root.shadowRoot.contains(el));
  }

  function inferRole(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'a') return 'link';
    if (tag === 'input') {
      const t = (el.type || '').toLowerCase();
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      return 'textbox';
    }
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    return null;
  }

  function getVisibleText(el) {
    const text = (el.innerText || el.textContent || '').trim();
    return (text.length > 0 && text.length < 60) ? text : null;
  }

  function getAssociatedLabel(el) {
    if (el.id) {
      const lbl = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (lbl) return lbl.innerText.trim();
    }
    const parent = el.closest('label');
    if (parent) return parent.innerText.trim();
    const refId = el.getAttribute('aria-labelledby');
    if (refId) {
      const ref = document.getElementById(refId);
      if (ref) return ref.innerText.trim();
    }
    return null;
  }

  function detectRegion(el) {
    for (const tag of ['header', 'nav', 'main', 'aside', 'footer', 'section', 'article']) {
      const a = el.closest(tag);
      if (a) return tag;
    }
    const r = el.closest('[role]');
    if (r) return r.getAttribute('role');
    return 'body';
  }

  function getNearbyHeading(el) {
    let cur = el;
    while (cur && cur !== document.body) {
      const prev = cur.previousElementSibling;
      if (prev) {
        const h = prev.querySelector('h1,h2,h3,h4,h5,h6') || prev.closest('h1,h2,h3,h4,h5,h6');
        if (h) return h.innerText.trim().substring(0, 100);
      }
      cur = cur.parentElement;
    }
    return null;
  }

  function getOptimalCssPath(el) {
    if (!el || el === document.body || el === document.documentElement) return null;
    const tag = el.tagName.toLowerCase();
    if (el.id && /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(el.id)) {
      const s = '#' + CSS.escape(el.id);
      if (document.querySelectorAll(s).length === 1) return s;
    }
    if (el.name && /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(el.name)) {
      const s = tag + '[name="' + CSS.escape(el.name) + '"]';
      if (document.querySelectorAll(s).length === 1) return s;
    }

    const parts = [];
    let cur = el;
    while (cur && cur !== document.body) {
      const ct = cur.tagName.toLowerCase();
      let part = ct;
      const ds = cur.dataset || {};
      if (ds.testid) part += '[data-testid="' + ds.testid.replace(/"/g, '\\\\"') + '"]';
      else if (ds.cy) part += '[data-cy="' + ds.cy.replace(/"/g, '\\\\"') + '"]';
      else if (ds.qa) part += '[data-qa="' + ds.qa.replace(/"/g, '\\\\"') + '"]';
      else if (cur.getAttribute('aria-label')) part += '[aria-label="' + cur.getAttribute('aria-label').replace(/"/g, '\\\\"') + '"]';
      else {
        const cls = Array.from(cur.classList || []).filter(c => /^[a-zA-Z0-9_-]+$/.test(c));
        if (cls.length) part += '.' + cls.slice(0, 2).map(c => CSS.escape(c)).join('.');
      }
      const sel = parts.length ? part + ' > ' + parts.join(' > ') : part;
      if (document.querySelectorAll(sel).length === 1) return sel;
      parts.unshift(part);
      cur = cur.parentElement;
    }
    return tag;
  }

  function getXPath(el) {
    if (!el) return null;
    if (el.id) return '//*[@id="' + el.id + '"]';
    const parts = [];
    while (el && el.nodeType === 1) {
      let idx = 1;
      let sib = el.previousElementSibling;
      while (sib) {
        if (sib.tagName === el.tagName) idx++;
        sib = sib.previousElementSibling;
      }
      parts.unshift(el.tagName.toLowerCase() + '[' + idx + ']');
      el = el.parentElement;
    }
    return '/' + parts.join('/');
  }

  function extractSelectorSet(el) {
    if (!el) return null;
    const ds = el.dataset || {};
    const tag = el.tagName.toLowerCase();
    const ariaLabel = el.getAttribute('aria-label');

    let primarySelector = null;
    if (ds.testid) primarySelector = '[data-testid="' + ds.testid.replace(/"/g, '\\\\"') + '"]';
    else if (ds.cy) primarySelector = '[data-cy="' + ds.cy.replace(/"/g, '\\\\"') + '"]';
    else if (ds.qa) primarySelector = '[data-qa="' + ds.qa.replace(/"/g, '\\\\"') + '"]';

    const ariaSelector = ariaLabel ? {
      role: el.getAttribute('role') || inferRole(el),
      name: ariaLabel,
    } : null;

    const textSelector = getVisibleText(el);
    const cssSelector = getOptimalCssPath(el);
    const xpathSelector = getXPath(el);
    const rect = el.getBoundingClientRect();

    let confidence = 0.5;
    if (ds.testid || ds.cy || ds.qa) confidence = 1.0;
    else if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) confidence = 0.95;
    else if (ariaLabel) confidence = 0.9;
    else if (el.name && document.querySelectorAll('[name="' + CSS.escape(el.name) + '"]').length === 1) confidence = 0.85;
    else if (textSelector) confidence = 0.75;
    else if (cssSelector) confidence = 0.6;

    return {
      primarySelector,
      ariaSelector,
      textSelector,
      cssSelector,
      xpathSelector,
      domContext: {
        parentTag: el.parentElement ? el.parentElement.tagName.toLowerCase() : null,
        parentId: el.parentElement ? el.parentElement.id : null,
        region: detectRegion(el),
        nearbyHeading: getNearbyHeading(el),
        label: getAssociatedLabel(el),
        tag: (el.tagName || '').toLowerCase(),
        inputType: el.type ? String(el.type).toLowerCase() : undefined,
        name: el.getAttribute('name') || undefined,
        placeholder: el.getAttribute('placeholder') || undefined,
        autocomplete: el.getAttribute('autocomplete') || undefined,
        maxLength: el.maxLength > 0 ? el.maxLength : undefined,
      },
      boundingBox: {
        x: Math.round(rect.x + window.scrollX),
        y: Math.round(rect.y + window.scrollY),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      confidence,
    };
  }

  // Describe an element the same way recorded steps do (used by automation_step).
  window.__opscodeDescribe = extractSelectorSet;

  function recordStep(step) {
    // The agent is acting through automation_step: it records its own, richer node.
    if (window.__opscodeRecorderMuted) return;
    if (window.__opscodeRecordingState && window.__opscodeRecordingState.isPaused) return;
    if (!window.__opscodeRecordingState || !window.__opscodeRecordingState.isRecording) return;

    step.url = step.url || window.location.href;
    step.pageTitle = document.title || '';
    step.rec = window.__opscodeRecId || REC_ID;
    window.__opscodeRecordingState.steps.push(step);
    persistState();

    // Immediately update in-page widget UI
    if (window.__opscodeUpdateSidebar) {
      window.__opscodeUpdateSidebar(window.__opscodeRecordingState.steps, window.__opscodeRecordingState.isPaused);
    }

    // Also notify Node session if connected
    try {
      if (window.opscodeRecordStep) {
        window.opscodeRecordStep(step);
      }
    } catch {}
  }

  let inputDebounceTimer = null;
  let lastFocusedInput = null;

  function flushElementInput(el) {
    if (!el || isInsideSidebar(el)) return;
    const tag = (el.tagName || '').toLowerCase();
    if (tag !== 'input' && tag !== 'textarea') return;
    const type = (el.type || '').toLowerCase();
    if (type === 'checkbox' || type === 'radio' || type === 'submit' || type === 'button' || type === 'file' || type === 'reset') return;

    const val = el.value || '';
    if (el.__opscodeLastRecordedValue === val) return;
    if (val === '' && el.__opscodeLastRecordedValue === undefined) return;

    el.__opscodeLastRecordedValue = val;
    const selectorSet = extractSelectorSet(el);
    const label = el.name || el.id || el.getAttribute('placeholder') || tag;
    const displayVal = type === 'password' ? '••••••••' : (val.length > 30 ? val.slice(0, 30) + '...' : val);

    recordStep({
      action: 'fill',
      selectorSet,
      value: String(val),
      sensitive: type === 'password' || /pass|secret|otp|pin|token/i.test(el.name || el.id || '') || undefined,
      fieldName: getAssociatedLabel(el) || el.name || el.id || el.getAttribute('placeholder') || tag,
      description: 'Fill "' + displayVal + '" into ' + label,
      timestamp: Date.now(),
    });
  }

  function flushActiveInput() {
    try {
      let active = document.activeElement;
      while (active && active.shadowRoot && active.shadowRoot.activeElement) {
        active = active.shadowRoot.activeElement;
      }
      if (active) {
        flushElementInput(active);
      }
    } catch {}
  }

  function flushAllInputs() {
    try {
      flushActiveInput();
      if (lastFocusedInput) {
        flushElementInput(lastFocusedInput);
      }
      const inputs = document.querySelectorAll('input, textarea');
      for (let i = 0; i < inputs.length; i++) {
        flushElementInput(inputs[i]);
      }
    } catch {}
  }
  window.__opscodeFlushActiveInput = flushAllInputs;
  window.__opscodeFlushAllInputs = flushAllInputs;

  // Track focused inputs & immediately flush on blur/focusout
  document.addEventListener('focusin', function(e) {
    if (isInsideSidebar(e.target)) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') {
      lastFocusedInput = e.target;
    }
  }, true);

  document.addEventListener('focusout', function(e) {
    if (isInsideSidebar(e.target)) return;
    flushElementInput(e.target);
  }, true);

  // Click handler
  document.addEventListener('click', function(e) {
    if (isInsideSidebar(e.target)) return;
    clearTimeout(inputDebounceTimer);
    flushAllInputs();

    const target = e.target.closest('button, a, input, [role="button"], [role="link"], select, textarea, div[onclick]') || e.target;
    if (isInsideSidebar(target)) return;
    // Clicking into a field, a dropdown or a checkbox is recorded by its fill / select / check step.
    const ttag = (target.tagName || '').toLowerCase();
    const ttype = (target.type || '').toLowerCase();
    if (ttag === 'textarea' || ttag === 'select' || ttag === 'option') return;
    if (ttag === 'input' && !['submit', 'button', 'reset', 'image'].includes(ttype)) return;
    if (ttag === 'label' && target.control && ['checkbox', 'radio'].includes((target.control.type || '').toLowerCase())) return;
    if (e.target.closest && e.target.closest('label') && e.target.closest('label').control &&
        ['checkbox', 'radio'].includes((e.target.closest('label').control.type || '').toLowerCase()) && ttag !== 'button' && ttag !== 'a') return;

    const selectorSet = extractSelectorSet(target);
    const text = getVisibleText(target) || target.getAttribute('aria-label') || target.tagName.toLowerCase();
    const desc = 'Click ' + target.tagName.toLowerCase() + (text ? ' "' + text.slice(0, 30) + '"' : '');

    recordStep({
      action: 'click',
      selectorSet,
      description: desc,
      timestamp: Date.now(),
    });
  }, true);

  // Debounced input tracker for text inputs & textareas
  document.addEventListener('input', function(e) {
    if (isInsideSidebar(e.target)) return;
    const el = e.target;
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') {
      lastFocusedInput = el;
      clearTimeout(inputDebounceTimer);
      inputDebounceTimer = setTimeout(function() {
        flushElementInput(el);
      }, 400);
    }
  }, true);

  // Change handler for form controls
  document.addEventListener('change', function(e) {
    if (isInsideSidebar(e.target)) return;
    const el = e.target;
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      // A value typed elsewhere comes first: record it before this choice.
      if (tag === 'select' || el.type === 'checkbox' || el.type === 'radio') {
        clearTimeout(inputDebounceTimer);
        flushAllInputs();
      }
      const selectorSet = extractSelectorSet(el);

      if (tag === 'select') {
        const val = el.value;
        const text = el.selectedOptions && el.selectedOptions[0] ? el.selectedOptions[0].innerText.trim() : val;
        const desc = 'Select "' + (text || val).slice(0, 30) + '" from ' + (el.name || el.id || 'dropdown');
        recordStep({
          action: 'select',
          selectorSet,
          value: String(val),
          description: desc,
          timestamp: Date.now(),
        });
      } else if (el.type === 'checkbox') {
        const act = el.checked ? 'check' : 'uncheck';
        const desc = (el.checked ? 'Check ' : 'Uncheck ') + (getAssociatedLabel(el) || el.name || el.id || 'checkbox');
        recordStep({
          action: act,
          selectorSet,
          value: el.checked,
          description: desc,
          timestamp: Date.now(),
        });
      } else if (el.type === 'radio') {
        recordStep({
          action: 'click',
          selectorSet,
          value: el.value,
          description: 'Select radio ' + (el.name || el.id || el.value),
          timestamp: Date.now(),
        });
      } else {
        clearTimeout(inputDebounceTimer);
        flushElementInput(el);
      }
    }
  }, true);

  // Keydown handler (e.g. Enter)
  document.addEventListener('keydown', function(e) {
    if (isInsideSidebar(e.target)) return;
    if (e.key === 'Enter') {
      clearTimeout(inputDebounceTimer);
      flushAllInputs();

      const el = e.target;
      const selectorSet = extractSelectorSet(el);
      recordStep({
        action: 'press',
        key: 'Enter',
        selectorSet,
        description: 'Press Enter on ' + (el.name || el.id || el.tagName.toLowerCase()),
        timestamp: Date.now(),
      });
    }
  }, true);

  // Form submit handler
  document.addEventListener('submit', function(e) {
    if (isInsideSidebar(e.target)) return;
    clearTimeout(inputDebounceTimer);
    flushAllInputs();
  }, true);

  // Navigation / Page unload flush
  window.addEventListener('beforeunload', function() {
    clearTimeout(inputDebounceTimer);
    flushAllInputs();
  }, true);

  window.addEventListener('pagehide', function() {
    clearTimeout(inputDebounceTimer);
    flushAllInputs();
  }, true);

  // URL monitor
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      recordStep({
        action: 'goto',
        url: lastUrl,
        description: 'Navigate to ' + lastUrl,
        timestamp: Date.now(),
      });
    }
  }, 1000);
})();
`;
}


function cleanStep(step) {
  const { rec, pageTitle, ...rest } = step || {};
  const node = { ...rest };
  if (!node.page && step.url && node.action !== 'goto' && node.action !== 'navigate') {
    node.page = { url: step.url, title: pageTitle || '' };
  }
  node.source = node.source || 'user';
  return node;
}

function stepKey(step) {
  return `${step.timestamp || ''}:${step.action || ''}:${step.source || 'user'}`;
}

/** Add a step coming from the page (user action) or from automation_step (agent action). */
function handleIncomingStep(step) {
  const rec = activeRecording;
  if (!rec || !rec.isRecording || !step || typeof step !== 'object') return null;
  if (rec.isPaused) return null;
  if (step.rec && step.rec !== rec.id) return null;
  const action = String(step.action || '').toLowerCase();
  // With browser events available, page navigations are recorded from those events instead.
  if ((action === 'goto' || action === 'navigate') && rec.navFromEvents && step.source !== 'agent') return null;
  const key = stepKey(step);
  if (rec.seen.has(key)) return null;
  rec.seen.add(key);

  const node = rec.builder.add(cleanStep({ ...step, action }));
  if (PAGE_ACTIONS.has(action)) {
    rec.lastActionAt = Date.now();
    rec.lastActionNodeId = node.id;
  }
  persist();
  pushSidebar();
  return node;
}

function onNavigated(url) {
  const rec = activeRecording;
  if (!rec || !rec.isRecording || !url || url === 'about:blank' || url.startsWith('chrome') || url.startsWith('devtools')) return;
  rec.currentUrl = url;
  if (url === rec.lastNavUrl) {
    persist();
    return;
  }
  rec.lastNavUrl = url;
  const last = rec.lastActionNodeId ? getNode(rec.builder.flow, rec.lastActionNodeId) : null;
  if (last && Date.now() - (rec.lastActionAt || 0) < NAV_RESULT_WINDOW_MS) {
    // The page changed because of the last action: that is its result, not a new step.
    last.result = { url, title: last.result?.url === url ? last.result.title || '' : '', observed: true };
    persist();
    return;
  }
  if (rec.isPaused) return;
  const node = rec.builder.add({ action: 'goto', url, description: `Navigate to ${url}`, timestamp: Date.now(), source: 'user', result: { url, title: '', observed: true } });
  rec.lastActionAt = Date.now();
  rec.lastActionNodeId = node.id;
  persist();
}

async function onLoaded(page) {
  const rec = activeRecording;
  if (!rec) return;
  try {
    const url = page.url();
    const title = await page.title();
    for (const n of rec.builder.flow.steps) {
      if (n.result && n.result.url === url && !n.result.title) n.result.title = title;
    }
    persist();
  } catch {}
  pushSidebar(page);
}

function sidebarSteps() {
  return (activeRecording?.builder.flow.steps || []).map((s) => ({ action: s.action, description: s.label || s.description || s.action }));
}

function pushSidebar(onlyPage) {
  const rec = activeRecording;
  if (!rec?.session) return;
  const pages = onlyPage ? [onlyPage] : listPages(rec.session);
  const payload = { steps: sidebarSteps(), isPaused: !!rec.isPaused };
  for (const p of pages) {
    try {
      const r = p.evaluate(({ steps, isPaused }) => {
        if (window.__opscodeUpdateSidebar) window.__opscodeUpdateSidebar(steps, isPaused);
      }, payload);
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch {}
  }
}

function listPages(session) {
  try {
    const pages = (session?.context?.pages && session.context.pages()) || [];
    if (pages.length) return pages;
  } catch {}
  return session?.page ? [session.page] : [];
}

function attachPageEvents(page) {
  if (!page || typeof page.on !== 'function' || page.__opscodeRecorderAttached) return;
  page.__opscodeRecorderAttached = true;
  page.on('framenavigated', (frame) => {
    try {
      if (frame === page.mainFrame()) onNavigated(frame.url());
    } catch {}
  });
  page.on('load', () => onLoaded(page));
}

function normalizeUrl(u) {
  if (u && !/^https?:\/\//i.test(u) && u !== 'about:blank' && !u.startsWith('file://')) return 'https://' + u;
  return u;
}

/**
 * Start recording on an open browser session (in this process). The daemon calls this; tests call
 * it with mock pages.
 */
export async function startRecording(session, options = {}) {
  const existing = readJson(sessionFile());
  if (existing && existing.isRecording && existing.id !== options.recId) {
    const alive = existing.pid === process.pid ? !!activeRecording : pidAlive(existing.pid);
    if (alive) {
      return { ok: false, error: `Recording session already active for flow "${existing.flowName}". Stop it first.` };
    }
  }

  const { flowName = `flow-${Date.now()}`, startUrl, cwd = process.cwd(), featureName = null, featureId = null, branchOf = null } = options;
  const { page } = session;
  const normStartUrl = normalizeUrl(startUrl);
  const recId = options.recId || `rec-${Date.now().toString(36)}`;

  let base = { name: flowName, steps: [], edges: [] };
  let cursor = null;
  if (branchOf?.flowFile) {
    const flow = readJson(branchOf.flowFile);
    if (!flow) return { ok: false, error: `Flow to branch from not found: ${branchOf.flowFile}` };
    base = ensureFlowGraph(flow);
    if (!getNode(base, branchOf.nodeId)) return { ok: false, error: `Node ${branchOf.nodeId} not found in ${branchOf.flowFile}` };
    cursor = { id: branchOf.nodeId, kind: branchOf.when || 'next' };
  }

  activeRecording = {
    id: recId,
    status: 'recording',
    isRecording: true,
    isPaused: false,
    flowName,
    startUrl: normStartUrl || (typeof page?.url === 'function' ? page.url() : ''),
    startTime: Date.now(),
    cwd,
    featureName: featureName || null,
    featureId: featureId || null,
    branchOf: branchOf || null,
    port: session.port || null,
    mode: session.mode || null,
    currentUrl: null,
    lastNavUrl: null,
    lastActionAt: 0,
    lastActionNodeId: null,
    navFromEvents: typeof page?.on === 'function',
    builder: new FlowBuilder(base, cursor),
    seen: new Set(),
    session,
  };

  const onStep = async (step) => handleIncomingStep(step);
  const onSidebar = async (action) => {
    const rec = activeRecording;
    if (!rec || !action) return;
    if (action.type === 'pause') rec.isPaused = true;
    else if (action.type === 'resume') rec.isPaused = false;
    else if (action.type === 'undo') rec.builder.undo();
    else if (action.type === 'stop') {
      if (typeof rec.onStopRequested === 'function') rec.onStopRequested();
      else await stopRecording({ cwd: rec.cwd });
      return;
    }
    persist();
    pushSidebar();
  };

  // Bindings and the recorder script on the whole context: every page and new tab is recorded.
  const ctx = session.context;
  try {
    if (ctx && typeof ctx.exposeBinding === 'function') {
      await ctx.exposeBinding('opscodeRecordStep', (_src, step) => onStep(step));
      await ctx.exposeBinding('opscodeSidebarAction', (_src, a) => onSidebar(a));
    } else if (typeof page?.exposeFunction === 'function') {
      await page.exposeFunction('opscodeRecordStep', onStep);
      await page.exposeFunction('opscodeSidebarAction', onSidebar);
    }
  } catch (err) {
    process.stderr.write(`[Recorder] Binding notice: ${err.message}\n`);
  }

  // The recorder goes first and each part runs on its own, so a widget problem never stops recording.
  const fullScript = `try {\n${getRecorderInjectionScript(flowName, recId)}\n} catch (e) {}\ntry {\n${getSidebarInjectionScript()}\n} catch (e) {}`;
  try {
    if (ctx && typeof ctx.addInitScript === 'function') await ctx.addInitScript(fullScript);
    else if (typeof page?.addInitScript === 'function') await page.addInitScript(fullScript);
  } catch {}

  if (activeRecording.navFromEvents) {
    for (const p of listPages(session)) attachPageEvents(p);
    if (ctx && typeof ctx.on === 'function') ctx.on('page', (p) => attachPageEvents(p));
  }

  // Inject into the page that is already open (evaluate works under a strict CSP; a script tag may not)
  try {
    await page.evaluate(fullScript);
  } catch {
    try {
      await page.evaluate((code) => {
        const s = document.createElement('script');
        s.textContent = code;
        (document.head || document.documentElement).appendChild(s);
      }, fullScript);
    } catch {}
  }

  if (typeof page?.bringToFront === 'function') {
    await page.bringToFront().catch(() => {});
  }

  if (!branchOf) {
    const here = typeof page?.url === 'function' ? page.url() : '';
    const target = normStartUrl || here;
    const node = activeRecording.builder.add({ action: 'goto', url: target, description: `Navigate to ${target}`, timestamp: Date.now(), source: 'user' });
    activeRecording.lastActionAt = Date.now();
    activeRecording.lastActionNodeId = node.id;
    if (normStartUrl && here !== normStartUrl && typeof page?.goto === 'function') {
      try {
        await page.goto(normStartUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      } catch (err) {
        process.stderr.write(`[Recorder] Navigation error: ${err.message}\n`);
      }
    }
    try {
      const url = page.url();
      node.result = { url, title: typeof page.title === 'function' ? await page.title().catch(() => '') : '', observed: activeRecording.navFromEvents };
      activeRecording.currentUrl = url;
      activeRecording.lastNavUrl = url;
    } catch {}
  } else {
    try {
      activeRecording.currentUrl = page.url();
      activeRecording.lastNavUrl = activeRecording.currentUrl;
    } catch {}
  }

  persist();
  pushSidebar();

  return {
    ok: true,
    id: recId,
    flowName,
    startUrl: activeRecording.startUrl,
    message: `Started recording flow "${flowName}". In-page recorder widget injected into ${activeRecording.currentUrl || activeRecording.startUrl}.`,
  };
}

/** Add a node to the active in-process recording (used by tests and by the daemon). */
export function recordNode(step) {
  return handleIncomingStep(step);
}

/**
 * Status of the recording, including the live flow graph (read from the session file: fast, no
 * browser connection).
 */
export async function getRecordingStatus() {
  const rec = readRecordingSession();
  if (!rec || !rec.isRecording) {
    const last = readJson(resultFile());
    return {
      isRecording: false,
      message: 'No active recording session.',
      lastSaved: last && last.ok ? { id: last.id, flowId: last.flowId, flowName: last.flowName, featureName: last.featureName, flowFile: last.flowFile, stepCount: last.stepCount, savedAt: last.savedAt } : null,
    };
  }
  const alive = rec.pid === process.pid ? true : pidAlive(rec.pid);
  const steps = rec.steps || [];
  return {
    isRecording: true,
    id: rec.id,
    status: alive ? rec.status || 'recording' : 'stalled',
    alive,
    isPaused: !!rec.isPaused,
    flowName: rec.flowName,
    featureName: rec.featureName,
    startUrl: rec.startUrl,
    currentUrl: rec.currentUrl,
    browser: rec.mode,
    durationMs: Date.now() - (rec.startTime || Date.now()),
    stepCount: steps.length,
    lastSteps: steps.slice(-5).map((s) => ({ id: s.id, action: s.action, label: s.label, description: s.description })),
    branchOf: rec.branchOf || null,
    graph: summarizeFlowGraph({ steps, edges: rec.edges || [], entry: rec.entry }),
  };
}

/**
 * Stop recording and save the flow. In the daemon (or in-process) this flushes the pages and
 * saves; from another process it asks the daemon to do it and waits for the result.
 */
export async function stopRecording(options = {}) {
  if (activeRecording) return finalizeInProcess(options);

  const rec = readJson(sessionFile());
  if (!rec || !rec.isRecording) {
    return { ok: false, error: 'No active recording session to stop.' };
  }

  if (rec.pid && rec.pid !== process.pid && pidAlive(rec.pid)) {
    writeJsonAtomic(controlFile(), { id: rec.id, cmd: 'stop', options: pickStopOptions(options), at: Date.now() });
    const deadline = Date.now() + (options.timeoutMs || 30000);
    while (Date.now() < deadline) {
      const res = readJson(resultFile());
      if (res && res.id === rec.id) {
        // Wait until the daemon has let go of the browser, so a replay right after does not overlap it.
        const end = Date.now() + 5000;
        while (pidAlive(rec.pid) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
        return res;
      }
      if (!pidAlive(rec.pid)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const res = readJson(resultFile());
    if (res && res.id === rec.id) return res;
    try { process.kill(rec.pid, 'SIGTERM'); } catch {}
  }

  // The recorder is gone: save what it had recorded so far.
  const fresh = readJson(sessionFile()) || rec;
  const builder = new FlowBuilder({ steps: fresh.steps || [], edges: fresh.edges || [], entry: fresh.entry }, fresh.cursor || null);
  if (options.rejoin) builder.rejoin(options.rejoin);
  const result = saveRecordedFlow(fresh, builder.flow, { ...options, cwd: options.cwd || fresh.cwd });
  result.salvaged = true;
  finishResult(fresh.id, result);
  return result;
}

function pickStopOptions(o) {
  const out = {};
  for (const k of ['featureId', 'featureName', 'flowName', 'rejoin', 'description']) if (o[k]) out[k] = o[k];
  return out;
}

function finishResult(id, result) {
  deleteRecordingSession();
  try { if (fs.existsSync(controlFile())) fs.unlinkSync(controlFile()); } catch {}
  try { writeJsonAtomic(resultFile(), { ...result, id, savedAt: new Date().toISOString() }); } catch {}
}

async function finalizeInProcess(options = {}) {
  const rec = activeRecording;
  rec.status = 'stopping';
  persist();

  // Flush typed values, collect any steps the page kept that never reached us, remove the widget.
  const inPage = [];
  for (const page of listPages(rec.session)) {
    try {
      const steps = await page.evaluate(() => {
        try {
          if (typeof window.__opscodeFlushAllInputs === 'function') window.__opscodeFlushAllInputs();
          else if (typeof window.__opscodeFlushActiveInput === 'function') window.__opscodeFlushActiveInput();
        } catch {}
        let saved = [];
        try {
          const raw = sessionStorage.getItem('__opscode_recording_state');
          const parsed = raw ? JSON.parse(raw) : null;
          if (parsed && Array.isArray(parsed.steps)) saved = parsed.steps;
        } catch {}
        const state = window.__opscodeRecordingState;
        if (state) state.isRecording = false;
        const root = document.getElementById('opscode-recording-sidebar-root');
        if (root) root.remove();
        try { sessionStorage.removeItem('__opscode_recording_state'); } catch {}
        const all = [...saved, ...((state && Array.isArray(state.steps)) ? state.steps : [])];
        const byTs = new Map();
        for (const s of all) if (s && s.timestamp) byTs.set(s.timestamp + ':' + s.action, s);
        return Array.from(byTs.values());
      });
      if (Array.isArray(steps)) inPage.push(...steps);
    } catch {}
  }
  // Let late binding calls (from the flush above) arrive before saving.
  if (rec.navFromEvents) await new Promise((r) => setTimeout(r, 300));
  inPage.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  for (const s of inPage) handleIncomingStep(s);

  if (options.rejoin) rec.builder.rejoin(options.rejoin);
  const meta = snapshot(rec);
  activeRecording = null;
  const result = saveRecordedFlow(meta, rec.builder.flow, { ...options, cwd: options.cwd || rec.cwd });
  finishResult(rec.id, result);
  return result;
}

function slug(text) {
  return String(text || '').toLowerCase().trim().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'item';
}

/** Fill each node's result (where it led) from the node after it, when the browser did not tell us. */
function fillResults(flow, endUrl) {
  for (const n of flow.steps) {
    if (n.result && n.result.url) continue;
    const next = outgoing(flow, n.id).map((e) => getNode(flow, e.target)).find(Boolean);
    const url = next ? next.page?.url || next.url : endUrl;
    if (url) n.result = { url, title: next?.page?.title || '' };
  }
}

function ensureAutomationIgnore(cwd) {
  const file = path.resolve(cwd, 'automation', '.gitignore');
  if (fs.existsSync(file)) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '# Typed passwords and run artefacts stay on this machine\n.secrets.json\nruns/\n', 'utf8');
  } catch {}
}

/** Write flow.json + spec and register the flow under its feature in automation/project.json. */
export function saveRecordedFlow(meta, flowGraph, options = {}) {
  const cwd = options.cwd || meta.cwd || process.cwd();
  const flowName = options.flowName || meta.flowName;
  const flow = ensureFlowGraph({ ...flowGraph, steps: flowGraph.steps.map((s) => ({ ...s })), edges: [...flowGraph.edges] });
  let endUrl = meta.currentUrl || '';
  if (!endUrl) {
    for (let i = flow.steps.length - 1; i >= 0; i--) {
      const u = flow.steps[i].result?.url || flow.steps[i].page?.url || flow.steps[i].url;
      if (u && String(u).startsWith('http')) { endUrl = u; break; }
    }
  }
  fillResults(flow, endUrl);
  applyDataRules(flow);
  ensureAutomationIgnore(cwd);

  // Continuing a branch of an existing flow: write the merged graph back to the same file.
  if (meta.branchOf?.flowFile) {
    const flowFile = meta.branchOf.flowFile;
    const existing = readJson(flowFile) || {};
    const flowId = existing.id || slug(existing.name || flowName);
    const merged = { ...existing, version: flow.version, entry: flow.entry, stepCount: flow.steps.length, steps: flow.steps, edges: flow.edges, updatedAt: new Date().toISOString() };
    mergeSecrets(cwd, extractSecrets(merged, flowId));
    fs.writeFileSync(flowFile, JSON.stringify(merged, null, 2), 'utf8');
    const specFile = flowFile.replace(/flow\.json$/, `${slug(merged.name || flowId)}.spec.ts`);
    fs.writeFileSync(specFile, compileFlowToSpec(merged), 'utf8');
    try {
      const project = loadProject(cwd);
      const rel = path.relative(cwd, flowFile);
      for (const f of project.features) for (const fl of f.flows || []) if (fl.flowPath === rel) fl.stepCount = merged.steps.length;
      saveProject(cwd, project);
    } catch {}
    const added = flow.steps.length - (meta.branchBaseCount || 0);
    return {
      ok: true,
      flowId,
      flowName: merged.name || flowName,
      stepCount: merged.steps.length,
      branchFrom: meta.branchOf.nodeId,
      branchKind: meta.branchOf.when || 'next',
      flowFile,
      specFile,
      message: `Added a "${meta.branchOf.when || 'next'}" branch from ${meta.branchOf.nodeId} to ${path.relative(cwd, flowFile)} (${merged.steps.length} nodes now).`,
      added,
    };
  }

  let project = loadProject(cwd);
  if (!project.baseUrl && meta.startUrl) project.baseUrl = meta.startUrl;
  const targetFeatureId = options.featureId || meta.featureId || null;
  const targetFeatureName = options.featureName || meta.featureName || null;
  let feat = null;
  if (targetFeatureId) feat = project.features.find((f) => f.id === targetFeatureId);
  if (!feat && targetFeatureName && targetFeatureName.toLowerCase() !== 'recorded flows') {
    feat = project.features.find((f) => f.name.toLowerCase() === targetFeatureName.toLowerCase());
    if (!feat) {
      feat = { id: `feat-${slug(targetFeatureName)}`, name: targetFeatureName, description: '', flows: [] };
      project.features.push(feat);
    }
  }
  if (!feat) {
    feat = project.features[0];
    if (!feat) {
      feat = { id: 'feat-general', name: 'General', description: 'Recorded flows', flows: [] };
      project.features.push(feat);
    }
  }
  if (!Array.isArray(feat.flows)) feat.flows = [];

  const cleanName = String(flowName).replace(/^flow-+/i, '');
  const flowId = 'flow-' + slug(cleanName || flowName);
  for (const other of project.features) {
    if (other !== feat && Array.isArray(other.flows)) other.flows = other.flows.filter((fl) => fl.id !== flowId);
  }
  const existingIdx = feat.flows.findIndex((fl) => fl.id === flowId || fl.name === flowName);
  const prevPath = existingIdx >= 0 ? feat.flows[existingIdx].flowPath : null;
  const flowFile = prevPath ? path.resolve(cwd, prevPath) : path.resolve(cwd, 'automation', 'features', slug(feat.name), slug(cleanName || flowName), 'flow.json');
  fs.mkdirSync(path.dirname(flowFile), { recursive: true });

  const flowData = {
    id: flowId,
    name: flowName,
    feature: feat.name,
    description: options.description || `Recorded flow starting at ${meta.startUrl || ''}`,
    createdAt: new Date().toISOString(),
    startUrl: meta.startUrl,
    endUrl,
    version: flow.version,
    entry: flow.entry,
    stepCount: flow.steps.length,
    steps: flow.steps,
    edges: flow.edges,
  };
  mergeSecrets(cwd, extractSecrets(flowData, flowId));
  fs.writeFileSync(flowFile, JSON.stringify(flowData, null, 2), 'utf8');
  const specFile = path.join(path.dirname(flowFile), `${slug(cleanName || flowName)}.spec.ts`);
  fs.writeFileSync(specFile, compileFlowToSpec(flowData), 'utf8');

  const entry = {
    id: flowId,
    name: flowName,
    description: flowData.description,
    flowPath: path.relative(cwd, flowFile),
    specPath: path.relative(cwd, specFile),
    startUrl: meta.startUrl,
    endUrl,
    stepCount: flow.steps.length,
    lastRunStatus: 'idle',
    lastRunAt: null,
  };
  if (existingIdx >= 0) feat.flows[existingIdx] = { ...feat.flows[existingIdx], ...entry };
  else feat.flows.push(entry);
  saveProject(cwd, project);

  return {
    ok: true,
    flowId,
    flowName,
    featureId: feat.id,
    featureName: feat.name,
    stepCount: flow.steps.length,
    branchCount: flow.edges.filter((e) => e.kind !== 'next').length,
    flowFile,
    specFile,
    message: `Recorded ${flow.steps.length} steps. Saved flow to ${path.relative(cwd, flowFile)} and compiled Playwright spec to ${path.relative(cwd, specFile)}.`,
  };
}

/**
 * Start a recording in a detached recorder daemon and wait until it is attached to the browser.
 */
export async function startRecordingDaemon(options = {}) {
  const existing = readJson(sessionFile());
  if (existing && existing.isRecording) {
    if (pidAlive(existing.pid)) {
      return { ok: false, error: `Recording session already active for flow "${existing.flowName}". Stop it first (automation_record_stop).` };
    }
    deleteRecordingSession();
  }
  const id = `rec-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  writeRecordingSession({
    id,
    status: 'starting',
    isRecording: true,
    isPaused: false,
    flowName: options.flowName,
    featureId: options.featureId || null,
    featureName: options.featureName || null,
    startUrl: normalizeUrl(options.startUrl),
    cwd: options.cwd || process.cwd(),
    branchOf: options.branchOf || null,
    branchBaseCount: options.branchBaseCount || 0,
    port: options.port || null,
    startTime: Date.now(),
    steps: [],
    edges: [],
  });

  fs.mkdirSync(runDir(), { recursive: true });
  const log = fs.openSync(recorderLogFile(), 'a');
  const child = spawn(process.execPath, [BIN, 'recorder-daemon'], {
    detached: true,
    stdio: ['ignore', log, log],
    cwd: options.cwd || process.cwd(),
    env: process.env,
  });
  child.unref();
  fs.closeSync(log);

  const deadline = Date.now() + (options.timeoutMs || 45000);
  while (Date.now() < deadline) {
    const rec = readJson(sessionFile());
    if (rec && rec.id === id && rec.status === 'recording') {
      return { ok: true, id, pid: rec.pid, flowName: rec.flowName, startUrl: rec.startUrl, currentUrl: rec.currentUrl, browser: rec.mode, stepCount: (rec.steps || []).length };
    }
    if (rec && rec.id === id && rec.status === 'error') {
      deleteRecordingSession();
      return { ok: false, error: rec.error || 'The recorder could not start.' };
    }
    if (!pidAlive(child.pid)) {
      deleteRecordingSession();
      return { ok: false, error: `The recorder stopped while starting. Log: ${tailLog()}` };
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  try { process.kill(child.pid, 'SIGTERM'); } catch {}
  deleteRecordingSession();
  return { ok: false, error: `The recorder did not attach to a browser in time. Log: ${tailLog()}` };
}

function tailLog() {
  try {
    return fs.readFileSync(recorderLogFile(), 'utf8').trim().split('\n').slice(-5).join(' | ');
  } catch {
    return '(no log)';
  }
}

/** Entry of `opscode-automation recorder-daemon`. Runs until stopped. */
export async function runRecorderDaemon() {
  const rec = readJson(sessionFile());
  if (!rec || rec.status !== 'starting') {
    process.stderr.write('[Recorder] Nothing to record (no starting session).\n');
    process.exit(1);
  }
  writeRecordingSession({ ...rec, pid: process.pid });
  const fail = (msg) => {
    writeRecordingSession({ ...rec, pid: process.pid, status: 'error', error: msg });
    process.exit(1);
  };

  let session;
  try {
    session = await getBrowserSession({ headless: false, persistent: true, port: rec.port || undefined });
  } catch (err) {
    return fail(`Could not open a browser: ${err.message}`);
  }
  const res = await startRecording(session, {
    recId: rec.id,
    flowName: rec.flowName,
    startUrl: rec.branchOf ? undefined : rec.startUrl,
    cwd: rec.cwd,
    featureName: rec.featureName,
    featureId: rec.featureId,
    branchOf: rec.branchOf,
  });
  if (!res.ok) return fail(res.error);
  activeRecording.branchBaseCount = rec.branchBaseCount || 0;
  persist();
  process.stderr.write(`[Recorder] ${rec.id} recording "${rec.flowName}" on ${session.mode} (port ${session.port || '-'})\n`);

  let finishing = false;
  const finish = async (opts = {}) => {
    if (finishing) return;
    finishing = true;
    try {
      await stopRecording({ ...opts, cwd: rec.cwd });
    } catch (err) {
      finishResult(rec.id, { ok: false, error: err.message });
    }
    setTimeout(() => process.exit(0), 10);
  };
  activeRecording.onStopRequested = () => finish({});
  try { session.browser?.on?.('disconnected', () => finish({})); } catch {}
  process.on('SIGTERM', () => finish({}));
  process.on('SIGINT', () => finish({}));

  const maxEnd = Date.now() + 8 * 3600 * 1000;
  setInterval(() => {
    const c = readJson(controlFile());
    if (c && c.id === rec.id && c.cmd === 'stop') {
      try { fs.unlinkSync(controlFile()); } catch {}
      finish(c.options || {});
    } else if (Date.now() > maxEnd) {
      finish({});
    }
  }, 250);
}
