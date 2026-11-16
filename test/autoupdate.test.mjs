import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { updateStepWithHealedSelector, commitHealedFlow } from '../src/runner/autoUpdater.mjs';

describe('Flow Self-Correction & Auto-Updater', () => {
  test('updateStepWithHealedSelector updates step in memory', () => {
    const flow = {
      name: 'Test Flow',
      steps: [
        { action: 'goto', url: 'https://example.com' },
        { action: 'click', description: 'Click Login', selector: '#old-btn' },
      ],
    };

    updateStepWithHealedSelector(flow, 2, {
      healedSelector: 'button:has-text("Sign In")',
      strategy: 'AI_REASONING',
      confidence: 0.94,
      explanation: 'Label mutated from Login to Sign In',
    });

    const step2 = flow.steps[1];
    assert.equal(step2.healed, true);
    assert.equal(step2.healedStrategy, 'AI_REASONING');
    assert.equal(step2.healedConfidence, 0.94);
    assert.equal(step2.selector, 'button:has-text("Sign In")');
    assert.equal(step2.selectorSet.cssSelector, 'button:has-text("Sign In")');
    assert.equal(step2.selectorSet.text, 'Sign In');
    assert.equal(step2.selectorSet.healedSelectors.length, 1);
  });

  test('commitHealedFlow persists changes to flow.json and compiles .spec.ts', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoupdate-test-'));
    const flowPath = path.join(tempDir, 'flow.json');

    const initialFlow = {
      name: 'Auth Flow',
      steps: [
        { action: 'goto', url: 'https://example.com/login' },
        { action: 'click', description: 'Submit Credentials', selector: '[data-testid="submit-old"]' },
      ],
    };
    fs.writeFileSync(flowPath, JSON.stringify(initialFlow, null, 2), 'utf8');

    const result = commitHealedFlow(flowPath, 2, {
      healedSelector: '[data-testid="submit-new"]',
      strategy: 'AI_REASONING',
      confidence: 0.96,
    });

    assert.equal(result.ok, true);
    assert.ok(fs.existsSync(flowPath));

    const updatedFlow = JSON.parse(fs.readFileSync(flowPath, 'utf8'));
    assert.equal(updatedFlow.steps[1].healed, true);
    assert.equal(updatedFlow.steps[1].selectorSet.primarySelector, '[data-testid="submit-new"]');

    // Check spec was compiled
    const specPath = path.join(tempDir, 'flow.spec.ts');
    assert.ok(fs.existsSync(specPath));
    const specContent = fs.readFileSync(specPath, 'utf8');
    assert.match(specContent, /getByTestId\("submit-new"\)/);

    // Clean up
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('commitHealedFlow updates primarySelector and compiles spec for text-based healed selector', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoupdate-text-test-'));
    const flowPath = path.join(tempDir, 'flow.json');

    const initialFlow = {
      name: 'Text Mutation Flow',
      steps: [
        { action: 'goto', url: 'https://example.com' },
        {
          action: 'click',
          description: 'Click Login Button',
          selectorSet: {
            primarySelector: '[data-testid="old-broken-btn"]',
            cssSelector: '#old-broken-btn',
          },
        },
      ],
    };
    fs.writeFileSync(flowPath, JSON.stringify(initialFlow, null, 2), 'utf8');

    const result = commitHealedFlow(flowPath, 2, {
      healedSelector: 'button:has-text("Sign In")',
      strategy: 'AI_REASONING',
      confidence: 0.95,
      explanation: 'UI label mutated from Login to Sign In',
    });

    assert.equal(result.ok, true);

    const updatedFlow = JSON.parse(fs.readFileSync(flowPath, 'utf8'));
    assert.equal(updatedFlow.steps[1].healed, true);
    assert.equal(updatedFlow.steps[1].selectorSet.primarySelector, 'button:has-text("Sign In")');
    assert.equal(updatedFlow.steps[1].selectorSet.textSelector, 'Sign In');

    // Check spec was compiled and prioritizes healed selector
    const specPath = path.join(tempDir, 'flow.spec.ts');
    assert.ok(fs.existsSync(specPath));
    const specContent = fs.readFileSync(specPath, 'utf8');
    assert.match(specContent, /button:has-text/);
    assert.match(specContent, /Sign In/);

    // Clean up
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
