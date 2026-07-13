# BLOOPTOPIA 3D — Design & Data Spec

A AAA-styled 3D flat-shaded low-poly coding game for kids. Player pre-programs a
bouncy ball hero ("Bloop") with direction commands, conditions, loops and functions to
roll through floating-island mazes, collect stars and coins, and reach the exit.

Tech: Three.js (flat-shaded low-poly), Vite, vanilla JS ES modules, no framework.
Persistence: localStorage. All audio synthesized via WebAudio (no asset files).

## Movement semantics (MUST be followed exactly by level authors)

- The maze is a 2D grid rendered in 3D. +x = right (R), +y = down (D) in grid space.
- The program's flattened token stream is a list of direction commands U/D/L/R.
- Execution: take the next direction command; Bloop rolls tile-by-tile in that
  direction until the NEXT tile is not walkable (void, out of bounds). Then the
  next command is consumed. Rolling over a tile collects any star/coin on it.
- CONDITIONS: list of `{color, d}` active for the whole run. When Bloop ENTERS a
  colored tile whose color has a condition, its direction immediately changes to
  the condition direction and it keeps rolling (no program command consumed).
  A condition fires EVERY time a matching tile is entered. At most one condition
  per color. If the condition direction is immediately blocked, Bloop stops there
  and consumes the next program command.
- If Bloop enters the exit tile `E`, the level is complete instantly (mid-roll).
- FAIL: program exhausted and Bloop is not on E; or the very first move of a
  command is blocked AND the program is exhausted. A command whose first move is
  blocked simply wastes that command (Bloop doesn't move); execution continues.
- LOOPS: `{t:'loop', n:2..5, body:[dir tokens]}` — body repeats n times (body =
  dir tokens only, no nesting).
- FUNCTIONS: one function F1 max: `functions: [[dir tokens...]]`,
  called from main with `{t:'call', f:0}`. Function bodies: dir tokens only.
- Dir token: `{t:'dir', d:'U'|'D'|'L'|'R'}`.

## Grid format

`grid` is an array of equal-length strings (max 12 cols × 9 rows). Chars:

| char | meaning |
|------|---------|
| ` ` (space) | void (not walkable) |
| `#` | path tile |
| `S` | start tile (exactly one) |
| `E` | exit tile (exactly one) |
| `*` | path tile with a STAR (exactly 3 per level) |
| `c` | path tile with a coin (0–6 per level) |
| `p` | pink tile, `b` blue, `g` green, `o` orange (walkable colored tiles) |

## Level object

```js
{
  id: 'w1-01',            // w<world>-<index, 2 digits>
  world: 1, index: 1,
  name: 'First Roll',
  intro: 'One-line kid-friendly tip (optional)',
  grid: [ '  S##*#E  ', ... ],
  allowed: {
    dirs: ['U','D','L','R'],   // subset allowed in this level
    loops: false,              // loop block available?
    functions: false,          // function F1 available?
    conditions: ['p','b'],     // colors the player may bind ([] = none)
    maxMain: 8                 // max tokens in main sequence
  },
  parCommands: 3,              // main tokens ≤ par → "perfect" bonus
  solution: {                  // MUST complete the level with ALL 3 stars
    main: [ {t:'dir',d:'R'}, {t:'loop',n:3,body:[{t:'dir',d:'R'},{t:'dir',d:'D'}]}, {t:'call',f:0} ],
    functions: [],             // or [[{t:'dir',d:'R'}, ...]]
    conditions: []             // or [{color:'p', d:'L'}]
  }
}
```

Export per world file: `export const levels = [ ... ]` from
`src/game/levels/world1.js` … `world5.js`.

## Worlds (12 levels each, 60 total; difficulty ramps within each)

1. **Bloopberry Meadows** — pure sequences (dirs only). Teach R first, then D/U/L.
2. **Crystal Caverns** — introduces color conditions (p, then b, g, o; multi-condition mazes).
3. **Loopy Canyon** — introduces loops (zig-zags, staircases, spirals).
4. **Function Junction** — introduces function F1 (repeated motifs called 2–3×).
5. **Bugstorm Peaks** — mastery: everything combined, tight maxMain budgets.

## Stats object (input to achievement/badge checks)

```js
stats = {
  levelsCompleted: 0,      // distinct levels completed
  totalStars: 0,           // 0..180 (best per level, 3 max each)
  perfectLevels: 0,        // distinct levels done with 3 stars AND main ≤ parCommands
  coinsEarned: 0,          // lifetime coins
  coinsSpent: 0,
  worldsCompleted: [false,false,false,false,false], // all 12 levels done
  worldsPerfected: [false,false,false,false,false], // all 12 at 3 stars
  runs: 0,                 // total program runs
  fails: 0,                // failed runs
  commandsUsed: 0,         // lifetime dir tokens executed
  loopsUsed: 0,            // lifetime loop blocks run
  functionCalls: 0,        // lifetime F1 calls run
  conditionsFired: 0,      // lifetime condition triggers
  starsCollectedLifetime: 0,
  charactersOwned: 1,
  firstTryWins: 0,         // levels beaten on their very first run
  noFailStreakBest: 0      // best streak of consecutive winning runs
}
```

## Achievements & badges

- Achievement: `{ id, name, desc, icon, tier:'bronze'|'silver'|'gold', coins, check(stats) }`
  (icon = single emoji; coins = reward 10–200 by tier). 40+ total, exported as
  `export const achievements = [...]` from `src/game/achievements.js`.
- Badge: `{ id, name, desc, icon, check(stats) }` — prestigious world/mastery
  emblems (20+), `export const badges = [...]` from `src/game/badges.js`.
- `check` must be a pure function of the stats object above only.

## Characters (src/game/characters.js)

`export const characters = [...]`, 16 entries, first has cost 0:

```js
{ id:'blip', name:'Blip', desc:'The original bloop.', cost:0,
  colors:{ body:'#7ec8ff', accent:'#2b6cb0' },
  accessory:'none', // 'none'|'antennae'|'crown'|'horns'|'halo'|'cap'|'bow'|'spikes'|'glasses'|'flower'|'headphones'|'ninja'
  eyes:'round',     // 'round'|'happy'|'sleepy'|'star'|'angry'|'wink'
  trail:'#9ad8ff' } // particle trail color
```

Costs ramp 0, 50, 75, 100, ... up to ~1200 for legendary ones.

## Audio API (src/audio/sfx.js)

All synthesized WebAudio, kid-friendly, gentle. Exports:
`initAudio()`, `playSfx(name)`, `startMusic(world /*1-5 or 0=menu*/)`,
`stopMusic()`, `setMuted(bool)`, `isMuted()`.
Sfx names: `ui, select, place, remove, run, roll, turn, coin, star, win, fail,
unlock, achievement, buy, whoosh`.
Music: per-world generative loop (different key/tempo per world), quiet (~-18dB).
