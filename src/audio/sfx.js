// src/audio/sfx.js
// Fully self-contained WebAudio audio module for Blooptopia 3D.
// Everything is synthesized — no audio asset files.
//
// Signal graph:
//   [oscillators / sfx / music] -> masterGain -> compressor -> destination
//
// All AudioContext usage is lazy (inside functions) so this module imports
// cleanly in Node where AudioContext is undefined. Calling playSfx/startMusic
// etc. before initAudio() is safe (no-op, never throws).

const MUTE_KEY = 'blooptopia-muted';

// ---- module-level state (all null until initAudio runs) --------------------
let ctx = null;             // AudioContext
let masterGain = null;      // master volume / mute node
let compressor = null;      // safety limiter before destination
let musicGain = null;       // sub-mix for generative music
let initialized = false;

let muted = readMutedFromStorage();

// music scheduler state
let musicWorld = -1;
let musicTimer = null;      // setInterval handle (lookahead scheduler)
let nextNoteTime = 0;       // ctx time of next step to schedule
let musicStep = 0;          // running step counter

// -------------------------------------------------------------------------
// storage helpers (localStorage is the only DOM access permitted)
// -------------------------------------------------------------------------
function readMutedFromStorage() {
  try {
    return (typeof localStorage !== 'undefined') &&
           localStorage.getItem(MUTE_KEY) === 'true';
  } catch (_) {
    return false;
  }
}

function writeMutedToStorage(val) {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(MUTE_KEY, val ? 'true' : 'false');
    }
  } catch (_) { /* ignore quota / privacy errors */ }
}

// -------------------------------------------------------------------------
// init / lifecycle
// -------------------------------------------------------------------------

/**
 * Lazily create/resume the AudioContext. Safe to call from a click handler
 * and safe to call repeatedly (guarded).
 */
export function initAudio() {
  const AC = (typeof globalThis !== 'undefined') &&
             (globalThis.AudioContext || globalThis.webkitAudioContext);
  if (!AC) return; // no WebAudio (e.g. Node) — stay a silent no-op module

  if (!initialized) {
    try {
      ctx = new AC();
    } catch (_) {
      ctx = null;
      return;
    }

    compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.knee.value = 24;
    compressor.ratio.value = 12;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.25;
    compressor.connect(ctx.destination);

    masterGain = ctx.createGain();
    masterGain.gain.value = muted ? 0 : 1;
    masterGain.connect(compressor);

    musicGain = ctx.createGain();
    musicGain.gain.value = 0.0; // ramped up when music starts
    musicGain.connect(masterGain);

    initialized = true;
  }

  // Handle the autoplay policy: contexts start "suspended" until a gesture.
  if (ctx && ctx.state === 'suspended') {
    ctx.resume().catch(() => {});
  }
}

// convenience: is the graph live and audible-capable?
function ready() {
  return initialized && ctx && masterGain;
}

// -------------------------------------------------------------------------
// low-level synth voice
// -------------------------------------------------------------------------

/**
 * Play a single enveloped oscillator "blip".
 * @param {Object} o
 *   type   oscillator type ('sine'|'triangle'|'square'|'sawtooth')
 *   freq   start frequency (Hz)
 *   freqTo optional end frequency for a linear pitch glide
 *   t0     start time offset from now (s)
 *   dur    duration (s)
 *   peak   peak gain (kept gentle, ~<=0.15)
 *   attack attack time (s)
 *   dest   destination node (defaults to masterGain)
 *   glide  'exp'|'lin' pitch curve when freqTo set (default 'exp')
 */
function blip(o) {
  if (!ready()) return;
  const now = ctx.currentTime;
  const start = now + (o.t0 || 0);
  const dur = o.dur == null ? 0.15 : o.dur;
  const end = start + dur;
  const peak = o.peak == null ? 0.12 : o.peak;
  const attack = o.attack == null ? 0.008 : o.attack;
  const dest = o.dest || masterGain;

  const osc = ctx.createOscillator();
  osc.type = o.type || 'sine';

  const f0 = o.freq;
  osc.frequency.setValueAtTime(f0, start);
  if (o.freqTo != null && o.freqTo !== f0) {
    if (o.glide === 'lin') {
      osc.frequency.linearRampToValueAtTime(o.freqTo, end);
    } else {
      // exponentialRamp requires strictly positive targets
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.freqTo), end);
    }
  }

  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), start + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, end);

  osc.connect(g);
  g.connect(dest);
  osc.start(start);
  osc.stop(end + 0.02);

  // let GC reclaim after it finishes
  osc.onended = () => {
    try { osc.disconnect(); g.disconnect(); } catch (_) {}
  };
}

