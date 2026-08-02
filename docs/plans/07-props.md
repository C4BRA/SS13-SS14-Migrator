# Plan 07 — Builtin Property Reads / Writes

Status: not started · Owner: runtime + emitter · Effort: 1–2 weeks ·
Impact: **11,644 broken prop reads** + **6,384 GLOB.x accessor reads** (uninitialized)

## Goal

Make `a.b` on builtin properties (`len`, `type`, `loc`, `x`, `y`, `z`, `dir`,
`contents`, `overlays`) behave per BYOND instead of `DMValue.Null`, and resolve or
diagnose the 6,384 `GLOB.x` reads whose variable is never initialized.

## Current state

- `BROKEN_PROP_NAMES` (`src/audit/fidelityAudit.ts:72`): `len, type, loc, dir, x,
  y, z, overlays, contents` → counter 11,644: `loc 2,872 · z 2,064 · len 2,043 ·
  type 1,558 · x 1,013 · y 942 · dir 588 · contents 447 · overlays 117`.
- Emitter: property reads emit `GetVar(comp, name)` on the current `comp` — there
  is no target-relative resolution and no universal-prop dispatch
  (`src/transpiler/csharpEmitter.ts`).
- Runtime: `DMValue` has no prop machinery; `DMRuntime.GetVar` is a var-bag lookup.
- GLOB.x: `GlobalVars` registry exists (Phase 0; 21,872 sites resolved); the
  remaining 6,384 are reads of names never declared as `/global/var/` in the
  parsed corpus (runtime-defined globals, or declaration-order gaps).

## Design

### 1. Runtime: `DMGetProp` (`dmRuntimeCS.ts`)

```csharp
public static DMValue DMGetProp(DMValue target, string prop)
```

Dispatch by target kind:

| prop | List | String | DMRuntime (datum) | Number |
|---|---|---|---|---|
| `len` | `FromNumber(list.Count)` | `FromNumber(text.Length)` | → var lookup, else Null | `FromNumber(ToString().Length)` (BYOND) |
| `type` | `"/list"` | `"/text"` | `FromString(datum.DMTypePath)` | `"/num"` |
| `loc` | — | — | datum.Loc (grid/atom ref) | Null |
| `x y z` | — | — | datum.X/Y/Z (grid coords; lazily computed, see Plan 04) | Null |
| `dir` | — | — | datum.Dir (appearance dir, Plan 05) | Null |
| `contents` | — | — | `DMList.FromArray(children)` (tracked on datum) | Null |
| `overlays` | — | — | datum.Appearance.Overlays (Plan 05 P1) | Null |
| *else* | — | — | `datum.GetVar(prop)` (existing var bag) | Null |

- **Resolution rule**: the var-bag lookup happens only when the prop is not
  universal AND the target is a datum; for `a.b` where `a` is a datum, `b` is a
  datum var or a universal prop — never silently `Null` when the var exists.
- String/list specials first; datum fallback to vars; `overlays`/`loc`/coords
  delegate to Plans 05/04 data once they exist (interface seams now, concrete
  values later — the *dispatch* is the deliverable of this plan).

### 2. Emitter: target-relative reads (`csharpEmitter.ts`)

- `property` IR nodes currently emit against `comp`; change to:
  `DMGetProp(<transpiled target>, "<name>")` when the property name is in the
  universal set (or generally — var-bag lookup covers the rest).
- Assignment `a.b = v`:
  - universal prop + datum target → `DMSetProp(target, name, value)` (coordinate
    setters: `x`, `y`, `z` validate grid bounds; `dir` → appearance; `overlays +=`
    already flows through list-append).
  - datum var → existing `SetVar`.
- Chained reads `a.b.c` compose naturally once reads are target-relative.

### 3. GLOB.x uninitialized reads (6,384)

- Triage: bucket by name. Most likely causes:
  a. globals declared via `var/global/...` in files the preprocessor dropped
     (inactive `#ifdef`, ordering) → fix collection, not runtime.
  b. globals created at runtime (`GLOB.x = ...` in an initializer or `New`) →
     make `GlobalVars.Get(name)` **lazily initialize a Null var** and emit a
     warning the first time an uninitialized name is read (audit counter
     `numUninitGlobalRead`), so reads are not silent.
  c. genuinely missing declarations → diagnostics list.
- The lazy-Null + warning approach keeps behavior (BYOND would error/Null) and
  surfaces the corpus-side bug (a real TG bug if a global is read before init).

### 4. Audit re-labeling

- Split `numBrokenPropRead` into per-prop counters that only count *unhandled*
  props after `DMGetProp` lands (target was not resolvable). The remaining
  genuine misses: `overlays` until Plan 05 P1, `loc`/`x/y/z` until Plan 04 grid.

## Implementation steps

1. `DMGetProp`/`DMSetProp` + unit tests for the dispatch table (list/string/datum/
   number × each universal prop).
2. Emitter: target-relative property reads/writes; golden tests for
   `obj.x`, `list.len`, `text.len`, `a.b.c` chains, `obj.x = 5`.
3. GLOB triage script (bucket 6,384 by name; classify a/b/c above) → lazy-Null +
   warning for class b; preprocessor fixes for class a.
4. Probes: `len` on list/string, `type` on datum, `x/y/z` read/write on a datum
   with grid (stub grid in engine-free mode), `contents`, `overlays +=` (data
   only, P1 of Plan 05).
5. Re-audit: `numBrokenPropRead` → only genuinely-unresolvable targets remain
   (target itself dynamic); `numUninitGlobalRead` reported separately.

## Verification

- Probes above assert BYOND values (e.g. `"abc".len == 3`, `list(1,2).len == 2`,
  `new /datum/x().type == "/datum/x"`).
- Audit: 11,644 → ≤ documented floor (dynamic-target-only).
- `npm test` green; compile proof green.

## Success criteria

- 100% of prop reads with a statically-known target type resolve; the audit's
  per-prop counters for `len/type/loc/x/y/z/dir/contents/overlays` show only
  dynamic-target misses.
- GLOB.x: 0 silent uninitialized reads (all warn or resolve).
- Plans 04/05 seams (`Loc`, `X/Y/Z`, `Overlays`) are stubbed with clear
  "not-yet-implemented" markers that flip to real values as those plans land.

## Risks / decisions

- **Dynamic targets** (`a.b` where `a` is an untyped `var`) cannot resolve at emit
  time — `DMGetProp` must handle them at runtime (it does, via var-bag + universal
  props); the audit should stop counting them as losses once dispatch exists.
- **`overlays`/`loc`/coords** have no engine-free values until Plans 04/05 — the
  dispatch returns stubs; keep the audit honest by labeling those stubs, and flip
  labels as the plans land.
- **GLOB lazy-init** changes behavior (Null instead of hard failure) — document
  that this matches BYOND's `GLOB.x` auto-null for undeclared names, and the
  *warning* is our added safety net.
