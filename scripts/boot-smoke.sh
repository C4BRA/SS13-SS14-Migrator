#!/usr/bin/env bash
# Boot smoke gate (item 68, B-0): converts a small fixture, builds the
# generated solution against the real engine (when present), boots the server
# for a few seconds, and requires the "Server Version ... -> Ready" line.
#
# Degrades gracefully when RobustToolbox is absent (SS14_ENGINE_DIR or the
# repo's sibling) so CI without the engine still passes with a notice.
#
# Usage: bash scripts/boot-smoke.sh
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINE_DIR="${SS14_ENGINE_DIR:-$REPO_DIR/../RobustToolbox}"
# The CLI rejects --output outside $HOME (item 61) — work under the home dir.
WORK="$(mktemp -d "$HOME/.dm2ss14-bootsmoke.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

if [ ! -d "$ENGINE_DIR/.git" ]; then
  echo "[boot-smoke] RobustToolbox not found at $ENGINE_DIR — skipping boot check (run scripts/setup-engine.sh)"
  exit 0
fi

# Small fixture exercising procs, a switch, a default arg, a label, and the
# entity spawn bridge (world/New spawns an atom -> real SS14 entity).
mkdir -p "$WORK/code"
cat > "$WORK/code/fixture.dm" <<'EOF'
/world/New()
	..()
	var/obj/bootsmoke_item/o = new /obj/bootsmoke_item(null)
	world.log << "bootsmoke: spawned [o.type]"

/obj/bootsmoke_item
	name = "smoke item"

/datum/bootsmoke/proc/compute(a = 5)
	switch (a)
		if (1, 2)
			return 10
		else
			return 20

/datum/bootsmoke/proc/outer()
	var/count = 0
	while (count < 3)
		count += 1
	return count
EOF

echo "[boot-smoke] Converting fixture..."
NODE_OPTIONS="--max-old-space-size=4096" SS14_ENGINE_DIR="$ENGINE_DIR" node "$REPO_DIR/dist/cli.js" convert \
  --input "$WORK/code" --output "$WORK/out" > /dev/null 2>&1 || {
  echo "[boot-smoke] FAIL: conversion failed"; exit 1;
}

echo "[boot-smoke] Building Content.Server (engine: $ENGINE_DIR)..."
# Retry once: the engine projects intermittently hit a NuGet cache race
# ("project.nuget.cache already exists") when built from a fresh solution.
if ! (cd "$WORK/out" && dotnet build -v q > "$WORK/build.log" 2>&1); then
  echo "[boot-smoke] Build failed — retrying once"
  if ! (cd "$WORK/out" && dotnet build -v q > "$WORK/build.log" 2>&1); then
    echo "[boot-smoke] FAIL: build failed"; tail -20 "$WORK/build.log"; exit 1
  fi
fi

echo "[boot-smoke] Booting server (45s window)..."
# Kill any stray converted-server from earlier runs (a lingering process
# holds port 1212 and fails the boot with 'Address already in use').
pkill -f "bin/Content.Server/Content.Server" 2>/dev/null || true
sleep 1
(cd "$WORK/out/bin/Content.Server" && ./Content.Server > "$WORK/boot.log" 2>&1 & echo $! > "$WORK/pid")
sleep 45
kill "$(cat "$WORK/pid")" 2>/dev/null || true
pkill -f "bin/Content.Server/Content.Server" 2>/dev/null || true
wait "$(cat "$WORK/pid")" 2>/dev/null || true

if grep -q "Server Version .* -> Ready" "$WORK/boot.log"; then
  ERRORS="$(grep -cE 'ERRO|FATL' "$WORK/boot.log" || true)"
  echo "[boot-smoke] PASS: server reached Ready (boot errors: $ERRORS)"
  if grep -q 'Spawned "obj_bootsmoke_item"' "$WORK/boot.log"; then
    echo "[boot-smoke] PASS: entity spawn bridge materialized the DM atom"
  else
    echo "[boot-smoke] FAIL: entity spawn bridge did not fire"; grep -iE "spawn|dm" "$WORK/boot.log" | tail -5; exit 1
  fi
  exit 0
fi
echo "[boot-smoke] FAIL: server did not reach Ready"; tail -15 "$WORK/boot.log"; exit 1
