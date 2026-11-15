import fs from 'node:fs';
import path from 'node:path';
import { SelectorResolver } from './resolver.mjs';

/**
 * Executes an automation test flow against a Playwright page session
 */
export async function runFlow(session, flowInput, options = {}) {
  let flow;
  if (typeof flowInput === 'string') {
    let resolved = flowInput;
    if (fs.existsSync(resolved)) {
      if (fs.statSync(resolved).isDirectory()) {
        resolved = path.join(resolved, 'flow.json');
      }
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

  const { page } = session;
  const steps = Array.isArray(flow.steps) ? flow.steps : [];
  const resolver = new SelectorResolver({ defaultTimeout: options.timeout || 5000 });

  const results = [];
  let passedCount = 0;
  let failedCount = 0;
  let healedCount = 0;
  const flowStartTime = Date.now();

  for (let idx = 0; idx < steps.length; idx++) {
    const step = steps[idx];
    const act = (step.action || '').toLowerCase();
    const stepStartTime = Date.now();
    let stepError = null;
    let layerUsed = '';
    let healed = false;
    let healedStrategy = '';

    try {
      switch (act) {
        case 'goto':
        case 'navigate': {
          const targetUrl = step.url || step.value;
          if (targetUrl) {
            await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          }
          break;
        }

        case 'click': {
          const res = await resolver.resolve(page, step.selectorSet, step.description, step);
          layerUsed = res.layerUsed;
          healed = res.healed;
          healedStrategy = res.strategy || '';
          await res.locator.click({ timeout: 5000 });
          break;
        }

        case 'fill': {
          const res = await resolver.resolve(page, step.selectorSet, step.description, step);
          layerUsed = res.layerUsed;
          healed = res.healed;
          healedStrategy = res.strategy || '';
          await res.locator.fill(String(step.value ?? ''), { timeout: 5000 });
          break;
        }

        case 'select': {
          const res = await resolver.resolve(page, step.selectorSet, step.description, step);
          layerUsed = res.layerUsed;
          healed = res.healed;
          healedStrategy = res.strategy || '';
          await res.locator.selectOption(String(step.value ?? ''), { timeout: 5000 });
          break;
        }

        case 'check': {
          const res = await resolver.resolve(page, step.selectorSet, step.description, step);
          layerUsed = res.layerUsed;
          healed = res.healed;
          healedStrategy = res.strategy || '';
          await res.locator.check({ timeout: 5000 });
          break;
        }

        case 'uncheck': {
          const res = await resolver.resolve(page, step.selectorSet, step.description, step);
          layerUsed = res.layerUsed;
          healed = res.healed;
          healedStrategy = res.strategy || '';
          await res.locator.uncheck({ timeout: 5000 });
          break;
        }

        case 'press': {
          const res = await resolver.resolve(page, step.selectorSet, step.description, step);
          layerUsed = res.layerUsed;
          healed = res.healed;
          healedStrategy = res.strategy || '';
          await res.locator.press(step.key || 'Enter', { timeout: 5000 });
          break;
        }

        case 'wait': {
          const ms = step.timeout || step.ms || 1000;
          await page.waitForTimeout(ms);
          break;
        }

        case 'screenshot': {
          const shotPath = step.path || path.join(options.cwd || process.cwd(), 'screenshots', `step-${idx + 1}.png`);
          fs.mkdirSync(path.dirname(shotPath), { recursive: true });
          await page.screenshot({ path: shotPath });
          break;
        }

        case 'assert': {
          const res = await resolver.resolve(page, step.selectorSet, step.description, step);
          layerUsed = res.layerUsed;
          healed = res.healed;
          healedStrategy = res.strategy || '';
          const isVisible = await res.locator.isVisible({ timeout: 5000 });
          if (!isVisible) {
            throw new Error(`Assertion failed: element "${step.description}" is not visible`);
          }
          break;
        }

        case 'scroll': {
          await page.evaluate(() => window.scrollBy(0, 500));
          break;
        }

        default: {
          throw new Error(`Unsupported automation step action: "${act}"`);
        }
      }

      if (healed) healedCount++;
      passedCount++;
      results.push({
        stepIndex: idx + 1,
        action: act,
        description: step.description,
        status: 'passed',
        durationMs: Date.now() - stepStartTime,
        layerUsed,
        healed,
        healedStrategy,
      });

      if (options.onProgress) {
        options.onProgress({
          step: idx + 1,
          total: steps.length,
          status: 'passed',
          description: step.description,
        });
      }
    } catch (err) {
      failedCount++;
      stepError = err.message;

      // Capture failure screenshot if feasible
      let failureScreenshot = null;
      try {
        const shotDir = path.join(options.cwd || process.cwd(), 'screenshots', 'failures');
        fs.mkdirSync(shotDir, { recursive: true });
        failureScreenshot = path.join(shotDir, `failure-step-${idx + 1}-${Date.now()}.png`);
        await page.screenshot({ path: failureScreenshot });
      } catch {}

      results.push({
        stepIndex: idx + 1,
        action: act,
        description: step.description,
        status: 'failed',
        error: stepError,
        durationMs: Date.now() - stepStartTime,
        layerUsed,
        failureScreenshot,
      });

      if (options.onProgress) {
        options.onProgress({
          step: idx + 1,
          total: steps.length,
          status: 'failed',
          error: stepError,
        });
      }

      // Stop on first failure unless continueOnError is set
      if (!options.continueOnError) {
        break;
      }
    }
  }

  const durationMs = Date.now() - flowStartTime;
  const ok = failedCount === 0;

  return {
    ok,
    flowName: flow.name || 'unnamed-flow',
    totalSteps: steps.length,
    executedSteps: results.length,
    passedSteps: passedCount,
    failedSteps: failedCount,
    healedSteps: healedCount,
    durationMs,
    results,
    summary: `${ok ? 'SUCCESS' : 'FAILED'}: ${passedCount}/${steps.length} steps passed (${healedCount} healed) in ${(durationMs / 1000).toFixed(2)}s`,
  };
}