/**
 * A short filtered noise burst (for pops / whooshes / sparkle tails).
 */
function noise(o) {
  if (!ready()) return;
  const now = ctx.currentTime;
  const start = now + (o.t0 || 0);
  const dur = o.dur == null ? 0.12 : o.dur;
  const peak = o.peak == null ? 0.08 : o.peak;
  const dest = o.dest || masterGain;

  const frames = Math.max(1, Math.floor(ctx.sampleRate * dur));
  const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;

  const src = ctx.createBufferSource();
  src.buffer = buf;

  const filt = ctx.createBiquadFilter();
  filt.type = o.filter || 'bandpass';
  filt.frequency.setValueAtTime(o.freq == null ? 1200 : o.freq, start);
  if (o.freqTo != null) {
    filt.frequency.exponentialRampToValueAtTime(Math.max(1, o.freqTo), start + dur);
  }
  filt.Q.value = o.q == null ? 1 : o.q;

  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), start + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);

  src.connect(filt);
  filt.connect(g);
  g.connect(dest);
  src.start(start);
  src.stop(start + dur + 0.02);
  src.onended = () => {
    try { src.disconnect(); filt.disconnect(); g.disconnect(); } catch (_) {}
  };
}

// -------------------------------------------------------------------------
// SFX definitions
// -------------------------------------------------------------------------

