#!/bin/bash
# Prepares a PR against linuxmint/cinnamon-spices-applets for this applet.
# Run with -h/--help for full usage.

set -euo pipefail

UUID="focal@zoharsnir"
GH_USER="zoharsnir"
REPO_NAME="cinnamon-spices-applets"
UPSTREAM="linuxmint/$REPO_NAME"
FORK_DIR="../$REPO_NAME"  # sibling of this repo's checkout
SCREENSHOT_SRC="screenshots/Popup-Direct-Mode.png"

usage() {
    cat <<EOF
Usage:
  ./publish-to-spice.sh "short description of this change for the commit title"
  ./publish-to-spice.sh --verify-only
  ./publish-to-spice.sh -h | --help

Summary:
Automatically runs all steps required to submit a release to spice repo.
Prints a link for a human to review and open a ready and pre-populated PR.

Details:
Builds/updates the spices submission layout for this applet in a local
fork of $UPSTREAM
($FORK_DIR, a sibling of this repo's checkout),
validates it with upstream's own validate-spice tool, commits, and
pushes a branch - then prints a GitHub compare URL for you to review
and open the PR yourself via the web UI. Never opens the PR itself.

  --verify-only   Build and validate the submission layout without
                  committing, pushing, or touching GitHub beyond what's
                  needed to have a local fork clone to work in (creates
                  the fork/clone on first use same as a real run). Use
                  this as a quick "did I break anything" check mid-cycle
                  when you're not ready to publish yet.

Each run resets the local fork clone to a clean baseline first - master,
no leftover branches or uncommitted changes from a previous run. This
tool treats each run as an atomic action: it never resumes a failed run
or asks you to run something to "unblock" a broken state - if a run fails
partway, interim state is retained for troubleshooring and the next run
(or the next --verify-only) cleans up after it automatically and runs from
scratch on the clean state. When hitting an issue, fix the root and just
run it again.

Must be run as ./publish-to-spice.sh from this repo's root - not via an
absolute/relative path from elsewhere, and not sourced.
EOF
}

# Announces a major step, distinct from the "Refusing to continue: ..." /
# "Failed ..." style used for errors (which stay on stderr, unprefixed).
step() {
    echo
    echo "==> $*"
}

VERIFY_ONLY=0
DESCRIPTION=""
case "${1:-}" in
    -h | --help | -help | --h | help | h | "/?" | "-?" | "?")
        usage
        exit 0
        ;;
    --verify-only)
        VERIFY_ONLY=1
        ;;
    "")
        usage
        exit 1
        ;;
    *)
        DESCRIPTION="$1"
        ;;
esac

# --- Must be run as ./publish-to-spice.sh from this exact directory, so the
# relative paths above (and the source file references below) are unambiguous
# regardless of whose machine/directory layout this runs on. ---
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ "$SCRIPT_DIR" != "$(pwd)" ]; then
    echo "Run this as ./publish-to-spice.sh from the repo root (got invoked from $(pwd), script lives in $SCRIPT_DIR)" >&2
    exit 1
fi

BRANCH="focal-update-$(date +%Y%m%d-%H%M%S)"
COMMIT_TITLE="focal: $DESCRIPTION"

# --- Ensure the fork exists ---
step "Ensuring fork of $UPSTREAM exists..."
if ! gh repo view "$GH_USER/$REPO_NAME" >/dev/null 2>&1; then
    echo "Forking $UPSTREAM..."
    gh repo fork "$UPSTREAM" --clone=false
else
    echo "Fork already exists."
fi

