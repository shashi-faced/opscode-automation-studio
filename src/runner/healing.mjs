/**
 * Deterministic DOM scan (Layer 6A) for self-healing when primary selectors fail.
 * Inspects all interactive elements currently on the page and matches against
 * semantic cues in the step description.
 */

export function buildSelectorFromCandidate(el) {
  if (el.dataTestId) return `[data-testid="${el.dataTestId}"]`;
  if (el.id && /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(el.id)) return `#${el.id}`;
  if (el.ariaLabel) return `[aria-label="${el.ariaLabel.replace(/"/g, '\\"')}"]`;
  if (el.placeholder) return `[placeholder="${el.placeholder.replace(/"/g, '\\"')}"]`;
  if (el.name) return `[name="${el.name.replace(/"/g, '\\"')}"]`;
  if (el.text && el.text.length < 50) {
    const tag = (el.tag || '').toLowerCase() || 'button';
    return `${tag}:has-text("${el.text.replace(/"/g, '\\"')}")`;
  }
  return el.tag ? el.tag.toLowerCase() : 'button';
}

export async function attemptDomScanHealing(page, step) {
  if (!page || !step) return null;

  try {
    const currentDOM = await page.evaluate(() => {
      const els = document.querySelectorAll(
        'button, a, input, select, textarea, [role="button"], [role="link"], [role="menuitem"], [tabindex="0"]'
      );
      return Array.from(els).map((el) => ({
        tag: el.tagName ? el.tagName.toLowerCase() : '',
        id: el.id || '',
        text: (el.textContent || '').trim().slice(0, 100),
        ariaLabel: el.getAttribute('aria-label') || '',
        dataTestId: el.dataset ? (el.dataset.testid || el.dataset.cy || el.dataset.qa || '') : '',
        placeholder: el.getAttribute('placeholder') || '',
        type: el.getAttribute('type') || '',
        name: el.getAttribute('name') || '',
        role: el.getAttribute('role') || '',
      }));
    });

    const desc = (step.description || '').toLowerCase();
    const words = desc
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !['click', 'fill', 'type', 'press', 'into', 'button', 'link', 'input', 'with'].includes(w));

    if (!words.length) return null;

    // Filter elements matching one or more descriptive keywords
    const scored = currentDOM.map((el) => {
      let score = 0;
      const t = el.text.toLowerCase();
      const a = el.ariaLabel.toLowerCase();
      const p = el.placeholder.toLowerCase();
      const n = el.name.toLowerCase();
      const i = el.id.toLowerCase();

      for (const word of words) {
        if (t === word) score += 4;
        else if (t.includes(word)) score += 2;
        if (a === word) score += 4;
        else if (a.includes(word)) score += 2;
        if (p.includes(word)) score += 2;
        if (n.includes(word)) score += 2;
        if (i.includes(word)) score += 1;
      }
      return { el, score };
    }).filter(item => item.score > 0);

    scored.sort((a, b) => b.score - a.score);

    if (scored.length > 0) {
      const top = scored[0];
      // Only accept if clearly the best match (or solitary match)
      if (scored.length === 1 || (scored.length > 1 && top.score >= scored[1].score + 2)) {
        const healedSelector = buildSelectorFromCandidate(top.el);
        return {
          selector: healedSelector,
          strategy: 'DOM_SCAN',
          confidence: Math.min(0.95, 0.6 + top.score * 0.05),
          matchedElement: top.el,
        };
      }
    }

    return null;
  } catch (err) {
    console.warn(`[Healing] DOM scan error: ${err.message}`);
    return null;
  }
}
