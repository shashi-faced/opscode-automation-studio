import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeSemanticSimilarity,
  buildCandidateSelector,
  reasonAboutStepFailure,
} from '../src/ai/reasoningEngine.mjs';

describe('AI Real-Time Step Reasoning & Healing Engine', () => {
  test('computeSemanticSimilarity handles exact and synonym groups', () => {
    // Exact
    assert.equal(computeSemanticSimilarity('Sign In', 'Sign In'), 1.0);

    // Synonym pairs
    const loginSim = computeSemanticSimilarity('Log In', 'Sign In');
    assert.ok(loginSim >= 0.85, `Expected loginSim >= 0.85, got ${loginSim}`);

    const submitSim = computeSemanticSimilarity('Submit', 'Continue');
    assert.ok(submitSim >= 0.85, `Expected submitSim >= 0.85, got ${submitSim}`);

    const cartSim = computeSemanticSimilarity('Add to Cart', 'Add to Bag');
    assert.ok(cartSim >= 0.85, `Expected cartSim >= 0.85, got ${cartSim}`);

    // Disparate words
    const lowSim = computeSemanticSimilarity('Delete Account', 'Search Products');
    assert.ok(lowSim < 0.3, `Expected lowSim < 0.3, got ${lowSim}`);
  });

  test('buildCandidateSelector creates resilient Playwright locators', () => {
    assert.equal(
      buildCandidateSelector({ dataTestId: 'login-submit-btn' }),
      '[data-testid="login-submit-btn"]'
    );
    assert.equal(
      buildCandidateSelector({ id: 'auth_submit' }),
      '#auth_submit'
    );
    assert.equal(
      buildCandidateSelector({ ariaLabel: 'Close Dialog' }),
      '[aria-label="Close Dialog"]'
    );
    assert.equal(
      buildCandidateSelector({ placeholder: 'Enter your email' }),
      '[placeholder="Enter your email"]'
    );
    assert.equal(
      buildCandidateSelector({ tag: 'button', text: 'Sign In' }),
      'button:has-text("Sign In")'
    );
  });

  test('reasonAboutStepFailure diagnoses 500 API failures as root cause', async () => {
    const result = await reasonAboutStepFailure({
      step: { action: 'click', description: 'Click Checkout Button' },
      stepIndex: 4,
      networkCalls: [
        {
          url: 'https://api.shop.com/v1/cart/checkout',
          method: 'POST',
          status: 500,
          failed: true,
          errorText: 'HTTP 500',
          requestPreview: '{"cartId": 123}',
          responsePreview: '{"error": "Database lock timeout"}',
        },
      ],
    });

    assert.equal(result.rootCauseType, 'BACKEND_API_FAILURE');
    assert.equal(result.recommendedAction, 'DIAGNOSTIC_TERMINATION');
    assert.ok(result.failedApi);
    assert.equal(result.failedApi.status, 500);
    assert.match(result.diagnosis, /Backend API failure/);
  });

  test('reasonAboutStepFailure discovers nearby changed button and recommends HEAL_AND_CONTINUE', async () => {
    const mockPage = {
      evaluate: async (fn) => {
        // Return simulated viewport interactive elements
        return [
          {
            tag: 'button',
            id: 'auth-btn',
            text: 'Sign In',
            ariaLabel: 'Sign in to your account',
            dataTestId: '',
            placeholder: '',
            type: 'submit',
            name: '',
            role: 'button',
            rect: { x: 300, y: 250, width: 120, height: 40 },
            isObscured: false,
          },
          {
            tag: 'a',
            id: 'forgot-link',
            text: 'Forgot Password?',
            ariaLabel: '',
            rect: { x: 300, y: 310, width: 140, height: 20 },
            isObscured: false,
          },
        ];
      },
    };

    const result = await reasonAboutStepFailure({
      page: mockPage,
      step: {
        action: 'click',
        description: 'Click Log In button',
        selectorSet: { text: 'Log In' },
      },
      stepIndex: 2,
      networkCalls: [],
      consoleErrors: [],
    });

    assert.equal(result.rootCauseType, 'UI_LABEL_CHANGE');
    assert.equal(result.recommendedAction, 'HEAL_AND_CONTINUE');
    assert.ok(result.selectedCandidate);
    assert.equal(result.selectedCandidate.selector, '#auth-btn');
    assert.ok(result.selectedCandidate.confidence > 0.75);
  });

  test('reasonAboutStepFailure decides BACKOFF_RETRY when pending in-flight API exists', async () => {
    const result = await reasonAboutStepFailure({
      step: { action: 'click', description: 'Click Checkout Button' },
      stepIndex: 3,
      networkCalls: [],
      pendingRequests: [
        {
          url: 'https://api.shop.com/v1/cart/items',
          method: 'GET',
          startTime: Date.now() - 2500,
          durationMs: 2500,
        },
      ],
      consoleErrors: [],
    });

    assert.equal(result.rootCauseType, 'SLOW_API_PENDING');
    assert.equal(result.recommendedAction, 'BACKOFF_RETRY');
    assert.equal(result.backoffMs, 2000);
    assert.ok(result.slowApi);
    assert.equal(result.slowApi.isPending, true);
    assert.match(result.explanation, /Backing off for 2000ms/);
  });

  test('reasonAboutStepFailure decides BACKOFF_RETRY on HTTP 429 rate limit or slow latency API', async () => {
    const result = await reasonAboutStepFailure({
      step: { action: 'fill', description: 'Search input', value: 'shoes' },
      stepIndex: 2,
      networkCalls: [
        {
          url: 'https://api.shop.com/search/suggest',
          method: 'GET',
          status: 429,
          durationMs: 400,
        },
      ],
      pendingRequests: [],
      consoleErrors: [],
    });

    assert.equal(result.rootCauseType, 'API_RATE_LIMIT');
    assert.equal(result.recommendedAction, 'BACKOFF_RETRY');
    assert.equal(result.backoffMs, 3500);
  });

  test('reasonAboutStepFailure discovers form inputs via associated labels and nearby siblings', async () => {
    const mockPage = {
      evaluate: async () => [
        {
          tag: 'input',
          id: 'user_email_input',
          text: '',
          associatedLabel: 'Work Email Address',
          nearbyText: 'Work Email Address Please enter your company email',
          rect: { x: 100, y: 150, width: 250, height: 35 },
          isObscured: false,
        },
      ],
    };

    const result = await reasonAboutStepFailure({
      page: mockPage,
      step: { action: 'fill', description: 'Fill Work Email', value: 'alice@company.com' },
      stepIndex: 1,
      networkCalls: [],
      pendingRequests: [],
      consoleErrors: [],
    });

    assert.equal(result.recommendedAction, 'HEAL_AND_CONTINUE');
    assert.equal(result.selectedCandidate.selector, '#user_email_input');
    assert.equal(result.selectedCandidate.matchedText, 'Work Email Address');
  });

  test('reasonAboutStepFailure falls back to ELEMENT_NOT_FOUND when no match exists', async () => {
    const mockPage = {
      evaluate: async () => [],
    };

    const result = await reasonAboutStepFailure({
      page: mockPage,
      step: { action: 'click', description: 'Click Nonexistent Element' },
      stepIndex: 1,
      networkCalls: [],
      consoleErrors: [{ type: 'error', text: 'Error in component' }],
    });

    assert.equal(result.rootCauseType, 'ELEMENT_NOT_FOUND');
    assert.equal(result.recommendedAction, 'DIAGNOSTIC_TERMINATION');
  });
});
