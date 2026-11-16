/**
 * AI Real-Time Step Reasoning & "Nearby Element" Self-Healing Engine
 * Analyzes live DOM hierarchy, semantic proximity, API failures, blocking overlays,
 * and console errors to diagnose root causes and heal broken automation steps in real time.
 */

// Common semantic synonyms and UI label mutations
const SYNONYM_GROUPS = [
  ['log in', 'login', 'sign in', 'signin', 'authenticate'],
  ['sign up', 'signup', 'register', 'create account', 'join'],
  ['submit', 'continue', 'proceed', 'next', 'confirm', 'done', 'send', 'save'],
  ['cancel', 'abort', 'dismiss', 'close', 'back'],
  ['search', 'find', 'lookup', 'query', 'filter'],
  ['add to cart', 'add to bag', 'buy now', 'purchase', 'order'],
  ['delete', 'remove', 'trash', 'clear'],
  ['edit', 'modify', 'change', 'update'],
  ['accept', 'agree', 'allow', 'got it', 'ok', 'understand', 'consent'],
];

/**
 * Computes semantic similarity between target phrase and candidate text (0.0 to 1.0)
 */
export function computeSemanticSimilarity(target, candidate) {
  if (!target || !candidate) return 0;
  const t = target.toLowerCase().trim();
  const c = candidate.toLowerCase().trim();

  if (t === c) return 1.0;
  if (t.includes(c) || c.includes(t)) {
    const ratio = Math.min(t.length, c.length) / Math.max(t.length, c.length);
    return Math.max(0.7, ratio);
  }

  // Check synonym groups
  for (const group of SYNONYM_GROUPS) {
    const targetInGroup = group.some((phrase) => t.includes(phrase) || phrase.includes(t));
    const candidateInGroup = group.some((phrase) => c.includes(phrase) || phrase.includes(c));
    if (targetInGroup && candidateInGroup) {
      return 0.88;
    }
  }

  // Token overlap / Jaccard similarity
  const tTokens = new Set(t.split(/[\s_-]+/).filter((w) => w.length > 2));
  const cTokens = new Set(c.split(/[\s_-]+/).filter((w) => w.length > 2));
  if (tTokens.size === 0 || cTokens.size === 0) return 0;

  let intersection = 0;
  for (const token of tTokens) {
    if (cTokens.has(token)) intersection++;
  }
  const union = new Set([...tTokens, ...cTokens]).size;
  return union > 0 ? intersection / union : 0;
}

/**
 * Builds a robust Playwright selector for a candidate element
 */
export function buildCandidateSelector(el) {
  if (el.dataTestId) return `[data-testid="${el.dataTestId}"]`;
  if (el.id && /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(el.id)) return `#${el.id}`;
  if (el.ariaLabel) return `[aria-label="${el.ariaLabel.replace(/"/g, '\\"')}"]`;
  if (el.placeholder) return `[placeholder="${el.placeholder.replace(/"/g, '\\"')}"]`;
  if (el.name) return `${el.tag || 'input'}[name="${el.name.replace(/"/g, '\\"')}"]`;
  if (el.text && el.text.length < 60) {
    const tag = (el.tag || 'button').toLowerCase();
    return `${tag}:has-text("${el.text.replace(/"/g, '\\"')}")`;
  }
  return el.tag ? el.tag.toLowerCase() : 'button';
}

/**
 * Inspects the live browser page and captures interactive elements in the viewport
 */
