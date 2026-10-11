# Plan 31 — W-K mc: subsystem instantiation (the SS_NO_FIRE fix) + emitter surgical gaps

`W-K mc` — kills the ~9.9k SS_NO_FIRE throw storm W-I measured on converted
paradise (`docs/plans/29-corpus-playability.md`): `RegisterSubsystemsAsync`
DMNew'd every `/datum/controller*` type with a fire/process decl, including
the abstract `/datum/controller/subsystem` base whose `fire()` is the
`flags |= SS_NO_FIRE; CRASH(...)` stub. Every cadence fired the crash —
the station's real subsystems drowned in the noise.

## What changed

### 1. Subsystem enumeration mirrors BYOND's Master (`csharpEmitter.ts`)

`subtypesof(/datum/controller/subsystem)` in `master.dm:104` returns strict
DESCENDANTS — the base is never instantiated. The registry now:

- Enumerates all `/datum/controller*` paths **except** the base itself
  (`subtypesof` semantics) and declared-abstract types.
- Instantiates **every concrete subsystem subtype** — even ones with no
  fire/process — because BYOND's `_subsystems` list holds them all (their
  `New()`/`PreInit` wires the SS* globals). A subtype whose effective
  fire/process resolves to the base's crash stub reports
  `instantiated (no real fire/process — not on the tick loop)`.