// Each entry is a function that fires its voices immediately.
const SFX = {
  // Neutral UI tick — soft high triangle blip.
  ui() {
    blip({ type: 'triangle', freq: 880, dur: 0.06, peak: 0.07, attack: 0.004 });
  },

  // Selecting a command/palette item — bright rising two-step.
  select() {
    blip({ type: 'square', freq: 660, freqTo: 990, dur: 0.09, peak: 0.06 });
  },

  // Placing a block into the program — satisfying low "thunk" up-tick.
  place() {
    blip({ type: 'triangle', freq: 300, freqTo: 460, dur: 0.1, peak: 0.11, glide: 'lin' });
    blip({ type: 'sine', freq: 600, dur: 0.05, peak: 0.05, t0: 0.005 });
  },

  // Removing a block — reverse of place, downward.
  remove() {
    blip({ type: 'triangle', freq: 460, freqTo: 240, dur: 0.11, peak: 0.1, glide: 'lin' });
  },

  // Pressing RUN — cheerful ascending triad kickoff.
  run() {
    blip({ type: 'square', freq: 523.25, dur: 0.08, peak: 0.06, t0: 0.0 });   // C5
    blip({ type: 'square', freq: 659.25, dur: 0.08, peak: 0.06, t0: 0.07 });  // E5
    blip({ type: 'square', freq: 783.99, dur: 0.12, peak: 0.07, t0: 0.14 });  // G5
  },

  // Bloop rolling one tile — very soft short mid blip (played often, keep tiny).
  roll() {
    blip({ type: 'sine', freq: 420, freqTo: 480, dur: 0.05, peak: 0.045 });
  },

  // Direction change / condition fires — quick blip + tiny airy noise.
  turn() {
    blip({ type: 'triangle', freq: 540, freqTo: 720, dur: 0.07, peak: 0.06 });
    noise({ filter: 'highpass', freq: 2500, dur: 0.05, peak: 0.02 });
  },

  // Collect a coin — classic two-note "pop-ding".
  coin() {
    blip({ type: 'square', freq: 988, dur: 0.06, peak: 0.08 });         // B5
    blip({ type: 'square', freq: 1318.5, dur: 0.12, peak: 0.09, t0: 0.05 }); // E6
  },

  // Collect a star — shimmering rising sparkle arpeggio + airy tail.
  star() {
    const notes = [659.25, 987.77, 1318.51, 1760]; // E5 B5 E6 A6
    notes.forEach((f, i) => {
      blip({ type: 'triangle', freq: f, dur: 0.14, peak: 0.07, t0: i * 0.05 });
    });
    noise({ filter: 'highpass', freq: 6000, dur: 0.25, peak: 0.025, t0: 0.05 });
  },

  // Level win — happy ascending major arpeggio flourish.
  win() {
    const seq = [523.25, 659.25, 783.99, 1046.5, 1318.51]; // C E G C6 E6
    seq.forEach((f, i) => {
      blip({ type: 'square', freq: f, dur: 0.18, peak: 0.08, t0: i * 0.09 });
      blip({ type: 'triangle', freq: f * 2, dur: 0.14, peak: 0.03, t0: i * 0.09 });
    });
  },

  // Fail — gentle descending "wah-wah", not harsh.
  fail() {
    blip({ type: 'sawtooth', freq: 392, freqTo: 349.23, dur: 0.22, peak: 0.07, glide: 'lin' }); // G->F
    blip({ type: 'sawtooth', freq: 349.23, freqTo: 293.66, dur: 0.3, peak: 0.07, t0: 0.2, glide: 'lin' }); // F->D
  },

  // Unlock (new level/character) — bright three-note rising sparkle.
  unlock() {
    const seq = [587.33, 880, 1174.66]; // D5 A5 D6
    seq.forEach((f, i) => {
      blip({ type: 'triangle', freq: f, dur: 0.16, peak: 0.08, t0: i * 0.08 });
    });
    noise({ filter: 'highpass', freq: 5000, dur: 0.2, peak: 0.02, t0: 0.16 });
  },

  // Achievement earned — triumphant little fanfare arpeggio (major 6th flavor).
  achievement() {
    const seq = [523.25, 659.25, 783.99, 880, 1046.5]; // C E G A C6
    seq.forEach((f, i) => {
      blip({ type: 'square', freq: f, dur: 0.16, peak: 0.075, t0: i * 0.08 });
      blip({ type: 'sine', freq: f * 2, dur: 0.12, peak: 0.025, t0: i * 0.08 });
    });
  },

  // Buy in shop — friendly "cha-ching" up-blip + coin sparkle.
  buy() {
    blip({ type: 'square', freq: 784, dur: 0.07, peak: 0.07 });
    blip({ type: 'square', freq: 1046.5, dur: 0.14, peak: 0.08, t0: 0.06 });
    noise({ filter: 'highpass', freq: 4000, dur: 0.12, peak: 0.02, t0: 0.06 });
  },

  // Whoosh — airy filtered-noise sweep (transitions / character trail burst).
  whoosh() {
    noise({ filter: 'bandpass', freq: 400, freqTo: 3000, dur: 0.28, peak: 0.06, q: 0.7 });
  }
};

/**
 * Play a named short SFX. Unknown names and pre-init calls are silent no-ops.
 */
export function playSfx(name) {
  if (!ready()) return;      // safe before initAudio()
  const fn = SFX[name];
  if (!fn) return;           // unknown name → no-op
  try { fn(); } catch (_) { /* never throw from audio */ }
}

// -------------------------------------------------------------------------
// Generative music
// -------------------------------------------------------------------------
//
// A simple lookahead scheduler (setInterval polls; notes queued slightly
// ahead on the audio clock for glitch-free timing). Each world has its own
// scale, tempo, mood and instrument character.

// note-name-free: frequencies via semitone offsets from a root.
function midiToFreq(m) {
  return 440 * Math.pow(2, (m - 69) / 12);
}

