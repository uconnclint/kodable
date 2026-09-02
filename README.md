# 🟣 Blooptopia 3D

Copyright (c) 2026 Clint McLeod. All rights reserved.

A AAA-styled, flat-shaded low-poly **3D coding adventure for kids** — you
pre-program a bouncy ball hero (a Bloop!) with direction commands, color
conditions, loops, and functions to roll through floating-island mazes,
collecting stars and coins.

Built with **Three.js + Vite**, vanilla ES modules, zero asset files (all audio
is synthesized WebAudio, all models are procedural geometry).

## Play

```bash
npm install
npm run dev        # then open http://localhost:5173
```

## What's inside

| | |
|---|---|
| **60 levels** | 5 worlds × 12: Bloopberry Meadows (sequences), Crystal Caverns (color conditions), Loopy Canyon (loops), Function Junction (functions), Bugstorm Peaks (mastery) |
| **63 achievements** | bronze/silver/gold tiers with coin rewards |
| **22 badges** | prestigious world & mastery emblems |
| **16 characters** | procedural bloop balls with 12 accessories & 6 eye styles, bought with coins |
| **3-star scoring** | plus PERFECT clears for beating par command counts |
| **Preview mode** | a non-scored dry run that draws the predicted path and tells kids whether their code reaches the goal — before they commit to Run |
| **Per-world themes** | terrain palettes, decorations, and generative music tracks |

## Custom art

All UI/button icons load from `public/assets/ui/<name>.png` and fall back to
emoji until the art is added — so the game runs today and gets a custom-art
glow-up the moment PNGs are dropped in. The full generator-ready spec (prompts,
filenames, palette) is in [`docs/ART_SPEC.md`](docs/ART_SPEC.md); the icon
loader is `src/ui/icons.js`.

Progress persists in localStorage. World N unlocks after 9 levels of world N-1;
levels unlock sequentially.

## How movement works

Each direction command rolls Bloop until it hits an edge. Color conditions
(`if pink → down`) fire every time Bloop enters a matching tile. Loops repeat a
sub-sequence 2–5×; the function F1 is a reusable move set callable from the
main program. Reaching the portal wins; stars are collected en route.

## Tooling

```bash
npm run validate   # proves every level's solution wins with all 3 stars
node tools/simulate.js  # simulates a full playthrough: all levels, economy,
                        # achievement/badge reachability, character affordability
npm run build      # production build
```

Levels live in `src/game/levels/world*.js` — see `docs/SPEC.md` for the full
data format if you want to add your own.

## Deploying

**Always publish the contents of `dist/`, never the repo root.** The root
`index.html` is the Vite dev entry: it points at `/src/main.js`, whose
`import 'three'` is a bare specifier that only the dev server can resolve. Serve
it as static files and every browser dies with
`Module name, 'three' does not resolve to a valid URL` — a blank screen.

On Cloudflare Pages, the project's build configuration must be:

| Setting | Value |
|---|---|
| Build command | `npm run build` |
| Output directory | `dist` |

`.node-version` pins Node to 22.12, the minimum Vite 8 accepts; without it the
Pages default image can be too old and the build fails.

### Browser support

School iPads and Chromebooks are the target, and many are frozen on old OS
releases, so `vite.config.js` pins the build down to ES2019 rather than Vite's
default `ios16.4` baseline. Do not remove that target: three.js ships class
static blocks that iPadOS below 16.4 cannot even parse, which fails silently as
a blank screen. The real floor is **iPadOS 15 / Chrome 56**, set by three.js
requiring WebGL2.

If the game ever fails to start, it now shows a readable card naming the cause
and the device, instead of a blank screen — see the boot watchdog at the bottom
of `index.html`.
