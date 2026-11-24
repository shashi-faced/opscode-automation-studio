#!/usr/bin/env node
// A stand-in for the GitHub CLI in tests: records calls in $FAKE_GH_LOG, answers like gh.
import fs from 'node:fs';
const args = process.argv.slice(2);
const log = process.env.FAKE_GH_LOG;
let input = '';
try { input = fs.readFileSync(0, 'utf8'); } catch {}
if (log) fs.appendFileSync(log, JSON.stringify({ args, input }) + '\n');
if (args[0] === 'repo' && args[1] === 'view') console.log('acme/shop');
else if (args[0] === 'issue' && args[1] === 'create') console.log('https://github.com/acme/shop/issues/42');
else if (args[0] === 'issue' && args[1] === 'view') console.log(process.env.FAKE_GH_STATE || 'OPEN');
else { console.error('unknown'); process.exit(1); }
