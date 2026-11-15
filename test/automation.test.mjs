import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PNG } from 'pngjs';

import {
  getOpscodeDevToolsPort,
  isCdpEndpointActive,
  findSystemBrowserExecutable,
  DEVTOOLS_PORT_FILE,
} from '../src/cdp/session.mjs';

import {
  SelectorResolver,
  SelectorFailureError,
  parseSelectorSet,
} from '../src/runner/resolver.mjs';

import {
  buildSelectorFromCandidate,
} from '../src/runner/healing.mjs';

import {
  compileFlowToSpec,
  compileStepToCode,
  buildPlaywrightLocatorCode,
  compileFlowFile,
} from '../src/runner/compiler.mjs';

import {
  compareImages,
} from '../src/runner/visual.mjs';

import { runDoctor } from '../src/doctor.mjs';
import { TOOL_DEFS, runTool } from '../src/tools.mjs';

test('1. CDP Session & Environment', async (t) => {
  await t.test('reads valid DevToolsActivePort from directory', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-test-'));
    fs.writeFileSync(path.join(tmpDir, 'DevToolsActivePort'), '9222\n/devtools/browser/abc\n');
    const port = getOpscodeDevToolsPort(tmpDir);
    assert.equal(port, 9222);
    fs.rmSync(tmpDir, { recursive: true });
  });

  await t.test('handles missing or corrupt DevToolsActivePort gracefully', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-test-'));
    assert.equal(getOpscodeDevToolsPort(tmpDir), null);
    fs.writeFileSync(path.join(tmpDir, 'DevToolsActivePort'), 'not-a-number\n');
    assert.equal(getOpscodeDevToolsPort(tmpDir), null);
    fs.rmSync(tmpDir, { recursive: true });
  });

  await t.test('finds system Chrome / Chromium binary', () => {
    const bin = findSystemBrowserExecutable();
    assert.ok(bin, 'Should find system Chrome or Chromium binary');
    assert.ok(fs.existsSync(bin));
  });
});

test('2. Selector Resolver & Self-Healing', async (t) => {
  await t.test('parseSelectorSet parses string and object formats', () => {
    const obj = { primarySelector: '[data-testid="submit-btn"]' };
    assert.deepEqual(parseSelectorSet(obj), obj);
    assert.deepEqual(parseSelectorSet(JSON.stringify(obj)), obj);
    assert.deepEqual(parseSelectorSet('button#submit'), { cssSelector: 'button#submit' });
    assert.equal(parseSelectorSet(null), null);
  });

  await t.test('buildSelectorFromCandidate generates prioritized selectors', () => {
    assert.equal(
      buildSelectorFromCandidate({ dataTestId: 'login-submit' }),
      '[data-testid="login-submit"]'
    );
    assert.equal(
      buildSelectorFromCandidate({ id: 'username' }),
      '#username'
    );
    assert.equal(
      buildSelectorFromCandidate({ ariaLabel: 'Close Dialog' }),
      '[aria-label="Close Dialog"]'
    );
    assert.equal(
      buildSelectorFromCandidate({ placeholder: 'Search...' }),
      '[placeholder="Search..."]'
    );
    assert.equal(
      buildSelectorFromCandidate({ name: 'email' }),
      '[name="email"]'
    );
    assert.equal(
      buildSelectorFromCandidate({ tag: 'button', text: 'Sign Up Today' }),
      'button:has-text("Sign Up Today")'
    );
  });

  await t.test('throws SelectorFailureError when element cannot be resolved', async () => {
    const mockPage = {
      locator: () => ({
        waitFor: async () => { throw new Error('Timeout'); },
        count: async () => 0,
      }),
      getByRole: () => null,
      getByText: () => null,
      evaluate: async () => [],
    };

    const resolver = new SelectorResolver({ defaultTimeout: 100 });
    await assert.rejects(
      async () => {
        await resolver.resolve(mockPage, {
          primarySelector: '[data-testid="non-existent"]',
          cssSelector: '#missing',
        }, 'Click missing button');
      },
      (err) => {
        assert.ok(err instanceof SelectorFailureError);
        assert.match(err.message, /Could not resolve element/);
        return true;
      }
    );
  });
});

