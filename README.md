# 🟣 Blooptopia 3D

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
