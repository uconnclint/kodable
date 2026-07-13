from __future__ import annotations

import math
import os
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "public" / "assets" / "ui"
SIZE = 512
SCALE = 4

COLORS = {
    "purple": "#7c5cff",
    "purple_deep": "#5a3fd6",
    "pink": "#ff6fae",
    "blue": "#4db3ff",
    "green": "#58cc6d",
    "orange": "#ffa53d",
    "gold": "#ffc93d",
    "gold_shadow": "#cf9b1d",
    "red": "#ff5c5c",
    "ink": "#2a2440",
    "paper": "#ffffff",
    "grey": "#94a3b8",
    "grey_dark": "#64748b",
    "grey_light": "#d9e2ef",
    "bronze": "#c98042",
    "silver": "#d7dee9",
}


def rgb(hex_color: str) -> tuple[int, int, int]:
    hex_color = hex_color.lstrip("#")
    return tuple(int(hex_color[i : i + 2], 16) for i in (0, 2, 4))


def shade(hex_color: str, factor: float) -> tuple[int, int, int, int]:
    r, g, b = rgb(hex_color)
    if factor >= 1:
        return (
            min(255, int(r + (255 - r) * (factor - 1))),
            min(255, int(g + (255 - g) * (factor - 1))),
            min(255, int(b + (255 - b) * (factor - 1))),
            255,
        )
    return (max(0, int(r * factor)), max(0, int(g * factor)), max(0, int(b * factor)), 255)


def pts(points):
    return [(int(x * SCALE), int(y * SCALE)) for x, y in points]


def box(x0, y0, x1, y1):
    return [int(x0 * SCALE), int(y0 * SCALE), int(x1 * SCALE), int(y1 * SCALE)]


def font(size: int, bold: bool = True) -> ImageFont.FreeTypeFont:
    candidates = [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/Library/Fonts/Arial Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    ]
    for path in candidates:
        if os.path.exists(path):
            return ImageFont.truetype(path, size * SCALE)
    return ImageFont.load_default()


def canvas() -> tuple[Image.Image, ImageDraw.ImageDraw]:
    img = Image.new("RGBA", (SIZE * SCALE, SIZE * SCALE), (0, 0, 0, 0))
    return img, ImageDraw.Draw(img, "RGBA")


def finish(img: Image.Image, name: str):
    img = img.resize((SIZE, SIZE), Image.Resampling.LANCZOS)
    OUT.mkdir(parents=True, exist_ok=True)
    img.save(OUT / f"{name}.png")


def shadow(d: ImageDraw.ImageDraw, x=256, y=374, w=250, h=50, alpha=44):
    d.ellipse(box(x - w / 2, y - h / 2, x + w / 2, y + h / 2), fill=(42, 36, 64, alpha))


def poly_icon(name: str, polygons: list[tuple[list[tuple[float, float]], tuple[int, int, int, int]]], shadow_args=None):
    img, d = canvas()
    if shadow_args is not None:
        shadow(d, *shadow_args)
    for p, c in polygons:
        d.polygon(pts(p), fill=c)
    finish(img, name)


def rotate(points, degrees, center=(256, 250)):
    angle = math.radians(degrees)
    cx, cy = center
    out = []
    for x, y in points:
        dx, dy = x - cx, y - cy
        out.append((cx + dx * math.cos(angle) - dy * math.sin(angle), cy + dx * math.sin(angle) + dy * math.cos(angle)))
    return out


def arrow(name: str, color: str, degrees: int):
    base = [(256, 96), (386, 246), (314, 246), (314, 386), (198, 386), (198, 246), (126, 246)]
    top = [(256, 96), (386, 246), (314, 246), (256, 196), (198, 246), (126, 246)]
    left = [(126, 246), (198, 246), (198, 386), (154, 342)]
    right = [(386, 246), (314, 246), (314, 386), (358, 342)]
    lower = [(198, 386), (314, 386), (358, 342), (256, 356), (154, 342)]
    hl = [(218, 198), (256, 142), (303, 199), (255, 185)]
    polys = [
        (rotate(base, degrees), shade(color, 0.92)),
        (rotate(top, degrees), shade(color, 1.15)),
        (rotate(left, degrees), shade(color, 0.72)),
        (rotate(right, degrees), shade(color, 0.82)),
        (rotate(lower, degrees), shade(color, 0.68)),
        (rotate(hl, degrees), (255, 255, 255, 118)),
    ]
    poly_icon(name, polys, (256, 396, 230, 42, 36))


