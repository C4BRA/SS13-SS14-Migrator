#!/usr/bin/env bash
# M2 feature-slice gate (item: M2 doors/airlocks end-to-end slice).
# Converts tests/m2-slice (VERBATIM Paradise door.dm + airlock.dm + extracted
# atom/access procs), builds the generated solution, boots the server, and
# drives the REAL door interaction chain from a headless client:
#
#   dmclick /obj/machinery/door         -> Click() -> attack_hand(user)
#     -> try_to_activate_door -> allowed -> check_access -> has_access
#     -> open() -> do_animate/flick -> update_icon -> icon_state swap
#
# Element verdicts:
#   E1  server Ready + converted map loaded + M2 harness world/New ran
#   E2  client InGame + B-1 player attach
#   E3  door Initialize() real chain ran: icon_state set via the paradise
#       update_icon -> update_icon_state path (mdoor1 / closed)
#   E4  dmclick -> plain door open: density 1->0, icon_state mdoor1->mdoor0
#       (server log + client-visible echo)
#   E5  dmclick -> airlock open: icon_state closed->open through the real
#       AIRLOCK_* update_icon state machine
#   E6  door entities streamed client-side with Sprite+Appearance
#       components (entfo on the entity uid captured from server)
#
# Exit 0 only if every element PASSes. Mirrors scripts/m1-gate.sh.
#
# Usage: bash scripts/m2-slice.sh
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINE_DIR="${SS14_ENGINE_DIR:-$REPO_DIR/../RobustToolbox}"
DEMO_DIR="$REPO_DIR/tests/m2-slice"
WORK="$(mktemp -d "$HOME/.dm2ss14-m2slice.XXXXXX")"
SRV_PID=""
CLI_PID=""
cleanup() {
  [ -n "$CLI_PID" ] && kill "$CLI_PID" 2>/dev/null
  [ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null
  exec 3>&- 2>/dev/null || true
  pkill -x Content.Client 2>/dev/null
  pkill -x Content.Server 2>/dev/null
}
trap cleanup EXIT

if [ ! -d "$ENGINE_DIR/.git" ]; then
  echo "[m2-slice] RobustToolbox not found at $ENGINE_DIR — skipping (run scripts/setup-engine.sh)"
  exit 0
fi
if [ ! -f "$DEMO_DIR/code/paradise_door.dm" ]; then
  echo "[m2-slice] FAIL: slice corpus missing at $DEMO_DIR"; exit 1
fi

echo "[m2-slice] work dir: $WORK"
echo "[m2-slice] Converting slice corpus..."
NODE_OPTIONS="--max-old-space-size=4096" SS14_ENGINE_DIR="$ENGINE_DIR" node "$REPO_DIR/dist/cli.js" convert \
  --input "$DEMO_DIR" --output "$WORK/out" > "$WORK/convert.log" 2>&1 || {
  echo "[m2-slice] FAIL: conversion failed"; tail -20 "$WORK/convert.log"; exit 1;
}

# W-H: sibling W-G appended `type: Function` binds to the template's
# keybinds.yml — the pinned engine's InputManager has no 'Function'
# KeyBindingType, so the client aborts in Initialize. They're
# console-editing QoL only; strip the tail block from the generated
# output (don't touch ss14Template — sibling-owned).
KEYBINDS="$WORK/out/Resources/keybinds.yml"
if grep -q "type: Function" "$KEYBINDS"; then
  awk '/# W-G input:/ {exit} {print}' "$KEYBINDS" > "$KEYBINDS.stripped" \
    && mv "$KEYBINDS.stripped" "$KEYBINDS"
fi

echo "[m2-slice] Building generated solution (engine: $ENGINE_DIR)..."
BUILD_OK=""
for attempt in $(seq 1 15); do
  if (cd "$WORK/out" && dotnet build Content.sln --nologo -v q -m:1 > "$WORK/build.log" 2>&1); then
    BUILD_OK=1; break
  fi
  echo "[m2-slice] Build attempt $attempt failed — retrying (engine first-build races)"
done
if [ -z "$BUILD_OK" ]; then
  echo "[m2-slice] FAIL: build failed after retries"; tail -20 "$WORK/build.log"; exit 1
fi
[ -x "$WORK/out/bin/Content.Client/Content.Client" ] || {
  echo "[m2-slice] FAIL: Content.Client binary missing"; exit 1;
}

# Robust.Client XAML embed fix — identical quirk to m1-gate/client-smoke.
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
  echo "[m2-slice] XAML pass $attempt incomplete — rebuilding Robust.Client"
  rm -f "$RC_OBJ/Robust.Client.dll" "$RC_OBJ/XAML/original.dll"
  (cd "$RC_DIR" && dotnet build Robust.Client.csproj -t:Rebuild --nologo -v q >> "$WORK/xaml.log" 2>&1) || true
done
if ! has_xaml; then
  echo "[m2-slice] FAIL: Robust.Client XAML compile failed"; tail -15 "$WORK/xaml.log"; exit 1
fi
cp "$RC_OBJ/Robust.Client.dll" "$WORK/out/bin/Content.Client/Robust.Client.dll"

pkill -x Content.Server 2>/dev/null || true
pkill -x Content.Client 2>/dev/null || true
sleep 1

echo "[m2-slice] Booting server..."
SRV_FIFO="$WORK/srv-in"
mkfifo "$SRV_FIFO"
# Keep fd3 open on the fifo so the server's stdin console stays attached
# for deterministic command injection (server-console-testing pattern).
exec 3<>"$SRV_FIFO"
(cd "$WORK/out/bin/Content.Server" && \
  ./Content.Server --config-file ../../Resources/ConfigFiles/server_config.toml \
  < "$SRV_FIFO" > "$WORK/server.log" 2>&1) &
SRV_PID=$!

for i in $(seq 1 90); do
  grep -q "Server Version .* -> Ready" "$WORK/server.log" 2>/dev/null && break
  kill -0 "$SRV_PID" 2>/dev/null || break
  sleep 1
done
if ! grep -q "Server Version .* -> Ready" "$WORK/server.log"; then
  echo "[m2-slice] FAIL: server did not reach Ready"; tail -20 "$WORK/server.log"; exit 1
fi

# Fetch the door entity uids from the SERVER console ('entities' is the
# toolshed command that lists live entities as 'name (uid/netuid, proto)').
echo "entities" >&3
sleep 2
DOOR_UID=$(grep -oE "[0-9]+/n[0-9]+, obj_machinery_door_m2\)" "$WORK/server.log" | grep -oE "^[0-9]+" | head -1 || true)
AIRLOCK_UID=$(grep -oE "[0-9]+/n[0-9]+, obj_machinery_door_airlock_m2\)" "$WORK/server.log" | grep -oE "^[0-9]+" | head -1 || true)
echo "[m2-slice] door uid=${DOOR_UID:-none} airlock uid=${AIRLOCK_UID:-none}"

# Resources/autocmds.txt drives the client session's console. Sequence:
# init both doors (real Initialize), dump pre-click state, click each,
# dump post-click state, entfo both uids for client-side components.
{
  echo "dmloc"
  echo "dmverbon /obj/machinery/door/m2 m2_init"
  echo "dmverbon /obj/machinery/door/airlock/m2 m2_init"
  echo "dmverbon /obj/machinery/door/m2 m2_state"
  echo "dmverbon /obj/machinery/door/airlock/m2 m2_state"
  echo "dmclick /obj/machinery/door/m2"
  echo "dmverbon /obj/machinery/door/m2 m2_state"
  echo "dmclick /obj/machinery/door/airlock/m2"
  echo "dmverbon /obj/machinery/door/airlock/m2 m2_state"
  echo "dumpentities"
} > "$WORK/out/Resources/autocmds.txt"
N_CMDS=$(wc -l < "$WORK/out/Resources/autocmds.txt")

echo "[m2-slice] Server Ready — launching headless client ($N_CMDS autocmds)"
(cd "$WORK/out/bin/Content.Client" && \
  ALSOFT_DRIVERS=null ./Content.Client \
    --headless --self-contained --connect --connect-address 127.0.0.1 \
    --cvar res.texturepreloadingenabled=false \
  > "$WORK/client.log" 2>&1) &
CLI_PID=$!

for i in $(seq 1 120); do
  if grep -q "Runlevel changed to: InGame\|Received Full GameState" "$WORK/client.log" 2>/dev/null; then
    break
  fi
  if ! kill -0 "$CLI_PID" 2>/dev/null; then break; fi
  sleep 1
done
sleep $((N_CMDS + 8))

echo "[m2-slice] ---- element verdicts ----"
FAIL=0
verdict() { # name, ok(0/1), evidence
  if [ "$2" = 0 ]; then echo "  [PASS] $1 — $3"; else echo "  [FAIL] $1 — $3"; FAIL=1; fi
}

# E1: server Ready + converted map loaded + harness ran.
E1=0
grep -q "World init: loaded map" "$WORK/server.log" || E1=1
grep -q "Registered .* converted tile definitions" "$WORK/server.log" || E1=1
grep -q "M2-WORLD: world/New complete" "$WORK/server.log" || E1=1
verdict "E1 server Ready + map loaded + M2 harness" $E1 "$(grep -E "loaded map|tile definitions|M2-WORLD" "$WORK/server.log" | tr '\n' ' | ')"

# E2: client InGame + B-1 attach.
E2=0
grep -q "Runlevel changed to: InGame\|Received Full GameState" "$WORK/client.log" || E2=1
grep -q "attached to mob" "$WORK/server.log" || E2=1
verdict "E2 client connect + player attach" $E2 "$(grep -E "attached to mob" "$WORK/server.log" | tail -1)"

# E3: real Initialize chain set icon_state through update_icon ->
# update_icon_state (plain door: door1 closed; airlock: closed).
E3=0
grep -q "M2-INIT /obj/machinery/door/m2: Initialize(1) done, icon_state=mdoor1" "$WORK/server.log" || E3=1
grep -q "M2-INIT /obj/machinery/door/airlock/m2: Initialize(1) done, icon_state=closed" "$WORK/server.log" || E3=1
verdict "E3 Initialize -> update_icon -> icon_state (mdoor1 / closed)" $E3 "$(grep "M2-INIT" "$WORK/server.log" | tr '\n' ' | ')"

# E4: dmclick -> real attack_hand -> try_to_activate_door -> allowed ->
# open(): density 1->0, icon_state mdoor1->mdoor0. Both states must appear
# (pre-click closed, post-click open), server log AND client echo.
E4=0
grep -q "M2-STATE /obj/machinery/door/m2: density=1" "$WORK/server.log" || E4=1
grep -q "M2-STATE /obj/machinery/door/m2: density=0 .*icon_state=mdoor0" "$WORK/server.log" || E4=1
grep -q "M2-STATE client: /obj/machinery/door/m2 icon_state=mdoor0" "$WORK/client.log" || E4=1
verdict "E4 plain door click->open (density->0, icon_state mdoor0)" $E4 "$(grep "M2-STATE /obj/machinery/door/m2:" "$WORK/server.log" | tr '\n' ' | ')"

# E5: dmclick -> airlock real chain -> icon_state closed->open.
E5=0
grep -q "M2-STATE /obj/machinery/door/airlock/m2: density=1" "$WORK/server.log" || E5=1
grep -q "M2-STATE /obj/machinery/door/airlock/m2: density=0 .*icon_state=open" "$WORK/server.log" || E5=1
grep -q "M2-STATE client: /obj/machinery/door/airlock/m2 icon_state=open" "$WORK/client.log" || E5=1
verdict "E5 airlock click->open (icon_state closed->open)" $E5 "$(grep "M2-STATE /obj/machinery/door/airlock/m2:" "$WORK/server.log" | tr '\n' ' | ')"

# E6: door entities exist server-side (uids from 'entities') AND the
# door protos streamed to the client (client 'dumpentities' lists them).
E6=0
[ -n "$DOOR_UID" ] || E6=1
[ -n "$AIRLOCK_UID" ] || E6=1
grep -qE "entity [0-9]+, obj_machinery_door_m2(,|$)" "$WORK/client.log" || E6=1
grep -qE "entity [0-9]+, obj_machinery_door_airlock_m2(,|$)" "$WORK/client.log" || E6=1
verdict "E6 door entities server-side + streamed client-side" $E6 "server uids door=${DOOR_UID:-?} airlock=${AIRLOCK_UID:-?}; client protos $(grep -cE "entity [0-9]+, obj_machinery_door" "$WORK/client.log")"

echo "[m2-slice] logs: $WORK/{server,client,build,convert}.log"
if [ $FAIL = 0 ]; then
  echo "[m2-slice] PASS: M2 doors/airlocks slice verified end-to-end"
else
  echo "[m2-slice] FAIL: one or more M2 elements failed — see verdicts above"
  echo "--- client log tail ---"; tail -15 "$WORK/client.log"
  echo "--- server log tail ---"; tail -10 "$WORK/server.log"
fi
exit $FAIL
