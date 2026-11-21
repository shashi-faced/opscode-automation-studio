import fs from 'node:fs';
import path from 'node:path';

/** A value for the spec: {{secret:x}} / {{input:x}} become environment variables. */
function valueCode(v) {
  const m = /^\{\{(secret|input):([^}]+)\}\}$/.exec(String(v ?? ''));
  if (!m) return JSON.stringify(String(v ?? ''));
  const env = m[2].toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  return `process.env.${env} ?? ''`;
}

/** The main path of a flow graph: from the entry, following next / yes edges. */
function mainPath(flow) {
  const steps = Array.isArray(flow.steps) ? flow.steps : [];
  if (!Array.isArray(flow.edges) || !flow.edges.length || !steps.every((s) => s.id)) return steps;
  const byId = new Map(steps.map((s) => [s.id, s]));
  const out = [];
  const seen = new Set();
  let cur = flow.entry || steps[0]?.id;
  while (cur && byId.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    out.push(byId.get(cur));
    const edges = flow.edges.filter((e) => e.source === cur);
    cur = (edges.find((e) => e.kind === 'next') || edges.find((e) => e.kind === 'yes') || edges[0])?.target;
  }
  return out;
}

/**
 * Builds the best Playwright locator expression for a step, with optional selector fallbacks.
 */
export function buildPlaywrightLocatorCode(step, options = {}) {
  const set = step.selectorSet || {};
  const candidates = [];

  if (set.primarySelector) {
    if (set.primarySelector.startsWith('[data-testid="') && set.primarySelector.endsWith('"]')) {
      const id = set.primarySelector.slice(14, -2);
      candidates.push(`page.getByTestId(${JSON.stringify(id)})`);
    } else {
      candidates.push(`page.locator(${JSON.stringify(set.primarySelector)})`);
    }
  }

  if (set.ariaSelector && set.ariaSelector.role) {
    const opts = set.ariaSelector.name ? `, { name: ${JSON.stringify(set.ariaSelector.name)} }` : '';
    candidates.push(`page.getByRole(${JSON.stringify(set.ariaSelector.role)}${opts})`);
  }

  if (set.textSelector) {
    candidates.push(`page.getByText(${JSON.stringify(set.textSelector)})`);
  }

  if (set.cssSelector) {
    candidates.push(`page.locator(${JSON.stringify(set.cssSelector)})`);
  }

  if (set.xpathSelector) {
    candidates.push(`page.locator(${JSON.stringify('xpath=' + set.xpathSelector)})`);
  }

  if (step.selector && !candidates.length) {
    candidates.push(`page.locator(${JSON.stringify(step.selector)})`);
  }

  const uniqueCandidates = [...new Set(candidates)];

  if (!uniqueCandidates.length) {
    return `page.locator('body')`;
  }

  if (options.withFallbacks && uniqueCandidates.length > 1) {
    let expr = uniqueCandidates[0];
    for (let i = 1; i < uniqueCandidates.length; i++) {
      expr += `.or(${uniqueCandidates[i]})`;
    }
    return expr;
  }

  return uniqueCandidates[0];
}

/**
 * Builds a locator expression with explicit selector fallbacks chained with .or()
 */
export function buildPlaywrightLocatorWithFallbacks(step) {
  return buildPlaywrightLocatorCode(step, { withFallbacks: true });
}

/**
 * Compiles a single step into TypeScript Playwright lines.
 */