def play_triangle(name: str, color: str):
    polys = [
        ([(168, 126), (386, 256), (168, 386)], shade(color, 0.9)),
        ([(168, 126), (386, 256), (228, 250)], shade(color, 1.18)),
        ([(168, 126), (228, 250), (168, 386), (134, 342), (134, 170)], shade(color, 0.72)),
        ([(168, 386), (386, 256), (228, 250)], shade(color, 0.76)),
        ([(207, 176), (286, 223), (224, 230)], (255, 255, 255, 110)),
    ]
    poly_icon(name, polys, (256, 398, 220, 48, 42))


def loop_icon():
    img, d = canvas()
    shadow(d, 256, 392, 260, 48, 38)
    purple = COLORS["purple"]
    d.arc(box(138, 122, 382, 366), 28, 218, fill=shade(purple, 1.08), width=46 * SCALE)
    d.arc(box(130, 114, 374, 358), 210, 400, fill=shade(purple, 0.72), width=46 * SCALE)
    d.polygon(pts([(158, 254), (98, 222), (141, 176)]), fill=shade(purple, 0.82))
    d.polygon(pts([(354, 232), (416, 264), (374, 310)]), fill=shade(purple, 1.08))
    d.arc(box(148, 132, 362, 346), 28, 218, fill=(255, 255, 255, 70), width=10 * SCALE)
    finish(img, "loop")


def function_icon():
    img, d = canvas()
    shadow(d, 256, 384, 245, 48, 40)
    blue = COLORS["blue"]
    d.rounded_rectangle(box(122, 132, 390, 382), radius=50 * SCALE, fill=shade(blue, 0.88))
    d.pieslice(box(222, 74, 290, 150), 0, 360, fill=shade(blue, 1.07))
    d.pieslice(box(352, 220, 428, 296), 0, 360, fill=(0, 0, 0, 0))
    d.polygon(pts([(122, 132), (390, 132), (352, 190), (166, 190)]), fill=shade(blue, 1.18))
    d.polygon(pts([(122, 132), (166, 190), (166, 382), (122, 342)]), fill=shade(blue, 0.70))
    d.polygon(pts([(166, 382), (390, 382), (352, 330)]), fill=shade(blue, 0.74))
    f = font(86)
    text = "F1"
    bb = d.textbbox((0, 0), text, font=f)
    x = (SIZE * SCALE - (bb[2] - bb[0])) // 2
    y = int(238 * SCALE - (bb[3] - bb[1]) / 2)
    d.text((x + 5 * SCALE, y + 7 * SCALE), text, font=f, fill=(42, 36, 64, 80))
    d.text((x, y), text, font=f, fill=COLORS["paper"])
    finish(img, "function")


def eye_icon():
    img, d = canvas()
    shadow(d, 256, 382, 232, 42, 36)
    blue = COLORS["blue"]
    d.polygon(pts([(72, 258), (150, 160), (256, 126), (362, 160), (440, 258), (362, 356), (256, 390), (150, 356)]), fill=shade(blue, 0.9))
    d.polygon(pts([(150, 160), (256, 126), (362, 160), (326, 206), (184, 206)]), fill=shade(blue, 1.18))
    d.polygon(pts([(72, 258), (150, 356), (256, 390), (256, 322), (148, 296)]), fill=shade(blue, 0.72))
    d.ellipse(box(174, 174, 338, 338), fill=COLORS["paper"])
    d.ellipse(box(216, 216, 296, 296), fill=COLORS["ink"])
    d.ellipse(box(236, 224, 260, 248), fill=(255, 255, 255, 230))
    d.polygon(pts([(372, 106), (388, 146), (430, 160), (390, 176), (374, 218), (358, 178), (316, 162), (356, 146)]), fill=shade(COLORS["gold"], 1.06))
    finish(img, "preview")


