// Steps inside iframes and file uploads.
import fs from 'node:fs';
import path from 'node:path';
import { samePage } from './graph.mjs';

/**
 * The frame a step works in. `frame` is what the recorder saved ({ url, name, selector }) or what
 * the agent gave: an iframe CSS selector, a frame name, or part of the frame's URL.
 * Returns a Playwright Frame (it has the same locator API as a page).
 */
export async function scopeFor(page, frame, { timeout = 10000 } = {}) {
  if (!frame) return page;
  const spec = typeof frame === 'string' ? { hint: frame } : frame;
  const end = Date.now() + timeout;
  while (true) {
    const frames = page.frames().filter((f) => f !== page.mainFrame());
    let found = null;
    if (spec.selector || (spec.hint && /^[#.[]|^iframe/i.test(spec.hint))) {
      try {
        const handle = await page.locator(spec.selector || spec.hint).first().elementHandle({ timeout: 500 });
        found = handle ? await handle.contentFrame() : null;
      } catch {}
    }
    if (!found && (spec.name || spec.hint)) found = frames.find((f) => f.name() && f.name() === (spec.name || spec.hint)) || null;
    if (!found && spec.url) found = frames.find((f) => f.url() === spec.url) || frames.find((f) => samePage(f.url(), spec.url)) || null;
    if (!found && spec.hint) found = frames.find((f) => f.url().includes(spec.hint)) || null;
    if (found) return found;
    if (Date.now() > end) throw new Error(`Frame not found: ${JSON.stringify(frame)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

// Small valid files for uploads when the recorded file is not in automation/files/.
const PNG_1X1 = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
function placeholder(name) {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.png') return PNG_1X1;
  if (ext === '.pdf') return Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
  if (ext === '.csv') return Buffer.from('name,email\nTest User,test.user@example.com\n');
  if (ext === '.json') return Buffer.from('{"test": true}\n');
  return Buffer.from(`Test file ${name} made by Opscode Automation Studio\n`);
}

/**
 * Paths of the files to upload: automation/files/<name> (or an absolute / workspace path).
 * A missing file is created there as a small valid placeholder so the flow can still run.
 * Returns { paths, created }.
 */
export function resolveUploadFiles(cwd, files) {
  const dir = path.join(cwd, 'automation', 'files');
  const paths = [];
  const created = [];
  for (const f of (Array.isArray(files) ? files : [files]).filter(Boolean)) {
    const s = String(f);
    const direct = path.isAbsolute(s) ? s : path.resolve(cwd, s);
    if (fs.existsSync(direct) && fs.statSync(direct).isFile()) { paths.push(direct); continue; }
    const p = path.join(dir, path.basename(s));
    if (!fs.existsSync(p)) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(p, placeholder(path.basename(s)));
      created.push(path.relative(cwd, p));
    }
    paths.push(p);
  }
  return { paths, created };
}
