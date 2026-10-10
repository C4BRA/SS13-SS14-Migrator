# Plan 29 — W-I corpus playability pass (paradise boot + headless client)

Status: **executed 2026-10-10** · scope `src/preprocessor.ts`, `src/parser/**`,
`src/ir/**`, `src/runtimeTemplate/dmRuntimeCS.ts` (`// W-I corpus` regions),
`src/tests/*` (append-only) · wave-5 W-I task.

## Problem

Paradise converted and booted `-> Ready`, but attaching a real client — which
spawns `mob_living_carbon_human` and starts subsystem `fire()` ticks — flooded
the server log with DM-visible exceptions. The task: triage every DM-side error
line, fix the highest-count root causes in the front end / shared runtime, and
quantify before/after.

## Method

`para-before` = master HEAD convert + boot + headless client attach
(`--connect`, waits for `InGame`). `para-v3` = same with all fixes. The
headless client exercises real corpus procs (`mob/New()`, every
`/datum/controller/subsystem` `fire()`) that the toy m1 demo never reaches.

## Before census (server, one attach window)

| bucket | lines | root cause |
|---|---:|---|
| unobserved-task exception wrappers (multi-line stack dumps) | ~280k raw / ~4.7k events | every pump-task exception written as a full `Unobserved task exception` dump — nothing observed the discarded Tasks |
| `SS_NO_FIRE` CRASH | 4,479 (within above) | emitted `RegisterSubsystemsAsync` instantiates the abstract `/datum/controller/subsystem` base; DM `subtypesof()` would exclude it — **emitter-side, flagged** |
| div-by-zero (miscompiled operand) | 282 | `x / globalproc(args)` bound the call to `x` not the divisor — e.g. `20/length(cards)` became `(20/length)(cards)` |
| div-by-zero (faithful DM) | 1 | paradise economy datum really divides by zero |
| client proto color parse errors | 57 | DM `color = rgb(r,g,b)` initializers emitted verbatim as `rgb(...)` strings into prototypes |

## Fixes (all in-scope)

1. **`src/parser/dmParser.ts`** — divisor-call binding: when the divisor of a
   merged TypePath `/` is followed by `(`, parse the call onto the last path
   segment (`chain.right`), not the whole `left`. `x/probe(args)` now evaluates
   `x / probe(args)`. Two differential probes added (269 total).
2. **`src/ir/dmIRGenerator.ts`** — `foldColorValue`: `rgb(r,g,b[,a])` var
   initializers on `color`/`light_color` fold to `#RRGGBB[AA]` at IR time
   (clamped 0-255); non-rgb strings degrade to `null` instead of emitting an
   unparseable color.
3. **`src/runtimeTemplate/dmRuntimeCS.ts`** (`DMTickScheduler`, `// W-I corpus`)
   — `ObservePumpTask` + `ReportPumpError`: every discarded pump Task now gets
   a faulted continuation that writes a deduped `[DM-PUMP] <ex>` line (first 3
   + every 100th per signature). Wired at all 4 `_ =` pump sites. Replaced
   ~4.7k multi-line dumps with compact single lines — and revealed the real
   error census.
4. **`src/runtimeTemplate/dmRuntimeCS.ts`** (`DMRuntimeHelpers`, `// W-I
   corpus`) — 3-arg `ValuesCutUnder`/`ValuesCutOver` overloads: tg calls them
   with BYOND's sorted-hint arg; hint is ignored.
5. Earlier same-branch front-end fixes feeding this pass: `parenBalance`
   `@"{"` template skip, `joinContinuations` sim-isolation restore,
   `expandMacros` `inTemplate` close rule, `throw` statement parsing
   (preprocessor.test.ts cases 36-38 cover them).

## After census (server, same attach window)

| bucket | lines |
|---|---:|
| `[DM-PUMP]` total | 189 |
| ↳ `SS_NO_FIRE` CRASH (dedupe-sampled x9901/x9801/…) | 188 |
| ↳ division by zero (faithful paradise economy datum) | 1 |

Client: 57 `rgb(...)` color-parse errors → 2 residual `state 'null'` lookups.
RSI `duplicate stateId` load errors (~500 lines) unchanged — paradise DMIs
contain legitimately duplicated icon_state names; needs a dedupe in the
DMI→RSI writer (**asset pipeline, out of scope**).

**DM-visible error lines: ~9,464 → 189 (-98.0%)**; server exception-dump
traffic ~289k lines → 189.

## Verification

- `npm run build` clean; `npm test` all-pass; `audit:semantics` **269/269**
  (267 + 2 new divisor probes).
- paradise convert + `Content.Server` build: **0 CS errors**; server Ready in
  22s; headless client attach reached `InGame` (`Received Full GameState`,
  mob attach).
- tg (`code/` dir) convert + `Content.Server` build: **0 CS errors** (needed
  the ValuesCut 3-arg overload).
- `scripts/boot-smoke.sh` PASS; `scripts/m1-gate.sh` 5/5 PASS.

## Remaining / cross-scope flags

- `csharpEmitter` `RegisterSubsystemsAsync` instantiates the abstract
  `/datum/controller/subsystem` base (DM `subtypesof()` excludes base types).
  Needs a declared-abstract or `SS_NO_FIRE`-flag check in the emitter —
  **out of scope; largest remaining error source** (~9.9k underlying throws,
  sampled to 188 lines).
- `ThrowStatement` parses but emits `// Unknown statement` — emitter case
  missing (out of scope).
- `catch(var/e)` binds the message string, not an `/exception` datum (out of
  scope).
- RSI writer emits duplicate `stateId`s for duplicated DM icon_state names
  (~500 client load errors; needs last-wins or rename dedupe — out of scope).
- ~8 `tile32.png` missing warnings; direction constants unverified against
  corpus usage.
