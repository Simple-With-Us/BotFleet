#!/usr/bin/env python3
"""Retarget GIF frame delays without Cloudinary or any CDN.

GIF playback speed is just the per-frame delay field (centiseconds in the
file; Pillow exposes milliseconds).  Halving every delay makes the clip
play ~2× faster while keeping every pixel and bookend frame intact.

Usage:
  python3 scripts/tv-face-retime-gifs.py --factor 2 public/tv-face/skins/default/gifs/*_enter.gif
  python3 scripts/tv-face-retime-gifs.py --target-ms 1000 path/to/clip.gif

No third-party service is required.  Cloudinary can do e_accelerate on a
URL, but for BotFleet we re-encode once into the repo so the player stays
offline-first.
"""
from __future__ import annotations
import argparse
from pathlib import Path
from PIL import Image, ImageSequence

def retime(path: Path, factor: float | None, target_ms: int | None) -> None:
    im = Image.open(path)
    frames, durs = [], []
    for fr in ImageSequence.Iterator(im):
        frames.append(fr.copy())
        durs.append(int(fr.info.get("duration", 40) or 40))
    total = sum(durs) or 1
    if target_ms is not None:
        factor = total / max(1, target_ms)
    assert factor is not None and factor > 0
    new_durs = [max(20, int(round(d / factor))) for d in durs]  # GIF min ~20ms practical
    # rescale to hit target if requested
    if target_ms is not None:
        s = sum(new_durs) or 1
        scale = target_ms / s
        new_durs = [max(20, int(round(d * scale))) for d in new_durs]
        # fix remainder on last frame
        drift = target_ms - sum(new_durs)
        new_durs[-1] = max(20, new_durs[-1] + drift)
    loop = im.info.get("loop", 0)
    if loop is None:
        loop = 0
    frames[0].save(
        path,
        save_all=True,
        append_images=frames[1:],
        duration=new_durs,
        loop=loop,
        disposal=2,
        optimize=False,
    )
    print(f"{path.name}: {total}ms -> {sum(new_durs)}ms (factor~{factor:.2f})")

def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("paths", nargs="+", type=Path)
    ap.add_argument("--factor", type=float, default=None, help=">1 = faster")
    ap.add_argument("--target-ms", type=int, default=None)
    args = ap.parse_args()
    if args.factor is None and args.target_ms is None:
        ap.error("need --factor or --target-ms")
    for p in args.paths:
        retime(p, args.factor, args.target_ms)

if __name__ == "__main__":
    main()