def chevron(name: str, color: str, right=True):
    pts_main = [(178, 116), (356, 256), (178, 396), (142, 330), (246, 256), (142, 182)]
    deg = 0 if right else 180
    polys = [
        (rotate(pts_main, deg, (256, 256)), shade(color, 0.9)),
        (rotate([(178, 116), (356, 256), (246, 256), (142, 182)], deg, (256, 256)), shade(color, 1.15)),
        (rotate([(142, 330), (246, 256), (356, 256), (178, 396)], deg, (256, 256)), shade(color, 0.72)),
    ]
    poly_icon(name, polys, (256, 398, 210, 45, 38))


def replay_icon(name: str, color: str):
    img, d = canvas()
    shadow(d, 256, 388, 242, 48, 40)
    d.arc(box(128, 116, 386, 374), 38, 330, fill=shade(color, 0.92), width=50 * SCALE)
    d.arc(box(142, 130, 372, 360), 42, 188, fill=shade(color, 1.15), width=13 * SCALE)
    d.polygon(pts([(360, 104), (420, 156), (346, 184)]), fill=shade(color, 0.9))
    d.polygon(pts([(346, 184), (420, 156), (385, 214)]), fill=shade(color, 0.68))
    finish(img, name)


def broom_icon():
    img, d = canvas()
    shadow(d, 258, 396, 235, 42, 34)
    d.polygon(pts([(142, 338), (242, 238), (274, 270), (178, 374)]), fill=shade(COLORS["orange"], 0.78))
    d.polygon(pts([(242, 238), (330, 90), (360, 118), (274, 270)]), fill=shade(COLORS["grey_light"], 0.93))
    d.polygon(pts([(330, 90), (350, 72), (380, 100), (360, 118)]), fill=shade(COLORS["paper"], 0.9))
    d.polygon(pts([(126, 318), (204, 360), (188, 420), (72, 378)]), fill=shade(COLORS["gold"], 1.0))
    d.polygon(pts([(126, 318), (204, 360), (162, 372), (72, 378)]), fill=shade(COLORS["gold"], 1.18))
    d.line(pts([(104, 342), (162, 404)]), fill=shade(COLORS["gold_shadow"], 0.95), width=7 * SCALE)
    d.line(pts([(138, 330), (178, 410)]), fill=shade(COLORS["gold_shadow"], 0.95), width=7 * SCALE)
    finish(img, "clear")


def coin_icon():
    img, d = canvas()
    shadow(d, 256, 384, 230, 46, 38)
    d.ellipse(box(118, 106, 394, 382), fill=shade(COLORS["gold_shadow"], 1.0))
    d.ellipse(box(102, 88, 374, 360), fill=shade(COLORS["gold"], 0.96))
    d.pieslice(box(102, 88, 374, 360), 205, 335, fill=shade(COLORS["gold_shadow"], 0.98))
    d.pieslice(box(102, 88, 374, 360), 25, 205, fill=shade(COLORS["gold"], 1.15))
    d.ellipse(box(150, 136, 326, 312), outline=shade(COLORS["gold_shadow"], 0.95), width=16 * SCALE)
    f = font(118)
    text = "B"
    bb = d.textbbox((0, 0), text, font=f)
    d.text(((238 * SCALE - (bb[2] - bb[0]) / 2), 142 * SCALE), text, font=f, fill=shade(COLORS["gold_shadow"], 0.9))
    d.polygon(pts([(320, 102), (334, 136), (370, 146), (336, 160), (322, 196), (308, 162), (272, 148), (306, 134)]), fill=(255, 255, 255, 130))
    finish(img, "coin")


