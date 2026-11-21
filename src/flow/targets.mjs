// Turn a target description into a Playwright locator, and evaluate decision conditions.
//
// A target is either a string (CSS, `text=...`, `label=...`, `placeholder=...`, `testid=...`,
// `role=button[name="Save"]`, `xpath=...`) or an object { selector | text | label | placeholder |
// testId | role + name, exact?, nth? }.

export function locatorFromTarget(page, target) {
  if (!target) throw new Error('A target is required (selector, text, label, role, placeholder or testId).');
  let loc;
  if (typeof target === 'string') {
    const t = target.trim();
    const m = /^(text|label|placeholder|testid|testId)=(.*)$/s.exec(t);
    if (m) {
      const v = m[2].replace(/^"(.*)"$/s, '$1');
      if (m[1] === 'text') loc = page.getByText(v);
      else if (m[1] === 'label') loc = page.getByLabel(v);
      else if (m[1] === 'placeholder') loc = page.getByPlaceholder(v);
      else loc = page.getByTestId(v);
    } else {
      loc = page.locator(t);
    }
  } else if (typeof target === 'object') {
    const exact = target.exact === true ? { exact: true } : {};
    if (target.selector) loc = page.locator(target.selector);
    else if (target.testId) loc = page.getByTestId(target.testId);
    else if (target.role) loc = page.getByRole(target.role, target.name ? { name: target.name, ...exact } : {});
    else if (target.label) loc = page.getByLabel(target.label, exact);
    else if (target.placeholder) loc = page.getByPlaceholder(target.placeholder, exact);
    else if (target.text) loc = page.getByText(target.text, exact);
    else throw new Error('Target object needs one of: selector, testId, role, label, placeholder, text.');
    if (Number.isInteger(target.nth)) return loc.nth(target.nth);
  } else {
    throw new Error('Target must be a string or an object.');
  }
  return loc.first();
}

/**
 * Evaluate a decision condition on the page.
 *   { type: 'url', value: '/dashboard' }            URL contains value
 *   { type: 'text', value: 'Welcome' }              text is visible on the page
 *   { type: 'visible', target: '#error' | {...} }   element is visible (value works as target too)
 */
export async function evaluateCondition(page, condition, timeoutMs = 1500) {
  if (!condition || !condition.type) throw new Error('A decision needs a condition { type: url | text | visible, value }.');
  const type = String(condition.type).toLowerCase();
  if (type === 'url') {
    const end = Date.now() + timeoutMs;
    do {
      if (page.url().includes(String(condition.value || ''))) return true;
      await new Promise((r) => setTimeout(r, 100));
    } while (Date.now() < end);
    return false;
  }
  if (type === 'text' || type === 'visible') {
    const loc = type === 'text' ? page.getByText(String(condition.value || '')).first() : locatorFromTarget(page, condition.target || condition.value);
    try {
      await loc.waitFor({ state: 'visible', timeout: timeoutMs });
      return true;
    } catch {
      return false;
    }
  }
  throw new Error(`Unknown condition type "${condition.type}". Use url, text or visible.`);
}
