// Clicking and typing with a check that the page really got it.
//
// Each click is done with real mouse events first; if the page never saw a pointer event, the click
// is done in the page instead (DOM events + element.click()). Typed values are checked too. Headless
// Chrome 157 sometimes drops all CDP input to a page reached by a redirect (docs/PLAN.md).

const PROBE = () => {
  window.__opscodeInputSeen = false;
  if (!window.__opscodeInputProbe) {
    window.__opscodeInputProbe = true;
    const mark = () => { window.__opscodeInputSeen = true; };
    document.addEventListener('pointerdown', mark, true);
    document.addEventListener('mousedown', mark, true);
  }
};

/** Click the middle of the element. Returns { method: 'mouse' | 'dom' }. */
export async function robustClick(page, locator, { timeout = 5000 } = {}) {
  await locator.waitFor({ state: 'visible', timeout });
  await locator.scrollIntoViewIfNeeded({ timeout }).catch(() => {});
  const box = await locator.boundingBox({ timeout });
  if (!box) throw new Error('Element has no size on the page (hidden?)');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;

  await page.evaluate(PROBE).catch(() => {});
  let navigated = false;
  const onNav = (frame) => { if (frame === page.mainFrame()) navigated = true; };
  page.on('framenavigated', onNav);
  try {
    await page.mouse.click(x, y);
    await page.waitForTimeout(120);
  } finally {
    page.off('framenavigated', onNav);
  }
  if (navigated) return { method: 'mouse' };
  // A navigation that has started destroys the context: count that as delivered.
  const seen = await page.evaluate(() => window.__opscodeInputSeen).catch(() => true);
  if (seen) return { method: 'mouse' };

  await locator.evaluate((el) => {
    const opts = { bubbles: true, cancelable: true, composed: true, view: window, button: 0 };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    if (typeof el.focus === 'function') el.focus();
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.click();
  });
  return { method: 'dom' };
}

/** Fill a field, and set the value in the page if typing did not arrive. */
export async function robustFill(locator, value, { timeout = 5000 } = {}) {
  const text = String(value ?? '');
  await locator.fill(text, { timeout });
  const now = await locator.inputValue({ timeout }).catch(() => null);
  if (now === text || now === null) return { method: 'type' };
  await locator.evaluate((el, v) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (typeof el.focus === 'function') el.focus();
    if (setter) setter.call(el, v); else el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, text);
  return { method: 'dom' };
}

/** Press a key on the element; if the key never arrived and it is Enter in a form, submit the form. */
export async function robustPress(page, locator, key = 'Enter', { timeout = 5000 } = {}) {
  await locator.focus({ timeout }).catch(() => {});
  await page.evaluate(() => {
    window.__opscodeKeySeen = false;
    if (!window.__opscodeKeyProbe) {
      window.__opscodeKeyProbe = true;
      document.addEventListener('keydown', () => { window.__opscodeKeySeen = true; }, true);
    }
  }).catch(() => {});
  let navigated = false;
  const onNav = (frame) => { if (frame === page.mainFrame()) navigated = true; };
  page.on('framenavigated', onNav);
  try {
    await locator.press(key, { timeout });
    await page.waitForTimeout(120);
  } finally {
    page.off('framenavigated', onNav);
  }
  if (navigated) return { method: 'key' };
  const seen = await page.evaluate(() => window.__opscodeKeySeen).catch(() => true);
  if (seen) return { method: 'key' };
  await locator.evaluate((el, k) => {
    const o = { key: k, bubbles: true, cancelable: true, composed: true };
    const down = new KeyboardEvent('keydown', o);
    const go = el.dispatchEvent(down);
    el.dispatchEvent(new KeyboardEvent('keyup', o));
    if (go && k === 'Enter' && el.form) {
      if (typeof el.form.requestSubmit === 'function') el.form.requestSubmit();
      else el.form.submit();
    }
  }, key);
  return { method: 'dom' };
}
