import axe from 'axe-core';

/**
 * Runs a WCAG accessibility audit on a page using axe-core
 */
export async function auditPage(session, options = {}) {
  const { page } = session;
  const { url, tags = ['wcag2a', 'wcag2aa', 'wcag21aa', 'best-practice'] } = options;

  if (url && page.url() !== url) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  }

  // Inject axe-core source directly into the page
  const axeSource = axe.source;
  await page.evaluate((src) => {
    if (!window.axe) {
      const s = document.createElement('script');
      s.textContent = src;
      (document.head || document.documentElement).appendChild(s);
    }
  }, axeSource);

  // Run accessibility evaluation
  const results = await page.evaluate(async (runTags) => {
    return await window.axe.run(document.body, {
      runOnly: {
        type: 'tag',
        values: runTags,
      },
    });
  }, tags);

  const rawViolations = results.violations || [];
  const violations = rawViolations.map((v) => ({
    rule: v.id,
    impact: v.impact || 'minor',
    description: v.description,
    helpUrl: v.helpUrl,
    nodesCount: (v.nodes || []).length,
    selectors: (v.nodes || []).map((n) => (Array.isArray(n.target) ? n.target.join(' > ') : String(n.target))).slice(0, 5),
  }));

  // Impact weighting
  let penalty = 0;
  let hasCriticalOrSerious = false;
  for (const v of violations) {
    if (v.impact === 'critical') {
      penalty += 15 * v.nodesCount;
      hasCriticalOrSerious = true;
    } else if (v.impact === 'serious') {
      penalty += 8 * v.nodesCount;
      hasCriticalOrSerious = true;
    } else if (v.impact === 'moderate') {
      penalty += 4 * v.nodesCount;
    } else {
      penalty += 1 * v.nodesCount;
    }
  }

  const score = Math.max(0, Math.min(100, Math.round(100 - penalty)));

  let wcagLevel = 'AAA';
  if (hasCriticalOrSerious || score < 70) {
    wcagLevel = 'FAIL';
  } else if (violations.length > 0 || score < 95) {
    wcagLevel = 'AA';
  }

  const currentUrl = page.url();

  return {
    ok: true,
    url: currentUrl,
    score,
    wcagLevel,
    violationsCount: violations.length,
    violations,
    passesCount: (results.passes || []).length,
    incompleteCount: (results.incomplete || []).length,
    summary: `Accessibility score: ${score}/100 (${wcagLevel}). Found ${violations.length} violation types on ${currentUrl}.`,
  };
}
