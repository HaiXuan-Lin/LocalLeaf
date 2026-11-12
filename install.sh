#!/usr/bin/env bash
#
# Install the LocalLeaf desktop app built by ./build.sh into /Applications.
#
#   ./install.sh               install (builds first if needed)
#   ./install.sh --help        all options
#
# See desktop/README.md.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$REPO_DIR/desktop"

APP_NAME="$(sed -n 's/.*"productName": *"\([^"]*\)".*/\1/p' "$DESKTOP_DIR/package.json" | head -n 1)"
BUNDLE_ID="$(sed -n 's/.*"bundleId": *"\([^"]*\)".*/\1/p' "$DESKTOP_DIR/package.json" | head -n 1)"
SOURCE_APP="$DESKTOP_DIR/dist/$APP_NAME.app"

DEST_DIR="/Applications"
OPEN_AFTER=0
UNINSTALL=0
PURGE=0

usage() {
  cat <<EOF
Usage: ./install.sh [options]

  --user            Install into ~/Applications instead of /Applications
  --dest <folder>   Install into another folder
  --open            Start the app after installing
  --uninstall       Remove the installed app
  --purge           With --uninstall: also remove settings and recent folders
                    (~/Library/Application Support/$APP_NAME)
  -h, --help        Show this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --user) DEST_DIR="$HOME/Applications"; shift ;;
    --dest) DEST_DIR="${2:?--dest needs a folder}"; shift 2 ;;
    --dest=*) DEST_DIR="${1#*=}"; shift ;;
    --open) OPEN_AFTER=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --purge) PURGE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# Apple's own tools are called by path: Conda, Homebrew and pip install
# different programs with the same names (codesign, xattr, ...) on the PATH.
DITTO=/usr/bin/ditto
XATTR=/usr/bin/xattr
CODESIGN=/usr/bin/codesign
OSASCRIPT=/usr/bin/osascript

[ "$(uname -s)" = "Darwin" ] || die "this installs a macOS app; run it on a Mac."
[ -n "$APP_NAME" ] || die "could not read the app name from desktop/package.json"

DEST_APP="$DEST_DIR/$APP_NAME.app"

# Run a command, with sudo only when the destination is not writable.
run_privileged() {
  if [ -w "$DEST_DIR" ]; then
    "$@"
  else
    echo "$DEST_DIR is not writable for $(id -un); using sudo."
    sudo "$@"
  fi
}

quit_running_app() {
  if pgrep -f "$DEST_APP/Contents/MacOS/" >/dev/null 2>&1; then
    echo "Quitting the running $APP_NAME…"
    "$OSASCRIPT" -e "tell application id \"$BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      pgrep -f "$DEST_APP/Contents/MacOS/" >/dev/null 2>&1 || return 0
      sleep 1
    done
    die "$APP_NAME is still running. Quit it and run ./install.sh again."
  fi
}

if [ "$UNINSTALL" = "1" ]; then
  if [ -d "$DEST_APP" ]; then
    quit_running_app
    run_privileged rm -rf "$DEST_APP"
    echo "Removed $DEST_APP"
  else
    echo "$DEST_APP is not installed."
  fi
  if [ "$PURGE" = "1" ]; then
    rm -rf "$HOME/Library/Application Support/$APP_NAME"
    echo "Removed $HOME/Library/Application Support/$APP_NAME"
  fi
  exit 0
fi

if [ ! -d "$SOURCE_APP" ]; then
  echo "$SOURCE_APP does not exist yet: building it first."
  "$REPO_DIR/build.sh"
fi
[ -d "$SOURCE_APP" ] || die "build did not produce $SOURCE_APP"
"$CODESIGN" --verify --deep --strict "$SOURCE_APP" 2>/dev/null ||
  die "$SOURCE_APP is not signed correctly; run ./build.sh again."

mkdir -p "$DEST_DIR" 2>/dev/null || sudo mkdir -p "$DEST_DIR"
quit_running_app

echo "Installing $APP_NAME into $DEST_DIR"
if [ -d "$DEST_APP" ]; then
  run_privileged rm -rf "$DEST_APP"
fi
# ditto keeps the symlinks and signatures inside the app bundle intact
run_privileged "$DITTO" "$SOURCE_APP" "$DEST_APP"
# Built on this Mac, so there is nothing for Gatekeeper to quarantine.
"$XATTR" -dr com.apple.quarantine "$DEST_APP" 2>/dev/null || true

# Tell Launch Services about the app (Spotlight, "Open With", Dock drops).
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
[ -x "$LSREGISTER" ] && "$LSREGISTER" -f "$DEST_APP" >/dev/null 2>&1 || true

printf '\033[32mInstalled %s\033[0m\n' "$DEST_APP"
echo "Start it from Launchpad or Spotlight, or open a folder directly:"
echo "  open -a \"$APP_NAME\" path/to/your/latex/folder"

if [ "$OPEN_AFTER" = "1" ]; then
  open "$DEST_APP"
fi
