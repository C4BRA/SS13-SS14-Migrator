# Plan 08 — `new /type(...)` Constructor Semantics

Status: not started · Owner: runtime + emitter · Effort: 1–2 weeks ·
Impact: **13,060 `new` sites** (2026-08-02 Plan 11 re-run; currently "returns caller as placeholder")

## Goal

Make `new /type(a, b, ...)` match BYOND constructor semantics: the `New()`
proc runs on the *new* object, args propagate correctly, `..()` chains through the
type hierarchy, `loc` is passed implicitly when the last arg is omitted, and the
expression value is the new object (never the caller).

## Current state

- Emitter (`src/transpiler/csharpEmitter.ts:417-421`): `new /type(args)` →
  `await DMNew(comp, "/type", args...)` (comp is `null` in global-initializer mode).
- Runtime (`src/runtimeTemplate/dmRuntimeCS.ts:535-541`):
  ```csharp
  var datum = new DMRuntime { DMTypePath = typePath };
  LiveDatums.Add(datum);
  await datum.CallProc("New", args);
  return DMValue.FromDatum(datum);
  ```
  The mechanism looks right — so what is the *placeholder* loss? Audit-verified
  failure modes to confirm at triage:
  1. `New` is not registered for the concrete type path (registry walks ancestors
     via `TryGetInherited`, but a type whose `New` was parsed under a parent path,
     or whose proc registration was dropped, silently skips `New`).
  2. TG's `Initialize()` convention: `New()` on `/obj/*` calls `Initialize()`
     (often via `..()`); if `..()` resolution misses, constructor side effects
     (e.g. `icon_state` setup, `update_icon()`) never run.
  3. Implicit `loc` argument: `new /obj/x(loc)` vs `new /obj/x` — BYOND passes the
     datum's `loc` as the first `New` arg when not given? (No — BYOND's `new`
     passes *zero* args; `loc` is set *after* `New` returns via the var.) Confirm
     actual BYOND rule: `new /type(arg1, arg2)` calls `New(arg1, arg2)`; `new /type`
     calls `New()` with **no** args; `loc` assignment is a separate step in DM's
     compiler. Triage our emitter for where the placeholder loss actually is.
  4. `new` in the global-initializer context: `DMNew(null, ...)` — `New` bodies
     referencing `src`/`usr` may assume a comp; guard.

## Design

### 1. Triage (step 1 — required before coding)

Instrument `DMNew` temporarily: count per typePath (a) whether `New` resolved,
(b) whether a `..()` chain ran, (c) `Initialize` invocation on `/obj/*`/`/mob/*`
paths, over the corpus compile sample. Bucket the 13,060 sites (2026-08-02
Plan 11 re-run) by failure mode
(1–4 above). The fix set depends on the buckets — expected:

### 2. Constructor chain completeness

- **Registry gap (mode 1)**: ensure every parsed proc registers under its
  *concrete* type path AND all ancestor paths it could be reached through
  (`ProcRegistry.Register` already supports one path per proc; add multi-path
  registration or rely on `TryGetInherited` — verify which fails in triage).
- **`..()` chain (mode 2)**: `New` bodies call `..()` → parent `New` → ...
  `CallProc("..")` context-walk exists (Phase 0.5); make the walk return the
  parent `New` for constructor calls specifically, and add the TG
  `Initialize()` follow-up: after `New` returns on entity-typed paths, call
  `Initialize(args...)` if the type has one (TG convention: `New` → `..()` →
  `Initialize`). This is TG-specific but is the dominant constructor pattern in
  the corpus (all 13,060 sites are TG/derivatives).
- **Var initialization**: BYOND's `New` often sets vars from args; nothing
  extra needed beyond (correct) `New` execution — the var bag already stores.

### 3. `loc` handling

- BYOND: `new /obj/x` then `obj.x = loc` (compiler-inserted when loc is passed
  implicitly as `new /obj/x(loc)`). Triage our parser: does `new /obj/x(loc)`
  parse `loc` as a regular arg? If so, `New(loc)` gets the loc as arg AND the
  compiler's implicit `x.loc = loc` is missing. Implement: for `new /type(EXPR)`
  where the *first* arg is a bare `loc` identifier in a movable context, after
  `DMNew` returns, set `datum.Loc = EXPR` (BYOND does both: passes to New and
  sets `.loc`). Probe to confirm exact BYOND behavior.

### 4. Expression-position correctness

- Assert `var/x = new /datum/y(a) == x` (identity), `f(new /datum/z(1))` passes
  the *new* object, `list(new /a, new /a)[1] != [2]` (distinct objects — probe
  exists). Add probes for `new` with args where `New` sets a var from arg1, and
  `..()` in `New` chains (parent `New` sets a var the child reads).

### 5. Global-initializer context

- `DMNew(null, ...)`: guard `New` execution against a null `comp`/`usr` by
  creating a synthetic root datum as `src` (BYOND: `src` in `New` is the new
  object itself — verify our `CallProc` sets `src` correctly; fix if the
  emitter passes `comp` as `src` in global-init mode).

## Implementation steps

1. Triage instrumentation (modes 1–4 buckets) over the corpus.
2. Registry multi-path or inherited-walk fix (whichever triage shows).
3. `Initialize()` follow-up for entity paths.
4. `loc` implicit handling + probes.
5. Global-init `src` guard.
6. Re-audit: re-label `numNew` to count only true residual losses (dynamic
   `new` on string paths — `new text2path(x)` stays runtime; document).

## Verification

- Probes: `New` arg propagation, parent-`New` chain, `Initialize` call order
  (log assertion), `loc` set, distinct-object identity, expression-position `new`.
- Audit `numNew` re-classification (13,060 → true-residual only).
- Compile proof green; `npm test` green.

## Success criteria

- Constructor behavior probe suite passes (5+ probes covering modes 1–4).
- Audit shows `new /type(...)` sites as "mapped+verified" with only dynamic
  (`text2path`, `new /list()`) sites counted as residual.

## Risks / decisions

- **TG-specific `Initialize()` coupling**: hard-wiring the TG convention into the
  runtime is acceptable for corpus fidelity (PLAN.md's target) but must be
  documented as a compatibility layer, not DM semantics (BYOND has no
  `Initialize`).
- **`..()` chain depth**: constructors chain deep (`/obj/item` → `/obj` →
  `/datum`); the registry walk is iterative — watch stack depth in the compile
  proof; add a recursion guard.
- **Triage may reveal mode 4 (src/usr) dominates** — order the fix list by
  bucket size; this plan's step order is a hypothesis until triage lands.
