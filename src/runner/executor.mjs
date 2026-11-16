import fs from 'node:fs';
import path from 'node:path';
import { SelectorResolver } from './resolver.mjs';
import { FlightRecorder } from '../telemetry/flightRecorder.mjs';
import { reasonAboutStepFailure, captureViewportInteractiveElements } from '../ai/reasoningEngine.mjs';
import { commitHealedFlow } from './autoUpdater.mjs';

/**
 * Executes an action on a Playwright locator
 */
async function executeLocatorAction(locator, act, step) {
  switch (act) {
    case 'click':
      await locator.click({ timeout: 5000 });
      break;
    case 'fill':
      await locator.fill(String(step.value ?? ''), { timeout: 5000 });
      break;
    case 'select':
      await locator.selectOption(String(step.value ?? ''), { timeout: 5000 });
      break;
    case 'check':
      await locator.check({ timeout: 5000 });
      break;
    case 'uncheck':
      await locator.uncheck({ timeout: 5000 });
      break;
    case 'press':
      await locator.press(step.key || 'Enter', { timeout: 5000 });
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

  for (let idx = 0; idx < steps.length; idx++) {
    const step = steps[idx];
    const act = (step.action || '').toLowerCase();
    const stepIndex = idx + 1;
    const stepStartTime = Date.now();

    recorder.setStep(stepIndex, { action: act, description: step.description });

    let stepError = null;
    let layerUsed = '';
    let healed = false;
    let healedStrategy = '';
    let healingDetails = null;
    let failureScreenshot = null;
    let aiDiagnosis = null;

    try {
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
            }
          }
          break;
        }

        case 'click':
        case 'fill':
        case 'select':
        case 'check':
        case 'uncheck':
        case 'press':
        case 'assert':
        case 'assert_visible': {
          if (!page) break;
          try {
            const res = await resolver.resolve(page, step.selectorSet, step.description, step);
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
                const retryRes = await resolver.resolve(page, step.selectorSet, step.description, step);
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
                  const healedLoc = page.locator(candSelector).first();
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
                const retryRes = await resolver.resolve(page, step.selectorSet, step.description, step);
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
              const healedLoc = page.locator(candSelector).first();
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

      const durationMs = Date.now() - stepStartTime;
      const stepTelemetry = recorder.getStepTelemetry(stepIndex);

      if (healed) healedCount++;
      passedCount++;

      const stepRecord = {
        stepIndex,
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

      const stepRecord = {
        stepIndex,
        action: act,
        description: step.description,
        status: 'failed',
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
        break;
      }
    }
  }

  recorder.stop();

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
    summary: `${ok ? 'SUCCESS' : 'FAILED'}: ${passedCount}/${steps.length} steps passed (${healedCount} healed) in ${(durationMs / 1000).toFixed(2)}s`,
  };

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