test('3. Playwright Spec Compiler', async (t) => {
  await t.test('buildPlaywrightLocatorCode chooses optimal locator', () => {
    assert.equal(
      buildPlaywrightLocatorCode({ selectorSet: { primarySelector: '[data-testid="cart-btn"]' } }),
      'page.getByTestId("cart-btn")'
    );
    assert.equal(
      buildPlaywrightLocatorCode({ selectorSet: { ariaSelector: { role: 'button', name: 'Submit' } } }),
      'page.getByRole("button", { name: "Submit" })'
    );
    assert.equal(
      buildPlaywrightLocatorCode({ selectorSet: { textSelector: 'Continue' } }),
      'page.getByText("Continue")'
    );
    assert.equal(
      buildPlaywrightLocatorCode({ selectorSet: { cssSelector: '.checkout-btn' } }),
      'page.locator(".checkout-btn")'
    );
    assert.equal(
      buildPlaywrightLocatorCode({ selectorSet: { xpathSelector: '//button[1]' } }),
      'page.locator("xpath=//button[1]")'
    );
  });

  await t.test('compiles individual actions correctly', () => {
    const gotoCode = compileStepToCode({ action: 'goto', url: 'https://example.com' }, 0);
    assert.match(gotoCode, /await page\.goto\("https:\/\/example\.com"/);

    const clickCode = compileStepToCode({ action: 'click', selectorSet: { primarySelector: '[data-testid="btn"]' }, description: 'Click button' }, 1);
    assert.match(clickCode, /await page\.getByTestId\("btn"\)\.click\(\)/);

    const fillCode = compileStepToCode({ action: 'fill', selectorSet: { cssSelector: '#input' }, value: 'hello' }, 2);
    assert.match(fillCode, /await page\.locator\("#input"\)\.fill\("hello"\)/);

    const assertCode = compileStepToCode({ action: 'assert', selectorSet: { textSelector: 'Welcome' } }, 3);
    assert.match(assertCode, /await expect\(page\.getByText\("Welcome"\)\)\.toBeVisible\(\)/);
  });

  await t.test('compileFlowToSpec produces complete, syntactically valid TypeScript test file', () => {
    const flow = {
      name: 'login-test',
      steps: [
        { action: 'goto', url: 'https://example.com/login' },
        { action: 'fill', selectorSet: { cssSelector: '#user' }, value: 'admin' },
        { action: 'click', selectorSet: { primarySelector: '[data-testid="submit"]' } },
        { action: 'assert', selectorSet: { textSelector: 'Dashboard' } },
      ],
    };
    const spec = compileFlowToSpec(flow);
    assert.match(spec, /import \{ test, expect \} from '@playwright\/test';/);
    assert.match(spec, /test\.describe\("login-test",/);
    assert.match(spec, /await page\.goto\("https:\/\/example\.com\/login"/);
    assert.match(spec, /await page\.locator\("#user"\)\.fill\("admin"\)/);
    assert.match(spec, /await page\.getByTestId\("submit"\)\.click\(\)/);
    assert.match(spec, /await expect\(page\.getByText\("Dashboard"\)\)\.toBeVisible\(\)/);
  });

  await t.test('compileFlowFile writes file to disk', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compile-test-'));
    const flowFile = path.join(tmpDir, 'flow.json');
    const specFile = path.join(tmpDir, 'test.spec.ts');
    fs.writeFileSync(flowFile, JSON.stringify({ name: 'disk-test', steps: [{ action: 'goto', url: 'http://test' }] }));

    const res = compileFlowFile(flowFile, specFile);
    assert.equal(res.ok, true);
    assert.ok(fs.existsSync(specFile));
    const content = fs.readFileSync(specFile, 'utf8');
    assert.match(content, /await page\.goto\("http:\/\/test"/);
    fs.rmSync(tmpDir, { recursive: true });
  });
});

test('4. Pixelmatch Visual Diff Engine', async (t) => {
  function makePng(width, height, r, g, b, a = 255) {
    const png = new PNG({ width, height });
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;
        png.data[idx] = r;
        png.data[idx + 1] = g;
        png.data[idx + 2] = b;
        png.data[idx + 3] = a;
      }
    }
    return PNG.sync.write(png);
  }

  await t.test('detects 0% difference on identical images', async () => {
    const imgBuf = makePng(50, 50, 100, 150, 200);
    const res = await compareImages(imgBuf, imgBuf);
    assert.equal(res.ok, true);
    assert.equal(res.isMatch, true);
    assert.equal(res.diffPercentage, 0);
    assert.equal(res.changedPixels, 0);
  });

  await t.test('detects visual differences and saves diff output', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-test-'));
    const imgA = makePng(40, 40, 255, 255, 255);
    const imgB = makePng(40, 40, 0, 0, 0);
    const diffPath = path.join(tmpDir, 'diff.png');

    const res = await compareImages(imgA, imgB, { outDiffPath: diffPath });
    assert.equal(res.ok, true);
    assert.equal(res.isMatch, false);
    assert.equal(res.diffPercentage, 100);
    assert.equal(res.changedPixels, 1600);
    assert.ok(fs.existsSync(diffPath));
    fs.rmSync(tmpDir, { recursive: true });
  });

  await t.test('handles different dimensions by normalizing canvas size', async () => {
    const imgA = makePng(20, 20, 255, 0, 0);
    const imgB = makePng(30, 25, 255, 0, 0);
    const res = await compareImages(imgA, imgB);
    assert.equal(res.ok, true);
    assert.ok(res.totalPixels === 30 * 25);
    assert.ok(res.changedPixels > 0);
  });
});

test('5. Automation Studio Doctor', async () => {
  const doc = await runDoctor();
  assert.equal(typeof doc.ok, 'boolean');
  assert.ok(Array.isArray(doc.checks));
  assert.ok(doc.checks.length >= 4);

  const nodeCheck = doc.checks.find(c => c.name === 'Node.js runtime');
  assert.ok(nodeCheck && nodeCheck.ok);

  const depsCheck = doc.checks.find(c => c.name === 'Automation Studio dependencies');
  assert.ok(depsCheck && depsCheck.ok);
});

test('6. Tool Definitions & CLI Tool Runner', async (t) => {
  await t.test('TOOL_DEFS defines all 8 tools with valid parameters', () => {
    const expected = [
      'automation_record_start',
      'automation_record_stop',
      'automation_record_status',
      'automation_flow_run',
      'automation_flow_compile',
      'automation_visual_diff',
      'automation_audit',
      'automation_doctor',
    ];
    const names = TOOL_DEFS.map(t => t.name);
    assert.deepEqual(names.sort(), expected.sort());
  });

  await t.test('runTool handles automation_doctor correctly', async () => {
    const res = await runTool('automation_doctor');
    assert.equal(res.ok, true);
    assert.match(res.text, /Automation Studio Doctor Diagnostics/);
  });

  await t.test('runTool handles automation_record_status when idle', async () => {
    const res = await runTool('automation_record_status');
    assert.equal(res.ok, true);
    assert.match(res.text, /No active recording session/);
  });
});
