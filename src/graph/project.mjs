import fs from 'node:fs';
import path from 'node:path';
import { compileFlowToSpec } from '../runner/compiler.mjs';
import { ensureFlowGraph } from '../flow/graph.mjs';
import { runFlow } from '../runner/executor.mjs';
import { getBrowserSession, closeSession } from '../cdp/session.mjs';

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'item';
}

const SYNONYMS = {
  login: ['login', 'signin', 'auth', 'authenticate', 'account', 'credential', 'credentials'],
  logout: ['logout', 'signout'],
  signup: ['signup', 'register', 'registration'],
  checkout: ['checkout', 'payment', 'pay', 'order', 'purchase', 'buy'],
  cart: ['cart', 'basket', 'bag'],
  search: ['search', 'find', 'query', 'lookup'],
  audit: ['audit', 'accessibility', 'a11y', 'wcag'],
  diff: ['diff', 'pixelmatch', 'visual', 'screenshot', 'regression'],
};

function getCanonicalToken(word) {
  for (const [canon, syns] of Object.entries(SYNONYMS)) {
    if (canon === word || syns.includes(word)) return canon;
  }
  return word;
}

function normalizeTokens(str) {
  if (!str) return [];
  const STOP_WORDS = new Set([
    'run', 'the', 'test', 'automation', 'flow', 'please', 'a', 'an', 'to', 'for',
    'in', 'on', 'with', 'and', 'do', 'of', 'at', 'by', 'from', 'again', 'now', 'rerun',
    'can', 'you', 'my', 'our', 'me', 'this', 'that', 'our', 'it', 'is'
  ]);
  const phraseNormalized = String(str)
    .toLowerCase()
    .replace(/\blog\s+in\b/g, 'login')
    .replace(/\bsign\s+in\b/g, 'login')
    .replace(/\blog\s+out\b/g, 'logout')
    .replace(/\bsign\s+out\b/g, 'logout')
    .replace(/\bsign\s+up\b/g, 'signup')
    .replace(/\bcheck\s+out\b/g, 'checkout')
    .replace(/\badd\s+to\s+cart\b/g, 'add cart');

  return phraseNormalized
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .split(/[\s_-]+/)
    .filter(t => t.length > 1 && !STOP_WORDS.has(t))
    .map(getCanonicalToken);
}

/**
 * Computes deterministic initial positions for graph nodes & hierarchy edges
 */