// World music configs. `scale` = semitone degrees over the root octave.
// root is a MIDI note. bassRoot is an octave (or two) lower.
const WORLDS = {
  // 0 — Menu: dreamy, floaty, slow. Lydian-ish major with a raised 4th.
  0: {
    bpm: 76, root: 62, // D
    scale: [0, 2, 4, 6, 7, 9, 11],
    lead: 'sine', bass: 'sine',
    leadPeak: 0.05, bassPeak: 0.05,
    density: 0.45, octaveSpread: 2, bassMul: 0.9
  },
  // 1 — Bloopberry Meadows: sunny major pentatonic, easy bounce.
  1: {
    bpm: 104, root: 60, // C
    scale: [0, 2, 4, 7, 9],
    lead: 'triangle', bass: 'triangle',
    leadPeak: 0.055, bassPeak: 0.055,
    density: 0.6, octaveSpread: 2, bassMul: 1.0
  },
  // 2 — Crystal Caverns: mysterious natural minor, sparse and echoey.
  2: {
    bpm: 84, root: 57, // A
    scale: [0, 2, 3, 5, 7, 8, 10],
    lead: 'sine', bass: 'triangle',
    leadPeak: 0.05, bassPeak: 0.055,
    density: 0.42, octaveSpread: 2, bassMul: 1.0
  },
  // 3 — Loopy Canyon: bouncy Mixolydian, brisk & playful.
  3: {
    bpm: 120, root: 67, // G
    scale: [0, 2, 4, 5, 7, 9, 10],
    lead: 'square', bass: 'triangle',
    leadPeak: 0.04, bassPeak: 0.06,
    density: 0.68, octaveSpread: 2, bassMul: 1.0
  },
  // 4 — Function Junction: quirky Dorian, syncopated & curious.
  4: {
    bpm: 112, root: 62, // D
    scale: [0, 2, 3, 5, 7, 9, 10],
    lead: 'square', bass: 'square',
    leadPeak: 0.038, bassPeak: 0.05,
    density: 0.6, octaveSpread: 2, bassMul: 1.0
  },
  // 5 — Bugstorm Peaks: epic/tense harmonic minor, driving.
  5: {
    bpm: 132, root: 55, // G (low)
    scale: [0, 2, 3, 5, 7, 8, 11],
    lead: 'sawtooth', bass: 'sawtooth',
    leadPeak: 0.035, bassPeak: 0.06,
    density: 0.72, octaveSpread: 2, bassMul: 1.0
  }
};

function worldCfg(world) {
  const w = (world | 0);
  return WORLDS[w] || WORLDS[0];
}

// pick a scale-degree frequency, `octave` octaves above root
function scaleFreq(cfg, degree, octave) {
  const semis = cfg.scale[((degree % cfg.scale.length) + cfg.scale.length) % cfg.scale.length];
  return midiToFreq(cfg.root + semis + 12 * octave);
}

// The lookahead scheduler tick.
const LOOKAHEAD_MS = 60;     // how often we wake up
const SCHEDULE_AHEAD = 0.2;  // seconds of audio to pre-queue

function scheduleMusic() {
  if (!ready() || musicWorld < 0) return;
  const cfg = worldCfg(musicWorld);
  const stepDur = 60 / cfg.bpm / 2; // eighth notes

  while (nextNoteTime < ctx.currentTime + SCHEDULE_AHEAD) {
    emitStep(cfg, musicStep, nextNoteTime, stepDur);
    musicStep++;
    nextNoteTime += stepDur;
  }
}

// Emit the notes for one eighth-note step at absolute audio time `when`.
function emitStep(cfg, step, when, stepDur) {
  const barPos = step % 16;   // 16 eighth-notes = 2 bars phrase

  // --- Bass: root/fifth on strong beats, one octave-ish below lead. -------
  if (barPos % 4 === 0) {
    // alternate root and fifth across the phrase for gentle motion
    const bassDeg = (Math.floor(step / 4) % 2 === 0) ? 0 : 4;
    const f = scaleFreq(cfg, bassDeg, -1) * cfg.bassMul;
    musicNote({
      type: cfg.bass, freq: f, when, dur: stepDur * 3.2,
      peak: cfg.bassPeak, attack: 0.02
    });
  }

  // --- Lead: pseudo-random walk over the scale, gated by density. ---------
  // Deterministic-ish but lively pseudo-noise from the step index.
  const r = frac(Math.sin((step + 1) * 12.9898 + musicWorld * 78.233) * 43758.5453);
  if (r < cfg.density) {
    // choose a degree with a wandering melodic contour
    const contour = [0, 2, 4, 2, 5, 4, 2, 1, 3, 5, 6, 4, 2, 4, 1, 0];
    const deg = contour[barPos] + (r > 0.75 ? 7 : 0); // occasional octave lift
    const octave = 1 + (deg >= 7 ? 1 : 0);
    const f = scaleFreq(cfg, deg, octave);
    musicNote({
      type: cfg.lead, freq: f, when,
      dur: stepDur * (r > 0.6 ? 1.6 : 0.9),
      peak: cfg.leadPeak, attack: 0.01
    });
    // sparkle harmony every so often (a soft octave shimmer)
    if (r > 0.85) {
      musicNote({
        type: 'sine', freq: f * 2, when,
        dur: stepDur * 0.8, peak: cfg.leadPeak * 0.4, attack: 0.01
      });
    }
  }
}

