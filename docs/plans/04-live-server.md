# Plan 04 — Live-Server Integration

Status: not started (PLAN.md Phase 3 deferred item) · Owner: integration ·
Effort: 3–6 weeks · Impact: turns "compiles" into "runs"

## Goal

Boot converted DM as a **headless Robust.Server** and prove real behavior: tick
execution, `world <<` output, `spawn`/`sleep` scheduling, datum/entity lifecycle,
and log-asserted gameplay smoke tests. This is the missing verification layer —
everything today is engine-free runtime + compile proof.

## Current state

- Generated solutions build against **real RobustToolbox** (pinned commit `9cefa116`,
  `engine.pin`, `scripts/setup-engine.sh`; RobustToolbox checkout exists at
  `/Users/russellrozario/Documents/antigravity/RobustToolbox`).
- `SS13.DM.Runtime` (`src/runtimeTemplate/dmRuntimeCS.ts`) is engine-free:
  `DMValue`, `DMList`, `ProcRegistry`, `DMTickScheduler` (uses `Task.Delay` — wall
  clock, not engine ticks), `DMNew`/`DMDelete`/`DMCallProc` operating on
  `DMRuntime` datums with `LiveDatums` tracking.
- `ConvertedDMSystem.cs` template exists: a real `EntitySystem` with
  `SubscribeLocalEvent`, `ComponentInit : EntityEventArgs`, `[RegisterComponent]`,
  `[DataField]`s — verified against engine sources.
- No process ever runs the converted code against the real engine.

## Design

### 1. Tick integration (foundation)

Replace `DMTickScheduler`'s `Task.Delay` with an injected tick source:

```
interface IGameTick { TimeSpan Now { get; } TimeSpan TickRate { get; } }
```

- Default engine-free implementation keeps `Task.Delay` (probes unchanged).
- Robust.Server wiring: in `ConvertedDMSystem.Initialize`, resolve
  `IGameTiming` from the engine, pass it into `DMTickScheduler.Configure(timing)`.
- DM `sleep(n)` = 1 decisecond = 100ms; map via tick rate
  (`timing.TickPeriod` × ceil(n / tickrate_deci)) with `Timing.CreateTimer` +
  `EventBus` suspension instead of async/await where possible (async in an
  `EntitySystem` is acceptable for v1 — log ordering is what we assert).

### 2. Entity lifecycle bridge

- `DMNew`/`DMDelete` today mutate `LiveDatums` (a dictionary) and never touch the
  engine. Bridge: `DMNew` for entity-typed paths (`/obj/*`, `/mob/*`, `/turf/*`,
  `/area/*` — the `ensureBaseTypes` mapping already maps these in YAML output)
  creates an `EntityUid` via `EntityManager.SpawnEntity` (or `CreateEntity` +
  `Initialize`), attaches the generated component, and binds
  `DMRuntime ↔ EntityUid` in both directions.
- `DMRuntime` gains `EntityUid? EntityId` and the system maintains a
  `Dictionary<EntityUid, DMRuntime>`; datum vars read/write stay on the runtime,
  component sync happens on events.
- `qdel`/`del` → `EntityManager.DeleteEntity`; `LiveDatums` pruned by system tick
  (or component shutdown event).

### 3. World plumbing

- `world << "text"` already emits `DMOutput` — route to `Console.WriteLine` in
  server build (v1) so log assertions can capture it; keep the engine-free default.
- `world` datum vars (`world.time`, `world.tick_lag`, `world.map`) — `world.time`
  from `IGameTiming.CurTick` (or `GameTiming.RealTime`); the probe currently stubs
  `world.time` — make it engine-real in server mode.
- `spawn(n){}` bodies already emit `DMTickScheduler.Spawn` — same tick-source
  injection as `sleep`.

### 4. Test harness (the deliverable)

`scripts/live-server.sh`:

1. Build the generated solution (real engine, `SS14_ENGINE_DIR`).
2. Boot `Robust.Server` headless with the converted system + a tiny generated grid
   (reuse the DMM→grid pipeline; a 5×5 test map).
3. Feed log-scenario DM snippets (compiled into the solution), assert on server
   stdout: proc execution order, `world <<` lines, sleep tick counts, spawn
   interleaving, qdel lifecycle.
4. Exit code reflects assertion pass/fail.

Scenario suite (start small, grow):
- boot: server starts, `InitGlobal*` procs run in declaration order (already a probe)
- tick: `world.time` advances with ticks
- sleep: `sleep(5)` resumes after ≥5 ticks
- spawn: two spawns interleave per BYOND ordering rules
- lifecycle: `new /obj/x` → entity spawned; `qdel` → entity deleted (log proof)
- output: `world << "hello"` appears in server log exactly once

## Implementation steps

1. `IGameTick` abstraction + `DMTickScheduler.Configure`; keep engine-free probes
   green (default provider).
2. World/output plumbing in server mode; log-based `world <<` assertion.
3. Entity bridge: `DMNew/DMDelete` → engine entities for entity paths; bind/unbind.
4. Tick-scheduled `spawn`/`sleep` on engine timers.
5. `scripts/live-server.sh` + scenario suite; wire into `build-loop.sh` as an
   optional stage.
6. First TG-derived smoke: boot with a converted `world.dm`-style file; get to
   "server runs N ticks without crash, logs the expected lines".

## Verification

- Every scenario asserts concrete log lines, not just "no crash".
- Existing suites must stay green engine-free: `npm test`, probes, compile proof.
- `live-server.sh` is part of `build-loop.sh` (skippable when no engine is present).

## Success criteria

- Headless server boots converted TG-derived code and runs ≥ 1,000 ticks without
  unhandled exceptions; scenario suite passes.
- `world.time`, `sleep`, `spawn`, `new`, `qdel` proven tick-correct on the real
  engine (5+ scenarios).
- PLAN.md Phase 3 "live server integration" item flips to done (server half; client
  remains out of scope).

## Risks / decisions

- **Async vs event-driven**: `Task.Delay`-based code inside an `EntitySystem` can
  starve or drift under tick preemption. Decision for v1: accept async + tick-source
  injection, verify ordering empirically; v2 can move to `TimerComponent`/events.
- **Engine API drift**: mitigated by `engine.pin` + `build-loop.sh`; the bridge lives
  in one adapter file so drift is contained.
- **DM's cooperative preemption** (BYOND interrupts procs at `sleep`/`spawn`
  boundaries only) has no direct SS14 equivalent — our model (async resumption at
  boundaries) is actually closer to BYOND than C# threading, which is the point of
  the tick-scheduler design.
- **Client/UI** (verbs, winset, screen objects) is explicitly out of scope here —
  see Plan 05 and the UI batch in Plan 01.