export function computeGraphLayout(project) {
  const projectId = project.id || 'default-project';
  const projectNodeId = `project:${projectId}`;
  const features = Array.isArray(project.features) ? project.features : [];

  const existingNodesMap = new Map(
    (project.canvasLayout?.nodes || []).map(n => [n.id, n.position])
  );

  const nodes = [];
  const edges = [];

  // 1. Project Root Node
  nodes.push({
    id: projectNodeId,
    type: 'project',
    position: existingNodesMap.get(projectNodeId) || { x: 0, y: 0 },
    data: {
      id: projectId,
      label: project.name || 'Automation Project',
      featureCount: features.length,
      flowCount: features.reduce((acc, f) => acc + (f.flows?.length || 0), 0),
    },
  });

  const featureStartX = 260;
  const featureGapY = 220;
  const flowGapX = 260;
  const flowGapY = 95;

  features.forEach((feature, fIdx) => {
    const featureNodeId = `feature:${feature.id}`;
    const fx = featureStartX;
    const fy = fIdx * featureGapY;

    nodes.push({
      id: featureNodeId,
      type: 'feature',
      position: existingNodesMap.get(featureNodeId) || { x: fx, y: fy },
      data: {
        id: feature.id,
        label: feature.name,
        description: feature.description || null,
        flowCount: (feature.flows || []).length,
      },
    });

    edges.push({
      id: `hier-${projectNodeId}-${featureNodeId}`,
      source: projectNodeId,
      target: featureNodeId,
      type: 'smoothstep',
      style: { stroke: '#94a3b8', strokeDasharray: '4 4' },
    });

    const flows = Array.isArray(feature.flows) ? feature.flows : [];
    flows.forEach((flow, flIdx) => {
      const flowNodeId = `flow:${flow.id}`;
      const flx = fx + flowGapX;
      const fly = fy + flIdx * flowGapY - ((flows.length - 1) * flowGapY) / 2;

      nodes.push({
        id: flowNodeId,
        type: 'flow',
        position: existingNodesMap.get(flowNodeId) || { x: flx, y: fly },
        data: {
          id: flow.id,
          featureId: feature.id,
          label: flow.name,
          description: flow.description || null,
          stepCount: flow.stepCount || 0,
          runStatus: flow.lastRunStatus || 'idle',
          lastRunAt: flow.lastRunAt || null,
          lastRunDurationMs: flow.lastRunDurationMs || 0,
        },
      });

      edges.push({
        id: `hier-${featureNodeId}-${flowNodeId}`,
        source: featureNodeId,
        target: flowNodeId,
        type: 'smoothstep',
        style: { stroke: '#94a3b8', strokeDasharray: '4 4' },
      });
    });
  });

  // Preserve any saved dependency edges (depends-on)
  const savedDeps = (project.canvasLayout?.edges || []).filter(e => e.type === 'depends-on' || e.id?.startsWith('dep-'));
  for (const dep of savedDeps) {
    edges.push({
      ...dep,
      type: 'depends-on',
      animated: true,
      style: dep.style || { stroke: '#3b82f6', strokeWidth: 2 },
    });
  }

  return {
    viewport: project.canvasLayout?.viewport || { x: 0, y: 0, zoom: 1 },
    nodes,
    edges,
  };
}

/**
 * Returns project path: automation/project.json
 */
export function getProjectPath(cwd = process.cwd()) {
  return path.resolve(cwd, 'automation', 'project.json');
}

/**
 * Loads or initializes automation/project.json
 */
export function loadProject(cwd = process.cwd()) {
  const projPath = getProjectPath(cwd);
  let project;

  if (fs.existsSync(projPath)) {
    try {
      project = JSON.parse(fs.readFileSync(projPath, 'utf8'));
    } catch {
      project = null;
    }
  }

  if (!project || typeof project !== 'object') {
    project = {
      id: 'default-project',
      name: path.basename(cwd) || 'Automation Project',
      baseUrl: '',
      canvasLayout: {
        viewport: { x: 0, y: 0, zoom: 1 },
        nodes: [],
        edges: [],
      },
      features: [],
    };
    saveProject(cwd, project);
  }

  if (!Array.isArray(project.features)) {
    project.features = [];
  }

  // Sync step counts and specs from disk for all flows
  for (const feat of project.features) {
    if (!Array.isArray(feat.flows)) feat.flows = [];
    for (const flow of feat.flows) {
      if (flow.flowPath) {
        const fullFlowPath = path.resolve(cwd, flow.flowPath);
        if (fs.existsSync(fullFlowPath)) {
          try {
            const raw = JSON.parse(fs.readFileSync(fullFlowPath, 'utf8'));
            if (Array.isArray(raw.steps)) {
              flow.stepCount = raw.steps.length;
            }
          } catch {}
        }
      }
    }
  }

  // Compute graph layout
  project.canvasLayout = computeGraphLayout(project);

  return project;
}

/**
 * Writes automation/project.json
 */
export function saveProject(cwd, project) {
  const projPath = getProjectPath(cwd);
  fs.mkdirSync(path.dirname(projPath), { recursive: true });

  // Update layout before saving
  project.canvasLayout = computeGraphLayout(project);
  fs.writeFileSync(projPath, JSON.stringify(project, null, 2), 'utf8');
  return project;
}

/**
 * Updates canvas layout positions and dependency edges
 */
