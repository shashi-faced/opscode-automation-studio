import fs from 'node:fs';
import path from 'node:path';
import { compileFlowFile } from './compiler.mjs';

/**
 * Updates a specific step inside a flow object with AI healed selectors
 */
export function updateStepWithHealedSelector(flow, stepIndex, healingDetails = {}) {
  if (!flow || !Array.isArray(flow.steps)) {
    throw new Error('Invalid flow object: missing steps array');
  }

  const idx = stepIndex - 1;
  if (idx < 0 || idx >= flow.steps.length) {
    throw new Error(`Step index ${stepIndex} out of bounds (1..${flow.steps.length})`);
  }

  const step = flow.steps[idx];
  const healedSelector = healingDetails.healedSelector || healingDetails.selector;
  if (!healedSelector) {
    throw new Error('Missing healedSelector in healingDetails');
  }

  step.healed = true;
  step.healedStrategy = healingDetails.strategy || 'AI_REASONING';
  step.healedConfidence = healingDetails.confidence || 0.9;
  if (healingDetails.explanation) {
    step.healedExplanation = healingDetails.explanation;
  }

  if (!step.selectorSet || typeof step.selectorSet !== 'object') {
    step.selectorSet = {};
  }

  if (!Array.isArray(step.selectorSet.healedSelectors)) {
    step.selectorSet.healedSelectors = [];
  }

  step.selectorSet.healedSelectors.push({
    selector: healedSelector,
    strategy: step.healedStrategy,
    confidence: step.healedConfidence,
    updatedAt: new Date().toISOString(),
  });

  // Apply to specific selector attributes and update primary selector to the healed locator
  step.selectorSet.primarySelector = healedSelector;

  if (healedSelector.startsWith('[data-testid=') && healedSelector.endsWith('"]')) {
    step.selectorSet.primarySelector = healedSelector;
  } else if (healedSelector.startsWith('#')) {
    step.selectorSet.cssSelector = healedSelector;
  } else if (healedSelector.includes(':has-text(')) {
    step.selectorSet.cssSelector = healedSelector;
    const match = healedSelector.match(/:has-text\("([^"]+)"\)/);
    if (match) {
      step.selectorSet.textSelector = match[1];
      step.selectorSet.text = match[1];
    }
  } else if (healedSelector.startsWith('[aria-label=')) {
    const match = healedSelector.match(/\[aria-label="([^"]+)"\]/);
    if (match) {
      step.selectorSet.ariaSelector = {
        role: step.selectorSet.ariaSelector?.role || 'button',
        name: match[1],
      };
    }
    step.selectorSet.cssSelector = healedSelector;
  } else {
    step.selectorSet.cssSelector = healedSelector;
  }

  step.selector = healedSelector;
  flow.updatedAt = new Date().toISOString();

  return flow;
}

/**
 * Commits a healed step selector to flow.json on disk and recompiles the Playwright .spec.ts
 */
export function commitHealedFlow(flowFilePath, stepIndex, healingDetails, options = {}) {
  let resolved = flowFilePath;
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
    resolved = path.join(resolved, 'flow.json');
  }

  if (!fs.existsSync(resolved)) {
    throw new Error(`Flow file does not exist: ${resolved}`);
  }

  const raw = fs.readFileSync(resolved, 'utf8');
  const flow = JSON.parse(raw);

  updateStepWithHealedSelector(flow, stepIndex, healingDetails);

  fs.writeFileSync(resolved, JSON.stringify(flow, null, 2), 'utf8');

  let specResult = null;
  if (options.recompile !== false) {
    try {
      specResult = compileFlowFile(resolved, undefined, { withFallbacks: true });
    } catch (err) {
      console.warn(`[AutoUpdater] Spec recompilation failed: ${err.message}`);
    }
  }

  return {
    ok: true,
    flowFilePath: resolved,
    specFile: specResult?.specFile,
    stepIndex,
    updatedStep: flow.steps[stepIndex - 1],
  };
}
