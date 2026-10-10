# Plan 16 — B-2 World/tick/time layer (item 70)

Status: **executed 2026-10-10** · scope `src/runtimeTemplate/dmRuntimeCS.ts`,
`src/transpiler/csharpEmitter.ts` (additive tick-pump region only),
`src/tests/fidelityDifferential.test.ts` · PLAN.md item 70.

## Problem

`DMTickScheduler` was a wall-clock shim: `Sleep` was `Task.Delay`, `Spawn`
was `Task.Run` + delay. Nothing was driven by a world tick, `world.time`
was a static `0`, `world.realtime`/`world.tick_lag`/`world.fps` were
defaults, and there was no per-tick hook for DM subsystem loops
(`fire`/`process`). On the engine side, the generated
`ConvertedDMSystem` declared no `Update` override — which is also the
verified reason the item-69 note's "Update never fired":
`EntitySystemManager.TickUpdate` only calls `system.Update(frameTime)`
when the type declares the method itself (`NeedsUpdate` checks
`Update.DeclaringType != typeof(EntitySystem)`).

DM timing semantics verified against the official BYOND reference
(byond.com/docs/ref/info.html, spawn/sleep/world entries) and the BYOND
help guide:

- `world.time` = "the number of server ticks that have passed multiplied
  by world.tick_lag" — **game time**, not real time; paused/idle servers
  do not advance it. Units: deciseconds (1/10 s); `tick_lag` default 1.
- `sleep(Delay)` takes **deciseconds**, not ticks — "sleep(1) still
  means sleep for 1/10s" whatever `tick_lag`/`fps` is. Durations are
  rounded to whole ticks (the wake fires on a tick boundary);
  `sleep(0)`/negative = defer to the end of the current scheduler pass
  (backlog check). Same-tick wakes fire in sleep order (FIFO).
- `spawn(Delay) body` schedules the block after `Delay` ds (same wake
  rules); `spawn(0)` queues at the end of the current scheduler pass;
  `spawn(-1)` runs the body **immediately** in the current proc (the
  BYOND copy also defers the caller's continuation — that half is not
  modeled; the body starting synchronously is the observable half).
- `world.realtime` = ds since **2000-01-01 00:00:00 GMT** (BYOND era);
  `world.timeofday` = ds since 00:00:00 GMT today. `world.fps` and
  `world.tick_lag` are linked: `fps = 10/tick_lag`.
- BYOND 515+ calls `world.Tick()` at the **end** of every server tick —
  the cadence hook point.

Engine timing verified at the pinned engine (`RobustToolbox` @
9cefa11): `BaseServer.Update` → `EntitySystemManager.TickUpdate`
per `GameLoop` tick with `frameTime = IGameTiming.TickPeriod` seconds,
skipped while paused — exactly DM's "game time" clock source.

## Approach

- **`DMTickScheduler.cs` (emitted, rewritten)** — a DM game-time clock
  (`_clockDs`, deciseconds) that only advances via `Pump(elapsedDs)`.
  - *Scheduling:* a `PriorityQueue<Entry, (DueDs, Seq)>` — due callbacks
    pop in `(due, insertion)` order = BYOND's FIFO-within-a-tick.
    `DueFor(n>0)` rounds the delay up onto the tick grid
    (`(floor(clock/lag) + ceil(n/lag)) * lag`); `n<=0` = due now (end of
    the current drain pass, since the drain loops until the queue is
    quiet — BYOND's "end of the current scheduler" yield).
  - *Pump:* drains all due entries, then — once per world-tick boundary
    crossed — runs the registered per-tick callbacks (subsystem cadence)
    and `world.Tick()`. Wakes fire **before** the same tick's
    `world.Tick()` (BYOND: Tick runs at tick end).
  - *Drivers:* engine path — `ConvertedDMSystem.Update` calls
    `Pump(frameTime * 10)` and `Initialize` sets `ExternalDriver = true`.
    Engine-free path — a daemon thread (`EnsureFallbackDriver`, started
    lazily by the first scheduled callback) converts wall-clock into
    whole `tick_lag` quanta, so probes observe exact tick-aligned times.
  - *Public surface:* `TickLag` (live `world.tick_lag` read, default 1),
    `NowDs`, `WorldTimeDs` (`floor(clock/lag)*lag`), `TicksElapsed`,
    `Pump`, `RegisterTickCallback`/`UnregisterTickCallback`,
    `Sleep`/`Spawn`/`SpawnExpr` (signatures unchanged for emitters).
- **`DMRuntimeHelpers.cs` (emitted)** — `DMWorld : DMRuntime` overrides
  the now-`virtual` `SetVar` to link `world.fps`/`world.tick_lag` writes
  (writing one rewrites the other). `BuildWorld` constructs a `DMWorld`;
  `WorldTickLag()` reads the var live. `DMGetProperty` world cases:
  `time` → scheduler game time, `realtime` → ds since the BYOND era,
  `timeofday` → ds since GMT midnight, `fps` → `10/tick_lag`,
  `tick_lag` → live var.
- **`csharpEmitter.ts` `generateSystemCS` (additive)** — new region:
  `public override void Update(float frameTime)` pumping the scheduler
  with simulated seconds→deciseconds (paused sim = frozen DM clock,
  matching BYOND), plus `RegisterSubsystems()` called from `StartWorld`:
  every registered type under `/datum/controller` with a `fire` or
  `process` proc is `DMNew`'d once and invoked per DM tick through
  `DMTickScheduler.RegisterTickCallback`, honoring the datum's `wait`
  var (ds, default `tick_lag`) between invocations. Minimal hook — not
  an MC port.
- **Probes (9 new)** — engine-free via the fallback driver: sleep
  duration on the world clock, tick-grid `world.time`, spawn delay +
  same-tick FIFO ordering + `spawn(0)` end-of-pass, `tick_lag`
  conversion (sleep is ds not ticks), `fps`↔`tick_lag` link,
  `realtime` era, and `world.Tick()`-per-boundary (with the
  wake-before-Tick ordering baked into the expectation).

## Verification

- `npm run build` clean (tsc strict).
- `npm test` — **all green**, including the generated-solution build
  against real RobustToolbox @ pin (`SS14_ENGINE_DIR=~/repos/RobustToolbox`,
  exit 0). The `Update` override + `Task.Run` + `RegisterTickCallback`
  emission compiles against the engine.
- `npm run audit:semantics` — **180/180** probes (was 171; +9 tick/time
  probes). Re-verified after rebasing onto `origin/master` (B-8 +
  baystation commits; zero file overlap).
- Probe of record for ordering: `world.Tick() fires once per world tick`
  expects `2` — a proc woken at tick 3's boundary reads before tick 3's
  end-of-tick `Tick()` runs, matching BYOND ordering.

## Known limits

- `world.time = x` writes store a var but reads are computed (BYOND
  treats `world.time` as read-only game state).
- `tick_lag` changing mid-run retargets the boundary grid (BYOND-like
  approximation; pathological in practice).
- `spawn(-1)` runs the body immediately but the BYOND "deferred
  continuation" (caller resumes after the spawn block later) is not
  modeled — the caller continues inline.
- Fallback driver polls at 5 ms and advances whole ticks; probes see
  tick-exact times, sub-tick real-time precision is not guaranteed.
- Subsystem matching is convention-based (`/datum/controller*` +
  `fire`/`process`); `wait` honored, `priority`/`flags` ignored.