export function updateCanvasLayout(cwd, layout) {
  const project = loadProject(cwd);
  if (!project.canvasLayout) {
    project.canvasLayout = { viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [] };
  }

  if (layout.viewport) {
    project.canvasLayout.viewport = layout.viewport;
  }

  if (Array.isArray(layout.nodes)) {
    const posMap = new Map(layout.nodes.map(n => [n.id, n.position]));
    project.canvasLayout.nodes = project.canvasLayout.nodes.map(n => ({
      ...n,
      position: posMap.get(n.id) || n.position,
    }));
  }

  if (Array.isArray(layout.edges)) {
    const dependsOnEdges = layout.edges
      .filter(e => e.type === 'depends-on' || e.id?.startsWith('dep-'))
      .map(e => ({ ...e, type: 'depends-on' }));
    // Replace dependency edges while preserving hierarchy
    project.canvasLayout.edges = [
      ...project.canvasLayout.edges.filter(e => e.type !== 'depends-on' && !e.id?.startsWith('dep-')),
      ...dependsOnEdges,
    ];
  }

  const projPath = getProjectPath(cwd);
  fs.writeFileSync(projPath, JSON.stringify(project, null, 2), 'utf8');
  return project;
}

/**
 * Creates a new Feature node in the automation project
 */
export function createFeature(cwd, { name, description = '' }) {
  if (!name || typeof name !== 'string') {
    throw new Error('Feature name is required');
  }

  const project = loadProject(cwd);
  const slug = slugify(name);
  let id = `feat-${slug}`;
  let count = 1;
  while (project.features.some(f => f.id === id)) {
    id = `feat-${slug}-${++count}`;
  }

  const featureDir = path.resolve(cwd, 'automation', 'features', slug);
  fs.mkdirSync(featureDir, { recursive: true });

  const feature = {
    id,
    name: name.trim(),
    description: (description || '').trim(),
    flows: [],
  };

  project.features.push(feature);
  saveProject(cwd, project);

  return { feature, project };
}

/**
 * Creates and registers a new Flow under a Feature
 */
export function createFlow(cwd, { featureId, name, description = '', steps = [], url = '' }) {
  if (!name || typeof name !== 'string') {
    throw new Error('Flow name is required');
  }

  let project = loadProject(cwd);
  const want = String(featureId || '').trim();
  let feature = project.features.find(f => f.id === want || f.name.toLowerCase() === want.toLowerCase());

  if (!feature) {
    if (want && !/^feat-/.test(want)) {
      // A feature name that does not exist yet: create it (e.g. "Orders").
      createFeature(cwd, { name: want, description: '' });
    } else if (project.features.length === 0) {
      createFeature(cwd, { name: 'General', description: 'Core application flows' });
    }
    // Reload: createFeature saved its own copy of the project.
    project = loadProject(cwd);
    feature = project.features.find(f => f.name.toLowerCase() === want.toLowerCase()) || project.features[0];
  }

  const featureSlug = slugify(feature.name);
  const flowSlug = slugify(name);
  let flowId = `flow-${flowSlug}`;
  let count = 1;
  const allFlows = project.features.flatMap(f => f.flows || []);
  while (allFlows.some(fl => fl.id === flowId)) {
    flowId = `flow-${flowSlug}-${++count}`;
  }

  const flowDir = path.resolve(cwd, 'automation', 'features', featureSlug, flowSlug);
  fs.mkdirSync(flowDir, { recursive: true });

  const initialSteps = Array.isArray(steps) && steps.length > 0 ? steps : (
    url ? [{ action: 'goto', url, description: `Navigate to ${url}`, timestamp: Date.now() }] : []
  );

  const flowData = {
    id: flowId,
    name: name.trim(),
    description: (description || '').trim(),
    createdAt: new Date().toISOString(),
    startUrl: url || (initialSteps[0]?.url) || '',
    stepCount: initialSteps.length,
    steps: initialSteps,
  };

  ensureFlowGraph(flowData); // node ids, labels and edges (flow format v2)

  const flowFilePath = path.join(flowDir, 'flow.json');
  fs.writeFileSync(flowFilePath, JSON.stringify(flowData, null, 2), 'utf8');

  // Compile standalone Playwright spec
  const specCode = compileFlowToSpec(flowData);
  const specFilePath = path.join(flowDir, `${flowSlug}.spec.ts`);
  fs.writeFileSync(specFilePath, specCode, 'utf8');

  const flowRecord = {
    id: flowId,
    name: name.trim(),
    description: (description || '').trim(),
    flowPath: path.relative(cwd, flowFilePath),
    specPath: path.relative(cwd, specFilePath),
    stepCount: initialSteps.length,
    lastRunStatus: 'idle',
    lastRunDurationMs: 0,
    lastRunAt: null,
  };

  feature.flows.push(flowRecord);
  saveProject(cwd, project);

  return { flow: flowRecord, feature, project };
}