export function compileStepToCode(step, index, options = {}) {
  const act = (step.action || '').toLowerCase();
  const desc = step.description ? `// Step ${index + 1}: ${step.description}` : `// Step ${index + 1}: ${act}`;
  const locatorCode = buildPlaywrightLocatorCode(step, options);

  switch (act) {
    case 'goto':
    case 'navigate': {
      let targetUrl = step.url || step.value || '';
      if (targetUrl && !/^https?:\/\//i.test(targetUrl) && !targetUrl.startsWith('file://')) {
        targetUrl = 'https://' + targetUrl;
      }
      return `${desc}\n    await page.goto(${JSON.stringify(targetUrl)}, { waitUntil: 'domcontentloaded' });`;
    }
    case 'click': {
      return `${desc}\n    await ${locatorCode}.click();`;
    }
    case 'fill': {
      if (options.fresh && options.fresh.has(String(step.value))) {
        return `${desc} (new test data each run: ${step.data?.kind || 'text'})\n    await ${locatorCode}.fill(DATA[${JSON.stringify(String(step.value))}]);`;
      }
      return `${desc}\n    await ${locatorCode}.fill(${valueCode(step.value)});`;
    }
    case 'select': {
      const val = step.value ?? '';
      return `${desc}\n    await ${locatorCode}.selectOption(${JSON.stringify(val)});`;
    }
    case 'check': {
      return `${desc}\n    await ${locatorCode}.check();`;
    }
    case 'uncheck': {
      return `${desc}\n    await ${locatorCode}.uncheck();`;
    }
    case 'press': {
      const key = step.key || 'Enter';
      return `${desc}\n    await ${locatorCode}.press(${JSON.stringify(key)});`;
    }
    case 'wait': {
      const ms = step.timeout || step.ms || 1000;
      return `${desc}\n    await page.waitForTimeout(${ms});`;
    }
    case 'screenshot': {
      const shotPath = step.path || `screenshots/step-${index + 1}.png`;
      return `${desc}\n    await page.screenshot({ path: ${JSON.stringify(shotPath)} });`;
    }
    case 'assert':
    case 'assert_visible': {
      return `${desc}\n    await expect(${locatorCode}).toBeVisible();`;
    }
    case 'assert_text': {
      const text = JSON.stringify(String(step.value || ''));
      return `${desc}\n    await expect(page.getByText(${options.fresh?.size ? `T(${text})` : text}).first()).toBeVisible();`;
    }
    case 'assert_url': {
      return `${desc}\n    await expect(page).toHaveURL(new RegExp(${JSON.stringify(String(step.value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))}));`;
    }
    case 'decision': {
      const c = step.condition || {};
      return `${desc}\n    // Decision (${c.type || '?'} "${String(c.value ?? '').replace(/\n/g, ' ')}"): this spec follows the "yes" path; replay the flow in Opscode to run every branch.`;
    }
    case 'scroll': {
      return `${desc}\n    await page.evaluate(() => window.scrollBy(0, window.innerHeight));`;
    }
    default: {
      return `${desc}\n    // Custom action: ${act}`;
    }
  }
}

/**
 * Compiles an entire flow object or array of steps into a standalone Playwright spec file.
 */
export function compileFlowToSpec(flowInput, options = {}) {
  const flow = typeof flowInput === 'string' ? JSON.parse(flowInput) : flowInput;
  const flowName = flow.name || 'recorded-flow';
  const steps = mainPath(flow);

  // Fields with a "generate" data rule get a fresh value each run (recorded value + a run tag).
  const fresh = new Map();
  for (const s of steps) {
    if (s.action === 'fill' && s.data?.mode === 'generate' && s.value != null && !/^\{\{/.test(String(s.value))) fresh.set(String(s.value), s.data.kind || 'text');
  }
  const stepCodes = steps.map((s, i) => compileStepToCode(s, i, { ...options, fresh })).join('\n\n    ');
  const dataBlock = fresh.size
    ? `
// Test data: these fields get a new value on every run, so repeated runs do not clash.
const RUN = Date.now().toString(36).slice(-5);
const fresh = (v: string, kind: string) => kind === 'email' ? v.replace(/@/, '.' + RUN + '@')
  : /\\d/.test(v) && kind !== 'text' ? v.replace(/\\d/g, () => String(Math.floor(Math.random() * 10))).replace(/^0/, '1')
  : v + ' ' + RUN;
const DATA: Record<string, string> = {
${[...fresh].map(([v, k]) => `  ${JSON.stringify(v)}: fresh(${JSON.stringify(v)}, ${JSON.stringify(k)}),`).join('\n')}
};
/** A text from the recording with the recorded test data swapped for this run's data. */
const T = (s: string) => Object.entries(DATA).reduce((a, [k, v]) => a.split(k).join(v), s);
`
    : '';

  return `import { test, expect } from '@playwright/test';
${dataBlock}
/**
 * Auto-generated by Opscode Automation Studio
 * Flow: ${flowName}
 * Created: ${flow.createdAt || new Date().toISOString()}
 * Steps: ${steps.length}
 */
test.describe(${JSON.stringify(flowName)}, () => {
  test('execute recorded journey', async ({ page }) => {
    // Set default viewport
    await page.setViewportSize({ width: 1280, height: 800 });

    ${stepCodes || '// No steps recorded'}
  });
});
`;
}

/**
 * CLI or tool handler to compile a flow.json file on disk
 */
export function compileFlowFile(flowFilePath, outSpecPath, options = {}) {
  let resolved = flowFilePath;
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
    resolved = path.join(resolved, 'flow.json');
  }
  const raw = fs.readFileSync(resolved, 'utf8');
  const flow = JSON.parse(raw);
  const spec = compileFlowToSpec(flow, options);

  const targetPath = outSpecPath || resolved.replace(/\.json$/i, '.spec.ts');
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, spec, 'utf8');

  return {
    ok: true,
    specFile: targetPath,
    stepCount: (flow.steps || []).length,
  };
}
