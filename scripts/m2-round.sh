#!/usr/bin/env bash
# M2 round-flow gate (W-N): converts tests/m2-round (paradise gameticker +
# jobs + spawn chain on a demo corpus), builds the generated solution, boots
# the server, connects a headless client, and asserts the round-flow chain:
#
#   R1  world/New completes (M2R-WORLD) and the server reaches Ready
#   R2  gameticker fires: lobby accept -> "Game will start" -> SETUP
#       (M2R-JOIN state=0, M2R-RUNLEVEL 2 = RUNLEVEL_SETUP)
#   R3  job assignment: assign_all_roles runs over GLOB.player_list, the
#       joined player's mind gets a role (ready=1, role=Assistant)
#   R4  spawn-in: create_characters + EquipRank — mob lands on the job's
#       start landmark (M2R-WHERE x=5 y=7) wearing the job's outfit datum
#       (M2R-WHO job=Assistant outfit=/datum/outfit/job/assistant), then
#       PLAYING (ticker_state=3, M2R-RUNLEVEL 4 = RUNLEVEL_GAME)
#   R5  post-round state verbs work on the attached mob: GetJob resolves,
#       name_occupations dict populated (M2R-PROBE names=2), occupations
#       listed (M2R-JOB lines)
#
# Exit 0 only if every element PASSes; each element reports PASS/FAIL with
# log evidence. Degrades gracefully without the engine (like m1-gate).
#
# Usage: bash scripts/m2-round.sh
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINE_DIR="${SS14_ENGINE_DIR:-$REPO_DIR/../RobustToolbox}"
DEMO_DIR="$REPO_DIR/tests/m2-round"
WORK="$(mktemp -d "$HOME/.dm2ss14-m2round.XXXXXX")"
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
  echo "[m2-round] RobustToolbox not found at $ENGINE_DIR — skipping (run scripts/setup-engine.sh)"
  exit 0
fi
if [ ! -f "$DEMO_DIR/code/m2r.dm" ]; then
  echo "[m2-round] FAIL: demo corpus missing at $DEMO_DIR"; exit 1
fi

echo "[m2-round] work dir: $WORK"
echo "[m2-round] Converting round-flow corpus..."
NODE_OPTIONS="--max-old-space-size=4096" SS14_ENGINE_DIR="$ENGINE_DIR" node "$REPO_DIR/dist/cli.js" convert \
  --input "$DEMO_DIR" --output "$WORK/out" > "$WORK/convert.log" 2>&1 || {
  echo "[m2-round] FAIL: conversion failed"; tail -20 "$WORK/convert.log"; exit 1;
}

echo "[m2-round] Building generated solution (engine: $ENGINE_DIR)..."
BUILD_OK=""
for attempt in $(seq 1 15); do
  if (cd "$WORK/out" && dotnet build Content.sln --nologo -v q -m:1 > "$WORK/build.log" 2>&1); then
    BUILD_OK=1; break
  fi
  echo "[m2-round] Build attempt $attempt failed — retrying (engine first-build races)"
done
if [ -z "$BUILD_OK" ]; then
  echo "[m2-round] FAIL: build failed after retries"; tail -20 "$WORK/build.log"; exit 1
fi
[ -x "$WORK/out/bin/Content.Client/Content.Client" ] || {
  echo "[m2-round] FAIL: Content.Client binary missing"; exit 1;
}

# Robust.Client XAML embed fix: building through the symlinked
# $WORK/out/RobustToolbox path flattens embedded resource names (every xaml
# then fails "Unable to find type 'X'" -> "No precompiled XAML"). Build via
# the RESOLVED real engine path and verify the namespaced Populate entries
# landed before copying the dll into the solution bin.
RT_REAL="$(readlink -f "$WORK/out/RobustToolbox")"
RC_DIR="$RT_REAL/Robust.Client"
RC_OBJ="$RC_DIR/obj/Debug"
has_xaml() {
  strings "$RC_OBJ/Robust.Client.dll" 2>/dev/null | grep "Populate:Robust.Client.UserInterface.CustomControls" >/dev/null
}
for attempt in $(seq 1 4); do
  has_xaml && break
  (cd "$RC_DIR" && dotnet build Robust.Client.csproj -t:Rebuild --nologo -v q > "$WORK/xaml.log" 2>&1) || true
  echo "[m2-round] XAML pass $attempt — rebuilt Robust.Client via real path"
done
if ! has_xaml; then
  echo "[m2-round] FAIL: Robust.Client XAML embed failed"; tail -15 "$WORK/xaml.log"; exit 1
fi
cp "$RC_OBJ/Robust.Client.dll" "$WORK/out/bin/Content.Client/Robust.Client.dll"
mkdir -p "$WORK/out/RobustToolbox/Robust.Client/obj/Debug/ref"
cp "$RC_OBJ/Robust.Client.dll" "$WORK/out/RobustToolbox/Robust.Client/obj/Debug/ref/Robust.Client.dll" 2>/dev/null || true

