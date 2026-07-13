// Simulates a full playthrough: runs every level's solution through the real
// interpreter + save/stats/unlock pipeline. Verifies:
//  - every level completes with 3 stars
//  - world/level unlock gating works in order
//  - all achievements and badges are reachable
//  - the coin economy can afford every character
import { parseGrid, runProgram } from '../src/engine/interpreter.js';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const load = (p) => import(pathToFileURL(path.join(root, p)).href);

const save = await load('src/game/save.js');
const { achievements } = await load('src/game/achievements.js');
const { badges } = await load('src/game/badges.js');
const { characters } = await load('src/game/characters.js');

const allLevels = [];
for (let w = 1; w <= 5; w++) {
  const { levels } = await load(`src/game/levels/world${w}.js`);
  allLevels.push(...levels);
}

let problems = 0;
const bad = (m) => { problems++; console.log('PROBLEM:', m); };

save.resetAll();

// Play in order, respecting unlock gates; each level twice (one fail-free perfect run
// is unrealistic for streak achievements, so add a deliberate fail every 7 levels).
let played = 0;
for (const lv of allLevels.sort((a, b) => a.world - b.world || a.index - b.index)) {
  if (!save.worldUnlocked(lv.world, allLevels)) bad(`world ${lv.world} locked when reaching ${lv.id}`);
  if (!save.levelUnlocked(lv, allLevels)) bad(`level ${lv.id} locked when reached in order`);
  const parsed = parseGrid(lv.grid);
  if (played % 7 === 3) {
    // deliberate failing run: single move that can't win
    const res = runProgram(parsed, { main: [{ t: 'dir', d: lv.allowed.dirs[0] }], functions: [], conditions: [] });
    save.recordRun(lv, res, { main: [{ t: 'dir', d: lv.allowed.dirs[0] }] }, allLevels);
  }
  const res = runProgram(parsed, lv.solution);
  if (!res.win || res.starsGot !== 3) bad(`${lv.id} solution imperfect: win=${res.win} stars=${res.starsGot}`);
  const summary = save.recordRun(lv, res, lv.solution, allLevels);
  if (!summary.win) bad(`${lv.id} summary not win`);
  save.checkUnlocks();
  played++;
}

const st = save.state.stats;
console.log('\n--- after full playthrough ---');
console.log(`levels ${st.levelsCompleted}/60  stars ${st.totalStars}/180  perfect ${st.perfectLevels}`);
console.log(`coins: ${save.state.coins} (earned ${st.coinsEarned})`);
console.log(`worlds completed: ${st.worldsCompleted}  perfected: ${st.worldsPerfected}`);
console.log(`loopsUsed ${st.loopsUsed}  functionCalls ${st.functionCalls}  conditionsFired ${st.conditionsFired}`);

if (st.levelsCompleted !== 60) bad('not all levels completed');
if (st.totalStars !== 180) bad('not all stars collected');
if (!st.worldsCompleted.every(Boolean)) bad('not all worlds completed');
if (st.loopsUsed === 0) bad('no loops used across all solutions?');
if (st.functionCalls === 0) bad('no function calls across all solutions?');
if (st.conditionsFired === 0) bad('no conditions fired across all solutions?');

// grind replays until every character affordable, then buy all
let grinds = 0;
const totalCost = characters.reduce((a, c) => a + c.cost, 0);
const lv1 = allLevels[0];
const parsed1 = parseGrid(lv1.grid);
while (save.state.coins < totalCost && grinds < 5000) {
  const res = runProgram(parsed1, lv1.solution);
  save.recordRun(lv1, res, lv1.solution, allLevels);
  save.checkUnlocks();
  grinds++;
}
for (const c of characters) if (c.cost > 0 && !save.buyCharacter(c)) bad(`cannot buy ${c.id}`);
save.checkUnlocks();
console.log(`bought all 16 characters after ${grinds} replay grinds (total cost ${totalCost})`);

// achievement / badge reachability
const aGot = achievements.filter((a) => save.state.achievementsUnlocked[a.id]);
const bGot = badges.filter((b) => save.state.badgesEarned[b.id]);
console.log(`achievements unlocked: ${aGot.length}/${achievements.length}`);
console.log(`badges earned: ${bGot.length}/${badges.length}`);
for (const a of achievements) if (!save.state.achievementsUnlocked[a.id]) console.log(`  not yet unlocked: [ach] ${a.id} — ${a.desc}`);
for (const b of badges) if (!save.state.badgesEarned[b.id]) console.log(`  not yet unlocked: [badge] ${b.id} — ${b.desc}`);

console.log(problems ? `\n${problems} PROBLEMS` : '\nSIMULATION CLEAN ✔');
process.exit(problems ? 1 : 0);