/**
 * Fuzzy matches user intent to existing saved features and flows
 */
export function matchFlow(cwd, intent) {
  if (!intent || typeof intent !== 'string' || !intent.trim()) {
    return { matched: false, confidence: 0, flow: null, candidates: [] };
  }

  const project = loadProject(cwd);
  const intentTrimmed = intent.trim();
  const intentNorm = intentTrimmed.toLowerCase();
  const intentTokens = normalizeTokens(intentTrimmed);

  const candidates = [];

  for (const feature of project.features) {
    const featTokens = normalizeTokens(feature.name + ' ' + (feature.description || ''));

    for (const flow of feature.flows || []) {
      let score = 0;
      const reasons = [];

      const flowNameNorm = flow.name.toLowerCase().trim();
      const flowNameTokens = normalizeTokens(flow.name);
      const flowDescTokens = normalizeTokens(flow.description || '');
      const allFlowTokens = [...new Set([...flowNameTokens, ...flowDescTokens])];

      // 1. Exact or strong substring match
      if (flowNameNorm === intentNorm) {
        score = 1.0;
        reasons.push('exact flow name match');
      } else if (intentNorm.includes(flowNameNorm) && flowNameNorm.length >= 3) {
        score = Math.max(score, 0.95);
        reasons.push('intent contains full flow name');
      } else if (flowNameNorm.includes(intentNorm) && intentNorm.length >= 3) {
        score = Math.max(score, 0.90);
        reasons.push('flow name contains full intent');
      } else {
        // 2. Flow name keyword coverage (how much of the flow's name is in the intent)
        const matchedFlowNameTokens = flowNameTokens.filter(ft =>
          intentTokens.some(it => it === ft || (it.length >= 4 && ft.length >= 4 && (it.includes(ft) || ft.includes(it))))
        );
        const flowNameCoverage = flowNameTokens.length > 0 ? matchedFlowNameTokens.length / flowNameTokens.length : 0;

        // Intent tokens matching any flow tokens
        const matchedIntentTokens = intentTokens.filter(it =>
          allFlowTokens.some(ft => it === ft || (it.length >= 4 && ft.length >= 4 && (it.includes(ft) || ft.includes(it))))
        );
        const intentCoverage = intentTokens.length > 0 ? matchedIntentTokens.length / intentTokens.length : 0;

        if (flowNameCoverage === 1.0) {
          score = Math.max(score, 0.88);
          reasons.push('all flow name keywords matched');
        } else if (flowNameCoverage >= 0.5) {
          score = Math.max(score, 0.75 + (intentCoverage * 0.15));
          reasons.push(`primary flow keyword matched (${matchedFlowNameTokens.join(',')})`);
        } else if (matchedIntentTokens.length > 0) {
          const jaccard = matchedIntentTokens.length / (new Set([...intentTokens, ...allFlowTokens]).size);
          const tokenScore = (jaccard * 0.4) + (intentCoverage * 0.5);
          if (tokenScore > score) {
            score = tokenScore;
            reasons.push(`token overlap (${matchedIntentTokens.length} matching words)`);
          }
        }

        // 3. Match against steps if available on disk
        if (flow.flowPath) {
          const fullPath = path.resolve(cwd, flow.flowPath);
          if (fs.existsSync(fullPath)) {
            try {
              const raw = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
              if (Array.isArray(raw.steps)) {
                const stepText = raw.steps.map(s => `${s.action} ${s.description || ''} ${s.value || ''} ${s.url || ''}`).join(' ');
                const stepTokens = normalizeTokens(stepText);
                const stepMatches = intentTokens.filter(t => stepTokens.some(st => st === t)).length;
                if (intentTokens.length > 0 && stepMatches > 0) {
                  const stepCoverage = (stepMatches / intentTokens.length) * 0.75;
                  if (stepCoverage > score) {
                    score = Math.min(0.85, score + stepCoverage * 0.5);
                    reasons.push(`matches ${stepMatches} step action keywords`);
                  }
                }
              }
            } catch {}
          }
        }

        // 4. Feature context boost
        const matchedFeat = intentTokens.filter(it => featTokens.some(ft => ft === it || (it.length >= 4 && ft.length >= 4 && (it.includes(ft) || ft.includes(it)))));
        if (matchedFeat.length > 0 && score > 0) {
          score = Math.min(1.0, score + 0.12);
          reasons.push('matches parent feature context');
        }
      }

      // Round score
      score = Math.round(score * 100) / 100;

      candidates.push({
        flow: {
          id: flow.id,
          name: flow.name,
          description: flow.description,
          featureId: feature.id,
          featureName: feature.name,
          flowPath: flow.flowPath,
          specPath: flow.specPath,
          stepCount: flow.stepCount,
          lastRunStatus: flow.lastRunStatus,
          lastRunAt: flow.lastRunAt,
        },
        confidence: score,
        reason: reasons.join(', ') || 'low similarity',
      });
    }
  }

  candidates.sort((a, b) => b.confidence - a.confidence);

  const top = candidates[0];
  const matched = !!top && top.confidence >= 0.7;

  return {
    matched,
    confidence: top ? top.confidence : 0,
    flow: top ? top.flow : null,
    candidates: candidates.slice(0, 5),
  };
}

