#!/usr/bin/env python3
"""Retime and mask the TV-Face GIF pack in place.

Two contracts the player relies on (see TVFaceAvatar.tsx):
  1. Every *_enter and *_return GIF runs TVFACE_TRANSITION_MS (1000 ms).  The
     player swaps to the hold (or the resting still) after exactly that long.
     Frames are sampled evenly over the original timeline, so the first and
     last frame are kept exactly and the resting bookends stay bit-identical.
  2. The TV sits on a transparent background, like the stills.  The opaque
     black square around it is the pure-black area connected to the image
     border; black glass inside the TV is enclosed by the body and stays.

Pixels are never re-quantized: frames keep their exact colors and only the
border background moves to a transparent palette entry, so compositing over
black gives back the original frame byte for byte (the bookend MD5 pin).

Usage: python3 scripts/tv-face-gifs.py [gif-dir]   (needs Pillow, numpy, scipy)
"""
import glob
import hashlib
import json
import os
import sys

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

TRANSITION_MS = 1000
TRANSITION_FRAMES = 25  # 40 ms each: above the 20 ms floor browsers enforce
# Disposal 2 (restore to background) is required: the silhouette changes
# between frames and a transparent index under disposal 1 means "keep the
# previous frame", which would leave stale pixels where the TV shrinks.
DISPOSAL = 2


def frames_of(path):
    im = Image.open(path)
    frames, delays = [], []
    for i in range(im.n_frames):
        im.seek(i)
        frames.append(np.array(im.convert("RGB")))
        delays.append(im.info.get("duration", 0))
    return frames, delays


def background(rgb):
    """Exact-black pixels connected to the image border."""
    dark = rgb.max(axis=2) == 0
    labels, _ = ndi.label(dark)
    edge = np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]])
    border = [v for v in np.unique(edge) if v != 0]
    return np.isin(labels, border)


def retime(frames, delays):
    total = sum(delays)
    starts = np.cumsum([0] + delays[:-1])
    picks = []
    for k in range(TRANSITION_FRAMES):
        t = k * total / TRANSITION_FRAMES
        picks.append(int(np.searchsorted(starts, t, side="right") - 1))
    picks[-1] = len(frames) - 1  # the landing frame is the resting bookend
    picks[0] = 0
    return [frames[i] for i in picks], [TRANSITION_MS // TRANSITION_FRAMES] * TRANSITION_FRAMES


def write(path, frames, delays):
    masks = [background(f) for f in frames]
    colors = {}
    for f, m in zip(frames, masks):
        px = f[~m].astype(np.uint32)
        for c in np.unique((px[:, 0] << 16) | (px[:, 1] << 8) | px[:, 2]).tolist():
            colors.setdefault(c, len(colors))
    if len(colors) > 255:
        raise SystemExit(f"{path}: {len(colors)} colors leaves no room for a transparent index")
    transparent = len(colors)
    palette = np.zeros((256, 3), np.uint8)
    for c, i in colors.items():
        palette[i] = ((c >> 16) & 255, (c >> 8) & 255, c & 255)
    lookup = {c: i for c, i in colors.items()}
    images = []
    for f, m in zip(frames, masks):
        packed = (f[..., 0].astype(np.uint32) << 16) | (f[..., 1].astype(np.uint32) << 8) | f[..., 2]
        idx = np.full(packed.shape, transparent, np.uint8)
        opaque = ~m
        idx[opaque] = np.vectorize(lookup.__getitem__, otypes=[np.uint8])(packed[opaque])
        img = Image.fromarray(idx, "P")
        img.putpalette(palette.flatten().tolist())
        images.append(img)
    images[0].save(
        path,
        save_all=True,
        append_images=images[1:],
        duration=delays,
        loop=0,
        transparency=transparent,
        disposal=DISPOSAL,
        optimize=False,
    )


def md5_over_black(path, index):
    im = Image.open(path)
    im.seek(index)
    rgba = im.convert("RGBA")
    flat = Image.alpha_composite(Image.new("RGBA", rgba.size, (0, 0, 0, 255)), rgba).convert("RGB")
    return hashlib.md5(flat.tobytes()).hexdigest()


def proof_grid(gif_dir, out_path, cell=120):
    """First and last frame of every GIF over a light checker, so a black box
    or a stale edge shows at a glance."""
    from PIL import ImageDraw
    paths = sorted(glob.glob(os.path.join(gif_dir, "*.gif")))
    cols = 6
    rows = (len(paths) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * (2 * cell + 8), rows * (cell + 18)), (255, 255, 255))
    draw = ImageDraw.Draw(sheet)
    checker = Image.new("RGB", (cell, cell))
    cd = ImageDraw.Draw(checker)
    for y in range(0, cell, 10):
        for x in range(0, cell, 10):
            cd.rectangle([x, y, x + 9, y + 9], fill=(235, 190, 235) if (x // 10 + y // 10) % 2 else (250, 235, 250))
    for n, path in enumerate(paths):
        im = Image.open(path)
        x0, y0 = (n % cols) * (2 * cell + 8), (n // cols) * (cell + 18)
        draw.text((x0 + 2, y0 + 2), os.path.basename(path), fill=(0, 0, 0))
        for k, idx in enumerate((0, im.n_frames - 1)):
            im.seek(idx)
            frame = im.convert("RGBA").resize((cell, cell), Image.LANCZOS)
            tile = checker.copy()
            tile.paste(frame, (0, 0), frame)
            sheet.paste(tile, (x0 + k * cell, y0 + 16))
    sheet.save(out_path, quality=85)


def main():
    gif_dir = sys.argv[1] if len(sys.argv) > 1 else "public/tv-face/skins/default/gifs"
    report_path = os.path.join(os.path.dirname(os.path.normpath(gif_dir)), "..", "..", "..", "..", "docs", "tv-face-qa", "bookend_report.json")
    report_path = os.path.normpath(report_path)
    for path in sorted(glob.glob(os.path.join(gif_dir, "*.gif"))):
        name = os.path.basename(path)
        frames, delays = frames_of(path)
        if name.endswith(("_enter.gif", "_return.gif")):
            frames, delays = retime(frames, delays)
        write(path, frames, delays)
        print(f"{name}: {len(frames)} frames, {sum(delays)} ms")
    if os.path.exists(report_path):
        report = json.load(open(report_path))
        rest = report["resting_md5"]
        for name, row in report["gifs"].items():
            path = os.path.join(gif_dir, name)
            im = Image.open(path)
            n = im.n_frames
            total = 0
            for i in range(n):
                im.seek(i)
                total += im.info.get("duration", 0)
            first, last = md5_over_black(path, 0), md5_over_black(path, n - 1)
            row.update(frames=n, first=first, last=last, total_ms=total, bytes=os.path.getsize(path),
                       transparent="transparency" in Image.open(path).info)
            if name.endswith("_enter.gif"):
                row["first_is_rest"] = first == rest
                row["ok"] = first == rest
            elif name.endswith("_return.gif"):
                row["last_is_rest"] = last == rest
                row["ok"] = last == rest
            else:
                row["ok"] = first == last
                if name in ("idle_loop.gif", "blink.gif", "anticipate.gif", "resting_hold.gif"):
                    row["ok"] = first == last == rest
        json.dump(report, open(report_path, "w"), indent=2)
        print("updated", report_path)
        proof_grid(gif_dir, os.path.join(os.path.dirname(report_path), "bookend_proof_grid.jpg"))


if __name__ == "__main__":
    main()