// fractional part helper
function frac(x) { return x - Math.floor(x); }

// A single scheduled music note routed through musicGain (its own sub-mix).
function musicNote(o) {
  if (!ready()) return;
  const start = o.when;
  const dur = o.dur;
  const end = start + dur;

  const osc = ctx.createOscillator();
  osc.type = o.type || 'sine';
  osc.frequency.setValueAtTime(o.freq, start);

  const g = ctx.createGain();
  const attack = o.attack == null ? 0.01 : o.attack;
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, o.peak), start + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, end);

  osc.connect(g);
  g.connect(musicGain);
  osc.start(start);
  osc.stop(end + 0.03);
  osc.onended = () => {
    try { osc.disconnect(); g.disconnect(); } catch (_) {}
  };
}

/**
 * Start (or switch to) the generative loop for a world (0=menu, 1–5 levels).
 * Calling while already playing cross-switches cleanly to the new track.
 */
export function startMusic(world) {
  initAudio();               // ensure graph exists; safe if already up
  if (!ready()) return;      // no WebAudio (Node) — silent no-op

  const w = (world | 0);

  // Already playing this exact world? nothing to do.
  if (musicTimer !== null && musicWorld === w) return;

  // Stop any current loop first (clean switch).
  if (musicTimer !== null) {
    clearInterval(musicTimer);
    musicTimer = null;
  }

  musicWorld = w;
  musicStep = 0;
  // start scheduling a hair into the future for headroom
  nextNoteTime = ctx.currentTime + 0.06;

  // gentle fade-in of the music sub-mix to the target quiet level (~-18 dB)
  const now = ctx.currentTime;
  musicGain.gain.cancelScheduledValues(now);
  musicGain.gain.setValueAtTime(Math.max(0.0001, musicGain.gain.value), now);
  musicGain.gain.linearRampToValueAtTime(1.0, now + 0.6);

  scheduleMusic(); // prime immediately
  musicTimer = setInterval(scheduleMusic, LOOKAHEAD_MS);
}

/**
 * Stop the generative music loop (with a short fade-out).
 */
export function stopMusic() {
  if (musicTimer !== null) {
    clearInterval(musicTimer);
    musicTimer = null;
  }
  musicWorld = -1;
  if (ready() && musicGain) {
    const now = ctx.currentTime;
    musicGain.gain.cancelScheduledValues(now);
    musicGain.gain.setValueAtTime(Math.max(0.0001, musicGain.gain.value), now);
    musicGain.gain.linearRampToValueAtTime(0.0001, now + 0.35);
  }
}

// -------------------------------------------------------------------------
// Mute
// -------------------------------------------------------------------------

/**
 * Master mute/unmute via the master GainNode. Persisted to localStorage.
 */
export function setMuted(val) {
  muted = !!val;
  writeMutedToStorage(muted);
  if (ready()) {
    const now = ctx.currentTime;
    masterGain.gain.cancelScheduledValues(now);
    masterGain.gain.setValueAtTime(masterGain.gain.value, now);
    masterGain.gain.linearRampToValueAtTime(muted ? 0 : 1, now + 0.04);
  }
}

/**
 * Current mute state (reflects persisted value even before initAudio).
 */
export function isMuted() {
  return muted;
}