export async function captureViewportInteractiveElements(page) {
  if (!page || typeof page.evaluate !== 'function') return [];

  try {
    return await page.evaluate(() => {
      const selectors = [
        'button',
        'a',
        'input',
        'select',
        'textarea',
        '[role="button"]',
        '[role="link"]',
        '[role="menuitem"]',
        '[role="tab"]',
        '[role="checkbox"]',
        '[tabindex="0"]',
      ].join(', ');

      const nodes = Array.from(document.querySelectorAll(selectors));
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight;

      const candidates = [];

      for (const el of nodes) {
        const rect = el.getBoundingClientRect();
        // Check if visible within viewport
        const isVisible =
          rect.width > 0 &&
          rect.height > 0 &&
          rect.bottom >= 0 &&
          rect.right >= 0 &&
          rect.top <= viewportHeight &&
          rect.left <= viewportWidth;

        if (!isVisible) continue;

        // Check if obscured by another element
        let isObscured = false;
        try {
          const centerX = rect.left + rect.width / 2;
          const centerY = rect.top + rect.height / 2;
          const topEl = document.elementFromPoint(centerX, centerY);
          if (topEl && topEl !== el && !el.contains(topEl) && !topEl.contains(el)) {
            isObscured = true;
          }
        } catch {}

        const tag = el.tagName ? el.tagName.toLowerCase() : '';
        const id = el.id || '';
        const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 100);
        const ariaLabel = el.getAttribute('aria-label') || '';
        const dataTestId = el.dataset ? (el.dataset.testid || el.dataset.cy || el.dataset.qa || '') : '';
        const placeholder = el.getAttribute('placeholder') || '';
        const type = el.getAttribute('type') || '';
        const name = el.getAttribute('name') || '';
        const role = el.getAttribute('role') || '';
        const parentTag = el.parentElement?.tagName ? el.parentElement.tagName.toLowerCase() : '';
        const parentId = el.parentElement?.id || '';

        // Capture associated label
        let associatedLabel = '';
        if (el.labels && el.labels.length > 0) {
          associatedLabel = (el.labels[0].textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
        } else if (el.id) {
          try {
            const lbl = document.querySelector(`label[for="${el.id}"]`);
            if (lbl) associatedLabel = (lbl.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
          } catch {}
        }
        if (!associatedLabel && el.closest) {
          const parentLbl = el.closest('label');
          if (parentLbl) associatedLabel = (parentLbl.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
        }

        // Capture nearby siblings
        const nearbySiblings = [];
        const prevEl = el.previousElementSibling;
        const nextEl = el.nextElementSibling;
        if (prevEl) {
          const prevText = (prevEl.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
          nearbySiblings.push({ tag: prevEl.tagName.toLowerCase(), text: prevText, position: 'previous' });
        }
        if (nextEl) {
          const nextText = (nextEl.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
          nearbySiblings.push({ tag: nextEl.tagName.toLowerCase(), text: nextText, position: 'next' });
        }

        const nearbyText = [associatedLabel, ...nearbySiblings.map((s) => s.text)].filter(Boolean).join(' ').slice(0, 120);

        candidates.push({
          tag,
          id,
          text,
          ariaLabel,
          dataTestId,
          placeholder,
          type,
          name,
          role,
          parentTag,
          parentId,
          associatedLabel,
          nearbySiblings,
          nearbyText,
          rect: {
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
          isObscured,
        });
      }

      return candidates;
    });
  } catch (err) {
    console.warn(`[AI Reasoning] Viewport capture error: ${err.message}`);
    return [];
  }
}

/**
 * Detects if a blocking overlay (cookie banner, promo popup, modal) is obstructing clicks
 */
export async function detectBlockingOverlay(page) {
  if (!page || typeof page.evaluate !== 'function') return null;

  try {
    return await page.evaluate(() => {
      // Find fixed or absolute elements with high z-index covering large parts of viewport
      const all = Array.from(document.querySelectorAll('div, dialog, aside, section, [role="dialog"], [role="alertdialog"]'));
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight;

      for (const el of all) {
        const style = window.getComputedStyle(el);
        const isPositioned = style.position === 'fixed' || style.position === 'absolute';
        const zIndex = parseInt(style.zIndex, 10) || 0;

        if (isPositioned && zIndex >= 20) {
          const rect = el.getBoundingClientRect();
          const coversArea = (rect.width * rect.height) / (viewportWidth * viewportHeight);

          if (coversArea > 0.25 || el.getAttribute('role') === 'dialog' || el.tagName.toLowerCase() === 'dialog') {
            // Find dismiss or close button inside this overlay
            const dismissBtns = Array.from(el.querySelectorAll('button, [role="button"], a, svg, [aria-label]'));
            for (const btn of dismissBtns) {
              const text = (btn.textContent || '').trim().toLowerCase();
              const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
              if (
                /close|dismiss|accept|agree|got it|ok|understand|×/i.test(text) ||
                /close|dismiss|accept|agree|got it/i.test(aria)
              ) {
                let dismissSelector = '';
                if (btn.getAttribute('aria-label')) {
                  dismissSelector = `[aria-label="${btn.getAttribute('aria-label')}"]`;
                } else if (text && text.length < 30) {
                  dismissSelector = `button:has-text("${text}")`;
                } else if (btn.id) {
                  dismissSelector = `#${btn.id}`;
                } else {
                  dismissSelector = 'button';
                }

                return {
                  isOverlayPresent: true,
                  overlayTag: el.tagName.toLowerCase(),
                  overlayClass: el.className || '',
                  dismissSelector,
                  dismissText: text || aria,
                };
              }
            }
          }
        }
      }
      return null;
    });
  } catch {
    return null;
  }
}

/**
 * Main AI Step Reasoning Loop:
 * Diagnoses why a step failed and decides the optimal recovery action:
 * (a) HEAL_AND_CONTINUE with nearby element
 * (b) DISMISS_OVERLAY and retry
 * (c) BACKOFF_RETRY for slow/pending API
 * (d) DIAGNOSTIC_TERMINATION for server API failures (500)
 */
export async function reasonAboutStepFailure(context = {}) {
  const {
    page,
    step = {},
    stepIndex = 1,
    networkCalls = [],
    pendingRequests = [],
    consoleErrors = [],
    attemptedStrategies = [],
    lastError = '',
  } = context;

  const action = (step.action || '').toLowerCase();
  const description = step.description || '';
  const selectorSet = step.selectorSet || {};

  // 1. Check for Hard Backend Server / API Errors (HTTP 500, or non-transient 5xx)
  const serverError = networkCalls.find(
    (call) =>
      call.status === 500 ||
      (call.status >= 501 && call.status < 600 && call.status !== 503 && call.status !== 504)
  );

  if (serverError) {
    return {
      diagnosis: `Backend API failure: ${serverError.method} ${serverError.url} returned HTTP ${serverError.status} (${serverError.errorText || 'Internal Server Error'}).`,
      rootCauseType: 'BACKEND_API_FAILURE',
      recommendedAction: 'DIAGNOSTIC_TERMINATION',
      failedApi: {
        url: serverError.url,
        method: serverError.method,
        status: serverError.status,
        durationMs: serverError.durationMs,
        errorText: serverError.errorText,
        requestPreview: serverError.requestPreview,
        responsePreview: serverError.responsePreview,
      },
      confidence: 0.95,
      explanation: `Step ${stepIndex} (${description || action}) failed because an essential backend API endpoint returned HTTP ${serverError.status}. Automation halts with diagnostic telemetry so developers can address the API defect.`,
    };
  }

  // 2. Check for Slow API / Pending In-Flight Requests / Transient Rate Limiting (Decision C: BACKOFF_RETRY)
  const pendingApi = pendingRequests && pendingRequests.length > 0 ? pendingRequests[0] : null;
  const slowOrTransientApi = networkCalls.find(
    (call) =>
      call.status === 429 || // Too Many Requests / Rate limited
      call.status === 503 || // Service Unavailable
      call.status === 504 || // Gateway Timeout
      /ERR_TIMED_OUT|ERR_CONNECTION_TIMED_OUT|net::ERR_NETWORK_CHANGED/i.test(call.errorText || '') ||
      (call.durationMs && call.durationMs >= 1200) // High API latency during this step
  );

  if (pendingApi || slowOrTransientApi) {
    const triggerApi = pendingApi || slowOrTransientApi;
    const isRateLimit = triggerApi.status === 429;
    const backoffMs = isRateLimit ? 3500 : 2000;

    return {
      diagnosis: pendingApi
        ? `Asynchronous API request still in-flight: ${pendingApi.method} ${pendingApi.url} (${pendingApi.durationMs || 0}ms elapsed). DOM element not yet rendered.`
        : `Slow or rate-limited API response detected: ${triggerApi.method} ${triggerApi.url} (status ${triggerApi.status || 'timeout'}, duration ${triggerApi.durationMs || 0}ms).`,
      rootCauseType: isRateLimit ? 'API_RATE_LIMIT' : 'SLOW_API_PENDING',
      recommendedAction: 'BACKOFF_RETRY',
      backoffMs,
      slowApi: {
        url: triggerApi.url,
        method: triggerApi.method,
        status: triggerApi.status || 0,
        durationMs: triggerApi.durationMs,
        isPending: !!pendingApi,
      },
      confidence: 0.90,
      explanation: `Step ${stepIndex} (${description || action}) failed because the page was waiting on slow or pending network API (${triggerApi.method} ${triggerApi.url}). Backing off for ${backoffMs}ms to allow DOM hydration before retry.`,
    };
  }

  // 3. Check for Blocking Modals / Overlays (Decision B: DISMISS_OVERLAY)
  if (page) {
    const overlay = await detectBlockingOverlay(page);
    if (overlay && overlay.dismissSelector) {
      return {
        diagnosis: `Interaction blocked by overlay/modal (<${overlay.overlayTag}>) obscuring target element.`,
        rootCauseType: 'OVERLAY_BLOCKED',
        recommendedAction: 'DISMISS_OVERLAY',
        dismissSelector: overlay.dismissSelector,
        confidence: 0.92,
        explanation: `A modal/consent dialog is covering the viewport. AI suggests dismissing the overlay via "${overlay.dismissSelector}" and retrying step ${stepIndex}.`,
      };
    }
  }

  // 4. Check for Nearby Interactive Elements and Semantic Mutations (Decision A: HEAL_AND_CONTINUE)
  let candidates = [];
  if (page) {
    candidates = await captureViewportInteractiveElements(page);
  }

  if (candidates.length > 0) {
    // Extract intent words from step
    const rawTarget =
      selectorSet.text ||
      selectorSet.textSelector ||
      selectorSet.ariaName ||
      description.replace(/^(click|fill|type|press|assert|check|uncheck)\s+/i, '');
    const targetText = String(rawTarget || '').replace(/^["']|["']$/g, '').trim();

    const scored = candidates
      .map((cand) => {
        let score = 0;
        // Text / aria similarity
        const textSim = computeSemanticSimilarity(targetText, cand.text);
        const ariaSim = computeSemanticSimilarity(targetText, cand.ariaLabel);
        const idSim = computeSemanticSimilarity(targetText, cand.id);
        const placeholderSim = computeSemanticSimilarity(targetText, cand.placeholder);
        const nameSim = computeSemanticSimilarity(targetText, cand.name);
        const labelSim = computeSemanticSimilarity(targetText, cand.associatedLabel);
        const nearbySim = computeSemanticSimilarity(targetText, cand.nearbyText);

        score = Math.max(
          textSim * 10,
          ariaSim * 9,
          placeholderSim * 8,
          labelSim * 8.5,
          nearbySim * 7.5,
          nameSim * 7,
          idSim * 6
        );

        // Action-specific bonuses
        if (action === 'click' && (cand.tag === 'button' || cand.role === 'button' || cand.tag === 'a')) {
          score += 2;
        }
        if (action === 'fill' && (cand.tag === 'input' || cand.tag === 'textarea')) {
          score += 2;
        }

        // Deduct if obscured
        if (cand.isObscured) {
          score -= 3;
        }

        return { cand, score, textSim, ariaSim, labelSim, nearbySim };
      })
      .filter((item) => item.score > 4);

    scored.sort((a, b) => b.score - a.score);

    if (scored.length > 0) {
      const top = scored[0];
      const confidence = Math.min(0.96, Math.max(0.72, top.score / 12));

      // Build healed selector
      const healedSelector = buildCandidateSelector(top.cand);

      return {
        diagnosis: `Target element changed or moved: detected matching candidate "${top.cand.text || top.cand.ariaLabel || top.cand.associatedLabel || top.cand.id}" with ${(confidence * 100).toFixed(0)}% confidence.`,
        rootCauseType: 'UI_LABEL_CHANGE',
        recommendedAction: 'HEAL_AND_CONTINUE',
        selectedCandidate: {
          selector: healedSelector,
          strategy: 'ai_nearby_semantic',
          confidence,
          matchedText: top.cand.text || top.cand.associatedLabel,
          tag: top.cand.tag,
          rect: top.cand.rect,
          nearbySiblings: top.cand.nearbySiblings,
        },
        explanation: `Original selector failed. AI located candidate element <${top.cand.tag}> matching intent "${targetText}" at (${top.cand.rect.x}, ${top.cand.rect.y}).`,
      };
    }
  }

  // 5. Fallback: Element Not Found with Console Error Diagnostics
  return {
    diagnosis: `Could not resolve target element for step "${description || action}".`,
    rootCauseType: 'ELEMENT_NOT_FOUND',
    recommendedAction: 'DIAGNOSTIC_TERMINATION',
    attemptedStrategies,
    lastError,
    consoleErrors: consoleErrors.slice(0, 5),
    confidence: 0.8,
    explanation: `All deterministic selector layers and AI viewport reasoning failed to identify a matching candidate. Check console errors or element state.`,
  };
}
