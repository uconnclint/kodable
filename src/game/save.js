// Persistent game state, coin economy, stats, and unlock checking.
import { achievements } from './achievements.js';
import { badges } from './badges.js';

const KEY = 'blooptopia-save-v1';

const defaultState = () => ({
  coins: 0,
  stars: {},        // levelId -> best 0..3
  completed: {},    // levelId -> true
  perfect: {},      // levelId -> true (3 stars AND main <= parCommands)
  attempted: {},    // levelId -> true (had at least one run)
  unlockedChars: ['blip'],
  currentChar: 'blip',
  achievementsUnlocked: {},
  badgesEarned: {},
  stats: {
    levelsCompleted: 0,
    totalStars: 0,
    perfectLevels: 0,
    coinsEarned: 0,
    coinsSpent: 0,
    worldsCompleted: [false, false, false, false, false],
    worldsPerfected: [false, false, false, false, false],
    runs: 0,
    fails: 0,
    commandsUsed: 0,
    loopsUsed: 0,
    functionCalls: 0,
    conditionsFired: 0,
    starsCollectedLifetime: 0,
    charactersOwned: 1,
    firstTryWins: 0,
    noFailStreakBest: 0,
  },
  streak: 0,
});

export let state = load();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultState();
    const s = { ...defaultState(), ...JSON.parse(raw) };
    s.stats = { ...defaultState().stats, ...s.stats };
    return s;
  } catch {
    return defaultState();
  }
}

export function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* full/blocked */ }
}

export function resetAll() {
  state = defaultState();
  save();
}

function addCoins(n) {
  state.coins += n;
  state.stats.coinsEarned += n;
}

export function spendCoins(n) {
  if (state.coins < n) return false;
  state.coins -= n;
  state.stats.coinsSpent += n;
  return true;
}

// Rewards
export const REWARDS = {
  firstComplete: 10,
  perStarFirstTime: 5,
  perfectBonus: 10,
  replayWin: 5,
  coinPickup: 2,
};

// Called after every run. `level` is the level object, `res` is runProgram's
// result, `program` the player's program. Returns a summary for the results UI.
export function recordRun(level, res, program, allLevels) {
  const st = state.stats;
  st.runs++;
  st.commandsUsed += res.counts.commands;
  st.loopsUsed += res.counts.loops;
  st.functionCalls += res.counts.calls;
  st.conditionsFired += res.counts.condFires;

  const firstAttempt = !state.attempted[level.id];
  state.attempted[level.id] = true;

  const summary = { win: res.win, stars: res.starsGot, coins: 0, newBest: false, perfect: false };

  if (!res.win) {
    st.fails++;
    state.streak = 0;
    save();
    return summary;
  }

  state.streak++;
  st.noFailStreakBest = Math.max(st.noFailStreakBest, state.streak);
  if (firstAttempt) st.firstTryWins++;

  st.starsCollectedLifetime += res.starsGot;

  const prevStars = state.stars[level.id] || 0;
  const firstComplete = !state.completed[level.id];
  state.completed[level.id] = true;

  let coins = res.coinsGot * REWARDS.coinPickup;
  if (firstComplete) coins += REWARDS.firstComplete;
  else coins += REWARDS.replayWin;
  if (res.starsGot > prevStars) {
    coins += (res.starsGot - prevStars) * REWARDS.perStarFirstTime;
    state.stars[level.id] = res.starsGot;
    summary.newBest = true;
  }

  const isPerfect = res.starsGot === 3 && program.main.length <= level.parCommands;
  if (isPerfect && !state.perfect[level.id]) {
    state.perfect[level.id] = true;
    coins += REWARDS.perfectBonus;
    summary.perfect = true;
  }

  addCoins(coins);
  summary.coins = coins;

  // Recompute aggregates
  st.levelsCompleted = Object.keys(state.completed).length;
  st.totalStars = Object.values(state.stars).reduce((a, b) => a + b, 0);
  st.perfectLevels = Object.keys(state.perfect).length;
  for (let w = 1; w <= 5; w++) {
    const wl = allLevels.filter((l) => l.world === w);
    st.worldsCompleted[w - 1] = wl.length > 0 && wl.every((l) => state.completed[l.id]);
    st.worldsPerfected[w - 1] = wl.length > 0 && wl.every((l) => (state.stars[l.id] || 0) === 3);
  }

  save();
  return summary;
}

export function buyCharacter(char) {
  if (state.unlockedChars.includes(char.id)) return false;
  if (!spendCoins(char.cost)) return false;
  state.unlockedChars.push(char.id);
  state.stats.charactersOwned = state.unlockedChars.length;
  save();
  return true;
}

export function selectCharacter(id) {
  if (!state.unlockedChars.includes(id)) return;
  state.currentChar = id;
  save();
}

// Checks achievements + badges against current stats; grants rewards.
// Returns [{kind:'achievement'|'badge', item}] newly unlocked, for toasts.
export function checkUnlocks() {
  const fresh = [];
  for (const a of achievements) {
    if (state.achievementsUnlocked[a.id]) continue;
    let ok = false;
    try { ok = !!a.check(state.stats); } catch { ok = false; }
    if (ok) {
      state.achievementsUnlocked[a.id] = true;
      addCoins(a.coins);
      fresh.push({ kind: 'achievement', item: a });
    }
  }
  for (const b of badges) {
    if (state.badgesEarned[b.id]) continue;
    let ok = false;
    try { ok = !!b.check(state.stats); } catch { ok = false; }
    if (ok) {
      state.badgesEarned[b.id] = true;
      fresh.push({ kind: 'badge', item: b });
    }
  }
  if (fresh.length) save();
  return fresh;
}

// World N is unlocked when world N-1 has >= 9 completed levels.
export function worldUnlocked(w, allLevels) {
  if (w === 1) return true;
  const prev = allLevels.filter((l) => l.world === w - 1);
  const done = prev.filter((l) => state.completed[l.id]).length;
  return done >= 9;
}

// Level unlocked when the previous level in its world is completed.
export function levelUnlocked(level, allLevels) {
  if (level.index === 1) return true;
  const prev = allLevels.find((l) => l.world === level.world && l.index === level.index - 1);
  return !!(prev && state.completed[prev.id]);
}
