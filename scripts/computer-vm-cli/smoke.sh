#!/bin/sh
# Smoke test for a built Local VM image, run INSIDE it as the desktop user.
#
#   docker run --rm -v "$PWD/scripts/computer-vm-cli/smoke.sh:/smoke.sh:ro" \
#     --entrypoint sh <image> -c 'su cua -s /bin/sh -c "sh /smoke.sh"'
#   docker run --rm -v "$PWD/scripts/computer-vm-cli/smoke.sh:/smoke.sh:ro" \
#     --entrypoint sh <image> -c 'su - cua -c "zsh -l /smoke.sh"'
#
# The first is how a bot meets the image (`docker exec -u cua`, no shell init, so
# only the image ENV applies).  The second is how the desktop terminal does
# (login shell, zsh).  Plain POSIX sh on purpose: it must run under dash, bash
# and zsh alike, so: tool names are spelled out because zsh does not word-split
# an unquoted variable, and no variable is called `path`, which zsh ties to PATH.
set -u
missing=""
for tool in rg brew node npm pnpm wrangler cloudflared gh uv uvx mise gitleaks actionlint tesseract pdftotext yq bat open zsh git pm2 sentry-cli; do
  if found="$(command -v "$tool" 2>/dev/null)" && [ -n "$found" ]; then
    printf '%-12s %s\n' "$tool" "$found"
  else
    missing="$missing $tool"
  fi
done
if [ -n "$missing" ]; then
  echo "missing on PATH:$missing" >&2
  exit 1
fi

# The pinned toolchain must win over anything Homebrew could bring.
node_path="$(command -v node)"
if [ "$node_path" != /usr/local/bin/node ]; then
  echo "node resolves to $node_path, not the pinned /usr/local/bin/node" >&2
  exit 1
fi
case "$(node -v)" in
  v24.*) ;;
  *) echo "node is $(node -v), not v24" >&2; exit 1 ;;
esac
case "$(command -v brew)" in
  /home/linuxbrew/.linuxbrew/bin/brew) ;;
  *) echo "brew resolves to $(command -v brew)" >&2; exit 1 ;;
esac
brew --version

# Build steps run as root with HOME=/home/cua.  Anything they leave root-owned in
# the desktop user's home makes the first real use fail with EACCES (~/.pm2,
# ~/.config/gcloud, the corepack cache), and `--version` alone does not notice.
stray="$(find /home/cua -xdev -user root -print -quit 2>/dev/null)"
if [ -n "$stray" ]; then
  echo "root-owned file left in cua's home: $stray" >&2
  exit 1
fi
