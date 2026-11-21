import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PNG } from 'pngjs';

// Recorder session files go to a temp folder, never to the real ~/.opscode/run
process.env.OPSCODE_AUTOMATION_RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oas-run-'));

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
  buildPlaywrightLocatorWithFallbacks,
  compileFlowFile,
} from '../src/runner/compiler.mjs';

import {
  startRecording,
  stopRecording,
  getRecordingStatus,
  deleteRecordingSession,
  getRecorderInjectionScript,
} from '../src/recorder/recorder.mjs';

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

    const gotoNoSchemeCode = compileStepToCode({ action: 'goto', url: 'example.com' }, 0);
    assert.match(gotoNoSchemeCode, /await page\.goto\("https:\/\/example\.com"/);

    const clickCode = compileStepToCode({ action: 'click', selectorSet: { primarySelector: '[data-testid="btn"]' }, description: 'Click button' }, 1);
    assert.match(clickCode, /await page\.getByTestId\("btn"\)\.click\(\)/);

    const fillCode = compileStepToCode({ action: 'fill', selectorSet: { cssSelector: '#input' }, value: 'hello' }, 2);
    assert.match(fillCode, /await page\.locator\("#input"\)\.fill\("hello"\)/);

    const assertCode = compileStepToCode({ action: 'assert', selectorSet: { textSelector: 'Welcome' } }, 3);
    assert.match(assertCode, /await expect\(page\.getByText\("Welcome"\)\)\.toBeVisible\(\)/);

    const assertVisibleCode = compileStepToCode({ action: 'assert_visible', selectorSet: { textSelector: 'Dashboard' } }, 3);
    assert.match(assertVisibleCode, /await expect\(page\.getByText\("Dashboard"\)\)\.toBeVisible\(\)/);

    const selectCode = compileStepToCode({ action: 'select', selectorSet: { cssSelector: 'select#role' }, value: 'admin' }, 4);
    assert.match(selectCode, /await page\.locator\("select#role"\)\.selectOption\("admin"\)/);

    const checkCode = compileStepToCode({ action: 'check', selectorSet: { cssSelector: 'input#agree' } }, 5);
    assert.match(checkCode, /await page\.locator\("input#agree"\)\.check\(\)/);

    const uncheckCode = compileStepToCode({ action: 'uncheck', selectorSet: { cssSelector: 'input#agree' } }, 6);
    assert.match(uncheckCode, /await page\.locator\("input#agree"\)\.uncheck\(\)/);
  });

  await t.test('buildPlaywrightLocatorWithFallbacks chains .or() locators', () => {
    const code = buildPlaywrightLocatorWithFallbacks({
      selectorSet: {
        primarySelector: '[data-testid="submit-btn"]',
        ariaSelector: { role: 'button', name: 'Submit' },
        cssSelector: 'button#submit',
      },
    });
    assert.equal(
      code,
      'page.getByTestId("submit-btn").or(page.getByRole("button", { name: "Submit" })).or(page.locator("button#submit"))'
    );
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

  await t.test('compileFlowFile writes file to disk and resolves directory', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compile-test-'));
    const flowDir = path.join(tmpDir, 'my-flow');
    fs.mkdirSync(flowDir);
    const flowFile = path.join(flowDir, 'flow.json');
    fs.writeFileSync(flowFile, JSON.stringify({ name: 'disk-test', steps: [{ action: 'goto', url: 'http://test' }] }));

    // Test passing directory
    const res = compileFlowFile(flowDir);
    assert.equal(res.ok, true);
    const expectedSpec = path.join(flowDir, 'flow.spec.ts');
    assert.ok(fs.existsSync(expectedSpec));
    const content = fs.readFileSync(expectedSpec, 'utf8');
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
  await t.test('TOOL_DEFS defines all 21 tools with valid parameters', () => {
    const expected = [
      'automation_record_start',
      'automation_record_stop',
      'automation_record_status',
      'automation_flow_run',
      'automation_flow_compile',
      'automation_flow_accept_fix',
      'automation_visual_diff',
      'automation_audit',
      'automation_doctor',
      'automation_graph_get',
      'automation_graph_save',
      'automation_feature_create',
      'automation_flow_create',
      'automation_flow_match',
      'automation_batch_run',
      'automation_step',
      'automation_flow_get',
      'automation_module_plan',
      'automation_flow_data',
      'automation_issues',
      'automation_issue_update',
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
    deleteRecordingSession();
    const res = await runTool('automation_record_status');
    assert.equal(res.ok, true);
    assert.match(res.text, /No active recording session/);
  });

  await t.test('startRecording, getRecordingStatus, and stopRecording lifecycle persists state', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-test-'));
    deleteRecordingSession();

    const mockSession = {
      port: 9222,
      page: {
        url: () => 'https://example.com/shop',
        exposeFunction: async () => {},
        addInitScript: async () => {},
        evaluate: async () => {},
        goto: async () => {},
      },
    };

    const startRes = await startRecording(mockSession, {
      flowName: 'shopping-flow',
      startUrl: 'https://example.com/shop',
      cwd: tmpDir,
    });
    assert.equal(startRes.ok, true);

    const statusRes = await getRecordingStatus({ session: mockSession });
    assert.equal(statusRes.isRecording, true);
    assert.equal(statusRes.flowName, 'shopping-flow');
    assert.ok(statusRes.stepCount >= 1);

    const stopRes = await stopRecording({ cwd: tmpDir, session: mockSession });
    assert.equal(stopRes.ok, true);
    assert.equal(stopRes.flowName, 'shopping-flow');
    assert.ok(fs.existsSync(stopRes.flowFile));
    assert.ok(fs.existsSync(stopRes.specFile));

    const flowData = JSON.parse(fs.readFileSync(stopRes.flowFile, 'utf8'));
    assert.equal(flowData.name, 'shopping-flow');
    assert.ok(flowData.steps.length >= 1);

    const idleStatus = await getRecordingStatus();
    assert.equal(idleStatus.isRecording, false);

    fs.rmSync(tmpDir, { recursive: true });
  });

  await t.test('stopRecording scans all open pages in browser context for in-page steps', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-multipage-'));
    deleteRecordingSession();

    const now = Date.now();
    const page1 = {
      url: () => 'https://example.com',
      exposeFunction: async () => {},
      addInitScript: async () => {},
      goto: async () => {},
      evaluate: async (fn) => {
        if (typeof fn === 'function') {
          return [
            { action: 'click', selectorSet: { primarySelector: '#tab1-btn' }, timestamp: now + 50, description: 'Click button in tab 1' },
          ];
        }
      },
    };
    const page2 = {
      url: () => 'https://example.com/other',
      evaluate: async () => [
        { action: 'click', selectorSet: { primarySelector: '#btn' }, timestamp: now + 100, description: 'Click button in tab 2' },
      ],
    };

    const multiPageSession = {
      port: 9222,
      page: page1,
      context: {
        pages: () => [page1, page2],
      },
    };

    await startRecording(multiPageSession, {
      flowName: 'multipage-flow',
      startUrl: 'https://example.com',
      cwd: tmpDir,
    });

    const stopRes = await stopRecording({ cwd: tmpDir, session: multiPageSession });
    assert.equal(stopRes.ok, true);

    const flowData = JSON.parse(fs.readFileSync(stopRes.flowFile, 'utf8'));
    assert.equal(flowData.steps.length, 3);
    assert.equal(flowData.steps[1].description, 'Click button in tab 1');
    assert.equal(flowData.steps[2].description, 'Click button in tab 2');

    fs.rmSync(tmpDir, { recursive: true });
  });
});