# keybinds: emitted `type: Function` crashes the client at bind-parse time
# (W-G ss14Template region — workaround lives here until that lands).
find "$WORK/out" -name "keybinds.yml" -exec sed -i 's/^  type: Function$/  type: State/' {} +

pkill -x Content.Server 2>/dev/null || true
pkill -x Content.Client 2>/dev/null || true
sleep 1

echo "[m2-round] Booting server..."
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
  echo "[m2-round] FAIL: server did not reach Ready"; tail -20 "$WORK/server.log"; exit 1
fi

# Autocmds drive the player session (B-6 seam). The ticker needs ~6s after
# InGame to finish lobby -> setup -> spawn, so pad with dmloc calls before
# querying state. {attached} is unreliable (can bind the landmark datum);
# dmverbon resolves via DatumForPath to the real mob.
cat > "$WORK/out/Resources/autocmds.txt" <<'EOF'
dmloc
dmverbs
dmloc
dmloc
dmloc
dmloc
dmloc
dmloc
dmloc
dmloc
dmloc
dmloc
dmloc
dmloc
dmloc
dmverbon /mob/living/carbon/human m2r_state
dmverbon /mob/living/carbon/human m2r_who
dmverbon /mob/living/carbon/human m2r_probe
dmverbon /mob/living/carbon/human m2r_jobs
dmloc
EOF
N_CMDS=$(wc -l < "$WORK/out/Resources/autocmds.txt")

echo "[m2-round] Server Ready — launching headless client ($N_CMDS autocmds)"
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

echo "[m2-round] ---- element verdicts ----"
FAIL=0
verdict() { # name, ok(0/1), evidence
  if [ "$2" = 0 ]; then echo "  [PASS] $1 — $3"; else echo "  [FAIL] $1 — $3"; FAIL=1; fi
}

# R1: world/New + server Ready.
R1=0
grep -q "M2R-WORLD: world/New complete" "$WORK/server.log" || R1=1
verdict "R1 world/New ran" $R1 "$(grep -E "M2R-WORLD" "$WORK/server.log" | tail -1)"

# R2: lobby join + ticker countdown -> SETUP runlevel.
R2=0
grep -q "M2R-JOIN: new_player .* in lobby (state=0)" "$WORK/client.log" || R2=1
grep -q "M2R-RUNLEVEL: 2" "$WORK/client.log" || R2=1
verdict "R2 join -> lobby -> SETUP (runlevel 2)" $R2 "$(grep -E "M2R-JOIN|M2R-RUNLEVEL: 2" "$WORK/client.log" | tr '\n' ' | ')"

# R3: role assignment over player_list; joined mind gets Assistant.
R3=0
grep -q "M2R-DBG: assign_all_roles list=[1-9]" "$WORK/client.log" || R3=1
grep -q "M2R-DBG: player .* ready=1" "$WORK/client.log" || R3=1
grep -q "M2R-DBG: create_character ckey=.* role=Assistant" "$WORK/client.log" || R3=1
verdict "R3 job/role assignment (Assistant)" $R3 "$(grep -E "assign_all_roles|ready=|role=" "$WORK/client.log" | tr '\n' ' | ')"

# R4: spawn at job landmark + outfit + round reaches PLAYING/GAME.
R4=0
grep -q "M2R-DBG: equipOutfit_impl /datum/outfit/job/assistant" "$WORK/client.log" || R4=1
grep -q "M2R-RUNLEVEL: 4" "$WORK/client.log" || R4=1
grep -q "M2R-STATE: ticker_state=3" "$WORK/client.log" || R4=1
grep -q "M2R-WHO: .* job=Assistant .* outfit=/datum/outfit/job/assistant" "$WORK/client.log" || R4=1
grep -q "M2R-WHERE: x=5 y=7" "$WORK/client.log" || R4=1
verdict "R4 spawn at job landmark + equip" $R4 "$(grep -E "M2R-WHO|M2R-WHERE|ticker_state" "$WORK/client.log" | tr '\n' ' | ')"

# R5: post-round queries — GetJob resolves, dicts populated.
R5=0
grep -q "M2R-PROBE: getjob=\S\+ names=[1-9]" "$WORK/client.log" || R5=1
grep -q "M2R-JOB: Assistant" "$WORK/client.log" || R5=1
verdict "R5 jobs dict + GetJob resolve" $R5 "$(grep -E "M2R-PROBE|M2R-JOB" "$WORK/client.log" | tr '\n' ' | ')"

echo "[m2-round] logs: $WORK/{server,client,build,convert}.log"
if [ $FAIL = 0 ]; then
  echo "[m2-round] PASS: round-flow slice verified end-to-end"
else
  echo "[m2-round] FAIL: one or more elements failed — see verdicts above"
  echo "--- client log tail ---"; tail -15 "$WORK/client.log"
  echo "--- server log tail ---"; tail -10 "$WORK/server.log"
fi
exit $FAIL
