import fs from 'node:fs';
import path from 'node:path';
import { SelectorResolver } from './resolver.mjs';
import { FlightRecorder } from '../telemetry/flightRecorder.mjs';
import { reasonAboutStepFailure, captureViewportInteractiveElements } from '../ai/reasoningEngine.mjs';
import { commitHealedFlow } from './autoUpdater.mjs';
import { ensureFlowGraph, getNode, nextNodeId, resolveValue, samePage, pagePattern } from '../flow/graph.mjs';
import { evaluateCondition } from '../flow/targets.mjs';
import { readSecrets } from '../flow/secrets.mjs';
import { robustClick, robustFill, robustPress } from '../flow/input.mjs';
import { planRunData, stepForRun, readHistory, readRunValues, rememberValues } from '../data/runData.mjs';
import { recordRunIssues } from '../issues/tracker.mjs';
import { scopeFor, resolveUploadFiles } from '../flow/frames.mjs';
import { readVars, saveVars, extractFrom } from '../data/vars.mjs';
import { requestPattern } from '../recorder/recorder.mjs';

/**
 * Requests saved on a node while recording (POST/PUT/PATCH/DELETE after the action) must happen
 * again and succeed. `logs` are the flight recorder's network logs.
 */
export async function checkStepRequests(step, logs, since, { timeoutMs = 6000 } = {}) {
  const wanted = (step.requests || []).filter((r) => !r.status || r.status < 400);
  if (!wanted.length || !Array.isArray(logs)) return [];
  const end = Date.now() + timeoutMs;
  const seen = [];
  for (const w of wanted) {
    let hit = null;
    while (!hit) {
      hit = logs.find((l) => l.timestamp >= since && String(l.method).toUpperCase() === w.method && requestPattern(l.url) === w.pattern) || null;
      if (hit || Date.now() > end) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    if (!hit) throw new Error(`Expected the app to send ${w.method} ${w.pattern} (it did when recorded), but no such request was made`);
    if (hit.failed || hit.status >= 400) throw new Error(`Server call failed: ${w.method} ${w.pattern} -> ${hit.status || hit.errorText || 'no response'}`);
    seen.push({ method: w.method, pattern: w.pattern, status: hit.status });
  }
  return seen;
}

/** Texts the page shows about a problem: alerts, error boxes, field validation messages. */
async function capturePageMessages(page) {
  if (!page || typeof page.evaluate !== 'function') return [];
  return page.evaluate(() => {
    const out = [];
    const add = (t) => {
      const s = String(t || '').replace(/\s+/g, ' ').trim();
      if (s && s.length <= 300 && !out.includes(s)) out.push(s);
    };
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const sel = '[role=alert], [aria-live=assertive], .error, .errors, .alert-danger, .alert-error, .invalid-feedback, .field-error, .form-error, .text-danger, .toast-error, [id*=error i], [class*=error-message i]';
    document.querySelectorAll(sel).forEach((el) => { if (visible(el)) add(el.innerText); });
    document.querySelectorAll('input, select, textarea').forEach((el) => {
      if (el.validationMessage && el.willValidate && !el.checkValidity()) add(`${el.labels?.[0]?.innerText || el.name || el.id}: ${el.validationMessage}`);
    });
    return out.slice(0, 5);
  }).catch(() => []);
}

const RESULT_CHECK_ACTIONS = new Set(['goto', 'navigate', 'click', 'press', 'select', 'check', 'uncheck', 'drag', 'dialog']);

/** After an action that changed the page while recording, wait until replay reaches the same page. */
async function checkStepResult(page, step, timeoutMs = 10000) {
  const res = step.result;
  if (!page || !res || !res.url || !res.observed) return;
  const before = step.page?.url || (step.action === 'goto' || step.action === 'navigate' ? null : null);
  if (before && samePage(before, res.url)) return; // the action did not change the page
  const end = Date.now() + timeoutMs;
  while (!samePage(page.url(), res.url)) {
    if (Date.now() > end) {
      throw new Error(`Expected this step to lead to ${pagePattern(res.url)}, but the page is ${page.url()}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

/**
 * Executes an action on a Playwright locator
 */
/**
 * Runs one action on an element. Clicks, typing and keys go through robust* helpers: real input
 * first, then in-page events if the page never got it (see src/flow/input.mjs).
 */
async function executeLocatorAction(locator, act, step) {
  const real = typeof locator?.page === 'function' && typeof locator?.boundingBox === 'function';
  switch (act) {
    case 'hover':
      await locator.hover({ timeout: 5000 });
      break;
    case 'upload':
      await locator.setInputFiles(step.uploadPaths || [], { timeout: 5000 });
      break;
    case 'click':
      if (real) await robustClick(locator.page(), locator);
      else await locator.click({ timeout: 5000 });
      break;
    case 'fill':
      if (real) await robustFill(locator, step.value);
      else await locator.fill(String(step.value ?? ''), { timeout: 5000 });
      break;
    case 'select':
      if (step.pickAnyOption && real) {
        const options = await locator.evaluate((el) => [...el.options].filter((o) => !o.disabled && o.value !== '' && !/^(select|choose|--)/i.test(o.text.trim())).map((o) => o.value));
        if (!options.length) throw new Error('The list has no options to choose from');
        step.value = options[Math.floor((step.random ? step.random() : Math.random()) * options.length)];
      }
      await locator.selectOption(String(step.value ?? ''), { timeout: 5000 });
      break;
    case 'check':
    case 'uncheck': {
      const want = act === 'check';
      if (!real) {
        await (want ? locator.check({ timeout: 5000 }) : locator.uncheck({ timeout: 5000 }));
        break;
      }
      if ((await locator.isChecked()) !== want) await robustClick(locator.page(), locator);
      if ((await locator.isChecked()) !== want) throw new Error(`Box did not become ${want ? 'checked' : 'unchecked'}`);
      break;
    }
    case 'press':
      if (real) await robustPress(locator.page(), locator, step.key || 'Enter');
      else await locator.press(step.key || 'Enter', { timeout: 5000 });
      break;
    case 'assert':
    case 'assert_visible': {
      const isVisible = await locator.isVisible({ timeout: 5000 });
      if (!isVisible) {
        throw new Error(`Assertion failed: element "${step.description}" is not visible`);
      }
      break;
    }
    default:
      break;
  }
}

/**
 * Executes an automation test flow against a Playwright page session with full telemetry,
 * real-time AI healing, and diagnostic run persistence.
 */
export async function runFlow(session, flowInput, options = {}) {
  let flow;
  let flowFilePath = null;

  if (typeof flowInput === 'string') {
    let resolved = flowInput;
    if (fs.existsSync(resolved)) {
      if (fs.statSync(resolved).isDirectory()) {
        resolved = path.join(resolved, 'flow.json');
      }
      flowFilePath = resolved;
      flow = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    } else {
      try {
        flow = JSON.parse(flowInput);
      } catch {
        throw new Error(`Flow file not found: ${flowInput}`);
      }
    }
  } else {
    flow = flowInput;
  }
  flow = ensureFlowGraph(JSON.parse(JSON.stringify(flow)));

  const { page } = session || {};
  if (typeof page?.bringToFront === 'function') {
    await page.bringToFront().catch(() => {});
  }

  const steps = Array.isArray(flow.steps) ? flow.steps : [];
  const resolver = new SelectorResolver({ defaultTimeout: options.timeout || 5000 });

  // Initialize CDP Flight Recorder Telemetry
  const recorder = new FlightRecorder(page, {
    maskCredentials: options.maskCredentials !== false,
  });
  recorder.start();

  // Setup Run Persistence Directories
  const cwd = options.cwd || process.cwd();
  const flowSlug = (flow.id || flow.name || 'unnamed-flow')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-');
  const runTimestamp = Date.now();
  const runId = `run-${runTimestamp}-${flowSlug}`;
  const runDir = path.join(cwd, 'automation', 'runs', runId);
  const stepsDir = path.join(runDir, 'steps');
  const failuresDir = path.join(runDir, 'failures');

  try {
    fs.mkdirSync(stepsDir, { recursive: true });
    fs.mkdirSync(failuresDir, { recursive: true });
  } catch {}

  const results = [];
  let passedCount = 0;
  let failedCount = 0;
  let healedCount = 0;
  const flowStartTime = Date.now();

  // Walk the flow graph from its entry (or options.fromNode), following decisions.
  const secrets = readSecrets(cwd);
  const inputs = options.inputs || {};
  // Form data for this run: new values from each field's data rule ("fresh", the default), the
  // recorded values ("recorded"), or the values of an earlier run (replayRun).
  const dataMode = options.dataMode === 'recorded' ? 'recorded' : 'fresh';
  const replayValues = options.replayRun ? readRunValues(cwd, options.replayRun) : null;
  const plan = planRunData(flow, { mode: dataMode, seed: options.seed, history: readHistory(cwd), replayValues, overrides: options.overrides || null, overrideSource: options.overrideSource || 'given' });
  const dataUsed = [];
  let lastStepStart = 0;
  let prevStepStart = 0;
  // Variables: saved ones (from earlier flows), plus any given for this run; values set during the
  // run (exportAs, extract) are saved at the end.
  const vars = { ...readVars(cwd), ...(options.vars || {}) };
  const varsSet = {};
  // Browser dialogs: answered as the flow's next "dialog" node says (armed before the action).
  let dialogPolicy = null;
  let dialogSeen = null;
  const onDialog = async (dialog) => {
    dialogSeen = { type: dialog.type(), message: dialog.message(), at: Date.now() };
    try {
      if (dialogPolicy && dialogPolicy.accept === false) await dialog.dismiss();
      else if (dialogPolicy) await dialog.accept(dialogPolicy.text != null ? String(dialogPolicy.text) : undefined);
      else await dialog.dismiss();
    } catch {}
    if (!dialogPolicy) unexpectedDialogs.push({ type: dialogSeen.type, message: String(dialogSeen.message).slice(0, 200), nodeId: currentId });
  };
  const unexpectedDialogs = [];
  if (page && typeof page.on === 'function') page.on('dialog', onDialog);
  const pathTaken = [];
  let currentId = options.fromNode || flow.entry;
  let idx = -1;
  while (currentId) {
    idx++;
    if (idx >= (options.maxSteps || 500)) {
      results.push({ stepIndex: idx + 1, nodeId: currentId, action: 'loop', status: 'failed', error: 'Stopped: more than 500 steps (a loop in the flow?)', durationMs: 0 });
      failedCount++;
      break;
    }
    const rawStep = getNode(flow, currentId);
    if (!rawStep) break;
    pathTaken.push(rawStep.id);
    const planned = stepForRun(rawStep, plan);
    const step = { ...planned, value: resolveValue(planned.value, { inputs, secrets, vars }), random: plan.rng.next };
    if (step.url) step.url = resolveValue(step.url, { inputs, secrets, vars });
    const missingSecret = typeof step.value === 'string' && /\{\{(secret|input|var):[^}]+\}\}/.test(step.value);
    const act = (step.action || '').toLowerCase();
    const noteData = () => {
      if (act !== 'fill' && act !== 'select') return;
      if (dataUsed.some((d) => d.nodeId === rawStep.id && d.at === idx)) return;
      const own = plan.values[rawStep.id];
      const isSecret = rawStep.sensitive || /\{\{secret:/.test(String(rawStep.value || ''));
      const fromInput = /\{\{input:/.test(String(rawStep.value || ''));
      dataUsed.push({
        nodeId: rawStep.id,
        field: rawStep.fieldName || rawStep.label || rawStep.id,
        value: isSecret ? '••••' : step.value,
        source: isSecret ? 'secret' : fromInput ? 'input' : own ? (own.source === 'any' ? 'any option' : own.source) : 'recorded',
        at: idx,
      });
    };

    const stepIndex = idx + 1;
    let outcome;
    prevStepStart = lastStepStart;
    const stepStartTime = Date.now();
    lastStepStart = stepStartTime;

    recorder.setStep(stepIndex, { action: act, description: step.description });

    let stepError = null;
    let layerUsed = '';
    let healed = false;
    let healedStrategy = '';
    let healingDetails = null;
    let failureScreenshot = null;
    let aiDiagnosis = null;

    try {
      if (missingSecret) {
        const v = /\{\{var:([^}]+)\}\}/.exec(step.value);
        if (v) throw new Error(`Missing value: variable "${v[1]}" is not set. Run the flow that sets it first (a fill with exportAs "${v[1]}" or an extract step), or pass it in inputs.`);
        throw new Error(`Missing value ${step.value} for "${rawStep.label || rawStep.description}": add it to automation/.secrets.json or pass it in inputs.`);
      }
      // the next node is a dialog: answer it the way it says when this action opens it
      {
        const nextId = nextNodeId(flow, rawStep.id, undefined);
        const nextNode = nextId ? getNode(flow, nextId) : null;
        dialogPolicy = nextNode && nextNode.action === 'dialog' ? { accept: nextNode.accept !== false, text: nextNode.text } : null;
        if (dialogPolicy) dialogSeen = null;
      }
      switch (act) {
        case 'goto':
        case 'navigate': {
          let targetUrl = step.url || step.value;
          if (targetUrl) {
            if (!/^https?:\/\//i.test(targetUrl) && !targetUrl.startsWith('file://')) {
              targetUrl = 'https://' + targetUrl;
            }
            if (page) {
              await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
              await checkStepResult(page, step);
            }
          }
          break;
        }

        case 'decision': {
          if (page) outcome = await evaluateCondition(page, step.condition, options.decisionTimeoutMs || 3000);
          layerUsed = `DECISION:${outcome ? 'yes' : 'no'}`;
          break;
        }

        case 'assert_text': {
          if (page) {
            await page.getByText(String(step.value || '')).first().waitFor({ state: 'visible', timeout: options.timeout || 5000 })
              .catch(() => { throw new Error(`Assertion failed: text "${step.value}" is not visible`); });
          }
          break;
        }

        case 'assert_url': {
          if (page) {
            const end = Date.now() + (options.timeout || 5000);
            while (!page.url().includes(String(step.value || ''))) {
              if (Date.now() > end) throw new Error(`Assertion failed: URL ${page.url()} does not contain "${step.value}"`);
              await page.waitForTimeout(150);
            }
          }
          break;
        }

        case 'dialog': {
          // the previous action opened a dialog (answered by the handler above)
          const end = Date.now() + (options.timeout || 5000);
          while (!dialogSeen && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
          if (!dialogSeen) throw new Error(`Expected a browser dialog${rawStep.message ? ` ("${String(rawStep.message).slice(0, 60)}")` : ''}, but none appeared`);
          layerUsed = `DIALOG:${step.accept === false ? 'dismissed' : 'accepted'}`;
          dialogSeen = null;
          break;
        }

        case 'extract': {
          if (!page) break;
          const scope = step.frame ? await scopeFor(page, step.frame) : page;
          let text;
          if (step.selectorSet && Object.values(step.selectorSet).some((v) => typeof v === 'string' && v)) {
            const res = await resolver.resolve(scope, step.selectorSet, step.description, step);
            text = await res.locator.innerText({ timeout: 5000 });
          } else {
            text = await scope.locator('body').innerText({ timeout: 5000 });
          }
          const val = extractFrom(text, step.pattern);
          if (step.name) { vars[step.name] = val; varsSet[step.name] = val; }
          step.value = val;
          layerUsed = `EXTRACT:${step.name || ''}`;
          break;
        }

        case 'drag': {
          if (!page) break;
          const scope = step.frame ? await scopeFor(page, step.frame) : page;
          const from = await resolver.resolve(scope, step.selectorSet, step.description, step);
          const to = await resolver.resolve(scope, step.to, `drop target of ${step.description}`, {});
          await from.locator.dragTo(to.locator, { timeout: 5000 });
          layerUsed = from.layerUsed;
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
        case 'assert':
        case 'assert_visible': {
          if (!page) break;
          const scope = step.frame ? await scopeFor(page, step.frame) : page;
          if (act === 'upload') {
            const up = resolveUploadFiles(cwd, step.files);
            step.uploadPaths = up.paths;
            if (up.created.length) layerUsed = `placeholder files: ${up.created.join(', ')}`;
          }
          try {
            const res = await resolver.resolve(scope, step.selectorSet, step.description, step);
            layerUsed = res.layerUsed;
            healed = res.healed;
            healedStrategy = res.strategy || '';
            if (healed) {
              healingDetails = {
                strategy: healedStrategy,
                healedSelector: res.healedSelector,
                confidence: res.confidence || 0.85,
                explanation: `Resolved via deterministic DOM scan (Layer 6A)`,
              };
            }
            await executeLocatorAction(res.locator, act, step);
          } catch (firstErr) {
            // First attempt failed — invoke AI Real-Time Reasoning Engine
            const preTelemetry = recorder.getStepTelemetry(stepIndex);
            aiDiagnosis = await reasonAboutStepFailure({
              page,
              step,
              stepIndex,
              networkCalls: preTelemetry.networkCalls,
              pendingRequests: preTelemetry.pendingRequests,
              consoleErrors: preTelemetry.consoleErrors,
              attemptedStrategies: [layerUsed].filter(Boolean),
              lastError: firstErr.message,
            });

            // Action: Backoff retry for slow API
            if (aiDiagnosis.recommendedAction === 'BACKOFF_RETRY') {
              const waitMs = aiDiagnosis.backoffMs || 2000;
              if (page) {
                await page.waitForTimeout(waitMs);
                if (typeof page.waitForLoadState === 'function') {
                  await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
                }
              }

              try {
                const retryRes = await resolver.resolve(scope, step.selectorSet, step.description, step);
                await executeLocatorAction(retryRes.locator, act, step);
                healed = true;
                healedStrategy = 'BACKOFF_RETRY';
                healingDetails = {
                  strategy: 'BACKOFF_RETRY',
                  confidence: aiDiagnosis.confidence,
                  explanation: aiDiagnosis.explanation,
                  slowApi: aiDiagnosis.slowApi,
                };
              } catch (retryErr) {
                // If retry after backoff still fails, try nearby candidate healing before giving up
                const postTelemetry = recorder.getStepTelemetry(stepIndex);
                const retryAi = await reasonAboutStepFailure({
                  page,
                  step,
                  stepIndex,
                  networkCalls: postTelemetry.networkCalls,
                  pendingRequests: postTelemetry.pendingRequests,
                  consoleErrors: postTelemetry.consoleErrors,
                  attemptedStrategies: [layerUsed, 'BACKOFF_RETRY'].filter(Boolean),
                  lastError: retryErr.message,
                });

                if (retryAi.recommendedAction === 'HEAL_AND_CONTINUE' && retryAi.selectedCandidate?.selector) {
                  const candSelector = retryAi.selectedCandidate.selector;
                  const healedLoc = scope.locator(candSelector).first();
                  await healedLoc.waitFor({ state: 'attached', timeout: 4000 });
                  await executeLocatorAction(healedLoc, act, step);

                  healed = true;
                  healedStrategy = 'AI_REASONING';
                  healingDetails = {
                    strategy: 'AI_REASONING',
                    originalSelector: step.selector || step.selectorSet?.primarySelector || step.selectorSet?.cssSelector,
                    healedSelector: candSelector,
                    confidence: retryAi.selectedCandidate.confidence,
                    explanation: retryAi.explanation,
                  };

                  if (options.autoCommitHealing && flowFilePath) {
                    try {
                      commitHealedFlow(flowFilePath, stepIndex, healingDetails);
                    } catch (commitErr) {
                      console.warn(`[Executor] Auto-commit healing failed: ${commitErr.message}`);
                    }
                  }
                } else {
                  throw new Error(`Step failed after API backoff retry: ${retryErr.message}`);
                }
              }
            } else if (aiDiagnosis.recommendedAction === 'DISMISS_OVERLAY' && aiDiagnosis.dismissSelector) {
              // Action: Dismiss blocking overlay and retry original step
              try {
                const dismissLoc = page.locator(aiDiagnosis.dismissSelector).first();
                await dismissLoc.click({ timeout: 3000 });
                await page.waitForTimeout(500);

                // Retry original locator resolution
                const retryRes = await resolver.resolve(scope, step.selectorSet, step.description, step);
                await executeLocatorAction(retryRes.locator, act, step);
                healed = true;
                healedStrategy = 'DISMISS_OVERLAY';
                healingDetails = {
                  strategy: 'DISMISS_OVERLAY',
                  dismissSelector: aiDiagnosis.dismissSelector,
                  confidence: aiDiagnosis.confidence,
                  explanation: aiDiagnosis.explanation,
                };
              } catch (retryErr) {
                throw new Error(`Step failed after modal dismissal: ${retryErr.message}`);
              }
            } else if (
              aiDiagnosis.recommendedAction === 'HEAL_AND_CONTINUE' &&
              aiDiagnosis.selectedCandidate?.selector
            ) {
              // Action: Heal with nearby candidate element discovered by AI
              const candSelector = aiDiagnosis.selectedCandidate.selector;
              const healedLoc = scope.locator(candSelector).first();
              await healedLoc.waitFor({ state: 'attached', timeout: 4000 });
              await executeLocatorAction(healedLoc, act, step);

              healed = true;
              healedStrategy = 'AI_REASONING';
              healingDetails = {
                strategy: 'AI_REASONING',
                originalSelector: step.selector || step.selectorSet?.primarySelector || step.selectorSet?.cssSelector,
                healedSelector: candSelector,
                confidence: aiDiagnosis.selectedCandidate.confidence,
                explanation: aiDiagnosis.explanation,
              };

              // Auto-commit fix to flow.json and recompile spec if requested
              if (options.autoCommitHealing && flowFilePath) {
                try {
                  commitHealedFlow(flowFilePath, stepIndex, healingDetails);
                } catch (commitErr) {
                  console.warn(`[Executor] Auto-commit healing failed: ${commitErr.message}`);
                }
              }
            } else {
              // Cannot be healed automatically; throw original or diagnostic error
              throw firstErr;
            }
          }
          break;
        }

        case 'wait': {
          const ms = step.timeout || step.ms || 1000;
          if (page) await page.waitForTimeout(ms);
          break;
        }

        case 'screenshot': {
          const shotPath =
            step.path || path.join(runDir, 'failures', `step-${stepIndex}.png`);
          fs.mkdirSync(path.dirname(shotPath), { recursive: true });
          if (page) await page.screenshot({ path: shotPath });
          break;
        }

        case 'scroll': {
          if (page) await page.evaluate(() => window.scrollBy(0, 500));
          break;
        }

        default: {
          throw new Error(`Unsupported automation step action: "${act}"`);
        }
      }

      if (RESULT_CHECK_ACTIONS.has(act) && act !== 'goto' && act !== 'navigate') {
        await page?.waitForLoadState?.('domcontentloaded', { timeout: 10000 }).catch(() => {});
        await checkStepResult(page, step);
      }
      // the server calls this action made when recorded must happen again and succeed
      if (page && options.checkRequests !== false && Array.isArray(rawStep.requests) && rawStep.requests.length) {
        const all = recorder.getAllTelemetry?.().networkLogs || recorder.networkLogs || [];
        // a dialog's requests are sent while the action before it (that opened it) runs
        await checkStepRequests(rawStep, all, act === 'dialog' && prevStepStart ? prevStepStart : stepStartTime);
      }
      // publish the value this fill used (for later steps and other flows)
      if (rawStep.exportAs && (act === 'fill' || act === 'select') && step.value != null) {
        vars[rawStep.exportAs] = String(step.value);
        varsSet[rawStep.exportAs] = String(step.value);
      }

      const durationMs = Date.now() - stepStartTime;
      const stepTelemetry = recorder.getStepTelemetry(stepIndex);

      if (healed) healedCount++;
      passedCount++;

      const stepRecord = {
        stepIndex,
        nodeId: rawStep.id,
        label: rawStep.label,
        outcome,
        action: act,
        description: step.description,
        status: healed ? 'healed' : 'passed',
        durationMs,
        layerUsed,
        healed,
        healedStrategy,
        healingDetails: healingDetails || undefined,
        networkCalls: stepTelemetry.networkCalls,
        consoleErrors: stepTelemetry.consoleErrors,
      };

      results.push(stepRecord);

      // Persist step telemetry
      try {
        fs.writeFileSync(
          path.join(stepsDir, `step-${stepIndex}-${act}.json`),
          JSON.stringify(stepRecord, null, 2),
          'utf8'
        );
      } catch {}

      if (options.onProgress) {
        options.onProgress({
          step: stepIndex,
          total: steps.length,
          status: healed ? 'healed' : 'passed',
          description: step.description,
          healed,
          healedStrategy,
        });
      }
    } catch (err) {
      failedCount++;
      stepError = err.message;
      const durationMs = Date.now() - stepStartTime;

      // Capture failure artifacts
      const stepTelemetry = recorder.getStepTelemetry(stepIndex);

      if (page) {
        try {
          failureScreenshot = path.join(failuresDir, `step-${stepIndex}-failure.png`);
          await page.screenshot({ path: failureScreenshot });
        } catch {}

        try {
          const domSnapshot = await captureViewportInteractiveElements(page);
          fs.writeFileSync(
            path.join(failuresDir, `step-${stepIndex}-dom-snapshot.json`),
            JSON.stringify(domSnapshot, null, 2),
            'utf8'
          );
        } catch {}
      }

      // If AI reasoning wasn't generated yet, generate now for the diagnostic report
      if (!aiDiagnosis) {
        try {
          aiDiagnosis = await reasonAboutStepFailure({
            page,
            step,
            stepIndex,
            networkCalls: stepTelemetry.networkCalls,
            pendingRequests: stepTelemetry.pendingRequests,
            consoleErrors: stepTelemetry.consoleErrors,
            attemptedStrategies: [layerUsed].filter(Boolean),
            lastError: stepError,
          });
        } catch {}
      }

      if (aiDiagnosis) {
        try {
          fs.writeFileSync(
            path.join(failuresDir, `step-${stepIndex}-ai-reasoning.json`),
            JSON.stringify(aiDiagnosis, null, 2),
            'utf8'
          );
        } catch {}
      }

      const pageMessages = await capturePageMessages(page);
      const failedRequests = (stepTelemetry.networkCalls || [])
        .filter((c) => c.failed || c.status >= 400)
        .map((c) => ({ method: c.method, url: c.url, status: c.status, errorText: c.errorText }));
      const stepRecord = {
        stepIndex,
        nodeId: rawStep.id,
        label: rawStep.label,
        outcome,
        action: act,
        description: step.description,
        status: 'failed',
        pageUrl: typeof page?.url === 'function' ? page.url() : null,
        pageMessages,
        failedRequests,
        consoleErrorTexts: (stepTelemetry.consoleErrors || []).map((c) => String(c.text || c.message || c).slice(0, 200)),
        error: stepError,
        durationMs,
        layerUsed,
        failureScreenshot,
        aiDiagnosis: aiDiagnosis || undefined,
        networkCalls: stepTelemetry.networkCalls,
        consoleErrors: stepTelemetry.consoleErrors,
      };

      results.push(stepRecord);

      try {
        fs.writeFileSync(
          path.join(stepsDir, `step-${stepIndex}-${act}.json`),
          JSON.stringify(stepRecord, null, 2),
          'utf8'
        );
      } catch {}

      if (options.onProgress) {
        options.onProgress({
          step: stepIndex,
          total: steps.length,
          status: 'failed',
          error: stepError,
          description: step.description,
        });
      }

      if (!options.continueOnError) {
        noteData();
        break;
      }
    }

    noteData();

    if (options.untilNode && rawStep.id === options.untilNode) break;
    currentId = nextNodeId(flow, rawStep.id, outcome);
  }

  // A flow that ends with a click (e.g. a form submit): let the page change it starts finish, so
  // the next run or step does not cancel it.
  const lastAct = String(getNode(flow, pathTaken[pathTaken.length - 1])?.action || '');
  if (page && ['click', 'press', 'dialog'].includes(lastAct) && typeof page.waitForEvent === 'function') {
    await page.waitForEvent('framenavigated', { timeout: 1500 }).catch(() => {});
    await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
  }
  recorder.stop();
  if (page && typeof page.off === 'function') page.off('dialog', onDialog);
  try { saveVars(cwd, varsSet, { flowId: flow.id || flowSlug, runId }); } catch {}

  const durationMs = Date.now() - flowStartTime;
  const ok = failedCount === 0;
  const allTelemetry = recorder.getAllTelemetry();

  const runSummary = {
    runId,
    flowId: flow.id || flowSlug,
    flowName: flow.name || 'unnamed-flow',
    flowPath: flowFilePath,
    timestamp: new Date(runTimestamp).toISOString(),
    ok,
    status: ok ? 'pass' : 'fail',
    totalSteps: steps.length,
    path: pathTaken,
    executedSteps: results.length,
    passedSteps: passedCount,
    failedSteps: failedCount,
    healedSteps: healedCount,
    durationMs,
    runDir,
    results,
    telemetry: {
      totalNetworkCalls: allTelemetry.totalNetworkCalls,
      failedNetworkCalls: allTelemetry.failedNetworkCalls,
      totalConsoleErrors: allTelemetry.totalConsoleErrors,
    },
    dataMode,
    replayRun: options.replayRun || undefined,
    dataSeed: plan.seed,
    dataUsed: dataUsed.map(({ at, ...d }) => d),
    varsSet: Object.keys(varsSet).length ? varsSet : undefined,
    unexpectedDialogs: unexpectedDialogs.length ? unexpectedDialogs : undefined,
    summary: `${ok ? 'SUCCESS' : 'FAILED'}: ${passedCount}/${pathTaken.length} steps passed${pathTaken.length !== steps.length ? ` (path of ${pathTaken.length} of ${steps.length} nodes)` : ''} (${healedCount} healed) in ${(durationMs / 1000).toFixed(2)}s`,
  };

  // Remember generated values (later runs avoid them) and turn failures into tracked issues.
  try { rememberValues(cwd, flow.id || flowSlug, runSummary.dataUsed, { created: ok && !options.untilNode && !options.fromNode && options.overrideSource !== 'negative' }); } catch {}
  if (options.trackIssues !== false) {
    try { runSummary.issues = recordRunIssues(cwd, flow, runSummary); } catch (e) { runSummary.issues = { error: e.message }; }
  }

  // Persist run-summary.json and latest-run.json
  try {
    fs.writeFileSync(path.join(runDir, 'run-summary.json'), JSON.stringify(runSummary, null, 2), 'utf8');
    fs.writeFileSync(
      path.join(cwd, 'automation', 'runs', 'latest-run.json'),
      JSON.stringify(runSummary, null, 2),
      'utf8'
    );
  } catch {}

  return runSummary;
}
