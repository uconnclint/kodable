// Validates level files: grid shape, char legality, star count, solution wins
// with all 3 stars, solution respects `allowed` constraints and parCommands sanity.
// Usage: node tools/validate.js [world1 world2 ...]  (default: all present)
import { parseGrid, runProgram } from '../src/engine/interpreter.js';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const names = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['world1', 'world2', 'world3', 'world4', 'world5'];

let failures = 0;
let total = 0;

function fail(id, msg) {
  failures++;
  console.log(`  FAIL ${id}: ${msg}`);
}

function mainTokenCount(main) {
  return main.length;
}

function checkAllowed(lv) {
  const a = lv.allowed;
  const sol = lv.solution;
  const dirsUsed = new Set();
  const scanDirs = (toks) => toks.forEach((t) => {
    if (t.t === 'dir') dirsUsed.add(t.d);
    else if (t.t === 'loop') t.body.forEach((b) => dirsUsed.add(b.d));
  });
  scanDirs(sol.main);
  (sol.functions || []).forEach(scanDirs);
  for (const d of dirsUsed)
    if (!a.dirs.includes(d)) fail(lv.id, `solution uses dir ${d} not in allowed.dirs`);
  if (!a.loops && sol.main.some((t) => t.t === 'loop'))
    fail(lv.id, 'solution uses loop but loops not allowed');
  if (!a.functions && sol.main.some((t) => t.t === 'call'))
    fail(lv.id, 'solution uses function but functions not allowed');
  for (const c of sol.conditions || [])
    if (!a.conditions.includes(c.color)) fail(lv.id, `condition color ${c.color} not allowed`);
  if (mainTokenCount(sol.main) > a.maxMain)
    fail(lv.id, `solution main has ${sol.main.length} tokens > maxMain ${a.maxMain}`);
  if (lv.parCommands > a.maxMain) fail(lv.id, 'parCommands > maxMain');
}

for (const name of names) {
  const file = path.join(root, 'src/game/levels', `${name}.js`);
  if (!existsSync(file)) { console.log(`-- ${name}: missing, skipped`); continue; }
  const { levels } = await import(pathToFileURL(file).href);
  console.log(`== ${name}: ${levels.length} levels`);
  if (levels.length !== 12) fail(name, `expected 12 levels, got ${levels.length}`);
  const seen = new Set();
  for (const lv of levels) {
    total++;
    if (seen.has(lv.id)) fail(lv.id, 'duplicate id');
    seen.add(lv.id);
    let parsed;
    try {
      parsed = parseGrid(lv.grid);
    } catch (e) { fail(lv.id, `grid: ${e.message}`); continue; }
    if (parsed.stars.length !== 3) fail(lv.id, `has ${parsed.stars.length} stars, need exactly 3`);
    if (parsed.rows > 9 || parsed.cols > 12) fail(lv.id, `grid ${parsed.cols}x${parsed.rows} exceeds 12x9`);
    if (!lv.solution) { fail(lv.id, 'no solution'); continue; }
    checkAllowed(lv);
    let res;
    try {
      res = runProgram(parsed, lv.solution);
    } catch (e) { fail(lv.id, `run error: ${e.message}`); continue; }
    if (!res.win) fail(lv.id, `solution does not win (${res.reason})`);
    else if (res.starsGot !== 3) fail(lv.id, `solution collects ${res.starsGot}/3 stars`);
    if (lv.solution.main.length > lv.parCommands)
      console.log(`  note ${lv.id}: solution main (${lv.solution.main.length}) > parCommands (${lv.parCommands}) — par may be impossible`);
  }
}
console.log(failures ? `\n${failures} FAILURES across ${total} levels` : `\nAll ${total} levels valid ✔`);
process.exit(failures ? 1 : 0);
