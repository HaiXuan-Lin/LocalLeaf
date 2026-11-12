#!/usr/bin/env bash
#
# Build the LocalLeaf desktop app (desktop/dist/LocalLeaf.app) from source.
#
#   ./build.sh                 build for this Mac
#   ./build.sh --help          all options
#
# Needs: macOS 12+, git, and an internet connection (npm packages and the
# Electron runtime are downloaded once; the built app itself works offline).
# Node.js is downloaded into desktop/.toolchain if a suitable one is not
# installed. Nothing is installed outside this repository.
#
# See desktop/README.md.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$REPO_DIR/desktop"
TOOLCHAIN_DIR="$DESKTOP_DIR/.toolchain"
BUILD_DIR="$DESKTOP_DIR/build"

# Node.js version to download when the installed one is too old.
NODE_FALLBACK_VERSION="${LOCALLEAF_NODE_VERSION:-24.22.2}"
NODE_DIST_URL="${NODEJS_ORG_MIRROR:-https://nodejs.org/dist}"

ARCH=""
DICTIONARIES="${LOCALLEAF_DICTIONARIES:-}"
SKIP_INSTALL=0
CLEAN=0

usage() {
  cat <<'EOF'
Usage: ./build.sh [options]

  --arch <arm64|x64|universal>  CPU architecture of the app (default: this Mac)
  --dictionaries <list|all>     Spell-check dictionaries to bundle, e.g.
                                "en_US,en_GB,de_DE,fr" (default: English).
                                "all" adds about 270 MB.
  --skip-install                Reuse the npm packages from a previous build
  --clean                       Remove build output and downloaded tools first
  -h, --help                    Show this help

Environment:
  NODEJS_ORG_MIRROR             Mirror of https://nodejs.org/dist
  YARN_NPM_REGISTRY_SERVER      npm registry for the editor's packages
  npm_config_registry           npm registry for the desktop shell's packages
  ELECTRON_MIRROR               Mirror for the Electron runtime download
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --arch) ARCH="${2:?--arch needs a value}"; shift 2 ;;
    --arch=*) ARCH="${1#*=}"; shift ;;
    --dictionaries) DICTIONARIES="${2:?--dictionaries needs a value}"; shift 2 ;;
    --dictionaries=*) DICTIONARIES="${1#*=}"; shift ;;
    --skip-install) SKIP_INSTALL=1; shift ;;
    --clean) CLEAN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# ------------------------------------------------------------------ platform

OS="$(uname -s)"
if [ "$OS" != "Darwin" ] && [ "${LOCALLEAF_ALLOW_NON_MAC:-0}" != "1" ]; then
  die "the app is packaged for macOS and must be built on a Mac (found $OS)."
fi

case "$(uname -m)" in
  arm64|aarch64) HOST_ARCH=arm64 ;;
  x86_64) HOST_ARCH=x64 ;;
  *) die "unsupported CPU: $(uname -m)" ;;
esac
ARCH="${ARCH:-$HOST_ARCH}"
case "$ARCH" in
  arm64|x64|universal) ;;
  *) die "--arch must be arm64, x64 or universal" ;;
esac

command -v git >/dev/null 2>&1 ||
  die "git is required (install the Xcode Command Line Tools: xcode-select --install)."
command -v curl >/dev/null 2>&1 || die "curl is required."

if [ "$CLEAN" = "1" ]; then
  step "Cleaning"
  rm -rf "$BUILD_DIR" "$DESKTOP_DIR/dist" "$TOOLCHAIN_DIR" \
    "$DESKTOP_DIR/node_modules" "$REPO_DIR/services/web/.cache/webpack-desktop"
fi
mkdir -p "$BUILD_DIR" "$TOOLCHAIN_DIR"

# ------------------------------------------------------------------- Node.js

# "major.minor.patch" required by the monorepo (package.json "engines")
REQUIRED_NODE="$(sed -n 's/.*"node": *">=\([0-9.]*\)".*/\1/p' "$REPO_DIR/package.json" | head -n 1)"
REQUIRED_NODE="${REQUIRED_NODE:-24.18.1}"

version_ge() { # version_ge A B  ->  true when A >= B
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -t. -k1,1n -k2,2n -k3,3n | head -n 1)" = "$2" ]
}

node_is_suitable() {
  command -v "$1" >/dev/null 2>&1 || [ -x "$1" ] || return 1
  local version
  version="$("$1" --version 2>/dev/null | sed 's/^v//')" || return 1
  [ -n "$version" ] && version_ge "$version" "$REQUIRED_NODE"
}

step "[1/6] Node.js (>= $REQUIRED_NODE)"
LOCAL_NODE_DIR="$TOOLCHAIN_DIR/node"
if node_is_suitable "$LOCAL_NODE_DIR/bin/node"; then
  export PATH="$LOCAL_NODE_DIR/bin:$PATH"
elif node_is_suitable node; then
  :