def star_icon(name: str, filled=True):
    img, d = canvas()
    shadow(d, 256, 390, 220, 42, 34)
    points = []
    for i in range(10):
        r = 150 if i % 2 == 0 else 68
        a = math.radians(-90 + i * 36)
        points.append((256 + math.cos(a) * r, 250 + math.sin(a) * r))
    if filled:
        d.polygon(pts(points), fill=shade(COLORS["gold"], 0.96))
        d.polygon(pts(points[:3] + [(256, 250)]), fill=shade(COLORS["gold"], 1.18))
        d.polygon(pts([(256, 250)] + points[4:8]), fill=shade(COLORS["gold_shadow"], 0.95))
        d.polygon(pts([(344, 102), (356, 128), (384, 138), (358, 150), (348, 178), (336, 152), (308, 142), (334, 130)]), fill=(255, 255, 255, 120))
    else:
        d.polygon(pts(points), fill=shade(COLORS["grey"], 0.82))
        inner = []
        for i in range(10):
            r = 104 if i % 2 == 0 else 46
            a = math.radians(-90 + i * 36)
            inner.append((256 + math.cos(a) * r, 250 + math.sin(a) * r))
        d.polygon(pts(inner), fill=(0, 0, 0, 0))
        d.polygon(pts(points[:3] + [(256, 250)]), fill=shade(COLORS["grey_light"], 0.92))
    finish(img, name)


def lock_icon():
    img, d = canvas()
    shadow(d, 256, 394, 214, 44, 36)
    d.rounded_rectangle(box(146, 218, 366, 390), radius=32 * SCALE, fill=shade(COLORS["grey"], 0.88))
    d.polygon(pts([(146, 218), (366, 218), (326, 266), (176, 266)]), fill=shade(COLORS["grey_light"], 0.95))
    d.polygon(pts([(146, 218), (176, 266), (176, 390), (146, 356)]), fill=shade(COLORS["grey_dark"], 0.82))
    d.arc(box(174, 104, 338, 280), 180, 360, fill=shade(COLORS["grey_dark"], 1.0), width=38 * SCALE)
    d.arc(box(196, 126, 316, 254), 180, 360, fill=shade(COLORS["grey_light"], 0.92), width=18 * SCALE)
    d.ellipse(box(236, 284, 276, 324), fill=COLORS["ink"])
    d.rectangle(box(248, 316, 264, 350), fill=COLORS["ink"])
    finish(img, "lock")


def sound_icon(off=False):
    img, d = canvas()
    shadow(d, 256, 386, 220, 42, 30)
    ink = COLORS["ink"]
    d.polygon(pts([(100, 226), (176, 226), (278, 144), (278, 368), (176, 286), (100, 286)]), fill=shade(ink, 1.22))
    d.polygon(pts([(176, 226), (278, 144), (278, 226), (206, 256)]), fill=shade(ink, 1.55))
    d.polygon(pts([(176, 286), (278, 368), (278, 286), (206, 256)]), fill=shade(ink, 0.76))
    if not off:
        for r, a in [(54, 120), (94, 90), (134, 62)]:
            d.arc(box(288, 256 - r, 288 + r, 256 + r), -a / 2, a / 2, fill=shade(COLORS["blue"], 1.05), width=14 * SCALE)
    else:
        d.line(pts([(328, 180), (430, 334)]), fill=shade(COLORS["red"], 1.0), width=34 * SCALE)
        d.line(pts([(430, 180), (328, 334)]), fill=shade(COLORS["red"], 0.86), width=34 * SCALE)
        d.line(pts([(328, 180), (430, 334)]), fill=(255, 255, 255, 70), width=8 * SCALE)
    finish(img, "sound-off" if off else "sound-on")


def trash_icon():
    img, d = canvas()
    shadow(d, 256, 394, 214, 42, 32)
    d.rounded_rectangle(box(164, 170, 348, 390), radius=24 * SCALE, fill=shade(COLORS["grey"], 0.88))
    d.polygon(pts([(164, 170), (348, 170), (322, 220), (186, 220)]), fill=shade(COLORS["grey_light"], 0.96))
    d.polygon(pts([(164, 170), (186, 220), (186, 390), (164, 354)]), fill=shade(COLORS["grey_dark"], 0.82))
    d.rounded_rectangle(box(138, 134, 374, 180), radius=18 * SCALE, fill=shade(COLORS["grey_dark"], 0.95))
    d.rounded_rectangle(box(214, 100, 298, 132), radius=15 * SCALE, fill=shade(COLORS["grey"], 0.92))
    for x in (216, 256, 296):
        d.line(pts([(x, 238), (x - 8, 348)]), fill=shade(COLORS["grey_dark"], 0.92), width=8 * SCALE)
    finish(img, "trash")