# --- Ensure a local clone exists ---
# A fork just created by `gh repo fork` above can take a few seconds to
# finish setting up on GitHub's side before it's cloneable (more likely on
# a monorepo this size) - retry instead of failing outright on the very
# first run.
step "Ensuring local clone exists..."
if [ ! -d "$FORK_DIR" ]; then
    CLONE_MAX_ATTEMPTS=6
    CLONE_RETRY_DELAY=10 # seconds; ~60s total worst-case wait across all attempts
    attempt=1
    while true; do
        echo "Cloning fork into $FORK_DIR (attempt $attempt/$CLONE_MAX_ATTEMPTS)..."
        if git clone "https://github.com/$GH_USER/$REPO_NAME.git" "$FORK_DIR"; then
            break
        fi
        if [ "$attempt" -ge "$CLONE_MAX_ATTEMPTS" ]; then
            echo "Failed to clone fork after $CLONE_MAX_ATTEMPTS attempts - it may still be initializing on GitHub's side. Just run this script again in a bit; it's safe to re-run." >&2
            exit 1
        fi
        echo "Clone failed - fork may still be initializing, retrying in ${CLONE_RETRY_DELAY}s..." >&2
        sleep "$CLONE_RETRY_DELAY"
        attempt=$((attempt + 1))
    done
    git -C "$FORK_DIR" remote add upstream "https://github.com/$UPSTREAM.git"
else
    echo "Local clone already present."
fi

# --- Sanity checks before anything destructive touches $FORK_DIR ---
if [ -z "$FORK_DIR" ] || [ "$FORK_DIR" = "/" ] || [ "$FORK_DIR" = "$HOME" ]; then
    echo "Refusing to continue: FORK_DIR looks wrong ('$FORK_DIR')" >&2
    exit 1
fi
if [ ! -d "$FORK_DIR/.git" ]; then
    echo "Refusing to continue: $FORK_DIR is not a git repo" >&2
    exit 1
fi
FORK_DIR_ABS="$(cd "$FORK_DIR" && pwd)"  # canonical absolute path, used below for real (not string-pattern) containment checks
ORIGIN_URL="$(git -C "$FORK_DIR" remote get-url origin 2>/dev/null || true)"
case "$ORIGIN_URL" in
    *"$GH_USER/$REPO_NAME"*) ;;
    *)
        echo "Refusing to continue: $FORK_DIR's origin ('$ORIGIN_URL') doesn't look like your fork" >&2
        exit 1
        ;;
esac

# --- Reset to a clean baseline before doing anything else ---
# No resuming/recovering a previous failed run - each run is all-or-nothing,
# so it starts by discarding whatever a prior interrupted run might have left
# behind (a half-built branch, uncommitted files under $UUID) rather than
# trying to clean up after itself on the way out. Scoped clean to $UUID since
# that's the only thing this tool ever touches in the fork.
step "Resetting local fork clone to a clean baseline..."
git -C "$FORK_DIR" reset --hard HEAD
git -C "$FORK_DIR" clean -fd -- "$UUID"
git -C "$FORK_DIR" checkout master
git -C "$FORK_DIR" reset --hard HEAD
for b in $(git -C "$FORK_DIR" branch --list "focal-update-*" --format='%(refname:short)'); do
    git -C "$FORK_DIR" branch -D "$b"
done

# --- Sync fork's master with upstream (monorepo gets constant unrelated traffic) ---
step "Syncing fork with upstream..."
git -C "$FORK_DIR" fetch upstream
git -C "$FORK_DIR" merge --ff-only upstream/master
git -C "$FORK_DIR" push origin master

# --- Branch ---
step "Creating branch $BRANCH..."
git -C "$FORK_DIR" checkout -b "$BRANCH"

# --- Copy files into the spices-expected layout (clean mirror each run) ---
# DEST's safety depends entirely on UUID being non-empty and FORK_DIR_ABS
# being correct (both already checked above) - if UUID were ever empty,
# DEST would resolve to FORK_DIR itself, and rm -rf would wipe the whole
# cloned fork (.git included). Resolve the REAL filesystem path (realpath
# -m, so it doesn't matter whether DEST exists yet) and verify it's a
# proper, non-empty subdirectory strictly inside FORK_DIR_ABS - checking
# the resolved path's actual structure, not just pattern-matching the
# string we built one line above (which can't meaningfully fail).
step "Building spices submission layout..."
if [ -z "$UUID" ]; then
    echo "Refusing to continue: UUID is empty" >&2
    exit 1
