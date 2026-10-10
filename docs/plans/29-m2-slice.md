# 29 — M2 feature slice: doors/airlocks end-to-end on converted paradise code

North star after M1: one REAL SS13 system working end-to-end on converted
paradise. This document records the slice choice, the corpus, the
transpiler bugs the slice surfaced, and the gate verdicts.

## Slice choice: doors/airlocks

Scored by "most complete type graph surviving conversion" against the
converted paradise output (~/m2-work/paradise-out, ~60 door procs +
~50 airlock procs emitted and registered cleanly):

| candidate   | verdict |
|-------------|---------|
| doors/airlocks | CHOSEN — appearance channel (icon_state + overlays), interaction (Click → attack_hand), state (density/opacity/layer), Sleep timing; self-contained type graph |
| vending     | gated behind TGUI (`ui_interact`/`ui_act`) — no UI seam in the slice |
| light switches | observable path (`get_area`, `machine_powernet`) unmapped → luminosity never reaches a light |

Doors dogfood the appearance channel end-to-end: `update_icon()` →
`update_icon_state()` → `icon_state` → AppearanceComponent → client sprite.

## Corpus — tests/m2-slice/

Convention: feature code is VERBATIM paradise; harness shims are marked.

- `code/paradise_door.dm` — verbatim `code/game/machinery/doors/door.dm`
- `code/paradise_airlock.dm` — verbatim `code/game/machinery/doors/airlock.dm`
- `code/paradise_access.dm` — verbatim `code/game/jobs/access.dm:1-45`
  (`allowed`, `check_access`, `check_access_list`, `has_access`)
- `code/paradise_atoms.dm` — verbatim extracts: `/atom/proc/update_icon`,
  `update_icon_state`, `update_overlays`, `set_density`, `set_opacity`,
  `attack_hand` (the real interaction entry the BYOND click chain ends at)
- `code/m2_defines.dm` — verbatim `#define` lines with source citations
  (`ALL`, `SECONDS`, door layer/state defines, `SEND_SIGNAL`, the
  `GLOBAL_LIST_EMPTY`/`COOLDOWN_DECLARE` macro shims the parser needs)
- `code/m2.dm` — harness only: turfs/area/mob, `Click()` → `attack_hand`
  bridge (paradise's full `_onclick` chain is out of scope; `attack_hand`
  IS the real terminal proc), `m2_init`/`m2_state`/`m2_debug*` evidence
  verbs, paradise globals (`GLOB.airlocks`, `airlock_overlays`, `cardinal`)
- `maps/m2.dmm` — 11×11 TGM: plain `/obj/machinery/door` + `/obj/machinery/door/airlock`
- `icons/` — real paradise `doorint.dmi`, `airlocks/station/public.dmi`,
  `airlocks/station/overlays.dmi`

Calls into code outside the slice degrade to Null BY DESIGN (dogfooding):
`_SendSignal`, `QUEUE_SMOOTH`, `QDEL_NULL`, `iswallturf`, `/datum/wires`
procs, `image()` (airlock overlay cache — `overlays=N` stays informational).

## Transpiler bugs the slice surfaced (all `// W-H`-marked)

Dogfooding on real paradise code found five real semantics bugs:

1. **Proc params clobbered same-named datum vars** (`dmRuntimeCS.ts`,
   `csharpEmitter.ts`). `/proc/get_airlock_overlay(icon_state, icon_file)`
   bound its params through `comp.SetVar("icon_state", ...)` — clobbering
   the CALLER's `icon_state` (doors briefly reported `icon_state=_open`).
   Fix: proc-local frames — `DMProcFrame` + `PushFrame`/`PopFrame`/
   `DeclareLocal` on `DMRuntime`; `GetVar`/`SetVar` resolve frame-declared
   names first. Emitter declares params + `.` + `var/x` + for-loop vars as
   locals and wraps the body in `try { ... } finally { PopFrame() }`.
   Also fixes `.` (BYOND return slot) leaking across calls on a datum —
   `..()` used to read stale return values.

2. **`for (x in null)` iterated once with Null** (`dmRuntimeCS.ts`,
   `DMListItems`). BYOND iterates zero times; the `default:` branch yielded
   the value itself. `has_access(null, null, list())` must `return 1`
   (empty requirement lists grant access) — it iterated once and failed.
   Fix: `case DMValueType.Null: break;`.

3. **`density`/`opacity`/`anchored` consumed into IR flags, never emitted**
   (`src/ir/dmIRGenerator.ts`). The datum var stayed Null → `if(density)`
   false → `update_icon_state` picked the open branch at init; `open()`
   `set_density(0)` then `if(density)` checks were wrong. Fix: emit the
   numeric value into `irType.customVars` alongside the flag so the datum
   keeps a real var and `initialVars` carries it.

