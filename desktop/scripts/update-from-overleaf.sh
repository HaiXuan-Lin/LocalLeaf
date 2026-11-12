#!/usr/bin/env bash
#
# Brings a newer version of Overleaf into LocalLeaf.
#
#   desktop/scripts/update-from-overleaf.sh --check [<ref>]
#       Fetch Overleaf and report what an update would mean for LocalLeaf.
#       Changes nothing.
#
#   desktop/scripts/update-from-overleaf.sh [<ref>]
#       Fetch Overleaf, merge it into the current branch, record the new base
#       in desktop/upstream.json and commit the merge if LocalLeaf still fits.
#       If it does not, the merge is left uncommitted with a list of what to
#       adapt.
#
# <ref> is a branch, tag or commit of https://github.com/overleaf/overleaf
# (default: main). See desktop/UPGRADING.md for the whole procedure.
#
# LOCALLEAF_UPSTREAM_SOURCE=<url or path> fetches from another copy of the
# Overleaf repository.
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_DIR"
MANIFEST="desktop/upstream.json"

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

CHECK_ONLY=0
REF=""
while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK_ONLY=1 ;;
    -h|--help) sed -n '3,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown option: $1" ;;
    *) [ -z "$REF" ] || die "only one <ref> can be given"; REF="$1" ;;
  esac
  shift
done

command -v git >/dev/null 2>&1 || die "git is required."
git rev-parse --is-inside-work-tree >/dev/null 2>&1 ||
  die "this is not a git checkout; updates are merged with git."

# Node.js: the one on the PATH, or the one build.sh downloaded.
if ! command -v node >/dev/null 2>&1; then
  if [ -x "desktop/.toolchain/node/bin/node" ]; then
    PATH="$REPO_DIR/desktop/.toolchain/node/bin:$PATH"
  else
    die "Node.js is required (run ./build.sh once, it installs a private copy)."
  fi
fi

manifest_value() {
  node -e '
    const manifest = require("./desktop/upstream.json");
    const value = process.argv[1].split(".").reduce((o, k) => o?.[k], manifest);
    if (Array.isArray(value)) console.log(value.join("\n"));
    else if (value != null) console.log(value);
  ' "$1"
}

UPSTREAM_URL="$(manifest_value repository)"
BASE="$(manifest_value base.commit)"
[ -n "$REF" ] || REF="$(manifest_value branch)"

# Fetch from a remote that already points at Overleaf, if there is one.
SOURCE="${LOCALLEAF_UPSTREAM_SOURCE:-}"
if [ -z "$SOURCE" ]; then
  SOURCE="$(git remote -v | awk '
    $3 == "(fetch)" && $2 ~ /github\.com[:\/]overleaf\/overleaf(\.git)?\/?$/ { print $1; exit }')"
  [ -n "$SOURCE" ] || SOURCE="$UPSTREAM_URL.git"
fi

step "Fetching $REF from $SOURCE"
git fetch --no-tags "$SOURCE" "$REF"
NEW="$(git rev-parse FETCH_HEAD)"
NEW_SHORT="$(git rev-parse --short=10 "$NEW")"
NEW_DATE="$(git show -s --format=%cs "$NEW")"

if git merge-base --is-ancestor "$NEW" HEAD; then
  echo "LocalLeaf already contains Overleaf $NEW_SHORT ($NEW_DATE). Nothing to do."
  exit 0
fi
git cat-file -e "$BASE^{commit}" 2>/dev/null ||
  die "the recorded base commit $BASE is not in this clone (shallow clone?). Run: git fetch --unshallow"

step "What changes for LocalLeaf (Overleaf ${BASE:0:10} -> $NEW_SHORT)"
FITS=1
node desktop/scripts/check-upstream.js --against "$NEW" || FITS=0

if [ "$CHECK_ONLY" = "1" ]; then
  if [ "$FITS" = "1" ]; then
    echo "LocalLeaf fits Overleaf $NEW_SHORT as it is. Review the report, then run this script without --check."
  else
    echo "LocalLeaf needs the changes listed above before it builds with Overleaf $NEW_SHORT."
  fi
  exit 0
fi

# ----------------------------------------------------------------- the merge

[ -z "$(git status --porcelain --untracked-files=no)" ] ||
  die "there are uncommitted changes; commit or stash them first."

step "Merging Overleaf $NEW_SHORT into $(git rev-parse --abbrev-ref HEAD)"
git merge --no-ff --no-commit "$NEW" >/dev/null 2>&1 || true
git rev-parse -q --verify MERGE_HEAD >/dev/null ||
  die "git could not start the merge; run 'git merge $NEW' to see why."

# Files that belong to LocalLeaf keep LocalLeaf's version, whatever Overleaf
# did to its own file of the same name.
while IFS= read -r path; do
  [ -n "$path" ] || continue
  if git cat-file -e "HEAD:$path" 2>/dev/null; then
    git checkout HEAD -- "$path"
  fi
done <<EOF
$(manifest_value keepOursOnMerge)
EOF

# Record the new base now, so that finishing the merge is all that is left.
node -e '
  const fs = require("fs");
  const path = "desktop/upstream.json";
  const manifest = JSON.parse(fs.readFileSync(path, "utf8"));
  manifest.base = { commit: process.argv[1], date: process.argv[2] };
  fs.writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
' "$NEW" "$NEW_DATE"
git add "$MANIFEST"

CONFLICTS="$(git diff --name-only --diff-filter=U)"
if [ -n "$CONFLICTS" ]; then
  printf '\nThese files changed both in Overleaf and in LocalLeaf:\n\n'
  printf '%s\n' "$CONFLICTS" | sed 's/^/  /'
  cat <<EOF

Resolve them (LocalLeaf only adds lines to .gitignore: keep both sides), then:

  git add <the files>
  node desktop/scripts/check-upstream.js
  git commit

To give up:  git merge --abort
EOF
  exit 1
fi

step "Checking the merged tree"
if node desktop/scripts/check-upstream.js; then
  git commit --quiet -m "Merge Overleaf $NEW_SHORT ($NEW_DATE) into LocalLeaf"
  cat <<EOF

Merged and committed. Now make sure the app still works:

  ./build.sh
  (cd desktop && npm test)
  LOCALLEAF_DEBUG=1 desktop/dist/LocalLeaf.app/Contents/MacOS/LocalLeaf   # logs requests the backend does not handle

desktop/UPGRADING.md lists what to look at.
EOF
else
  cat <<EOF

The merge is staged but NOT committed: LocalLeaf has to be adapted first.
Fix what is listed above (desktop/UPGRADING.md explains each kind), run

  node desktop/scripts/check-upstream.js

until it passes, then:  git add -A && git commit
To give up:             git merge --abort
EOF
  exit 1
fi