/**
 * Topologically sorts flow IDs based on 'depends-on' edges
 */
export function orderFlowsByDependencies(flows, edges = []) {
  const depEdges = edges.filter(e => e.type === 'depends-on');
  const graph = new Map();
  const inDegree = new Map();
  const flowIdSet = new Set(flows.map(f => f.id));

  for (const f of flows) {
    graph.set(f.id, []);
    inDegree.set(f.id, 0);
  }

  for (const edge of depEdges) {
    const src = edge.source?.replace(/^flow:/, '');
    const tgt = edge.target?.replace(/^flow:/, '');
    if (flowIdSet.has(src) && flowIdSet.has(tgt)) {
      graph.get(src).push(tgt);
      inDegree.set(tgt, (inDegree.get(tgt) || 0) + 1);
    }
  }

  const queue = flows.filter(f => inDegree.get(f.id) === 0).map(f => f.id);
  const orderedIds = [];

  while (queue.length > 0) {
    const curr = queue.shift();
    orderedIds.push(curr);
    for (const next of (graph.get(curr) || [])) {
      inDegree.set(next, inDegree.get(next) - 1);
      if (inDegree.get(next) === 0) {
        queue.push(next);
      }
    }
  }

  // Include any remaining (e.g. cycles)
  for (const f of flows) {
    if (!orderedIds.includes(f.id)) {
      orderedIds.push(f.id);
    }
  }

  const flowMap = new Map(flows.map(f => [f.id, f]));
  return orderedIds.map(id => flowMap.get(id)).filter(Boolean);
}

/**
 * Runs a batch of flows according to dependencies, updating project.json run status
 */