- `ProcRegistry.ResolveProcDeclaringType(typePath, proc)` (runtime helper)
  reports WHICH type provides a proc: a subtype's fire resolving to
  `/datum/controller/subsystem` IS the crash stub — BYOND never cadences it.
  A real decl (leaf's own or a concrete ancestor like
  `/datum/controller/subsystem/processing`'s bucket processor) cadences.
- `flags & SS_NO_FIRE` (2) honored twice, mirroring BYOND's fire loop
  (master.dm:320 `if(SS.flags & SS_NO_FIRE) continue` is per-fire): once
  post-`DMNew` for the early-exit + `instantiated (SS_NO_FIRE flag)` log,
  and re-read every tick inside the cadenced callback so flags set later
  (PreInit, runtime toggles) drop the subsystem off the list. Verified on
  the mini corpus (New()-flagged leaf: logged, never fires). On paradise,
  utility subsystems flag in `PreInit()` or via `flags = SS_NO_FIRE`
  expression var-inits — PreInit isn't driven by the runtime and
  expression var-inits aren't seeded (scalar-only), so those still
  cadence — documented gap, same as BYOND would show if PreInit were
  skipped.
- Instantiation order: `init_order` descending, stable on ties — BYOND's
  `sortTim(cmp_subsystem_init)` sorts `initial(init_order)` highest-first.
  Read via `ApplyTypeVarInits` on a throwaway datum (`SubsystemInitOrder`),
  matching `initial()` without construction.
- Per-tick gate: `can_fire ≤ 0` drops the subsystem from the fire list for
  that tick (BYOND's runtime pause), `wait` var honored between invocations
  (unchanged from W-E), first-fire evidence line logged at
  `world.time={Time}` for verification.

### 2. throw/catch emit real DM semantics (`csharpEmitter.ts` + runtime)

- `ThrowStatement` was `// Unknown statement` — now emits
  `throw new DMRuntimeHelpers.DMThrownException(<expr>)` carrying the thrown
  DMValue on the C# exception channel.
- `catch(var/exception/e)` bound the raw `ex.Message` string — now binds an
  **/exception datum** via `DMRuntimeHelpers.MakeExceptionDatum`: `name`/
  `desc` = the thrown text, `value` = the thrown DMValue for DM `throw`,
  `file`/`line` = Null (engine-free runtime has no DM source location —
  honest gap). Rethrowing a caught /exception datum rebinds the same datum.

### 3. Abstract-type guard (`dmRuntimeCS.ts`)

- `ProcRegistry.RegisterAbstract(path)` emitted for types whose declared
  `abstract_type` equals their own path (BYOND's abstract marker; children
  inherit an abstract_type that is NOT their own path → stay concrete).
- `DMNew` on an abstract path returns `DMValue.Null` + one `[DM]` warning
  per type — BYOND runtime-errors; we degrade instead of throwing storms.

## Verification

| check | result |
|---|---|
| `npm run build` (tsc strict) | clean |
| `npm test` | all suites pass |
| `npm run audit:semantics` | **303/303** (298 baseline + 5 new probes: throw/catch datum, thrown value, rethrow, abstract-new null, concrete child) |
| paradise convert + Content.Server build | 0 CS errors |
| paradise boot (`auto_pause_empty=false`) | Ready; **SS_NO_FIRE = 0** (was 4,479 in W-I's window / ~9.9k sampled); **90 distinct subsystems fired** at world.time=1 (SSair, SSmachines, SSmobs, SSjobs, SSticker, SSgarbage, SSatoms, SSidlenpcpool, SSnpcpool, SSnightshift*, SSmovement/* — full MC inventory); unobserved-task exceptions **0** (was ~4.7k events); DM-PUMP **1** (faithful paradise div-by-zero) |
| mini MC corpus (`~/para-wk/mc-corpus`) | init_order sort order verified; crash-stub leaf `instantiated (no real fire/process)`; `flags |= SS_NO_FIRE` leaf `instantiated (SS_NO_FIRE flag)`; `can_fire`/`wait` gates; abstract-new `isnull=1` + warn-once, child `isnull=0` |
| `scripts/boot-smoke.sh` | PASS |
| `scripts/m1-gate.sh` | 5/5 — E2-E5 needed the W-G `type: Function` keybinds strip (same gap m2-slice.sh:58-65 already papers over; pre-existing on master, unrelated) |

## Finding: the sim auto-pauses with zero clients

The reason the earlier boot showed registrations but no fires: RobustToolbox
`game.auto_pause_empty` defaults true — `_time.Paused = _autoPause` when no
players connect → `TickUpdate` (→ `Pump`) never runs. W-I's census ran
inside a client-attach window, which unpauses. Set
`[game] auto_pause_empty = false` in `server_config.toml` (or attach a
client) to see the tick loop.

## Known limits

- Paradise's utility-subsystem pattern (flag in `PreInit()`, or
  `flags = SS_NO_FIRE` as an expression var-init) still cadences:
  `PreInit` isn't driven by the runtime and expression var-inits aren't
  seeded (scalar-only — `(1<<1)` doesn't constant-fold). Subsystems whose
  flags var is a seeded scalar or that flag in `New()` are correctly
  skipped — the per-tick check catches flags set at ANY time once they
  land, matching BYOND's fire-loop semantics.
- `runlevels` (BYOND's per-runlevel fire gating) not modeled — every
  eligible subsystem fires every tick.
- `wait` cadence uses the datum's live var; BYOND rounds `next_fire` to
  tick boundaries with tick_overrun bookkeeping — approximated.
- `/exception` `file`/`line` stay Null — no DM source mapping at runtime.
- Non-subsystem `/datum/controller*` types keep the old fire/process gate
  (any real decl → cadence), e.g. `/datum/controller/master`'s process().

## Files

- `src/transpiler/csharpEmitter.ts` — `RegisterSubsystemsAsync` rewrite +
  `SubsystemInitOrder`, `RegisterAbstract` emit, TryStatement catch-var,
  ThrowStatement case (`// W-K mc` regions)
- `src/runtimeTemplate/dmRuntimeCS.ts` — ProcRegistry `AbstractPaths`/
  `RegisterAbstract`/`IsAbstract`/`MarkAbstractNewWarned`/`SubtypesOf`/
  `ResolveProcDeclaringType`, DMNew abstract guard,
  `DMThrownException` + `MakeExceptionDatum` (`// W-K mc` regions)
- `src/tests/fidelityDifferential.test.ts` — 5 appended probes
- `src/tests/csharpEmitter.test.ts` — appended Tests 48-50; Test 47's two
  TryGet/TryGetInherited call-site asserts repointed at
  `ResolveProcDeclaringType` (same leaf+ancestor coverage, now with the
  declaring-type answer the MC needs)
