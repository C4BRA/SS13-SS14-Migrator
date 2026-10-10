# Plan 20 — B-5 Client boot (item 73)

Status: **executed 2026-10-10** · scope `src/project/ss14Template.ts`,
`scripts/client-smoke.sh` (new), `src/tests/runTests.ts` (append-only
probes) · PLAN.md item 73.

## Problem

Generated solutions emitted a real `Content.Server` entry
(`ContentStart.Start` → `GameServer` → Ready on :1212) but the client
was a `Console.WriteLine` stub — nothing could connect, render, or
exercise the B-1 player-attach path end to end.

## Engine conventions verified at pin 9cefa116

- **Entry**: `Robust.Client.ContentStart.Start(args)` is the public
  client host (same shape as `ContentStart`/`GameServer` on the server
  side). It constructs `GameController` with `StartType.Content`.
- **Mounts** (`ProgramShared.DoMounts`, dev layout): the binary dir is
  mounted at `/Assemblies/`; content root is resolved two levels up
  from the exe, so the client binary MUST land at
  `<solution>/bin/Content.Client/`; `<solution>/Resources/` mounts at
  `/`. Engine `Resources/` mounts too.
- **Module loading**: `_modLoader.TryLoadModulesFrom("/Assemblies/",
  "Content.")` — every `GameShared`/`GameClient` subclass in
  `Content.*` assemblies is instantiated as an entry point.
- **Registration parity**: the engine never calls
  `IComponentFactory.DoAutoRegistrations()` or `GenerateNetIds()`
  client-side — content's `GameClient.Init()` must, or the first
  spawned entity throws (and after net ids are generated the component
  table locks).
- **Client-side ignores required**:
  `IComponentFactory.RegisterIgnore("DMRuntime")` — the server-only
  DMRuntime component sits in every emitted entity prototype;
  `IPrototypeManager.RegisterIgnore("dmTile")` — unknown `type:` kinds
  throw `PrototypeLoadException` for the whole yaml document, which
  would drop every entity prototype.
- **Connect args** (`CommandLineArgs`): `--headless` (ClydeHeadless +
  HeadlessAudioManager), `--connect`, `--connect-address` (default
  localhost:1212), `--username`, `--self-contained`. The manifest is
  `Resources/manifest.yml` (`ResourceManifestData`: window title,
  `autoConnect`).
- **Builtin connect screen**:
  `DebugBuiltinConnectionScreenState`/`DebugBuiltinConnectionScreen`
  are `[ContentAccessAllowed]` engine UI — a working connect dialog
  with zero content UI code.
- **Headless client also needs**
  `--cvar res.texturepreloadingenabled=false`:
  `ResourceCache.PreloadRsis` calls `GL.GetInteger` unconditionally at
  startup even under `--headless` (engine bug at this pin) and crashes
  with `InvalidOperationException`.
- **XAML is mandatory at startup**: `UserInterfaceManager.Initialize`
  loads `DropDownDebugConsole` even headless — a `Robust.Client.dll`
  that missed the `CompileRobustXaml` rewrite aborts boot with
  "No precompiled XAML found".

## What changed

- `Content.Client.csproj` — real executable: `OutputType=Exe`,
  `AppendTargetFrameworkToOutputPath=false`,
  `OutputPath=..\bin\Content.Client\` (mount convention above),
  engine `Shared.props` + `Client.props` imports plus
  `Robust.Properties.targets` and the entity-system-subscriptions
  generator targets (same import set as `Content.Server`).
- `Content.Client/Program.cs` — `[STAThread] Main → ContentStart.Start(args)`.
- `Content.Client/EntryPoint.cs` (new) — `GameClient` entry point:
  `Init()` registers the two ignores, runs
  `DoAutoRegistrations`+`GenerateNetIds`;
  `PostInit()` requests `DebugBuiltinConnectionScreenState`.
- `Resources/manifest.yml` — `defaultWindowTitle` + `autoConnect: true`.
- `scripts/client-smoke.sh` (new) — converts the `world/New` fixture,
  builds the generated solution, boots server + headless client with
  `--connect`, and asserts the B-1 attach (`attached to mob` in the
  server log).
- `src/tests/runTests.ts` — 11 new probes (item 73) on emitted client
  files; the real-engine build check now retries serially (bounded) —
  see build hygiene below.

## Build hygiene (engine shared-obj quirk)

The generated `RobustToolbox` is a **symlink** to the checkout, so
engine `obj/` dirs are shared across every generated tree. Parallel
`dotnet build Content.sln` runs race each other's
`obj/.../ref/*.dll` (transient CS0006) and the nested
`CompileRobustXaml` msbuild call can rewrite `Robust.Client.dll` with
a partial xaml set. The smoke script therefore:

1. builds the sln serially (`-m:1`) with a bounded retry (each pass
   completes more of the dependency graph);
2. deletes the `XAML/doot` incremental marker, re-runs the inner
   `CompileRobustXaml` in the current context, and *verifies*
   `DropDownDebugConsole.xaml` is embedded (`strings`), falling back
   to `dotnet build -t:Rebuild` when the embedded resources were
   stripped;
3. copies the verified dll into `bin/Content.Client/`.

Gotcha: `set -o pipefail` + `strings … | grep -q` can never succeed
(early grep exit → SIGPIPE → 141); the check must drain the pipe.

## Manual connect path

```bash
# server (default :1212)
cd <out>/bin/Content.Server && ./Content.Server --config-file ../../Resources/ConfigFiles/server_config.toml
# client, headless auto-connect
cd <out>/bin/Content.Client && ./Content.Client --headless --self-contained --connect --connect-address 127.0.0.1 --cvar res.texturepreloadingenabled=false
# client, windowed (needs a display)
./Content.Client --self-contained --connect --connect-address 127.0.0.1
```

`--connect-address` defaults to `localhost:1212`; `--username` picks
the display name; the engine's builtin connect screen shows when run
windowed without `--connect`.

## Verification

- `scripts/client-smoke.sh` → **PASS**: client log reaches
  `Runlevel changed to: InGame` / `Received Full GameState: to=1` /
  `Attaching local player to player (2/n3, dm_player_mob, …)`;
  server log `[INFO] dm: Player … attached to mob "3" (proto
  "dm_player_mob")` — the B-1 attach path fired over the wire.
- Client + server serializer hashes match
  (`A80FF7F8BA816F7B…`).
- `npm run build` clean; `npm test` green (all prior probes + 11 new);
  `npm run audit:semantics` 218/218.
- Generated solution `dotnet build Content.sln` converges to 0 errors
  under `-m:1` retries (shared-obj races documented above).

## Known limits

- The client joins on the builtin debug connect screen — a real SS14
  lobby UI is intentionally out of scope for M1.
- `--cvar res.texturepreloadingenabled=false` is required for headless
  boots (engine GL call unguarded at the pin); windowed boots don't
  need it.
- `dmTile` prototypes are server-side-only by design (tile defs load
  via `ConvertedDMSystem`); the client tolerates them through the
  registered ignore.