fi
DEST="$FORK_DIR/$UUID"
DEST_ABS="$(cd "$FORK_DIR_ABS" && realpath -m "$UUID")"
if [ "$DEST_ABS" = "$FORK_DIR_ABS" ] || [ "$(basename "$DEST_ABS")" != "$UUID" ]; then
    echo "Refusing to continue: resolved DEST ('$DEST_ABS') doesn't look like a proper uuid subdirectory" >&2
    exit 1
fi
case "$DEST_ABS" in
    "$FORK_DIR_ABS"/*)
        ;;
    *)
        echo "Refusing to continue: resolved DEST ('$DEST_ABS') is not inside FORK_DIR ('$FORK_DIR_ABS')" >&2
        exit 1
        ;;
esac
rm -rf "$DEST_ABS"
mkdir -p "$DEST/files/$UUID"

cp info.json "$DEST/info.json"
cp README.md "$DEST/README.md"
cp "$SCREENSHOT_SRC" "$DEST/screenshot.png"
cp applet.js settings-schema.json stylesheet.css icon.png "$DEST/files/$UUID/"

# metadata.json's "last-edited" is forbidden by validate-spice (spices
# manages it on their end) but stays in our own copy - Cinnamon's own About
# dialog reads it locally. Strip it only from the copy being published.
python3 -c "
import json
with open('metadata.json') as f:
    data = json.load(f)
data.pop('last-edited', None)
with open('$DEST/files/$UUID/metadata.json', 'w') as f:
    json.dump(data, f, indent=2)
    f.write('\n')
"

# cp -r would also pull in gitignored __pycache__/*.pyc, which validate-spice
# forbids (no binaries/compiled code) - copy source only.
mkdir -p "$DEST/files/$UUID/helper"
cp helper/calendar_helper.py "$DEST/files/$UUID/helper/"

# Translation files - po/ lives inside files/{uuid}/, not at the submission
# root, since it's part of what Cinnamon actually installs (cinnamon-spices-
# makepot compiles it to the runtime locale dir on install/test).
mkdir -p "$DEST/files/$UUID/po"
cp po/*.pot po/*.po "$DEST/files/$UUID/po/" 2>/dev/null || cp po/*.pot "$DEST/files/$UUID/po/"

# --- Validate against upstream's own checker (needs the Pillow Python
# package - validate-spice uses it to confirm icon.png is square) ---
step "Validating submission with validate-spice..."
(cd "$FORK_DIR" && python3 validate-spice "$UUID")

if [ "$VERIFY_ONLY" -eq 1 ]; then
    git -C "$FORK_DIR" checkout master
    git -C "$FORK_DIR" branch -D "$BRANCH"
    echo
    echo "Verification passed - nothing was committed or pushed."
    exit 0
fi

# --- Abort cleanly if nothing actually changed ---
step "Checking for changes..."
git -C "$FORK_DIR" add -A "$UUID"
if git -C "$FORK_DIR" diff --cached --quiet; then
    echo "No changes to publish."
    git -C "$FORK_DIR" checkout master
    git -C "$FORK_DIR" branch -d "$BRANCH"
    exit 0
fi

# --- Commit and push ---
step "Committing and pushing..."
git -C "$FORK_DIR" commit -m "$COMMIT_TITLE"
git -C "$FORK_DIR" push -u origin "$BRANCH"

# --- Print a ready-to-review PR URL (web UI, title pre-filled) ---
TITLE_ENC=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$COMMIT_TITLE")

echo
echo "Pushed. Review and open the PR here:"
echo "https://github.com/$UPSTREAM/compare/master...$GH_USER:$REPO_NAME:$BRANCH?expand=1&title=$TITLE_ENC"