test('7. Automation Graph, Intent Matching & Batch Runner', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-test-'));

  await t.test('automation_graph_get initializes valid default project structure', async () => {
    const res = await runTool('automation_graph_get', {}, { cwd: tmpDir });
    assert.equal(res.ok, true);
    assert.ok(res.data);
    assert.equal(res.data.id, 'default-project');
    assert.ok(Array.isArray(res.data.features));
    assert.ok(Array.isArray(res.data.canvasLayout.nodes));
    assert.ok(Array.isArray(res.data.canvasLayout.edges));
    assert.ok(fs.existsSync(path.join(tmpDir, 'automation', 'project.json')));
  });

  await t.test('automation_feature_create and automation_flow_create link hierarchy properly', async () => {
    const featRes = await runTool('automation_feature_create', {
      name: 'Authentication',
      description: 'Sign-in and sign-up journeys',
    }, { cwd: tmpDir });
    assert.equal(featRes.ok, true);
    assert.equal(featRes.data.feature.name, 'Authentication');

    const flowRes = await runTool('automation_flow_create', {
      featureId: featRes.data.feature.id,
      name: 'User Login',
      description: 'Login with username and password',
      url: 'https://example.com/login',
      steps: [
        { action: 'goto', url: 'https://example.com/login', description: 'Navigate to login' },
        { action: 'fill', selectorSet: { primarySelector: '#username' }, value: 'testuser', description: 'Type username' },
        { action: 'fill', selectorSet: { primarySelector: '#password' }, value: 'secret123', description: 'Type password' },
        { action: 'click', selectorSet: { primarySelector: 'button[type="submit"]' }, description: 'Click login button' },
      ],
    }, { cwd: tmpDir });

    assert.equal(flowRes.ok, true);
    assert.equal(flowRes.data.flow.name, 'User Login');
    assert.equal(flowRes.data.flow.stepCount, 4);

    const fullFlowPath = path.join(tmpDir, flowRes.data.flow.flowPath);
    assert.ok(fs.existsSync(fullFlowPath), 'flow.json must exist');
    const fullSpecPath = path.join(tmpDir, flowRes.data.flow.specPath);
    assert.ok(fs.existsSync(fullSpecPath), 'Playwright spec must exist');

    // Verify graph reflection
    const graphRes = await runTool('automation_graph_get', {}, { cwd: tmpDir });
    const flowNode = graphRes.data.canvasLayout.nodes.find(n => n.data.label === 'User Login');
    assert.ok(flowNode, 'FlowNode must be present in canvasLayout');
    assert.equal(flowNode.data.stepCount, 4);
  });

  await t.test('automation_graph_save persists custom positions and dependency edges', async () => {
    const layout = {
      viewport: { x: 100, y: 50, zoom: 1.2 },
      nodes: [
        { id: 'project:default-project', position: { x: 50, y: 50 } },
      ],
      edges: [
        { id: 'edge-auth-checkout', source: 'flow:flow-user-login', target: 'flow:flow-checkout', type: 'depends-on' },
      ],
    };

    const saveRes = await runTool('automation_graph_save', { canvasLayout: layout }, { cwd: tmpDir });
    assert.equal(saveRes.ok, true);

    const savedProject = JSON.parse(fs.readFileSync(path.join(tmpDir, 'automation', 'project.json'), 'utf8'));
    assert.equal(savedProject.canvasLayout.viewport.zoom, 1.2);
    const depEdge = savedProject.canvasLayout.edges.find(e => e.id === 'edge-auth-checkout');
    assert.ok(depEdge, 'Dependency edge must be saved');
    assert.equal(depEdge.type, 'depends-on');
  });

  await t.test('automation_flow_match matches prompt intents accurately', async () => {
    // 1. High confidence match for user login
    const match1 = await runTool('automation_flow_match', { intent: 'Please test the user login automation' }, { cwd: tmpDir });
    assert.equal(match1.ok, true);
    assert.equal(match1.data.matched, true);
    assert.ok(match1.data.confidence >= 0.7, `Expected confidence >= 0.7, got ${match1.data.confidence}`);
    assert.equal(match1.data.flow.name, 'User Login');

    // 2. High confidence match for login keyword
    const match2 = await runTool('automation_flow_match', { intent: 'login' }, { cwd: tmpDir });
    assert.equal(match2.ok, true);
    assert.equal(match2.data.matched, true);
    assert.equal(match2.data.flow.name, 'User Login');

    // 3. Real-world natural prompt with descriptive words (credentials, staging)
    const match3 = await runTool('automation_flow_match', { intent: 'Run the login test on staging with credentials' }, { cwd: tmpDir });
    assert.equal(match3.ok, true);
    assert.equal(match3.data.matched, true);
    assert.ok(match3.data.confidence >= 0.7);
    assert.equal(match3.data.flow.name, 'User Login');

    // 4. Two-word phrase normalization (log in, sign in)
    const match4 = await runTool('automation_flow_match', { intent: 'log in to the account' }, { cwd: tmpDir });
    assert.equal(match4.ok, true);
    assert.equal(match4.data.matched, true);
    assert.ok(match4.data.confidence >= 0.7);

    const match5 = await runTool('automation_flow_match', { intent: 'sign in with user admin' }, { cwd: tmpDir });
    assert.equal(match5.ok, true);
    assert.equal(match5.data.matched, true);
    assert.ok(match5.data.confidence >= 0.7);

    // 5. Unrelated prompt should not match
    const match6 = await runTool('automation_flow_match', { intent: 'book a flight ticket to Paris' }, { cwd: tmpDir });
    assert.equal(match6.ok, true);
    assert.equal(match6.data.matched, false);
    assert.ok(match6.data.confidence < 0.7);

    // 6. Empty / whitespace intent
    const match7 = await runTool('automation_flow_match', { intent: '   ' }, { cwd: tmpDir });
    assert.equal(match7.ok, true);
    assert.equal(match7.data.matched, false);
    assert.equal(match7.data.confidence, 0);
  });

  await t.test('automation_batch_run handles empty or flow subsets gracefully', async () => {
    const batchRes = await runTool('automation_batch_run', { featureId: 'non-existent-feat' }, { cwd: tmpDir });
    assert.equal(batchRes.ok, true);
    assert.equal(batchRes.data.totalFlows, 0);
  });

  fs.rmSync(tmpDir, { recursive: true });
});