4. **Type-path shorthand broke proc inheritance** (`dmRuntimeCS.ts` —
   the biggest find). `TryGetInherited("/obj/machinery/door", "update_icon")`
   stripped segments `/obj/machinery` → `/obj` → empty, never reaching
   `/atom` because BYOND's real parent chain is `/obj` → `/atom/movable` →
   `/atom` → `/datum`. Every `/atom`-level proc (`update_icon`,
   `update_icon_state`, `attack_hand`, `set_density`...) was invisible to
   `/obj` and `/mob` children — `CallProc`/`..()` returned Null and the
   door's whole appearance chain silently no-oped. Fix: `DMParentPaths`
   yields the canonical ancestor chain through `DMAliasAncestors`
   (obj/mob→movable→atom→datum, turf/area/image→atom→datum, atom→datum);
   both `TryGetInherited` overloads, `GetParamNames`, `EnumerateProcs`,
   and `IsType` now walk it (`istype(o, /atom)` is true for `/obj` too).

5. **initialVars load raw DM initializer TEXT as truthy strings**
   (`dmRuntimeCS.ts`, `csharpEmitter.ts`). `parseInitialValueText` keeps
   source text verbatim into YAML (`barricaded: "FALSE"`, `flags: "( 1 << 8 )"`);
   `OnDMComponentInit` loaded each via `DMValue.FromString` — and any
   non-empty string is TRUTHY, so `var/barricaded = FALSE` read back truthy
   and door's `if(operating || emagged || foam_level || barricaded) return`
   silently killed every click before `allowed()` even ran (verified via
   M2-TR overrides: `try_to_activate_door` entered, returned early, no
   `allowed` trace). Fix: `DMRuntimeHelpers.ParseInitialVar` coerces
   `null`/`TRUE`/`FALSE`/numerics/quoted strings; non-literal text keeps
   string identity (expressions like `1 << 8` degrade to truthy strings,
   same as before — flagged as a residual gap).
   Also required for the slice to click at all: cardless player mobs are
   CORRECTLY denied by `check_access_list` (real paradise semantics), so
   the demo types `/obj/machinery/door/m2` + `/obj/machinery/door/airlock/m2`
   carry `unres_sides = 15` — paradise's own maintenance-door mechanism
   (`unrestricted_side(M)` = `get_dir(src,M) & unres_sides`), not a shim.

New fidelity probes appended (fidelityDifferential.test.ts, 9 total):
null-iteration, null req_access, param-no-clobber, param read-through,
var/x locality, for-var locality, /atom proc on /obj child, /obj `..()` to
/atom grandparent, istype sugar chain.

## Gate — scripts/m2-slice.sh

Mirrors m1-gate: convert → dotnet build (retry loop for shared-engine
races) → Content.Server boot (fifo console) → headless client autocmds
(`dmloc`, `m2_init`, `m2_state`, `dmclick`, `dumpentities`). Evidence:

- E1 server Ready + map + `M2-WORLD`
- E2 client InGame + mob attach
- E3 `Initialize(1)` → `update_icon` → `icon_state=door1` / `closed`
- E4 dmclick plain door → `density 1→0`, `opacity 1→0`,
  `icon_state door1→door0` (server log + `usr <<` client echo)
- E5 dmclick airlock → `icon_state closed→open`, overlays 9→25
  (server + client echo)
- E6 door entities listed server-side (`entities` → uids) and streamed to
  the client (`dumpentities` proto lines)

## Final gate verdict

`scripts/m2-slice.sh` — PASS 6/6 (E1–E6), 2026-10-10 run:
`[PASS] E4 ... icon_state=door0`, `[PASS] E5 ... icon_state=open`,
`[m2-slice] PASS: M2 doors/airlocks slice verified end-to-end`.

## Known limits

- `image()` unmapped → airlock overlay cache stores Nulls; `overlays`
  count is informational (1–2 Null entries), no visual layer asserts.
- Airlock `update_icon` runs its `..()` → door chain fine; `_SendSignal`
  is a Null stub so `SEND_SIGNAL` updates are dropped silently.
- `open()` returns without `autoclose`/`operating` timing paths fully
  covered (verbs avoid `Sleep` waits); state evidence is icon+density.
- The `Click()` bridge bypasses paradise's `_onclick` chain deliberately;
  `attack_hand(usr)` is the verbatim entry it terminates at.
