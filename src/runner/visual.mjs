import fs from 'node:fs';
import path from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

/**
 * Normalizes two PNG images to equal dimensions by padding with transparent pixels
 */
function normalizeImages(pngA, pngB) {
  const width = Math.max(pngA.width, pngB.width);
  const height = Math.max(pngA.height, pngB.height);

  function pad(src, w, h) {
    if (src.width === w && src.height === h) return src;
    const dest = new PNG({ width: w, height: h });
    // Fill with transparency
    dest.data.fill(0);
    // Copy pixels from source
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) {
        const srcIdx = (y * src.width + x) * 4;
        const destIdx = (y * w + x) * 4;
        dest.data[destIdx] = src.data[srcIdx];
        dest.data[destIdx + 1] = src.data[srcIdx + 1];
        dest.data[destIdx + 2] = src.data[srcIdx + 2];
        dest.data[destIdx + 3] = src.data[srcIdx + 3];
      }
    }
    return dest;
  }

  return {
    imgA: pad(pngA, width, height),
    imgB: pad(pngB, width, height),
    width,
    height,
  };
}

/**
 * Compares two images using pixelmatch and outputs a visual diff.
 */
export async function compareImages(baselineInput, currentInput, options = {}) {
  const {
    threshold = 0.1, // pixelmatch color threshold (0.0 to 1.0)
    maxDiffPercent = 0.1, // allowable difference percentage
    outDiffPath,
  } = options;

  let baseBuf;
  if (Buffer.isBuffer(baselineInput)) {
    baseBuf = baselineInput;
  } else if (typeof baselineInput === 'string' && fs.existsSync(baselineInput)) {
    baseBuf = fs.readFileSync(baselineInput);
  } else {
    throw new Error(`Baseline image not found: ${baselineInput}`);
  }

  let currBuf;
  if (Buffer.isBuffer(currentInput)) {
    currBuf = currentInput;
  } else if (typeof currentInput === 'string' && fs.existsSync(currentInput)) {
    currBuf = fs.readFileSync(currentInput);
  } else {
    throw new Error(`Current image not found: ${currentInput}`);
  }

  const rawBase = PNG.sync.read(baseBuf);
  const rawCurr = PNG.sync.read(currBuf);

  const { imgA, imgB, width, height } = normalizeImages(rawBase, rawCurr);
  const totalPixels = width * height;
  const diffImg = new PNG({ width, height });

  const changedPixels = pixelmatch(
    imgA.data,
    imgB.data,
    diffImg.data,
    width,
    height,
    {
      threshold,
      includeAA: false,
      diffColor: [255, 0, 96], // Bright neon red/magenta
    }
  );

  const diffPercentage = totalPixels > 0 ? (changedPixels / totalPixels) * 100 : 0;
  const roundedDiff = Math.round(diffPercentage * 100) / 100;
  const isMatch = roundedDiff <= maxDiffPercent;

  let savedDiffPath = null;
  if (outDiffPath || !isMatch) {
    savedDiffPath = outDiffPath || path.join(process.cwd(), 'diffs', `diff-${Date.now()}.png`);
    fs.mkdirSync(path.dirname(savedDiffPath), { recursive: true });
    const diffBuf = PNG.sync.write(diffImg);
    fs.writeFileSync(savedDiffPath, diffBuf);
  }

  return {
    ok: true,
    isMatch,
    diffPercentage: roundedDiff,
    changedPixels,
    totalPixels,
    diffPath: savedDiffPath,
    message: isMatch
      ? `Visual check passed: ${roundedDiff}% diff (${changedPixels} changed pixels)`
      : `Visual mismatch detected: ${roundedDiff}% diff (${changedPixels}/${totalPixels} pixels changed). Diff image saved to ${savedDiffPath}`,
  };
}
