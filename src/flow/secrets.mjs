// Typed passwords are kept out of flow.json, in automation/.secrets.json (git-ignored).
import fs from 'node:fs';
import path from 'node:path';

export function secretsFile(cwd) {
  return path.resolve(cwd, 'automation', '.secrets.json');
}

export function readSecrets(cwd) {
  try {
    return JSON.parse(fs.readFileSync(secretsFile(cwd), 'utf8')) || {};
  } catch {
    return {};
  }
}

export function mergeSecrets(cwd, secrets) {
  if (!secrets || !Object.keys(secrets).length) return;
  const all = { ...readSecrets(cwd), ...secrets };
  fs.mkdirSync(path.dirname(secretsFile(cwd)), { recursive: true });
  fs.writeFileSync(secretsFile(cwd), JSON.stringify(all, null, 2), { encoding: 'utf8', mode: 0o600 });
}
