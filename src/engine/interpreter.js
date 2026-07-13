// Pure, DOM-free program interpreter for Blooptopia 3D.
// Shared by the game runtime and tools/validate.js (node).

export const DIRS = {
  U: { x: 0, y: -1 },
  D: { x: 0, y: 1 },
  L: { x: -1, y: 0 },
  R: { x: 1, y: 0 },
};

export const COLOR_CHARS = ['p', 'b', 'g', 'o'];

export function parseGrid(grid) {
  const rows = grid.length;
  const cols = grid[0].length;
  const tiles = [];
  let start = null;
  let exit = null;
  const stars = [];
  const coins = [];
  for (let y = 0; y < rows; y++) {
    if (grid[y].length !== cols) throw new Error(`row ${y} length mismatch`);
    const row = [];
    for (let x = 0; x < cols; x++) {
      const ch = grid[y][x];
      let t = null;
      if (ch === '#') t = { kind: 'path' };
      else if (ch === 'S') { t = { kind: 'path' }; start = { x, y }; }
      else if (ch === 'E') { t = { kind: 'exit' }; exit = { x, y }; }
      else if (ch === '*') { t = { kind: 'path' }; stars.push({ x, y }); }
      else if (ch === 'c') { t = { kind: 'path' }; coins.push({ x, y }); }
      else if (COLOR_CHARS.includes(ch)) t = { kind: 'color', color: ch };
      else if (ch !== ' ') throw new Error(`bad char '${ch}' at ${x},${y}`);
      row.push(t);
    }
    tiles.push(row);
  }
  if (!start) throw new Error('no start tile');
  if (!exit) throw new Error('no exit tile');
  return { rows, cols, tiles, start, exit, stars, coins };
}

export function flattenProgram(main, functions = []) {
  const out = [];
  for (const tok of main) {
    if (tok.t === 'dir') out.push({ d: tok.d, src: tok });
    else if (tok.t === 'loop') {
      for (let i = 0; i < tok.n; i++)
        for (const b of tok.body) out.push({ d: b.d, src: tok, iter: i });
    } else if (tok.t === 'call') {
      const body = functions[tok.f] || [];
      for (const b of body) out.push({ d: b.d, src: tok, fn: tok.f });
    } else throw new Error(`bad token ${JSON.stringify(tok)}`);
  }
  return out;
}

function walkable(level, x, y) {
  if (x < 0 || y < 0 || x >= level.cols || y >= level.rows) return false;
  return !!level.tiles[y][x];
}

// Runs a program against a parsed level.
// Returns { win, reason, steps, starsGot, coinsGot, counts }
// steps: [{type:'move',from,to,d} | {type:'turn',at,d,color} |
//         {type:'collect',at,item} | {type:'command',d} | {type:'blocked',at,d} |
//         {type:'win',at} | {type:'fail',at,reason}]
export function runProgram(level, program) {
  const { main = [], functions = [], conditions = [] } = program;
  const condMap = {};
  for (const c of conditions) condMap[c.color] = c.d;

  const flat = flattenProgram(main, functions);
  const steps = [];
  const gotStars = new Set();
  const gotCoins = new Set();
  const counts = { commands: 0, loops: 0, calls: 0, condFires: 0 };
  const countedSrc = new Set();

  let pos = { ...level.start };
  let idx = 0;
  const MAX_MOVES = 500;
  let moves = 0;

  const key = (p) => `${p.x},${p.y}`;
  const collect = (p) => {
    if (level.stars.some((s) => s.x === p.x && s.y === p.y) && !gotStars.has(key(p))) {
      gotStars.add(key(p));
      steps.push({ type: 'collect', at: { ...p }, item: 'star' });
    }
    if (level.coins.some((s) => s.x === p.x && s.y === p.y) && !gotCoins.has(key(p))) {
      gotCoins.add(key(p));
      steps.push({ type: 'collect', at: { ...p }, item: 'coin' });
    }
  };
  collect(pos);

  while (idx < flat.length) {
    const cmd = flat[idx++];
    counts.commands++;
    if (cmd.src && cmd.src.t === 'loop' && !countedSrc.has(cmd.src)) { counts.loops++; countedSrc.add(cmd.src); }
    if (cmd.src && cmd.src.t === 'call' && !countedSrc.has(cmd.src)) { counts.calls++; countedSrc.add(cmd.src); }
    let dir = cmd.d;
    steps.push({ type: 'command', d: dir, src: cmd.src });
    let movedAny = false;
    // roll until blocked
    for (;;) {
      const v = DIRS[dir];
      const nx = pos.x + v.x;
      const ny = pos.y + v.y;
      if (!walkable(level, nx, ny)) {
        steps.push({ type: 'blocked', at: { ...pos }, d: dir });
        break;
      }
      pos = { x: nx, y: ny };
      movedAny = true;
      steps.push({ type: 'move', to: { ...pos }, d: dir });
      if (++moves > MAX_MOVES) {
        steps.push({ type: 'fail', at: { ...pos }, reason: 'toolong' });
        return result(false, 'toolong');
      }
      collect(pos);
      if (pos.x === level.exit.x && pos.y === level.exit.y) {
        steps.push({ type: 'win', at: { ...pos } });
        return result(true, 'win');
      }
      const tile = level.tiles[pos.y][pos.x];
      if (tile.kind === 'color' && condMap[tile.color] && condMap[tile.color] !== dir) {
        dir = condMap[tile.color];
        counts.condFires++;
        steps.push({ type: 'turn', at: { ...pos }, d: dir, color: tile.color });
      }
    }
    void movedAny;
  }
  steps.push({ type: 'fail', at: { ...pos }, reason: 'out-of-commands' });
  return result(false, 'out-of-commands');

  function result(win, reason) {
    return { win, reason, steps, starsGot: gotStars.size, coinsGot: gotCoins.size, counts };
  }
}
