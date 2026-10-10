# Plan 26 — W-E subsystem thread-safety (RegisterSubsystems off the IoC thread)

Status: **executed 2026-10-10** · scope `src/transpiler/csharpEmitter.ts`
(`RegisterSubsystems` region), `src/runtimeTemplate/dmRuntimeCS.ts`
(`DMTickScheduler` PumpGate region), `src/tests/*` (append-only) · wave-4 W-E
task.

## Problem

The generated `ConvertedDMSystem.RegisterSubsystems` wrapped subsystem
construction in `Task.Run(async () => ...)`:

```csharp
_ = Task.Run(async () =>
{
    foreach (var typePath in ...)
    {
        var datum = await DMRuntimeHelpers.DMNew(worldDatum, typePath);
        ...
        DMTickScheduler.RegisterTickCallback(async () => await subsystem.CallProc(procName, ...));
    }
});
```

`Task.Run` pushes the whole chain — `DMNew`, the datum's `New()` (which for
SS13 `/datum/controller` types typically spawns atoms, wires timers, and
mutates shared datum state), and every async continuation — onto a
**thread-pool thread**. The engine asserts otherwise:

- `EntityManager.ThreadCheck()` (`Robust.Shared/GameObjects/EntityManager.cs`)
  throws `DebugAssertException` on any entity op off the main thread —
  reachable immediately via a subsystem `New()` that does
  `new /obj/...` → `EntitySpawnBridge`.
- `IoCManager.Resolve` asserts thread context: *"IoC has no context on this
  thread."* — hit when the spawn bridge logs the failure (`Logger.ErrorS` →
  `LogManagerSingleton` → `IoCManager.Resolve`), so the original assert
  **escalated**: the faulted task's exception was never observed →
  `[ERRO] unobserved` spam every GC — **and** the tick callback was never
  registered, so every `/datum/controller` silently went dead.

Reproduced against m1-demo + appended `/datum/controller` corpus
(`fire`/`process`, `new` an obj inside `New()`): the server log showed the
unobserved exception and **no** `DM subsystem ... on the tick loop` lines —
subsystems existed in the registry but never made it onto the cadence.

A second, latent race: `DMTickScheduler.ExternalDriver` is set in
`Initialize` *before* `StartWorld` runs, but the wall-clock fallback driver
starts lazily on the first `RegisterTickCallback`/`ScheduleSleep` — i.e.
during `world/New()` — and notices the flag only *between* pumps. For one
iteration the fallback thread could drain due callbacks while
`EntitySystem.Update` pumps the same scheduler → DM state mutated on two
threads at once.

## Approach

- **csharpEmitter.ts — `RegisterSubsystems` (rewritten, W-E region).**
  Registration no longer leaves the calling thread. `StartWorld` is invoked
  by the content EntryPoint `PostInit()` on the server's main (IoC) thread —
  where `RobustSynchronizationContext` is installed — so every `await` in
  the new `RegisterSubsystemsAsync` (DMNew, `New()`, any `sleep`/`spawn`
  inside it) resumes on the main thread via `TaskManager.ProcessPendingTasks`
  each tick, and the registered cadence callback's `CallProc` later fires
  inside `Pump` from `Update` on that same thread. No dedicated marshal
  needed — staying on the calling thread *is* the marshal.
  - `RegisterSubsystemsAsync` DMNew's each `/datum/controller*` type
    **sequentially**, matching BYOND's in-order boot; a failing `New()` is
    logged (`DM subsystem {Type} init failed`) and skipped instead of
    silently faulting a fire-and-forget task.
  - Proc resolution now checks `TryGet` **then** `TryGetInherited` for both
    `fire` and `process`. `TryGetInherited` walks ancestors only, so a
    `process()` declared on the leaf type (a legal `/datum/controller`
    shape) was silently skipped before — real product bug surfaced by the
    repro corpus.
- **dmRuntimeCS.ts — `DMTickScheduler.PumpGate`.** Whole `Pump` bodies now
  run under `lock (PumpGate)` so the external/fallback driver overlap
  window (one iteration while `ExternalDriver` settles) can never run two
  due-drains or tick-callback passes concurrently. Single-driver operation
  is unchanged: on a live server `Pump` is only called from `Update`.

## Verification

- `npm run build` clean, `npm test` all-pass (incl. new assertions),
  `npm run audit:semantics` **245/245** probes green — tick/sleep/spawn
  FIFO and `world.time` grid untouched (PumpGate serializes only the
  driver-overlap window; ordering semantics inside Pump are byte-identical).
- Converted repro corpus (`m1.dm` + `/datum/controller/subsystem`
  `wait = 1` + `fire`, subtype `m1_sub` whose `New()` does
  `new /obj/we_marker`, leaf-declared `process` on `/datum/controller/leaf_proc`):
  `dotnet build Content.Server.csproj` 0 errors; server log now shows all
  three `DM subsystem ... on the tick loop` registrations, the spawned
  `obj_we_marker` entity, `WE-SUB`/`WE-LEAF` `New()` output, and
  `WE-SUB-FIRE: t=N`/`WE-LEAF-PROC: t=N` cadence on the tick grid
  (438 invocations in ~25 s at `wait = 1`).
- `grep` for `unobserved` / `IoC has no context` / `DebugAssert` /
  `Entity spawn failed` / `[ERRO]` in the post-fix log: **zero hits**
  (pre-fix log had the unobserved exception chain and no registrations).
- `bash scripts/boot-smoke.sh` PASS (the engine `Robust.Client` XAMLIL /
  `ref/*.dll` first-build race on the shared engine `obj` needed retries —
  documented flake, m1-gate has the same fix-up pass).

## Notes / limits

- With `game.auto_pause_empty` (engine default `true`) and no client
  connected, `GameTiming.Paused` zeroes `frameTime` → DM clock does not
  advance → cadence idle. That matches BYOND: a playerless world does not
  tick. Verification runs set `auto_pause_empty = false` in the generated
  config (output-dir only, not repo) to exercise the loop headlessly.
- The cadence callback still invokes `CallProc` fire-and-forget per tick
  boundary (unchanged B-2 cadence semantics); its continuations now always
  resume on the main thread under `RobustSynchronizationContext`.
