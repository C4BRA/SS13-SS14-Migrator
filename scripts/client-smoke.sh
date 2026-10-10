#!/usr/bin/env bash
# Client connect smoke gate (item 73, B-5): converts a small fixture, builds
# the generated solution against the real engine, boots the server, launches
# the generated client headless with --connect, and requires:
#   1. server "Server Version ... -> Ready"
#   2. client reaching RunLevel Connected/InGame (the BaseClient run-level line)
#   3. server-side player attach firing (the B-1 PlayerStatusChanged ->
#      SpawnPlayerMob -> SetAttachedEntity path: "attached to mob")
#
# The headless display mode is a first-class engine feature at pin 9cefa116
# (Robust.Client --headless -> ClydeHeadless + HeadlessAudioManager), so no
# X/GL/audio device is needed. res.texturepreloadingenabled=false is REQUIRED
# headless: the engine's RSI preload queries GL bindings unconditionally and
# aborts on headless otherwise.
#
# Degrades gracefully when RobustToolbox is absent (SS14_ENGINE_DIR or the
# repo's sibling) so CI without the engine still passes with a notice.
#
# Usage: bash scripts/client-smoke.sh
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINE_DIR="${SS14_ENGINE_DIR:-$REPO_DIR/../RobustToolbox}"
# The CLI rejects --output outside $HOME (item 61) — work under the home dir.
WORK="$(mktemp -d "$HOME/.dm2ss14-clientsmoke.XXXXXX")"
SRV_PID=""
CLI_PID=""
cleanup() {
  [ -n "$CLI_PID" ] && kill "$CLI_PID" 2>/dev/null
  [ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null
  # Exact process-name kills: the binaries exec as ./Content.Server etc. so
  # -f path patterns miss them.
  pkill -x Content.Client 2>/dev/null
  pkill -x Content.Server 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT

if [ ! -d "$ENGINE_DIR/.git" ]; then
  echo "[client-smoke] RobustToolbox not found at $ENGINE_DIR — skipping client check (run scripts/setup-engine.sh)"
  exit 0
fi

# Same fixture as boot-smoke: world/New spawns an atom (server-side sanity
# that this converted world boots and the spawn bridge still fires).
mkdir -p "$WORK/code"
cat > "$WORK/code/fixture.dm" <<'EOF'
/world/New()
	..()
	var/obj/bootsmoke_item/o = new /obj/bootsmoke_item(null)
	world.log << "bootsmoke: spawned [o.type]"

/obj/bootsmoke_item
	name = "smoke item"
EOF

echo "[client-smoke] Converting fixture..."
NODE_OPTIONS="--max-old-space-size=4096" SS14_ENGINE_DIR="$ENGINE_DIR" node "$REPO_DIR/dist/cli.js" convert \
  --input "$WORK/code" --output "$WORK/out" > /dev/null 2>&1 || {
  echo "[client-smoke] FAIL: conversion failed"; exit 1;
}

echo "[client-smoke] Building generated solution (engine: $ENGINE_DIR)..."
# Cold builds of the engine graph hit two known first-build races at the pin:
# the NuGet "project.nuget.cache already exists" race (also seen by
# boot-smoke) and the nested CompileRobustXaml msbuild invocation racing
# reference-assembly production (missing obj/.../ref/*.dll) under parallel
# sln builds. Both converge: each pass completes more of the dependency
# graph. Retry a bounded number of times, like boot-smoke does once.
BUILD_OK=""
for attempt in $(seq 1 15); do
  if (cd "$WORK/out" && dotnet build Content.sln --nologo -v q -m:1 > "$WORK/build.log" 2>&1); then
    BUILD_OK=1; break
  fi
  echo "[client-smoke] Build attempt $attempt failed — retrying (engine first-build races)"
done
if [ -z "$BUILD_OK" ]; then
  echo "[client-smoke] FAIL: build failed after retries"; tail -20 "$WORK/build.log"; exit 1
fi
[ -x "$WORK/out/bin/Content.Client/Content.Client" ] || {
  echo "[client-smoke] FAIL: Content.Client binary missing"; exit 1;
}

# The engine's CompileRobustXaml step (Robust.Client) caches a "references"
# file + a `doot` up-to-date marker in the shared engine obj/ — pinned to
# whichever content tree built it last. Under the generated symlinked layout
# those paths point at other (possibly deleted) outputs, and a partial XAML
# rewrite can stick (a failed rewrite strips embedded .xaml resources from
# the assembly). Force a fresh rewrite in THIS tree's context: clear the
# marker, rerun the task, and verify DropDownDebugConsole.xaml actually made
# it in — without compiled xaml the client aborts at
# "No precompiled XAML found for DropDownDebugConsole". If the embedded
# xamls were already stripped, a project rebuild re-embeds them via
# CoreCompile.
RC_DIR="$WORK/out/RobustToolbox/Robust.Client"
RC_OBJ="$RC_DIR/obj/Debug"
has_xaml() {
  # NB: no `grep -q` here — under `set -o pipefail` an early grep exit kills
  # `strings` with SIGPIPE and the pipeline reports 141 even on a match.
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
  # Embedded xamls missing or task failed — force a full re-emit of the
  # project in this context (plain `dotnet build` can skip CoreCompile
  # incrementally); Rebuild cleans obj artifacts then recompiles and
  # re-runs the XAML task, restoring all embedded xaml resources.
  echo "[client-smoke] XAML pass $attempt incomplete — rebuilding Robust.Client"
  rm -f "$RC_OBJ/Robust.Client.dll" "$RC_OBJ/XAML/original.dll"
  (cd "$RC_DIR" && dotnet build Robust.Client.csproj -t:Rebuild --nologo -v q >> "$WORK/xaml.log" 2>&1) || true
done
if ! has_xaml; then
  echo "[client-smoke] FAIL: Robust.Client XAML compile failed"; tail -15 "$WORK/xaml.log"; exit 1
fi
cp "$RC_OBJ/Robust.Client.dll" "$WORK/out/bin/Content.Client/Robust.Client.dll"

# Kill strays from earlier runs (a lingering server holds port 1212).
pkill -x Content.Server 2>/dev/null || true
pkill -x Content.Client 2>/dev/null || true
sleep 1

echo "[client-smoke] Booting server..."
(cd "$WORK/out/bin/Content.Server" && ./Content.Server > "$WORK/server.log" 2>&1) &
SRV_PID=$!

# Poll for Ready (60s; the generated fixture server takes ~10-20s).
for i in $(seq 1 60); do
  grep -q "Server Version .* -> Ready" "$WORK/server.log" 2>/dev/null && break
  sleep 1
done
if ! grep -q "Server Version .* -> Ready" "$WORK/server.log"; then
  echo "[client-smoke] FAIL: server did not reach Ready"; tail -15 "$WORK/server.log"; exit 1
fi
echo "[client-smoke] Server Ready — launching headless client with --connect"

# --headless: ClydeHeadless + HeadlessAudioManager (no GL/audio needed).
# --connect --connect-address 127.0.0.1: auto-connect at end of startup;
# default port is 1212 and the address defaults to localhost.
# --self-contained: userdata lands in bin/Content.Client/user_data so the
# smoke doesn't read or write a shared player profile.
# --cvar res.texturepreloadingenabled=false: texture preload calls GL even
# headless and aborts without it.
(cd "$WORK/out/bin/Content.Client" && \
  ./Content.Client --headless --self-contained --connect --connect-address 127.0.0.1 \
    --cvar res.texturepreloadingenabled=false \
  > "$WORK/client.log" 2>&1) &
CLI_PID=$!

# Poll for the client reaching InGame (90s window: module load + state sync).
CONNECTED=""
for i in $(seq 1 90); do
  if grep -q "Runlevel changed to: InGame\|Received Full GameState" "$WORK/client.log" 2>/dev/null; then
    CONNECTED=1; break
  fi
  # Bail early on a dead client (fatal boot failure).
  if ! kill -0 "$CLI_PID" 2>/dev/null; then break; fi
  sleep 1
done

if [ -z "$CONNECTED" ]; then
  echo "[client-smoke] FAIL: client did not reach Connected/InGame in 90s"
  echo "--- client log tail ---"; tail -25 "$WORK/client.log"
  echo "--- server log tail ---"; tail -10 "$WORK/server.log"
  exit 1
fi

# The server-side B-1 attach path fires when the session goes InGame.
if grep -q "attached to mob" "$WORK/server.log"; then
  echo "[client-smoke] PASS: client connected, received game state; B-1 attach fired"
else
  echo "[client-smoke] FAIL: client connected but no player attach logged"
  grep -iE "player|attach|session" "$WORK/server.log" | tail -10
  exit 1
fi
exit 0
