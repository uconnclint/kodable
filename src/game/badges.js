// Blooptopia 3D — Badges
// Prestigious emblems: { id, name, desc, icon, check(stats) }
// icon = single emoji, distinct across all badges.
// check is a PURE function of the stats object (see docs/SPEC.md "Stats object").

export const badges = [
  // ── One per world completed ───────────────────────────────────────
  {
    id: 'badge-meadows-cleared',
    name: 'Meadows Emblem',
    desc: 'Cleared all of Bloopberry Meadows.',
    icon: '🌾',
    check: (s) => s.worldsCompleted[0] === true,
  },
  {
    id: 'badge-caverns-cleared',
    name: 'Caverns Emblem',
    desc: 'Cleared all of Crystal Caverns.',
    icon: '🪨',
    check: (s) => s.worldsCompleted[1] === true,
  },
  {
    id: 'badge-canyon-cleared',
    name: 'Canyon Emblem',
    desc: 'Cleared all of Loopy Canyon.',
    icon: '🏜️',
    check: (s) => s.worldsCompleted[2] === true,
  },
  {
    id: 'badge-junction-cleared',
    name: 'Junction Emblem',
    desc: 'Cleared all of Function Junction.',
    icon: '🚏',
    check: (s) => s.worldsCompleted[3] === true,
  },
  {
    id: 'badge-peaks-cleared',
    name: 'Peaks Emblem',
    desc: 'Cleared all of Bugstorm Peaks.',
    icon: '🗻',
    check: (s) => s.worldsCompleted[4] === true,
  },

  // ── One per world perfected ───────────────────────────────────────
  {
    id: 'badge-meadows-perfect',
    name: 'Meadows Crown',
    desc: 'Three-starred every level of Bloopberry Meadows.',
    icon: '🌸',
    check: (s) => s.worldsPerfected[0] === true,
  },
  {
    id: 'badge-caverns-perfect',
    name: 'Caverns Crown',
    desc: 'Three-starred every level of Crystal Caverns.',
    icon: '💎',
    check: (s) => s.worldsPerfected[1] === true,
  },
  {
    id: 'badge-canyon-perfect',
    name: 'Canyon Crown',
    desc: 'Three-starred every level of Loopy Canyon.',
    icon: '🌵',
    check: (s) => s.worldsPerfected[2] === true,
  },
  {
    id: 'badge-junction-perfect',
    name: 'Junction Crown',
    desc: 'Three-starred every level of Function Junction.',
    icon: '🚂',
    check: (s) => s.worldsPerfected[3] === true,
  },
  {
    id: 'badge-peaks-perfect',
    name: 'Peaks Crown',
    desc: 'Three-starred every level of Bugstorm Peaks.',
    icon: '❄️',
    check: (s) => s.worldsPerfected[4] === true,
  },

  // ── Grand milestones ──────────────────────────────────────────────
  {
    id: 'badge-all-stars',
    name: 'All Stars',
    desc: 'Collected every star in Blooptopia — all 180.',
    icon: '🌌',
    check: (s) => s.totalStars >= 180,
  },
  {
    id: 'badge-completionist',
    name: 'Completionist',
    desc: 'Completed all 60 levels.',
    icon: '🗺️',
    check: (s) => s.levelsCompleted >= 60,
  },
  {
    id: 'badge-perfectionist',
    name: 'Perfectionist',
    desc: 'Perfect-cleared all 60 levels.',
    icon: '👑',
    check: (s) => s.perfectLevels >= 60,
  },
  {
    id: 'badge-collector',
    name: 'Collector',
    desc: 'Owns all 16 bloopy characters.',
    icon: '🎭',
    check: (s) => s.charactersOwned >= 16,
  },

  // ── Creative mastery ──────────────────────────────────────────────
  {
    id: 'badge-command-virtuoso',
    name: 'Command Virtuoso',
    desc: 'Executed 1,000 direction commands.',
    icon: '🎮',
    check: (s) => s.commandsUsed >= 1000,
  },
  {
    id: 'badge-loop-lord',
    name: 'Loop Lord',
    desc: 'Ran 100 loop blocks.',
    icon: '🌀',
    check: (s) => s.loopsUsed >= 100,
  },
  {
    id: 'badge-condition-conjurer',
    name: 'Condition Conjurer',
    desc: 'Triggered 100 color conditions.',
    icon: '🌈',
    check: (s) => s.conditionsFired >= 100,
  },
  {
    id: 'badge-function-forger',
    name: 'Function Forger',
    desc: 'Called function F1 100 times.',
    icon: '🧩',
    check: (s) => s.functionCalls >= 100,
  },
  {
    id: 'badge-first-try-hero',
    name: 'First-Try Hero',
    desc: 'Won 50 levels on the very first try.',
    icon: '🦸',
    check: (s) => s.firstTryWins >= 50,
  },
  {
    id: 'badge-streak-sovereign',
    name: 'Streak Sovereign',
    desc: 'Won 20 runs in a row without a fail.',
    icon: '🏆',
    check: (s) => s.noFailStreakBest >= 20,
  },

  // ── Extra prestige ────────────────────────────────────────────────
  {
    id: 'badge-coin-baron',
    name: 'Coin Baron',
    desc: 'Earned 5,000 coins in your Blooptopia career.',
    icon: '💰',
    check: (s) => s.coinsEarned >= 5000,
  },
  {
    id: 'badge-grand-champion',
    name: 'Grand Champion',
    desc: 'Cleared every world in Blooptopia.',
    icon: '🎖️',
    check: (s) =>
      s.worldsCompleted[0] === true &&
      s.worldsCompleted[1] === true &&
      s.worldsCompleted[2] === true &&
      s.worldsCompleted[3] === true &&
      s.worldsCompleted[4] === true,
  },
];
