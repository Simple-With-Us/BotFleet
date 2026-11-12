#!/usr/bin/env python3
"""Expand TV-Face multi-GIF skins into one-file packs under the 2 MB budget.

Usage:
  python3 scripts/tv-face-expand-onefile-packs.py \\
    --skin public/tv-face/skins/default \\
    --out public/tv-face/packs/tvface-default.webp \\
    --name tvface-default

Requires: magick, ffmpeg, img2webp, node, tsx (or node that runs scripts/avatar-build.ts).

This is the BF-2627 pack expansion path.  Frame caps keep the encode under 2 MB
while covering the high-traffic states (thinking, working, speaking, listening,
tools, computer, memory).  Recolor a default-built pack for other shells with
scripts/tv-face-build-color-skins.py then re-embed the same ranges.
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

DELAY_MS = 83
SIZE = 256
MAX_BYTES = 2 * 1024 * 1024

# (state, [(role, gif_stem, max_frames), ...])
DEFAULT_PLAN = [
    ("*", [("hold", "resting_hold", 24)]),
    ("thinking", [
        ("enter", "thinking_enter", 18),
        ("hold", "thinking_hold", 36),
        ("return", "thinking_return", 18),
    ]),
    ("working", [("hold", "working_hold", 48)]),
    ("speaking", [
        ("enter", "speaking_enter", 16),
        ("hold", "speaking_hold", 40),
        ("return", "speaking_return", 16),
    ]),
    ("listening", [
        ("enter", "listening_enter", 16),
        ("hold", "listening_hold", 28),
        ("return", "listening_return", 16),
    ]),
    ("tools", [
        ("enter", "tools_enter", 14),
        ("hold", "tools_hold", 24),
        ("return", "tools_return", 14),
    ]),
    ("computer", [
        ("enter", "computer_enter", 14),
        ("hold", "computer_hold", 24),
        ("return", "computer_return", 14),
    ]),
    ("memory", [
        ("enter", "memory_enter", 12),
        ("hold", "memory_hold", 20),
        ("return", "memory_return", 12),
    ]),
]


def extract_gif(gif: Path, dest_dir: Path, max_frames: int) -> int:
    dest_dir.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "magick",
            str(gif),
            "-coalesce",
            "-resize",
            f"{SIZE}x{SIZE}",
            "-background",
            "none",
            "-gravity",
            "center",
            "-extent",
            f"{SIZE}x{SIZE}",
            str(dest_dir / "f%04d.png"),
        ],
        check=True,
        capture_output=True,
    )
    files = sorted(dest_dir.glob("f*.png"))
    if len(files) > max_frames:
        idxs = (
            [round(i * (len(files) - 1) / (max_frames - 1)) for i in range(max_frames)]
            if max_frames > 1
            else [0]
        )
        keep = set(idxs)
        for i, f in enumerate(files):
            if i not in keep:
                f.unlink()
        files = sorted(dest_dir.glob("f*.png"))
    return len(files)


def build(skin: Path, out: Path, name: str, work: Path) -> None:
    gifs = skin / "gifs"
    if not gifs.is_dir():
        raise SystemExit(f"no gifs under {skin}")
    if work.exists():
        shutil.rmtree(work)
    frames = work / "frames"
    frames.mkdir(parents=True)
    states: dict = {}
    cursor = 0
    global_i = 0
    for state, parts in DEFAULT_PLAN:
        entry: dict = {}
        for role, stem, max_f in parts:
            gif = gifs / f"{stem}.gif"
            if not gif.exists():
                raise SystemExit(f"missing {gif}")
            tmp = work / f"tmp_{stem}"
            if tmp.exists():
                shutil.rmtree(tmp)
            n = extract_gif(gif, tmp, max_f)
            print(f"  {stem}: {n} frames (cap {max_f})", flush=True)
            start = cursor
            for f in sorted(tmp.glob("f*.png")):
                shutil.copy(f, frames / f"{global_i:05d}.png")
                global_i += 1
                cursor += 1
            # AVAT ranges are inclusive on both ends.
            entry[role] = {"from": start, "to": cursor - 1}
            shutil.rmtree(tmp)
        states[state] = entry

    manifest = {
        "formatVersion": 1,
        "name": name,
        "version": "1.1.0",
        "author": "BotFleet",
        "frame": {"width": SIZE, "height": SIZE, "count": cursor, "delayMs": DELAY_MS},
        "restingFrame": 0,
        "states": states,
    }
    man_path = work / "avatar.json"
    man_path.write_text(json.dumps(manifest, indent=2) + "\n")
    out.parent.mkdir(parents=True, exist_ok=True)
    # Prefer tsx; fall back to node --experimental-strip-types.
    root = Path(__file__).resolve().parents[1]
    build_ts = root / "scripts" / "avatar-build.ts"
    cmd = None
    if shutil.which("tsx"):
        cmd = ["tsx", str(build_ts), str(frames), "--manifest", str(man_path), "--out", str(out), "--lossy"]
    else:
        cmd = [
            "node",
            "--experimental-strip-types",
            str(build_ts),
            str(frames),
            "--manifest",
            str(man_path),
            "--out",
            str(out),
            "--lossy",
        ]
    print("running", " ".join(cmd), flush=True)
    subprocess.run(cmd, check=True)
    size = out.stat().st_size
    print(f"built {out} ({size / 1024:.0f} KB)")
    if size > MAX_BYTES:
        raise SystemExit(f"over budget: {size} > {MAX_BYTES}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--skin", type=Path, required=True, help="skin dir with gifs/")
    ap.add_argument("--out", type=Path, required=True, help="output webp path")
    ap.add_argument("--name", default="tvface-default")
    ap.add_argument("--work", type=Path, default=Path("/tmp/tvface-expand-work"))
    args = ap.parse_args()
    build(args.skin, args.out, args.name, args.work)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
