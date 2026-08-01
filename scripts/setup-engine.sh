#!/usr/bin/env bash
# Fetches the pinned RobustToolbox checkout required to build generated
# solutions against the real engine.
#
# Usage:   bash scripts/setup-engine.sh
# Env:     SS14_ENGINE_DIR   (default: <repo>/../RobustToolbox)
#
# Mirrors engine.pin: shallow clone + shallow submodules.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINE_DIR="${SS14_ENGINE_DIR:-$REPO_DIR/../RobustToolbox}"
PIN_FILE="$REPO_DIR/engine.pin"

if [ ! -f "$PIN_FILE" ]; then
  echo "[setup-engine] engine.pin not found at $PIN_FILE" >&2
  exit 1
fi

COMMIT="$(grep -m1 '^commit:' "$PIN_FILE" | awk '{print $2}')"
REPO_URL="$(grep -m1 '^repo:' "$PIN_FILE" | awk '{print $2}')"

if [ ! -d "$ENGINE_DIR/.git" ]; then
  echo "[setup-engine] Cloning $REPO_URL -> $ENGINE_DIR"
  git clone --depth 1 "$REPO_URL" "$ENGINE_DIR"
fi

echo "[setup-engine] Fetching submodules (shallow)"
git -C "$ENGINE_DIR" submodule update --init --depth 1 >/dev/null

CURRENT="$(git -C "$ENGINE_DIR" rev-parse HEAD)"
if [ "$CURRENT" != "$COMMIT" ]; then
  echo "[setup-engine] WARNING: engine HEAD is $CURRENT, engine.pin wants $COMMIT"
  echo "[setup-engine] Update engine.pin or check out the pinned commit."
else
  echo "[setup-engine] Engine at pinned commit $COMMIT OK"
fi
