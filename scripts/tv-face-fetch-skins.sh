#!/usr/bin/env bash
# Download color TV-Face packs from FleetLink into public/tv-face/skins/{color}/.
# After fetch, add each color to SHIPPED_SKINS in TVFaceAvatar.tsx.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE="${TVFACE_SKINS_BASE:-https://fleetlink.online/TV-Face/botfleet-skins}"
DEST="${ROOT}/public/tv-face/skins"
COLORS=("${@:-blue green purple pink red cyan yellow teal coral}")

# Manifest lists files per color
for color in "${COLORS[@]}"; do
  echo "=== $color ==="
  mkdir -p "$DEST/$color/stills" "$DEST/$color/gifs"
  # Prefer manifest.json if present
  if curl -fsSL "$BASE/$color/manifest.json" -o "/tmp/tvface-man-$color.json" 2>/dev/null; then
    echo "got manifest"
  fi
  # Pull default file list from local default pack
  for f in "$DEST/default/stills"/*.png; do
    name=$(basename "$f")
    [[ "$name" == "speaking_hold_preview.png" ]] && continue
    curl -fsSL "$BASE/$color/stills/$name" -o "$DEST/$color/stills/$name" || echo "miss still $name"
  done
  for f in "$DEST/default/gifs"/*.gif; do
    name=$(basename "$f")
    curl -fsSL "$BASE/$color/gifs/$name" -o "$DEST/$color/gifs/$name" || echo "miss gif $name"
  done
  echo "  stills=$(ls "$DEST/$color/stills" | wc -l) gifs=$(ls "$DEST/$color/gifs" | wc -l)"
done
echo "Done.  Add fetched colors to SHIPPED_SKINS in src/components/tv-face/TVFaceAvatar.tsx."
