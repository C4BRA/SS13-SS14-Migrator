#!/usr/bin/env bash
# M1 acceptance gate (item 74, B-6): converts tests/m1-demo, builds the
# generated solution against the real engine, boots the server, connects a
# headless client, drives the *player session's* dm* commands through the
# generated client's DM_AUTOCMDS channel, and asserts each M1 element:
#
#   E1  server Ready + converted map loaded (grids, tile defs, turf datums)
#   E2  client Connected/InGame + B-1 player attach (server "attached to mob")
#   E3  mob visibly rendered: client-side Sprite component resolves the
#       emitted RSI (entfo dump, no missing-RSI errors)
#   E4  movement: dmverb moves the attached mob (x/y/z datum vars change;
#       engine coords change in the client-side entity dump)
#   E5  interaction: dmclick/dmverbon fire Click()/verb on the demo object
#       and the observable output lands ('usr <<' -> client console,
#       'world <<' -> server log + client console)
#
# Exit 0 only if every element PASSes; each element reports PASS/FAIL with a
# grepable evidence line. Degrades gracefully without the engine (like
# boot-smoke/client-smoke).
#
# Usage: bash scripts/m1-gate.sh
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINE_DIR="${SS14_ENGINE_DIR:-$REPO_DIR/../RobustToolbox}"
DEMO_DIR="$REPO_DIR/tests/m1-demo"
WORK="$(mktemp -d "$HOME/.dm2ss14-m1gate.XXXXXX")"
SRV_PID=""
CLI_PID=""
cleanup() {
  [ -n "$CLI_PID" ] && kill "$CLI_PID" 2>/dev/null
  [ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null
  pkill -x Content.Client 2>/dev/null
  pkill -x Content.Server 2>/dev/null
}
trap cleanup EXIT

if [ ! -d "$ENGINE_DIR/.git" ]; then
  echo "[m1-gate] RobustToolbox not found at $ENGINE_DIR — skipping (run scripts/setup-engine.sh)"
  exit 0
fi
if [ ! -f "$DEMO_DIR/code/m1.dm" ]; then
  echo "[m1-gate] FAIL: demo corpus missing at $DEMO_DIR"; exit 1
fi

# Keep the work dir so logs survive for inspection on failure.
echo "[m1-gate] work dir: $WORK"
echo "[m1-gate] Converting demo corpus..."
NODE_OPTIONS="--max-old-space-size=4096" SS14_ENGINE_DIR="$ENGINE_DIR" node "$REPO_DIR/dist/cli.js" convert \
  --input "$DEMO_DIR" --output "$WORK/out" > "$WORK/convert.log" 2>&1 || {
  echo "[m1-gate] FAIL: conversion failed"; tail -20 "$WORK/convert.log"; exit 1;
}

echo "[m1-gate] Building generated solution (engine: $ENGINE_DIR)..."
BUILD_OK=""
for attempt in $(seq 1 15); do
  if (cd "$WORK/out" && dotnet build Content.sln --nologo -v q -m:1 > "$WORK/build.log" 2>&1); then
    BUILD_OK=1; break
  fi
  echo "[m1-gate] Build attempt $attempt failed — retrying (engine first-build races)"
done
if [ -z "$BUILD_OK" ]; then
  echo "[m1-gate] FAIL: build failed after retries"; tail -20 "$WORK/build.log"; exit 1
fi
[ -x "$WORK/out/bin/Content.Client/Content.Client" ] || {
  echo "[m1-gate] FAIL: Content.Client binary missing"; exit 1;
}

# Robust.Client XAML embed fix — same shared-engine-obj quirk as
# scripts/client-smoke.sh (see its comment): re-run CompileRobustXaml in
# this tree's context and verify DropDownDebugConsole.xaml embedded.
RC_DIR="$WORK/out/RobustToolbox/Robust.Client"
RC_OBJ="$RC_DIR/obj/Debug"
has_xaml() {
  strings "$RC_OBJ/Robust.Client.dll" 2>/dev/null | grep "DropDownDebugConsole.xaml" >/dev/null
}
for attempt in $(seq 1 6); do
  has_xaml && break
  rm -f "$RC_OBJ/XAML/doot"
  (cd "$RC_DIR" && dotnet msbuild Robust.Client.csproj /t:CompileRobustXaml \
      /p:_RobustForceInternalMSBuild=true /p:Configuration=Debug \
      /p:RuntimeIdentifier= /p:TargetFramework=net10.0 \
      /p:BuildProjectReferences=false /p:IntermediateOutputPath="obj/Debug//" \
      --nologo -v q > "$WORK/xaml.log" 2>&1) || true
  has_xaml && break
  echo "[m1-gate] XAML pass $attempt incomplete — rebuilding Robust.Client"
  rm -f "$RC_OBJ/Robust.Client.dll" "$RC_OBJ/XAML/original.dll"
  (cd "$RC_DIR" && dotnet build Robust.Client.csproj -t:Rebuild --nologo -v q >> "$WORK/xaml.log" 2>&1) || true
done
if ! has_xaml; then
  echo "[m1-gate] FAIL: Robust.Client XAML compile failed"; tail -15 "$WORK/xaml.log"; exit 1
fi
cp "$RC_OBJ/Robust.Client.dll" "$WORK/out/bin/Content.Client/Robust.Client.dll"

pkill -x Content.Server 2>/dev/null || true
pkill -x Content.Client 2>/dev/null || true
sleep 1

echo "[m1-gate] Booting server..."
(cd "$WORK/out/bin/Content.Server" && \
  ./Content.Server --config-file ../../Resources/ConfigFiles/server_config.toml \
  > "$WORK/server.log" 2>&1) &
SRV_PID=$!

for i in $(seq 1 90); do
  grep -q "Server Version .* -> Ready" "$WORK/server.log" 2>/dev/null && break
  kill -0 "$SRV_PID" 2>/dev/null || break
  sleep 1
done
if ! grep -q "Server Version .* -> Ready" "$WORK/server.log"; then
  echo "[m1-gate] FAIL: server did not reach Ready"; tail -20 "$WORK/server.log"; exit 1
fi

# Resources/autocmds.txt drives the client session's console (B-6 seam:
# the headless client has no stdin console; content is sandboxed so no env
# var). One command per line; {attached} -> mob uid; 1s between commands.
cat > "$WORK/out/Resources/autocmds.txt" <<'EOF'
dmloc
dmverbs
entfo {attached}
dumpentities
dmverb step_north
dmloc
dmverb step_east
dmloc
dmclick /obj/m1_button
dmverbon /obj/m1_button poke
dmloc
dumpentities
entfo {attached}
EOF
N_CMDS=$(wc -l < "$WORK/out/Resources/autocmds.txt")

echo "[m1-gate] Server Ready — launching headless client ($N_CMDS autocmds)"
(cd "$WORK/out/bin/Content.Client" && \
  ALSOFT_DRIVERS=null ./Content.Client \
    --headless --self-contained --connect --connect-address 127.0.0.1 \
    --cvar res.texturepreloadingenabled=false \
  > "$WORK/client.log" 2>&1) &
CLI_PID=$!

# Wait for InGame, then let the autocmd queue drain (2s arm + 1s per cmd).
for i in $(seq 1 120); do
  if grep -q "Runlevel changed to: InGame\|Received Full GameState" "$WORK/client.log" 2>/dev/null; then
    break
  fi
  if ! kill -0 "$CLI_PID" 2>/dev/null; then break; fi
  sleep 1
done
sleep $((N_CMDS + 6))

echo "[m1-gate] ---- element verdicts ----"
FAIL=0
verdict() { # name, ok(0/1), evidence
  if [ "$2" = 0 ]; then echo "  [PASS] $1 — $3"; else echo "  [FAIL] $1 — $3"; FAIL=1; fi
}

# E1: server Ready + converted map loaded.
E1=0
grep -q "World init: loaded map" "$WORK/server.log" || E1=1
grep -q "Registered .* converted tile definitions" "$WORK/server.log" || E1=1
grep -q "minted turf datums" "$WORK/server.log" || E1=1
grep -q "M1-WORLD: world/New complete" "$WORK/server.log" || E1=1
verdict "E1 server Ready + map loaded" $E1 "$(grep -E "loaded map|tile definitions|minted turf" "$WORK/server.log" | tr '\n' ' | ')"

# E2: client InGame + B-1 attach.
E2=0
grep -q "Runlevel changed to: InGame\|Received Full GameState" "$WORK/client.log" || E2=1
grep -q "attached to mob" "$WORK/server.log" || E2=1
verdict "E2 client connect + player attach" $E2 "$(grep -E "attached to mob" "$WORK/server.log" | tail -1)"

# E3: visible rendering — sprite path resolves client-side. Evidence:
# entfo dumps the mob's SpriteComponent visible with a live sprite layer
# (state=human, UseSpriteStrategy — a resolved texture strategy), the
# button entity streams to the client (dumpentities), and the log has no
# missing-RSI/texture errors. Pixel-level rendering is unverifiable
# headless (see docs/plans/21-b6-m1-gate.md).
E3=0
grep -qE "Unable to load RSI|Unable to load layer RSI|Failed to load RSI|missing texture|Resource not found" "$WORK/client.log" && E3=1
grep -q "mob_living_carbon_human/m1 player" "$WORK/client.log" || E3=1
grep -q "Robust.Client.GameObjects.SpriteComponent" "$WORK/client.log" || E3=1
grep -q "UseSpriteStrategy" "$WORK/client.log" || E3=1
grep -qE "entity [0-9]+, obj_m1_button" "$WORK/client.log" || E3=1
verdict "E3 sprite/appearance resolves client-side" $E3 "$(grep -E "vis/depth|rsi/state|UseSpriteStrategy" "$WORK/client.log" | tail -2 | tr '\n' ' | ')"

# E4: movement — dmloc coords change and/or M1-MOVE log.
E4=0
grep -q "M1-MOVE: mob moved to" "$WORK/server.log" || E4=1
# dmloc output lines "x=.., y=.., z=.." — expect y to differ across calls.
LOCS=$(grep -oE "x=[0-9.]+, y=[0-9.]+, z=[0-9.]+" "$WORK/client.log" | sort -u | wc -l)
[ "$LOCS" -ge 2 ] || E4=1
verdict "E4 movement (dmloc coords changed: $LOCS distinct)" $E4 "$(grep -oE "x=[0-9.]+, y=[0-9.]+, z=[0-9.]+" "$WORK/client.log" | sort -u | tr '\n' ' | ')"

# E5: interaction — Click() fired, output observed both sides.
E5=0
grep -q "M1-CLICK:" "$WORK/server.log" || E5=1
grep -q "M1-CLICK client" "$WORK/client.log" || E5=1
verdict "E5 interaction (Click fired + output)" $E5 "$(grep -E "M1-CLICK" "$WORK/server.log" | tail -1)"

echo "[m1-gate] logs: $WORK/{server,client,build,convert}.log"
if [ $FAIL = 0 ]; then
  echo "[m1-gate] PASS: M1 minimum playable demo verified end-to-end"
else
  echo "[m1-gate] FAIL: one or more M1 elements failed — see verdicts above"
  echo "--- client log tail ---"; tail -15 "$WORK/client.log"
  echo "--- server log tail ---"; tail -10 "$WORK/server.log"
fi
exit $FAIL
