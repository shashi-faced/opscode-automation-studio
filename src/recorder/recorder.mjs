import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getSidebarInjectionScript } from './sidebar.mjs';
import { compileFlowToSpec } from '../runner/compiler.mjs';
import { getBrowserSession } from '../cdp/session.mjs';

const SESSION_FILE = path.join(os.homedir(), '.opscode', 'run', 'automation-session.json');

// In-memory active recording session (if within same node process)
let activeRecording = null;

export function readRecordingSession() {
  if (activeRecording && activeRecording.isRecording) {
    return activeRecording;
  }
  if (!fs.existsSync(SESSION_FILE)) return null;
  try {
    const raw = fs.readFileSync(SESSION_FILE, 'utf8');
    const data = JSON.parse(raw);
    return data && data.isRecording ? data : null;
  } catch {
    return null;
  }
}

export function writeRecordingSession(data) {
  try {
    fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
    // Exclude live Playwright session object which contains circular references
    const { session, ...persistable } = data || {};
    fs.writeFileSync(SESSION_FILE, JSON.stringify(persistable, null, 2), 'utf8');
  } catch {}
}

export function deleteRecordingSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
  } catch {}
}

/**
 * Returns in-page DOM recorder JavaScript string
 */
export function getRecorderInjectionScript(flowName = '') {
  return `
(function() {
  if (window.__opscodeRecorderInjected) return;
  window.__opscodeRecorderInjected = true;

  // Initialize or restore in-page state
  if (!window.__opscodeRecordingState) {
    try {
      const saved = sessionStorage.getItem('__opscode_recording_state');
      if (saved) window.__opscodeRecordingState = JSON.parse(saved);
    } catch {}
  }
  if (!window.__opscodeRecordingState) {
    window.__opscodeRecordingState = {
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

  function recordStep(step) {
    if (window.__opscodeRecordingState && window.__opscodeRecordingState.isPaused) return;
    if (!window.__opscodeRecordingState || !window.__opscodeRecordingState.isRecording) return;

    step.url = step.url || window.location.href;
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
        const desc = (el.checked ? 'Check ' : 'Uncheck ') + (el.name || el.id || 'checkbox');
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

/**
 * Start an interactive recording session
 */
export async function startRecording(session, options = {}) {
  const existing = readRecordingSession();
  if (existing && existing.isRecording) {
    return {
      ok: false,
      error: `Recording session already active for flow "${existing.flowName}". Stop it first.`,
    };
  }

  const { flowName = `flow-${Date.now()}`, startUrl, cwd = process.cwd(), featureName = null, featureId = null } = options;
  const { page } = session;

  let normStartUrl = startUrl;
  if (normStartUrl && !/^https?:\/\//i.test(normStartUrl) && normStartUrl !== 'about:blank' && !normStartUrl.startsWith('file://')) {
    normStartUrl = 'https://' + normStartUrl;
  }

  activeRecording = {
    isRecording: true,
    isPaused: false,
    flowName,
    startUrl: normStartUrl || page.url(),
    startTime: Date.now(),
    cwd,
    featureName: featureName || null,
    featureId: featureId || null,
    port: session.port,
    steps: [],
    session,
  };

  // Expose callbacks to Playwright page
  try {
    await page.exposeFunction('opscodeRecordStep', async (step) => {
      if (!activeRecording || !activeRecording.isRecording || activeRecording.isPaused) return;
      activeRecording.steps.push(step);
      writeRecordingSession(activeRecording);
      try {
        await page.evaluate(({ steps, isPaused }) => {
          if (window.__opscodeUpdateSidebar) {
            window.__opscodeUpdateSidebar(steps, isPaused);
          }
        }, { steps: activeRecording.steps, isPaused: activeRecording.isPaused });
      } catch {}
    });
  } catch {}

  try {
    await page.exposeFunction('opscodeSidebarAction', async (action) => {
      if (!activeRecording) return;
      if (action.type === 'pause') {
        activeRecording.isPaused = true;
        writeRecordingSession(activeRecording);
      } else if (action.type === 'resume') {
        activeRecording.isPaused = false;
        writeRecordingSession(activeRecording);
      } else if (action.type === 'undo') {
        activeRecording.steps.pop();
        writeRecordingSession(activeRecording);
        try {
          await page.evaluate(({ steps, isPaused }) => {
            if (window.__opscodeUpdateSidebar) {
              window.__opscodeUpdateSidebar(steps, isPaused);
            }
          }, { steps: activeRecording.steps, isPaused: activeRecording.isPaused });
        } catch {}
      } else if (action.type === 'stop') {
        await stopRecording({ cwd });
      }
    });
  } catch {}

  // Inject sidebar and recorder scripts on navigation
  const fullScript = getSidebarInjectionScript() + '\n' + getRecorderInjectionScript(flowName);
  try {
    await page.addInitScript(fullScript);
  } catch {}
  if (session?.context?.addInitScript) {
    try {
      await session.context.addInitScript(fullScript);
    } catch {}
  }

  // Also inject immediately into the current DOM
  try {
    await page.evaluate((code) => {
      const s = document.createElement('script');
      s.textContent = code;
      (document.head || document.documentElement).appendChild(s);
    }, fullScript);
  } catch (err) {
    console.warn(`[Recorder] Immediate injection notice: ${err.message}`);
  }

  // Navigate to startUrl if specified
  if (typeof page?.bringToFront === 'function') {
    await page.bringToFront().catch(() => {});
  }
  if (normStartUrl && page.url() !== normStartUrl) {
    try {
      await page.goto(normStartUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      activeRecording.steps.push({
        action: 'goto',
        url: normStartUrl,
        description: `Navigate to ${normStartUrl}`,
        timestamp: Date.now(),
      });
    } catch (err) {
      console.warn(`[Recorder] Navigation error: ${err.message}`);
    }
  } else {
    activeRecording.steps.push({
      action: 'goto',
      url: page.url(),
      description: `Navigate to ${page.url()}`,
      timestamp: Date.now(),
    });
  }

  // Sync initial in-page state
  try {
    await page.evaluate(({ steps, flowName, isPaused }) => {
      if (window.__opscodeRecordingState) {
        window.__opscodeRecordingState.flowName = flowName;
        window.__opscodeRecordingState.steps = steps;
        window.__opscodeRecordingState.isPaused = isPaused;
      }
      if (window.__opscodeUpdateSidebar) {
        window.__opscodeUpdateSidebar(steps, isPaused);
      }
    }, { steps: activeRecording.steps, flowName, isPaused: false });
  } catch {}

  writeRecordingSession(activeRecording);

  return {
    ok: true,
    flowName,
    startUrl: activeRecording.startUrl,
    message: `Started recording flow "${flowName}". In-page recorder widget injected into ${page.url()}.`,
  };
}

/**
 * Get the status of the active recording session
 */
export async function getRecordingStatus(options = {}) {
  let rec = readRecordingSession();
  if (!rec || !rec.isRecording) {
    return {
      isRecording: false,
      message: 'No active recording session.',
    };
  }

  // Try to query active page in browser to sync any fresh in-page recorded steps
  try {
    const session = options.session || activeRecording?.session || await getBrowserSession({ persistent: false });
    const pages = (session?.context?.pages && session.context.pages()) || (session?.page ? [session.page] : []);
    for (const page of pages) {
      try {
        const inPage = await page.evaluate(() => {
          return window.__opscodeRecordingState
            ? { steps: window.__opscodeRecordingState.steps, isPaused: window.__opscodeRecordingState.isPaused }
            : null;
        });
        if (inPage && Array.isArray(inPage.steps)) {
          const existingTs = new Set((rec.steps || []).map(s => s.timestamp));
          for (const s of inPage.steps) {
            if (s && s.timestamp && !existingTs.has(s.timestamp)) {
              rec.steps.push(s);
              existingTs.add(s.timestamp);
            }
          }
          if (typeof inPage.isPaused === 'boolean') rec.isPaused = inPage.isPaused;
          writeRecordingSession(rec);
        }
      } catch {}
    }
  } catch {}

  return {
    isRecording: true,
    isPaused: !!rec.isPaused,
    flowName: rec.flowName,
    startUrl: rec.startUrl,
    durationMs: Date.now() - (rec.startTime || Date.now()),
    stepCount: (rec.steps || []).length,
    lastSteps: (rec.steps || []).slice(-5),
  };
}

/**
 * Stop recording, save flow.json, and compile standalone .spec.ts
 */
export async function stopRecording(options = {}) {
  let rec = readRecordingSession();
  if (!rec || !rec.isRecording) {
    return {
      ok: false,
      error: 'No active recording session to stop.',
    };
  }

  // Attempt to sync final in-page steps and remove sidebar widget across all open pages
  try {
    const session = options.session || activeRecording?.session || await getBrowserSession({ persistent: false });
    const pages = (session?.context?.pages && session.context.pages()) || (session?.page ? [session.page] : []);
    for (const page of pages) {
      try {
        const inPageSteps = await page.evaluate(() => {
          try {
            if (typeof window.__opscodeFlushAllInputs === 'function') {
              window.__opscodeFlushAllInputs();
            } else if (typeof window.__opscodeFlushActiveInput === 'function') {
              window.__opscodeFlushActiveInput();
            }
          } catch {}

          let savedSteps = [];
          try {
            const raw = sessionStorage.getItem('__opscode_recording_state');
            if (raw) {
              const parsed = JSON.parse(raw);
              if (parsed && Array.isArray(parsed.steps)) {
                savedSteps = parsed.steps;
              }
            }
          } catch {}

          const state = window.__opscodeRecordingState;
          const root = document.getElementById('opscode-recording-sidebar-root');
          if (root) root.remove();
          try { sessionStorage.removeItem('__opscode_recording_state'); } catch {}

          const winSteps = (state && Array.isArray(state.steps)) ? state.steps : [];
          const stepMap = new Map();
          for (const s of [...savedSteps, ...winSteps]) {
            if (s && s.timestamp) {
              stepMap.set(s.timestamp, s);
            }
          }
          return Array.from(stepMap.values());
        });
        if (Array.isArray(inPageSteps)) {
          const existingTs = new Set((rec.steps || []).map(s => s.timestamp));
          for (const s of inPageSteps) {
            if (s && s.timestamp && !existingTs.has(s.timestamp)) {
              rec.steps.push(s);
              existingTs.add(s.timestamp);
            }
          }
        }
      } catch {}
    }
    if (Array.isArray(rec.steps)) {
      rec.steps.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    }
  } catch {}

  activeRecording = null;
  deleteRecordingSession();

  const cwd = options.cwd || rec.cwd || process.cwd();
  const flowDir = path.resolve(cwd, 'automation', rec.flowName);
  fs.mkdirSync(flowDir, { recursive: true });

  const steps = rec.steps || [];
  let endUrl = rec.startUrl || '';
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].url && typeof steps[i].url === 'string' && steps[i].url.startsWith('http')) {
      endUrl = steps[i].url;
      break;
    }
  }

  const flowData = {
    name: rec.flowName,
    createdAt: new Date().toISOString(),
    startUrl: rec.startUrl,
    endUrl,
    stepCount: steps.length,
    steps,
  };

  const flowFile = path.join(flowDir, 'flow.json');
  fs.writeFileSync(flowFile, JSON.stringify(flowData, null, 2), 'utf8');

  // Compile standalone Playwright spec
  const specCode = compileFlowToSpec(flowData);
  const specFile = path.join(flowDir, `${rec.flowName}.spec.ts`);
  fs.writeFileSync(specFile, specCode, 'utf8');

  // Update automation/project.json so the new flow appears on the visual graph
  try {
    const projectFile = path.resolve(cwd, 'automation', 'project.json');
    let project = null;
    if (fs.existsSync(projectFile)) {
      project = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
    }
    if (!project || !Array.isArray(project.features)) {
      project = {
        id: 'proj-' + path.basename(cwd),
        name: 'Automation Studio',
        baseUrl: rec.startUrl || 'http://localhost:3000',
        canvasLayout: { viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [] },
        features: [],
      };
    }

    const targetFeatureId = options.featureId || rec.featureId || null;
    const targetFeatureName = options.featureName || rec.featureName || null;
    let feat = null;
    if (targetFeatureId) {
      feat = project.features.find(f => f.id === targetFeatureId);
    }
    if (!feat && targetFeatureName && targetFeatureName.toLowerCase() !== 'recorded flows') {
      feat = project.features.find(f => f.name.toLowerCase() === targetFeatureName.toLowerCase());
    }
    if (!feat) {
      if (project.features.length > 0) {
        feat = project.features[0];
      } else {
        const featName = targetFeatureName || 'Authentication';
        feat = {
          id: targetFeatureId || ('feat-' + featName.toLowerCase().replace(/[^a-z0-9_-]+/g, '-')),
          name: featName,
          description: 'Recorded automation features',
          flows: [],
        };
        project.features.push(feat);
      }
    }

    // Clean up flow id to avoid double 'flow-' prefix
    const cleanName = rec.flowName.replace(/^flow-+/i, '');
    const flowId = 'flow-' + (cleanName || rec.flowName).toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
    const relFlow = path.relative(cwd, flowFile);
    const relSpec = path.relative(cwd, specFile);

    // Remove any duplicate instances of this flow from other features
    for (const otherFeat of project.features) {
      if (otherFeat !== feat && Array.isArray(otherFeat.flows)) {
        otherFeat.flows = otherFeat.flows.filter(fl => fl.id !== flowId && fl.flowPath !== relFlow && fl.id !== 'flow-' + rec.flowName);
      }
    }

    const existingIdx = feat.flows.findIndex(fl => fl.id === flowId || fl.name === rec.flowName || fl.id === 'flow-' + rec.flowName);
    const flowEntry = {
      id: flowId,
      name: rec.flowName,
      description: `Automated flow starting at ${rec.startUrl || ''}`,
      flowPath: relFlow,
      specPath: relSpec,
      startUrl: rec.startUrl,
      endUrl,
      stepCount: steps.length,
      lastRunStatus: 'idle',
      lastRunAt: new Date().toISOString(),
    };
    if (existingIdx >= 0) {
      feat.flows[existingIdx] = { ...feat.flows[existingIdx], ...flowEntry };
    } else {
      feat.flows.push(flowEntry);
    }
    fs.writeFileSync(projectFile, JSON.stringify(project, null, 2), 'utf8');
  } catch (err) {
    console.warn(`[Recorder] Notice updating project.json: ${err.message}`);
  }

  return {
    ok: true,
    flowName: rec.flowName,
    stepCount: (rec.steps || []).length,
    flowFile,
    specFile,
    message: `Recorded ${(rec.steps || []).length} steps. Saved flow to ${path.relative(cwd, flowFile)} and compiled Playwright spec to ${path.relative(cwd, specFile)}.`,
  };
}
