#!/usr/bin/env bash
# Download color TV-Face packs from FleetLink into public/tv-face/skins/{color}/.
# After fetch, add each color to SHIPPED_SKINS in TVFaceAvatar.tsx.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE="${TVFACE_SKINS_BASE:-https://fleetlink.online/TV-Face/botfleet-skins}"
DEST="${ROOT}/public/tv-face/skins"
if [ "$#" -eq 0 ]; then
  set -- blue green purple pink red cyan yellow teal coral
fi
COLORS=("$@")

fetch_one() {
  local url="$1"
  local out="$2"
  local label="$3"
  if curl -fsSL --remove-on-error "$url" -o "$out"; then
    return 0
  fi
  rm -f "$out"
  echo "miss $label ($url)" >&2
  return 1
}

# Pull the file list from the local default pack: every color pack is built
# from the same inventory, so the default directory is the source of truth
# for which files a pack should contain.
failed=0
for color in "${COLORS[@]}"; do
  echo "=== $color ==="
  mkdir -p "$DEST/$color/stills" "$DEST/$color/gifs"
  for f in "$DEST/default/stills"/*.png; do
    name=$(basename "$f")
    [[ "$name" == "speaking_hold_preview.png" ]] && continue
    fetch_one "$BASE/$color/stills/$name" "$DEST/$color/stills/$name" "still $name" || failed=1
  done
  for f in "$DEST/default/gifs"/*.gif; do
    name=$(basename "$f")
    fetch_one "$BASE/$color/gifs/$name" "$DEST/$color/gifs/$name" "gif $name" || failed=1
  done
  echo "  stills=$(ls "$DEST/$color/stills" | wc -l) gifs=$(ls "$DEST/$color/gifs" | wc -l)"
done

if [ "$failed" -ne 0 ]; then
  echo "Fetch incomplete — fix misses before adding colors to SHIPPED_SKINS." >&2
  exit 1
fi

echo "Done.  Add fetched colors to SHIPPED_SKINS in src/components/tv-face/TVFaceAvatar.tsx."