else
  case "$OS" in
    Darwin) NODE_PLATFORM=darwin ;;
    Linux) NODE_PLATFORM=linux ;;
    *) die "cannot download Node.js for $OS; install Node.js >= $REQUIRED_NODE." ;;
  esac
  NODE_NAME="node-v$NODE_FALLBACK_VERSION-$NODE_PLATFORM-$HOST_ARCH"
  echo "No suitable Node.js found; downloading $NODE_NAME into desktop/.toolchain"
  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TMP_DIR"' EXIT
  curl -fL --progress-bar -o "$TMP_DIR/$NODE_NAME.tar.gz" \
    "$NODE_DIST_URL/v$NODE_FALLBACK_VERSION/$NODE_NAME.tar.gz" ||
    die "could not download Node.js from $NODE_DIST_URL (set NODEJS_ORG_MIRROR, or install Node.js >= $REQUIRED_NODE yourself)."
  # Verify the download against the published checksums.
  if curl -fsSL -o "$TMP_DIR/SHASUMS256.txt" \
    "$NODE_DIST_URL/v$NODE_FALLBACK_VERSION/SHASUMS256.txt"; then
    EXPECTED="$(grep " $NODE_NAME.tar.gz\$" "$TMP_DIR/SHASUMS256.txt" | cut -d' ' -f1)"
    ACTUAL="$(shasum -a 256 "$TMP_DIR/$NODE_NAME.tar.gz" | cut -d' ' -f1)"
    [ -n "$EXPECTED" ] && [ "$EXPECTED" = "$ACTUAL" ] ||
      die "checksum mismatch for $NODE_NAME.tar.gz"
  else
    die "could not download the Node.js checksums from $NODE_DIST_URL"
  fi
  rm -rf "$LOCAL_NODE_DIR"
  mkdir -p "$LOCAL_NODE_DIR"
  tar -xzf "$TMP_DIR/$NODE_NAME.tar.gz" -C "$LOCAL_NODE_DIR" --strip-components=1
  rm -rf "$TMP_DIR"
  trap - EXIT
  export PATH="$LOCAL_NODE_DIR/bin:$PATH"
fi
echo "node $(node --version) ($(command -v node))"

# ---------------------------------------------------------------------- Yarn

# The monorepo pins its package manager ("packageManager": "yarn@x.y.z").
YARN_VERSION="$(sed -n 's/.*"packageManager": *"yarn@\([0-9.]*\)".*/\1/p' "$REPO_DIR/package.json" | head -n 1)"
[ -n "$YARN_VERSION" ] || die "could not read the Yarn version from package.json"
YARN_DIR="$TOOLCHAIN_DIR/yarn-$YARN_VERSION"
YARN_JS="$YARN_DIR/node_modules/@yarnpkg/cli-dist/bin/yarn.js"

step "[2/6] Yarn $YARN_VERSION"
if [ ! -f "$YARN_JS" ]; then
  mkdir -p "$YARN_DIR"
  (cd "$YARN_DIR" && npm install --no-audit --no-fund --no-save --prefix "$YARN_DIR" \
    "@yarnpkg/cli-dist@$YARN_VERSION")
fi
yarn() { node "$YARN_JS" "$@"; }
echo "yarn $(cd "$REPO_DIR" && yarn --version)"

export YARN_ENABLE_TELEMETRY=0
# Only the front-end build is needed: skip the install scripts of the
# server-side packages (native add-ons, browser downloads for tests, ...).
export YARN_ENABLE_SCRIPTS=false

# ------------------------------------------------------------- dependencies

step "[3/6] Packages of the editor (services/web)"
if [ "$SKIP_INSTALL" = "1" ] && [ -f "$REPO_DIR/.pnp.cjs" ]; then
  echo "skipped (--skip-install)"
else
  (cd "$REPO_DIR" && yarn workspaces focus @overleaf/web)
fi

step "[4/6] Packages of the desktop shell (Electron)"
if [ "$SKIP_INSTALL" = "1" ] && [ -d "$DESKTOP_DIR/node_modules/electron" ]; then
  echo "skipped (--skip-install)"
else
  (cd "$DESKTOP_DIR" && npm ci --no-audit --no-fund)
fi

# ---------------------------------------------------------------- front end

step "[5/6] Editor front end (webpack; takes a few minutes)"
(
  cd "$REPO_DIR"
  export LOCALLEAF_DICTIONARIES="$DICTIONARIES"
  export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=4096"
  yarn workspace @overleaf/web exec webpack \
    --config modules/desktop/webpack.config.desktop.js
)

# ------------------------------------------------------------------- package

step "[6/6] Packaging"
(cd "$DESKTOP_DIR" && node scripts/stage-app.js)

APP_NAME="$(sed -n 's/.*"productName": *"\([^"]*\)".*/\1/p' "$DESKTOP_DIR/package.json" | head -n 1)"
APP_PATH="$DESKTOP_DIR/dist/$APP_NAME.app"

if [ "$OS" = "Darwin" ]; then
  # .icns from the 1024px artwork
  ICONSET="$BUILD_DIR/icon.iconset"
  rm -rf "$ICONSET"
  mkdir -p "$ICONSET"
  for size in 16 32 128 256 512; do
    sips -z "$size" "$size" "$DESKTOP_DIR/resources/icon.png" \
      --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
    sips -z "$((size * 2))" "$((size * 2))" "$DESKTOP_DIR/resources/icon.png" \
      --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
  done
  iconutil -c icns "$ICONSET" -o "$BUILD_DIR/icon.icns"
fi

(cd "$DESKTOP_DIR" && node scripts/package-app.js "--arch=$ARCH" --platform=darwin >/dev/null)
[ -d "$APP_PATH" ] || die "packaging did not produce $APP_PATH"

if [ "$OS" = "Darwin" ]; then
  # Apple silicon only runs signed code. An ad-hoc signature is enough for an
  # app that is built and used on the same Mac.
  xattr -cr "$APP_PATH" 2>/dev/null || true
  codesign --force --deep --sign - "$APP_PATH" 2>&1 | grep -v 'replacing existing signature' || true
  codesign --verify --deep --strict "$APP_PATH" ||
    die "the app could not be signed (codesign --verify failed)."
fi

SIZE="$(du -sh "$APP_PATH" | cut -f1)"
printf '\n\033[32mBuilt %s (%s, %s)\033[0m\n' "$APP_PATH" "$SIZE" "$ARCH"
echo "Install it with:  ./install.sh"
