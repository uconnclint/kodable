# BLOOPTOPIA — UI Icon Art Spec

This document specifies every custom button/icon image for the game, ready to
feed into an image generator. Generate each as its own image, name the file
exactly as listed, and drop it into **`public/assets/ui/`**. The game loads
`/assets/ui/<name>.png` automatically and falls back to a placeholder emoji
until the file exists — so you can add art incrementally and reload to see it.

---

## Global art direction (paste this at the top of EVERY prompt)

> Flat-shaded low-poly 3D icon, rendered in the style of a modern mobile puzzle
> game. Chunky, rounded, toy-like geometry with clean flat facets (no gradients
> baked into the polys), soft global illumination, gentle ambient occlusion, one
> soft key light from the upper-left. Playful, candy-colored, kid-friendly.
> Centered single object, 3/4 top-down "hero" angle, small contact shadow.
> **Transparent background (PNG with alpha).** No text unless specified, no
> border, no frame, no drop-shadow bleeding to edges. Consistent scale and
> lighting across the whole set so the icons look like one family.

**Technical output**
- Format: PNG-24 with alpha (transparent background).
- Canvas: **512×512 px**, square, object centered, ~12% padding margin.
- Style must match the in-game 3D look: flat-shaded low-poly, matte surfaces,
  the palette below. Think "the 3D pieces in the game, rendered as icons."

**Master palette** (match the game so icons blend with the 3D scene)
| token | hex |
|---|---|
| purple (primary) | `#7c5cff` / deep `#5a3fd6` |
| pink | `#ff6fae` |
| blue | `#4db3ff` |
| green | `#58cc6d` |
| orange | `#ffa53d` |
| gold/coin | `#ffc93d` / shadow `#cf9b1d` |
| red | `#ff5c5c` |
| ink (outlines/eyes) | `#2a2440` |
| paper (light face) | `#ffffff` |

---

## 1. Core gameplay tokens (highest priority — these are the coding blocks)

**Status: superseded — do not generate these as PNGs.** These sit on the
command palette and inside the player's program (the highest-frequency glyphs
in the whole game), and the first-pass illustrated "gem" icons — while
on-brand — read as decoration rather than an unambiguous arrow: kids couldn't
tell direction at a glance. They're now drawn as a plain vector chevron+shaft
arrow directly in code (`dirArrowIcon()` in `src/ui/icons.js`), colored per
direction via CSS `currentColor` so it always matches the token's border. No
`dir-up/down/left/right.png` files are loaded or needed — leave this style
(illustrated gem) for other icons in this spec, not for direction arrows.

| file | subject | notes |
|---|---|---|
| `loop.png` | two circular-chasing arrows forming a **repeat/loop** ring | purple `#7c5cff`, low-poly, glossy |
| `function.png` | a **puzzle piece** block stamped/embossed with "F1" | blue `#4db3ff`; the only token allowed to carry text |

---

## 2. Primary action buttons

| file | subject | notes |
|---|---|---|
| `run.png` | a bold 3D **play triangle** | green `#58cc6d`, rounded corners, energetic |
| `preview.png` | a friendly **eye** OR a magnifying glass with a sparkle | blue `#4db3ff`; means "see what will happen" — must feel distinct from Run |
| `play.png` | 3D **play triangle** (menu Play button) | purple `#7c5cff`; can reuse the run shape in purple |
| `next.png` | **right chevron / forward arrow** | green `#58cc6d` |
| `replay.png` | a single **circular refresh arrow** | purple `#7c5cff` |
| `clear.png` | a little **broom** OR pencil eraser sweeping | soft neutral, friendly |
| `back.png` | a **left-pointing rounded arrow** (navigation back) | ink `#2a2440` on light, or purple |

---

## 3. HUD / chrome icons

| file | subject | notes |
|---|---|---|
| `coin.png` | a shiny **gold coin** with a subtle star or "B" (for Bloop) embossed | gold `#ffc93d`, rim shadow `#cf9b1d`; appears everywhere as currency |
| `star-filled.png` | a plump **5-point star**, lit | gold `#ffc93d`, glossy, tiny sparkle |
| `star-empty.png` | the **same star outline**, unlit/hollow | desaturated grey, matches filled star's silhouette exactly |
| `lock.png` | a chunky closed **padlock** | grey-blue, low-poly |
| `sound-on.png` | a **speaker** with sound waves | ink/neutral |
| `sound-off.png` | the **same speaker** with an X or a slash | ink/neutral; must match sound-on's speaker body |
| `trash.png` | a **trash can** (reset progress) | neutral grey; slightly cute, not scary |

