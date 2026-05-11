#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUN_VERSION="1.3.13"
ENTRY_SCRIPT="ai_init.js"
REQUEST_TIMEOUT=121

# ── Early exit if bun is already on PATH ──────────────────────────
if command -v bun &>/dev/null; then
  exit 0
fi

# ── musl / Alpine detection ───────────────────────────────────────
is_alpine_or_musl() {
  if command -v ldd &>/dev/null; then
    # ldd may print version info to stdout *or* stderr
    if ldd --version 2>&1 | grep -qi musl; then
      return 0
    fi
  fi
  if [[ -f /etc/os-release ]] && grep -qi 'alpine' /etc/os-release; then
    return 0
  fi
  return 1
}

# ── Platform / arch → asset name ──────────────────────────────────
resolve_asset() {
  local kernel arch key
  kernel="$(uname -s)"
  arch="$(uname -m)"

  case "$kernel" in
    Linux)  kernel="linux"  ;;
    Darwin) kernel="darwin" ;;
    *)      echo "Unsupported OS: $kernel" >&2; exit 1 ;;
  esac

  case "$arch" in
    x86_64|amd64)   arch="x64"   ;;
    aarch64|arm64)   arch="arm64" ;;
    *)               echo "Unsupported architecture: $arch" >&2; exit 1 ;;
  esac

  key="${kernel}-${arch}"

  case "$key" in
    linux-arm64)  echo "bun-linux-aarch64"  ;;
    linux-x64)
      if is_alpine_or_musl; then
        echo "bun-linux-x64-musl-baseline"
      else
        echo "bun-linux-x64-baseline"
      fi
      ;;
    darwin-arm64) echo "bun-darwin-aarch64" ;;
    darwin-x64)   echo "bun-darwin-x64"     ;;
    *)            echo "Unsupported platform/arch: $key" >&2; exit 1 ;;
  esac
}

# ── Download (curl preferred, wget fallback) ──────────────────────
download_file() {
  local url="$1" dest="$2"

  if command -v curl &>/dev/null; then
    curl -fSL --max-time "$REQUEST_TIMEOUT" -o "$dest" "$url"
  elif command -v wget &>/dev/null; then
    wget -q --timeout="$REQUEST_TIMEOUT" -O "$dest" "$url"
  else
    echo "Error: neither curl nor wget is available" >&2
    exit 1
  fi
}

# ── Extract a single entry from a zip ─────────────────────────────
extract_bun() {
  local zip_path="$1" entry="$2" out_dir="$3"

  if command -v unzip &>/dev/null; then
    unzip -ojq "$zip_path" "$entry" -d "$out_dir"
  elif command -v bsdtar &>/dev/null; then
    bsdtar -xf "$zip_path" -C "$out_dir" --strip-components=1 "$entry"
  elif command -v python3 &>/dev/null; then
    python3 -c "
import zipfile, os, sys
with zipfile.ZipFile(sys.argv[1]) as z:
    data = z.read(sys.argv[2])
    dest = os.path.join(sys.argv[3], os.path.basename(sys.argv[2]))
    with open(dest, 'wb') as f:
        f.write(data)
" "$zip_path" "$entry" "$out_dir"
  else
    echo "Error: no unzip, bsdtar, or python3 found to extract the archive" >&2
    exit 1
  fi
}

# ── Main ──────────────────────────────────────────────────────────
ASSET="$(resolve_asset)"
BIN_NAME="bun"
URL="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${ASSET}.zip"

TMP_DIR="$(mktemp -d)"
ZIP_PATH="${TMP_DIR}/${ASSET}.zip"
BIN_PATH="${TMP_DIR}/${BIN_NAME}"

cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

download_file "$URL" "$ZIP_PATH"
extract_bun "$ZIP_PATH" "${ASSET}/${BIN_NAME}" "$TMP_DIR"
rm -f "$ZIP_PATH"

chmod 755 "$BIN_PATH"

cd "$SCRIPT_DIR"
exec "$BIN_PATH" "${SCRIPT_DIR}/${ENTRY_SCRIPT}"