export async function batchRunFlows(cwd, options = {}) {
  const {
    featureId,
    flowIds,
    followDependencies = true,
    continueOnError = false,
    headless = false,
    onProgress,
  } = options;

  const project = loadProject(cwd);
  let targetFlows = [];

  if (featureId) {
    const feat = project.features.find(f => f.id === featureId || f.name.toLowerCase() === String(featureId).toLowerCase());
    targetFlows = feat ? [...(feat.flows || [])] : [];
  } else if (Array.isArray(flowIds) && flowIds.length > 0) {
    const idSet = new Set(flowIds.map(id => id.replace(/^flow:/, '')));
    targetFlows = project.features.flatMap(f => f.flows || []).filter(fl => idSet.has(fl.id));
  } else {
    targetFlows = project.features.flatMap(f => f.flows || []);
  }

  if (targetFlows.length === 0) {
    return {
      ok: true,
      summary: 'No flows to execute.',
      totalFlows: 0,
      passedFlows: 0,
      failedFlows: 0,
      results: [],
    };
  }

  // Order by dependencies if requested
  const runSequence = followDependencies
    ? orderFlowsByDependencies(targetFlows, project.canvasLayout?.edges || [])
    : targetFlows;

  let session;
  try {
    session = await getBrowserSession({ headless: !!headless });
  } catch (err) {
    return {
      ok: false,
      summary: `Failed to acquire browser session: ${err.message}`,
      totalFlows: runSequence.length,
      passedFlows: 0,
      failedFlows: runSequence.length,
      results: runSequence.map(f => ({
        flowId: f.id,
        flowName: f.name,
        ok: false,
        status: 'fail',
        durationMs: 0,
        summary: err.message,
      })),
    };
  }

  const results = [];
  let passedCount = 0;
  let failedCount = 0;

  try {
    for (let i = 0; i < runSequence.length; i++) {
      const flow = runSequence[i];
      const fullFlowPath = path.resolve(cwd, flow.flowPath);

      // Mark running
      flow.lastRunStatus = 'running';
      saveProject(cwd, project);

      if (onProgress) {
        onProgress({
          flowIndex: i + 1,
          totalFlows: runSequence.length,
          flowName: flow.name,
          flowId: flow.id,
          status: 'running',
        });
      }

      let res;
      if (!fs.existsSync(fullFlowPath)) {
        res = {
          ok: false,
          summary: `Flow file not found: ${flow.flowPath}`,
          durationMs: 0,
          results: [],
        };
      } else {
        try {
          res = await runFlow(session, fullFlowPath, {
            cwd,
            continueOnError,
            dataMode: options.dataMode,
            onProgress: (p) => {
              if (onProgress) onProgress({ ...p, flowId: flow.id, flowName: flow.name });
            },
          });
        } catch (err) {
          res = {
            ok: false,
            summary: err.message,
            durationMs: 0,
            results: [],
          };
        }
      }

      const status = res.ok ? 'pass' : 'fail';
      flow.lastRunStatus = status;
      flow.lastRunDurationMs = res.durationMs || 0;
      flow.lastRunAt = new Date().toISOString();

      if (res.ok) passedCount++; else failedCount++;

      results.push({
        flowId: flow.id,
        flowName: flow.name,
        ok: res.ok,
        status,
        durationMs: res.durationMs,
        summary: res.summary,
      });

      saveProject(cwd, project);

      if (!res.ok && !continueOnError) {
        for (let j = i + 1; j < runSequence.length; j++) {
          results.push({
            flowId: runSequence[j].id,
            flowName: runSequence[j].name,
            ok: false,
            status: 'idle',
            durationMs: 0,
            summary: `Skipped because dependency ${flow.name} failed`,
          });
        }
        break;
      }
    }
  } finally {
    if (!session.isCdp) {
      await closeSession(session);
    }
  }

  const ok = failedCount === 0;
  return {
    ok,
    summary: `Batch run ${ok ? 'PASSED' : 'FAILED'}: ${passedCount}/${runSequence.length} flows passed (${failedCount} failed)`,
    totalFlows: runSequence.length,
    passedFlows: passedCount,
    failedFlows: failedCount,
    results,
  };
}