def bloop_icon():
    img, d = canvas()
    shadow(d, 256, 392, 238, 44, 38)
    blue = COLORS["blue"]
    spikes = []
    for i in range(16):
        a = math.radians(i * 22.5)
        r1, r2 = 148, 178
        spikes.append((256 + math.cos(a) * (r2 if i % 2 == 0 else r1), 248 + math.sin(a) * (r2 if i % 2 == 0 else r1)))
    d.polygon(pts(spikes), fill=shade(blue, 0.82))
    d.ellipse(box(112, 104, 400, 392), fill=shade(blue, 0.95))
    d.pieslice(box(112, 104, 400, 392), 210, 340, fill=shade(blue, 0.72))
    d.pieslice(box(112, 104, 400, 392), 20, 205, fill=shade(blue, 1.15))
    d.ellipse(box(176, 210, 232, 278), fill=COLORS["paper"])
    d.ellipse(box(280, 210, 336, 278), fill=COLORS["paper"])
    d.ellipse(box(194, 232, 224, 268), fill=COLORS["ink"])
    d.ellipse(box(298, 232, 328, 268), fill=COLORS["ink"])
    d.ellipse(box(204, 232, 214, 242), fill=COLORS["paper"])
    d.ellipse(box(308, 232, 318, 242), fill=COLORS["paper"])
    d.arc(box(210, 270, 302, 336), 18, 162, fill=COLORS["ink"], width=8 * SCALE)
    finish(img, "bloop")


def trophy_icon():
    img, d = canvas()
    shadow(d, 256, 402, 230, 44, 36)
    gold = COLORS["gold"]
    d.ellipse(box(88, 154, 182, 278), outline=shade(gold, 0.9), width=22 * SCALE)
    d.ellipse(box(330, 154, 424, 278), outline=shade(gold, 0.9), width=22 * SCALE)
    d.polygon(pts([(148, 104), (364, 104), (334, 266), (292, 318), (220, 318), (178, 266)]), fill=shade(gold, 0.96))
    d.polygon(pts([(148, 104), (364, 104), (330, 154), (182, 154)]), fill=shade(gold, 1.2))
    d.polygon(pts([(178, 266), (220, 318), (220, 104), (148, 104)]), fill=shade(gold, 0.72))
    d.rectangle(box(226, 312, 286, 372), fill=shade(COLORS["gold_shadow"], 0.95))
    d.rounded_rectangle(box(164, 368, 348, 414), radius=18 * SCALE, fill=shade(gold, 0.87))
    finish(img, "trophy")


def rosette(name: str, center_text: str | None, ribbon_color: str, medallion: str = "gold"):
    img, d = canvas()
    shadow(d, 256, 400, 232, 42, 34)
    main = COLORS[medallion] if medallion in COLORS else medallion
    teeth = []
    for i in range(24):
        r = 154 if i % 2 == 0 else 128
        a = math.radians(-90 + i * 15)
        teeth.append((256 + math.cos(a) * r, 222 + math.sin(a) * r))
    d.polygon(pts(teeth), fill=shade(main, 0.86))
    d.ellipse(box(130, 96, 382, 348), fill=shade(main, 1.0))
    d.pieslice(box(130, 96, 382, 348), 28, 208, fill=shade(main, 1.18))
    d.pieslice(box(130, 96, 382, 348), 205, 335, fill=shade(main, 0.72))
    d.polygon(pts([(190, 326), (242, 330), (218, 444), (178, 390)]), fill=shade(ribbon_color, 0.86))
    d.polygon(pts([(270, 330), (322, 326), (334, 390), (294, 444)]), fill=shade(ribbon_color, 0.70))
    if center_text:
        f = font(82 if len(center_text) <= 3 else 70)
        bb = d.textbbox((0, 0), center_text, font=f)
        d.text(((256 * SCALE - (bb[2] - bb[0]) / 2) + 4 * SCALE, (214 * SCALE - (bb[3] - bb[1]) / 2) + 6 * SCALE), center_text, font=f, fill=(42, 36, 64, 82))
        d.text((256 * SCALE - (bb[2] - bb[0]) / 2, 214 * SCALE - (bb[3] - bb[1]) / 2), center_text, font=f, fill=COLORS["paper"])
    finish(img, name)


