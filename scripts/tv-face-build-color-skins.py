#!/usr/bin/env python3
"""Build TV-Face color skins from the default pack (single pass).

Usage:
  python3 scripts/tv-face-build-color-skins.py \\
    public/tv-face/skins/default public/tv-face/skins blue green purple pink red cyan yellow teal coral

Requires: Pillow, numpy.

Preserves GIF frame delays (enter/return stay at TVFACE_TRANSITION_MS = 1000).
Green remaps cyan face glyphs to red.  See docs/tv-face/GIF-SPEED.md.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageSequence

SWATCHES = {
    "blue":   {"base": (55, 127, 230), "shadow": (20, 50, 120), "highlight": (150, 200, 255), "mouth": "cyan"},
    "green":  {"base": (0, 153, 87), "shadow": (0, 70, 35), "highlight": (120, 230, 170), "mouth": "red"},
    "red":    {"base": (217, 75, 82), "shadow": (110, 20, 25), "highlight": (255, 150, 155), "mouth": "cyan"},
    "purple": {"base": (128, 87, 200), "shadow": (55, 30, 100), "highlight": (200, 170, 255), "mouth": "cyan"},
    "cyan":   {"base": (14, 165, 198), "shadow": (5, 70, 90), "highlight": (140, 235, 245), "mouth": "cyan"},
    "pink":   {"base": (216, 79, 139), "shadow": (120, 25, 70), "highlight": (255, 180, 210), "mouth": "cyan"},
    "yellow": {"base": (216, 167, 41), "shadow": (120, 90, 10), "highlight": (255, 230, 130), "mouth": "cyan"},
    "teal":   {"base": (1, 164, 146), "shadow": (0, 75, 65), "highlight": (120, 230, 215), "mouth": "cyan"},
    "coral":  {"base": (229, 99, 78), "shadow": (120, 40, 30), "highlight": (255, 180, 160), "mouth": "cyan"},
}


def rgb_to_hsv(rgb: np.ndarray):
    r, g, b = rgb[..., 0] / 255.0, rgb[..., 1] / 255.0, rgb[..., 2] / 255.0
    mx = np.maximum(np.maximum(r, g), b)
    mn = np.minimum(np.minimum(r, g), b)
    df = mx - mn + 1e-8
    h = np.zeros_like(mx)
    m = (mx == r) & (df > 1e-6)
    h[m] = ((g[m] - b[m]) / df[m]) % 6
    m = (mx == g) & (df > 1e-6)
    h[m] = (b[m] - r[m]) / df[m] + 2
    m = (mx == b) & (df > 1e-6)
    h[m] = (r[m] - g[m]) / df[m] + 4
    h = h / 6.0
    s = np.where(mx < 1e-6, 0, df / (mx + 1e-8))
    return h, s, mx


def shell_mask(rgb: np.ndarray, a: np.ndarray) -> np.ndarray:
    h, s, v = rgb_to_hsv(rgb)
    m = ((h < 0.09) | (h > 0.95)) & (s > 0.25) & (v > 0.15) & (v < 0.98)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    return m & (r > g) & (r > b) & (r > 60) & ((r + g + b) > 90) & (a > 20)


def cyan_mask(rgb: np.ndarray, a: np.ndarray) -> np.ndarray:
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    return (b > 140) & (g > 100) & (b > r * 1.2) & (g > r * 1.1) & ((g + b) / 2 > r + 30) & (a > 20)


def recolor(arr: np.ndarray, sw: dict, red_mouth: bool = False) -> np.ndarray:
    rgb = arr[..., :3].astype(np.float32)
    a = arr[..., 3]
    out = rgb.copy()
    mask = shell_mask(rgb, a)
    if mask.any():
        _, _, v = rgb_to_hsv(rgb)
        vv = v[mask]
        vmin, vmax = np.percentile(vv, 5), np.percentile(vv, 95)
        t = np.clip((vv - vmin) / (vmax - vmin + 1e-6), 0, 1)
        sh = np.array(sw["shadow"], np.float32)
        ba = np.array(sw["base"], np.float32)
        hi = np.array(sw["highlight"], np.float32)
        res = np.zeros((t.shape[0], 3), np.float32)
        lo = t <= 0.5
        hi_m = ~lo
        tlo = t[lo] * 2
        thi = (t[hi_m] - 0.5) * 2
        res[lo] = sh * (1 - tlo[:, None]) + ba * tlo[:, None]
        res[hi_m] = ba * (1 - thi[:, None]) + hi * thi[:, None]
        out[mask] = res
    if red_mouth:
        cm = cyan_mask(rgb, a)
        if cm.any():
            cy = rgb[cm]
            lum = (0.299 * cy[:, 0] + 0.587 * cy[:, 1] + 0.114 * cy[:, 2]) / 255.0
            t2 = np.clip((lum - lum.min()) / (lum.max() - lum.min() + 1e-6), 0, 1)
            rs = np.array([120, 10, 20], np.float32)
            rb = np.array([220, 40, 50], np.float32)
            rh = np.array([255, 140, 150], np.float32)
            res2 = np.zeros((t2.shape[0], 3), np.float32)
            lo = t2 <= 0.5
            hi_m = ~lo
            tlo = t2[lo] * 2
            thi = (t2[hi_m] - 0.5) * 2
            res2[lo] = rs * (1 - tlo[:, None]) + rb * tlo[:, None]
            res2[hi_m] = rb * (1 - thi[:, None]) + rh * thi[:, None]
            out[cm] = res2
    return np.dstack([np.clip(out, 0, 255), a]).astype(np.uint8)


def process_color(src: Path, out_root: Path, color: str) -> None:
    sw = SWATCHES[color]
    red_mouth = sw["mouth"] == "red"
    out = out_root / color
    (out / "stills").mkdir(parents=True, exist_ok=True)
    (out / "gifs").mkdir(parents=True, exist_ok=True)
    stills = sorted(p for p in (src / "stills").glob("*.png") if p.name != "speaking_hold_preview.png")
    for p in stills:
        arr = recolor(np.array(Image.open(p).convert("RGBA")), sw, red_mouth)
        Image.fromarray(arr).save(out / "stills" / p.name, compress_level=3)
    for p in sorted((src / "gifs").glob("*.gif")):
        im = Image.open(p)
        frames, durs = [], []
        for fr in ImageSequence.Iterator(im):
            frames.append(Image.fromarray(recolor(np.array(fr.convert("RGBA")), sw, red_mouth)))
            durs.append(int(fr.info.get("duration", 40) or 40))
        frames[0].save(
            out / "gifs" / p.name,
            save_all=True,
            append_images=frames[1:],
            duration=durs,
            loop=0,
            disposal=2,
            optimize=False,
        )
    (out / "README.md").write_text(
        f"# TV-Face skin: {color}\n\n"
        f"Shell recolored from default orange to RGB{sw['base']}.\n"
        + ("Mouth/glyphs remapped to **red**.\n" if red_mouth else "Cyan face glyphs preserved.\n")
        + "Enter/return GIFs honor TVFACE_TRANSITION_MS (1000 ms).\n",
        encoding="utf-8",
    )
    print(f"{color}: stills={len(stills)} gifs={len(list((out / 'gifs').glob('*.gif')))}", flush=True)


def main() -> None:
    if len(sys.argv) < 4:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    src = Path(sys.argv[1])
    out_root = Path(sys.argv[2])
    colors = sys.argv[3:]
    for c in colors:
        if c not in SWATCHES:
            print(f"unknown color {c}", file=sys.stderr)
            sys.exit(2)
        process_color(src, out_root, c)


if __name__ == "__main__":
    main()
