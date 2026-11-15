import fs from 'node:fs';
import {
  getOpscodeDevToolsPort,
  isCdpEndpointActive,
  findSystemBrowserExecutable,
  DEVTOOLS_PORT_FILE,
} from './cdp/session.mjs';

/**
 * Diagnostic health check for Automation Studio
 */
export async function runDoctor() {
  const checks = [];

  // 1. Node.js Version
  const nodeVer = process.version;
  const major = parseInt(nodeVer.slice(1).split('.')[0], 10);
  const nodeOk = major >= 18;
  checks.push({
    name: 'Node.js runtime',
    ok: nodeOk,
    detail: `${nodeVer} (required: >= 18.0.0)`,
    fix: nodeOk ? undefined : 'Install Node.js 18 or higher.',
  });

  // 2. Opscode DevToolsActivePort file
  const portFileExists = fs.existsSync(DEVTOOLS_PORT_FILE);
  const port = getOpscodeDevToolsPort();
  const cdpActive = port ? await isCdpEndpointActive(port) : false;

  checks.push({
    name: 'Opscode internal browser CDP',
    ok: cdpActive,
    detail: cdpActive
      ? `Connected to Opscode browser on CDP port ${port}`
      : portFileExists
      ? `Port file exists (${DEVTOOLS_PORT_FILE}), but port ${port || 'unknown'} is not responding. Start Opscode browser tab to activate.`
      : `DevToolsActivePort not found at ${DEVTOOLS_PORT_FILE}. Will fallback to standalone Chrome when Opscode browser is not active.`,
    isWarning: !cdpActive,
  });

  // 3. System Chrome / Chromium
  const chromePath = findSystemBrowserExecutable();
  const chromeOk = !!chromePath;
  checks.push({
    name: 'System Chrome / Chromium executable',
    ok: chromeOk,
    detail: chromePath || 'No system Chrome/Chromium found in standard paths.',
    fix: chromeOk ? undefined : 'Install Google Chrome or Chromium via apt/snap if standalone fallback is required.',
  });

  // 4. Dependencies
  let depsOk = true;
  let depsDetail = 'axe-core, pixelmatch, playwright-core, pngjs loaded';
  try {
    await Promise.all([
      import('axe-core'),
      import('pixelmatch'),
      import('playwright-core'),
      import('pngjs'),
    ]);
  } catch (err) {
    depsOk = false;
    depsDetail = `Missing dependencies: ${err.message}`;
  }

  checks.push({
    name: 'Automation Studio dependencies',
    ok: depsOk,
    detail: depsDetail,
    fix: depsOk ? undefined : 'Run npm install in @opscode/automation-studio.',
  });

  const allRequiredOk = checks.filter(c => !c.isWarning).every(c => c.ok);

  return {
    ok: allRequiredOk,
    checks,
    summary: allRequiredOk
      ? 'Automation Studio environment is ready.'
      : 'Automation Studio has missing dependencies or requirements.',
  };
}