def party_icon():
    img, d = canvas()
    shadow(d, 256, 398, 230, 42, 34)
    d.polygon(pts([(150, 340), (328, 152), (386, 420)]), fill=shade(COLORS["purple"], 0.94))
    d.polygon(pts([(150, 340), (328, 152), (244, 376)]), fill=shade(COLORS["purple"], 1.18))
    d.polygon(pts([(244, 376), (386, 420), (328, 152)]), fill=shade(COLORS["purple_deep"], 0.9))
    for color, x, y, rot in [
        (COLORS["pink"], 112, 132, 8),
        (COLORS["green"], 210, 86, -20),
        (COLORS["gold"], 302, 96, 16),
        (COLORS["red"], 390, 156, -14),
        (COLORS["blue"], 394, 262, 26),
        (COLORS["orange"], 142, 230, -34),
    ]:
        p = rotate([(x - 16, y - 8), (x + 18, y - 4), (x + 12, y + 16), (x - 18, y + 12)], rot, (x, y))
        d.polygon(pts(p), fill=shade(color, 1.03))
    d.arc(box(104, 88, 210, 194), 20, 260, fill=shade(COLORS["blue"], 1.1), width=9 * SCALE)
    d.arc(box(318, 74, 436, 210), 100, 330, fill=shade(COLORS["pink"], 1.0), width=9 * SCALE)
    finish(img, "win")


def question_icon():
    img, d = canvas()
    shadow(d, 256, 388, 236, 44, 36)
    p = COLORS["purple"]
    d.rounded_rectangle(box(120, 116, 392, 388), radius=54 * SCALE, fill=shade(p, 0.92))
    d.polygon(pts([(120, 116), (392, 116), (340, 174), (166, 174)]), fill=shade(p, 1.18))
    d.polygon(pts([(120, 116), (166, 174), (166, 388), (120, 340)]), fill=shade(p, 0.70))
    f = font(178)
    bb = d.textbbox((0, 0), "?", font=f)
    d.text((256 * SCALE - (bb[2] - bb[0]) / 2, 218 * SCALE - (bb[3] - bb[1]) / 2), "?", font=f, fill=COLORS["paper"])
    finish(img, "question")