test('8. Recording Target Feature, Single Flow Prefix & Input Flush', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-feature-target-'));

  await t.test('startRecording and stopRecording route to target featureId without creating Recorded Flows', async () => {
    deleteRecordingSession();

    // Create an initial project with an Authentication feature
    const initRes = await runTool('automation_graph_get', {}, { cwd: tmpDir });
    assert.equal(initRes.ok, true);
    const authFeatRes = await runTool('automation_feature_create', {
      name: 'Authentication',
      description: 'Sign-in journey',
    }, { cwd: tmpDir });
    assert.equal(authFeatRes.ok, true);
    const authFeatId = authFeatRes.data.feature.id;

    const mockSession = {
      port: 9222,
      page: {
        url: () => 'https://uiqa.credlixlab.com/login',
        exposeFunction: async () => {},
        addInitScript: async () => {},
        evaluate: async () => [],
        goto: async () => {},
      },
    };

    // Start recording with target feature
    const startRes = await startRecording(mockSession, {
      startUrl: 'https://uiqa.credlixlab.com/login',
      flowName: 'flow-ktm2',
      featureId: authFeatId,
      featureName: 'Authentication',
      cwd: tmpDir,
    });
    assert.equal(startRes.ok, true);

    // Stop recording
    const stopRes = await stopRecording({
      cwd: tmpDir,
      session: mockSession,
      featureId: authFeatId,
      featureName: 'Authentication',
    });
    assert.equal(stopRes.ok, true);

    // Verify project.json structure
    const proj = JSON.parse(fs.readFileSync(path.join(tmpDir, 'automation', 'project.json'), 'utf8'));
    // Recorded Flows should NOT exist
    const recordedFeat = proj.features.find(f => f.name.toLowerCase() === 'recorded flows');
    assert.equal(recordedFeat, undefined);

    // Authentication feature should contain flow with id 'flow-ktm2', not 'flow-flow-ktm2'
    const authFeat = proj.features.find(f => f.id === authFeatId);
    assert.ok(authFeat);
    assert.equal(authFeat.flows.length, 1);
    assert.equal(authFeat.flows[0].id, 'flow-ktm2');
    assert.equal(authFeat.flows[0].name, 'flow-ktm2');
  });

  await t.test('getRecorderInjectionScript contains flushAllInputs, focusin, focusout, and input debounce', () => {
    const script = getRecorderInjectionScript('test-flow');
    assert.ok(script.includes('flushActiveInput'));
    assert.ok(script.includes('flushAllInputs'));
    assert.ok(script.includes('flushElementInput'));
    assert.ok(script.includes('inputDebounceTimer'));
    assert.ok(script.includes('focusin'));
    assert.ok(script.includes('focusout'));
    assert.ok(script.includes('submit'));
    assert.ok(script.includes('beforeunload'));
    assert.ok(script.includes('Enter'));
  });

  await t.test('stopRecording routes to existing feature even if generic Recorded Flows is passed', async () => {
    deleteRecordingSession();

    // Create an initial project with Authentication feature
    const mockSession = {
      port: 9222,
      page: {
        url: () => 'https://uiqa.credlixlab.com/login',
        exposeFunction: async () => {},
        addInitScript: async () => {},
        evaluate: async () => [],
        goto: async () => {},
      },
    };

    await startRecording(mockSession, {
      startUrl: 'https://uiqa.credlixlab.com/login',
      flowName: 'flow-second-journey',
      featureName: 'Recorded Flows', // Untargeted / generic
      cwd: tmpDir,
    });

    const stopRes = await stopRecording({
      cwd: tmpDir,
      session: mockSession,
      featureName: 'Recorded Flows',
    });
    assert.equal(stopRes.ok, true);

    const proj = JSON.parse(fs.readFileSync(path.join(tmpDir, 'automation', 'project.json'), 'utf8'));
    // Recorded Flows must still not exist; flow added to Authentication
    const recordedFeat = proj.features.find(f => f.name.toLowerCase() === 'recorded flows');
    assert.equal(recordedFeat, undefined);
    assert.equal(proj.features[0].flows.length, 2);
  });

  fs.rmSync(tmpDir, { recursive: true });
});