---

## 4. Menu / section icons

| file | subject | notes |
|---|---|---|
| `bloop.png` | the **Bloop mascot face** — a round fuzzy low-poly ball creature with big friendly eyes and little spikes/fuzz | blue `#4db3ff` body (the starter Bloop "Blip"); this is the game's mascot, make it adorable |
| `trophy.png` | a classic **gold trophy cup** | gold `#ffc93d` |
| `badge.png` | a **medal / rosette** with a ribbon | gold + purple ribbon |
| `perfect.png` | a **"100" seal / gold rosette** meaning a perfect clear | gold + red ribbon, celebratory |
| `win.png` | a **party popper / confetti burst** | multicolor confetti, festive |
| `question.png` | a rounded **"?" mystery block** (locked achievement) | purple `#7c5cff`, matches the puzzle/token family |

---

## 5. World icons (shown on the world-select cards, ~46px)

Each represents a world's theme. Low-poly, sitting on a tiny matching ground tuft.

| file | world | subject | palette |
|---|---|---|---|
| `world-1.png` | Bloopberry Meadows | a **cherry-blossom flower** or berry sprig on grass | green + pink |
| `world-2.png` | Crystal Caverns | a glowing **purple crystal cluster** | purple `#7c5cff`, emissive |
| `world-3.png` | Loopy Canyon | a **swirling loop / spiral** over canyon rock | orange `#ffa53d` |
| `world-4.png` | Function Junction | a **puzzle piece** (or two interlocking) | blue `#4db3ff` |
| `world-5.png` | Bugstorm Peaks | a **storm cloud with lightning** over a dark peak | red `#ff5c5c` + storm grey |

---

## 6. Optional: achievement & badge medallions (phase 2)

There are 63 achievements and 22 badges that currently use emoji on their cards
(these are *content icons*, not buttons, so they're lower priority). Two options:

**Recommended — tier medallions (3 images, reused by tier):**
| file | subject |
|---|---|
| `medal-bronze.png` | round **bronze** medallion blank (with ribbon) |
| `medal-silver.png` | round **silver** medallion blank |
| `medal-gold.png` | round **gold** medallion blank |

Then we tint/stamp per achievement in code. Low effort, cohesive look.

**Or — full custom set:** generate one icon per achievement/badge (85 total). If
you go this route, tell me and I'll export the exact `id → name → description`
list so each prompt is tailored. Filenames would be `ach-<id>.png` / `badge-<id>.png`.

> Until these exist, achievement/badge cards keep their emoji — the game is fully
> playable without them.

---

## Status: DELIVERED ✓

All 34 icons above (31 core + 3 tier medallions) were generated and are live in
`public/assets/ui/`. Achievement cards now use `medal-<tier>.png`, badge cards
use `badge.png`, and unlock toasts use the medallions — the whole UI is
emoji-free. The results-modal "back to levels" button reuses `back.png` (no
separate `map` asset needed). If per-achievement/per-badge unique art is wanted
later (85 images for full variety instead of the 3 reused medals), ask for the
`id → name` export.

**Update:** the 4 direction-arrow PNGs (`dir-up/down/left/right.png`) were
replaced by a code-drawn vector arrow — see the note in section 1 above. The
PNG files still sit unused in `public/assets/ui/`; harmless to keep or delete.

## Integration checklist (for whoever wires it up after art is generated)

1. Save each PNG into `public/assets/ui/` with the exact filename above.
2. Reload — icons appear automatically (no code change; see `src/ui/icons.js`).
3. If you add the tier medallions, update `renderAchievements`/`renderBadges`
   in `src/ui/screens.js` to map `a.tier → medal-<tier>.png`.
4. Sizes are handled by CSS (`.ui-icon` rules in `src/style.css`); the source
   art just needs to be square with transparent padding.

## Full filename list (copy/paste)

```
loop  function
run  preview  play  next  replay  clear  back
coin  star-filled  star-empty  lock  sound-on  sound-off  trash
bloop  trophy  badge  perfect  win  question
world-1  world-2  world-3  world-4  world-5
(optional) medal-bronze  medal-silver  medal-gold
```