def world_icons():
    # world-1
    img, d = canvas()
    shadow(d, 256, 400, 240, 40, 34)
    d.ellipse(box(112, 342, 400, 420), fill=shade(COLORS["green"], 0.86))
    d.polygon(pts([(245, 342), (268, 342), (270, 192), (246, 192)]), fill=shade(COLORS["green"], 0.72))
    for cx, cy in [(214, 190), (256, 152), (298, 190), (238, 232), (276, 232)]:
        d.ellipse(box(cx - 46, cy - 38, cx + 46, cy + 38), fill=shade(COLORS["pink"], 1.03))
        d.pieslice(box(cx - 46, cy - 38, cx + 46, cy + 38), 20, 180, fill=shade(COLORS["pink"], 1.2))
    d.ellipse(box(230, 184, 282, 236), fill=shade(COLORS["gold"], 1.0))
    finish(img, "world-1")

    # world-2
    img, d = canvas()
    shadow(d, 256, 402, 238, 40, 34)
    d.ellipse(box(122, 350, 390, 420), fill=shade(COLORS["purple_deep"], 0.85))
    crystals = [
        [(214, 350), (238, 112), (286, 350)],
        [(138, 356), (184, 178), (234, 356)],
        [(282, 354), (342, 160), (386, 354)],
    ]
    for p in crystals:
        d.polygon(pts(p), fill=shade(COLORS["purple"], 0.92))
        d.polygon(pts([p[0], p[1], ((p[0][0] + p[2][0]) / 2, p[2][1])]), fill=shade(COLORS["purple"], 1.25))
        d.polygon(pts([p[1], p[2], ((p[0][0] + p[2][0]) / 2, p[2][1])]), fill=shade(COLORS["purple_deep"], 0.92))
    finish(img, "world-2")

    # world-3
    img, d = canvas()
    shadow(d, 256, 402, 238, 40, 34)
    d.ellipse(box(110, 342, 402, 422), fill=shade(COLORS["orange"], 0.72))
    d.arc(box(132, 126, 380, 374), 20, 340, fill=shade(COLORS["orange"], 1.12), width=38 * SCALE)
    d.arc(box(178, 172, 334, 328), 40, 345, fill=shade(COLORS["gold"], 1.0), width=30 * SCALE)
    d.arc(box(220, 214, 292, 286), 60, 360, fill=shade(COLORS["red"], 0.95), width=22 * SCALE)
    finish(img, "world-3")

    # world-4
    img, d = canvas()
    shadow(d, 256, 402, 238, 40, 34)
    d.ellipse(box(112, 344, 400, 422), fill=shade(COLORS["green"], 0.72))
    blue = COLORS["blue"]
    d.rounded_rectangle(box(136, 154, 356, 358), radius=42 * SCALE, fill=shade(blue, 0.92))
    d.ellipse(box(216, 92, 284, 166), fill=shade(blue, 1.1))
    d.ellipse(box(322, 218, 398, 294), fill=shade(blue, 0.92))
    d.polygon(pts([(136, 154), (356, 154), (324, 204), (174, 204)]), fill=shade(blue, 1.17))
    d.polygon(pts([(136, 154), (174, 204), (174, 358), (136, 324)]), fill=shade(blue, 0.72))
    finish(img, "world-4")

    # world-5
    img, d = canvas()
    shadow(d, 256, 402, 238, 40, 34)
    d.polygon(pts([(110, 376), (220, 204), (302, 376)]), fill=shade(COLORS["grey_dark"], 0.8))
    d.polygon(pts([(232, 376), (344, 170), (420, 376)]), fill=shade(COLORS["grey"], 0.78))
    d.ellipse(box(112, 126, 232, 230), fill=shade(COLORS["grey"], 0.98))
    d.ellipse(box(190, 94, 330, 230), fill=shade(COLORS["grey_light"], 0.92))
    d.ellipse(box(290, 132, 408, 232), fill=shade(COLORS["grey"], 0.9))
    d.rectangle(box(146, 184, 372, 238), fill=shade(COLORS["grey"], 0.92))
    d.polygon(pts([(260, 224), (214, 316), (268, 306), (238, 402), (332, 270), (278, 282)]), fill=shade(COLORS["red"], 1.08))
    finish(img, "world-5")


def main():
    arrow("dir-up", COLORS["blue"], 0)
    arrow("dir-down", COLORS["orange"], 180)
    arrow("dir-left", COLORS["pink"], -90)
    arrow("dir-right", COLORS["green"], 90)
    loop_icon()
    function_icon()

    play_triangle("run", COLORS["green"])
    eye_icon()
    play_triangle("play", COLORS["purple"])
    chevron("next", COLORS["green"], True)
    replay_icon("replay", COLORS["purple"])
    broom_icon()
    chevron("back", COLORS["purple"], False)

    coin_icon()
    star_icon("star-filled", True)
    star_icon("star-empty", False)
    lock_icon()
    sound_icon(False)
    sound_icon(True)
    trash_icon()

    bloop_icon()
    trophy_icon()
    rosette("badge", None, COLORS["purple"], "gold")
    rosette("perfect", "100", COLORS["red"], "gold")
    party_icon()
    question_icon()
    world_icons()

    rosette("medal-bronze", None, COLORS["purple"], "bronze")
    rosette("medal-silver", None, COLORS["purple"], "silver")
    rosette("medal-gold", None, COLORS["purple"], "gold")


if __name__ == "__main__":
    main()
