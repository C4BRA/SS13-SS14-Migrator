#!/usr/bin/env bash
# Phase 0 build loop — the project's definition of "compiles":
#   1. npm ci + tsc build
#   2. npm test (unit suites + integration: transpile fixture -> solution
#      -> dotnet build against the REAL RobustToolbox, exit 0)
#   3. semantic differential probes (engine-free; honest fidelity count)
#
# Usage:   bash scripts/build-loop.sh
# Env:     SS14_ENGINE_DIR   (default: <repo>/../RobustToolbox)

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export SS14_ENGINE_DIR="${SS14_ENGINE_DIR:-$REPO_DIR/../RobustToolbox}"

if [ ! -f "$SS14_ENGINE_DIR/Robust.Shared/Robust.Shared.csproj" ]; then
  echo "[phase0] RobustToolbox not found at $SS14_ENGINE_DIR"
  echo "[phase0] Run: bash scripts/setup-engine.sh   (or set SS14_ENGINE_DIR)"
  exit 1
fi

cd "$REPO_DIR"

echo "[phase0] npm ci"
npm ci --silent

echo "[phase0] npm run build"
npm run build

echo "[phase0] --- npm test (unit + integration + real-engine build) ---"
npm test

echo "[phase0] --- semantic differential probes ---"
npm run audit:semantics

echo "[phase0] Build loop green."
