# Plan 25 — Fidelity reduction wave 2 (locate + movement + misc builtins)

Status: **executed 2026-10-10** · scope `src/transpiler/builtinMappings.ts`,
append-only `// ==== W-D builtins ====` region in
`src/runtimeTemplate/dmRuntimeCS.ts`, append-only probes in
`src/tests/fidelityDifferential.test.ts` (+ one expectation update in
`src/tests/csharpEmitter.test.ts` for the changed `locate` emission).

## Problem

Wave-1 builtins dropped paradise's stubbed-builtin counter 2525→1908 and
unresolved 488→352. The residual buckets (Oct-2026 audit, master @596b142):

| counter | paradise before | tg before |
|---|---|---|
| `numStubbedBuiltin` | 1915 | 3062 |
| `numUnresolvedCalls` | 345 | 102 |

Call-site triage (`rg -io '\bNAME\s*\('` across both corpora) showed the stub
bucket dominated by `locate` (paradise 1029, tg 1824 sites), then `input`
(349/252), `alert` (295/28), `browse`, `winset` — the UI surface that stays
honestly stubbed. The unresolved bucket's top entries were not one-off corpus
procs but (a) missing real builtins (`ASSERT`, `EXCEPTION`, `walk*` family,
`fract`, `sha1`, `num2hex`, `values_cut_*`, `*_char` delegates, `shutdown`)
and (b) preprocessor-mechanism failures (`EQUIPMENT`, `span_*` inside nested
`[...]` interpolation, `CONFIG_GET`, `ADMIN_*`, `TEST_*`, `VV_HREF_*`,
multi-line `#define`s like tg's `is_station_level`) — corpus *defines* that
exist but fail to expand at some sites. Class (b) is a parser/preprocessor
fix owned by a sibling session and is only flagged here.

## Approach

25 new `MAPPED_BUILTINS` entries + `transpileBuiltinCall` cases, all emitting
`DMRuntimeHelpers.<Name>(args)` (or `(comp, args)` for implicit-src member
ops). Implementations live in one marked `// ==== W-D builtins ====` region at
the end of `DMRuntimeHelpers` so parallel sessions don't conflict. Four names
left `STUBBED_BUILTINS` (`locate`, `__detect_rust_g`, `gradient`, `vector`) and
four joined it (`winexists`, `winshow`, `winclone`, `shell` — recognized real
BYOND builtins whose surface is UI/OS only).

| builtin | semantics |
|---|---|
| `locate` | real resolution, three forms: `locate(x,y,z)` → turf at coords via the atom registry; `locate(X, container)` → recursive contents search (datum) or direct membership (list); `locate(X)` → first live datum of a type path / `tag` match / ref-format string / datum passthrough-if-live |
| `step_to` | single step toward Trg when outside Trange; `1` in range or on move |
| `step_rand` | single step in a random dir from the 8-dir table |
| `walk` / `walk_to` / `walk_towards` / `walk_away` / `walk_rand` | persistent movement driven by the DM tick scheduler (`RegisterTickCallback`); `walk(Ref,0)` stops; one `WalkSpec` per atom, replaced on re-walk; deleted atoms/targets prune |
| `ASSERT` | falsy → `DMCRASH` (BYOND aborts the proc) |
| `EXCEPTION` | real `/exception` datum (`name`, `desc`, `file`, `line`) — the value `throw`/`catch` needs |
| `fract` | `n - trunc(n)`, sign-preserving |
| `sha1` | SHA-1 lowercase hex of text or `file()` bytes |
| `num2hex` | lowercase hex, zero-padded to `len` |
| `values_cut_under` / `values_cut_over` | sum of per-element under/over margins vs a bound |
| `spantext_char` / `replacetextEx_char` | `_char` delegates onto the existing `SpanText`/`ReplaceTextEx` helpers |
| `shutdown` | fires the new `WorldShutdown` hook (engine adapter plugs a real stop); returns null, never throws |
| `gradient` / `vector` | real datums with readable vars (named-arg unwrapping like `matrix()`) |
| `MapColors`/`Blend`/`SwapColor`/`Shift`/`SetIntensity` (icon) | bare calls inside `/icon/proc/*` are implicit-src — mapped to `comp` (the receiver), ops recorded on the icon's `_iconops` list; `Blend`/`SwapColor` return usable values |
| `Multiply` (matrix) | bare call inside `/matrix/proc/*` → real affine a..f composition on `comp` |
| `winexists`/`winshow`/`winclone`/`shell` | honest stubs → `Null` |

## Results

Probe suite: 238 baseline + 22 new = **260/260 green**.

| counter | paradise before → after | tg before → after |
|---|---|---|
| `numStubbedBuiltin` | 1915 → **905** | 3062 → **773** |
| `numUnresolvedCalls` | 345 → **175** | 102 → **54** |
| `totalLossSites` | 22491 → **21311** | 24953 → **22616** |

## Known limits / flags for siblings

- **Preprocessor mechanism bugs** (the dominant remaining unresolved bucket):
  `EQUIPMENT` ~140 paradise sites — a later `#undef EQUIPMENT` in the same
  file deletes the pre-seeded macro so *earlier* uses don't expand
  (`joinContinuations` file-level pre-pass, preprocessor.ts ~L372). Same
  class: `span_*` inside nested `[...]` interpolation (~12 sites),
  `CONFIG_GET`/`VV_HREF_*`/`ADMIN_*`/`TEST_*`/`REGEX_QUOTE_REPLACEMENT`
  defines, tg multi-line `#define is_station_level`. Needs the preprocessor
  owner, not name-chasing.
- **Direction constants** `NORTH`/`SOUTH`/`EAST`/`WEST`/… are BYOND builtins
  that resolve to no global in converted code (`comp.GetVar("NORTH")` → null).
  They don't show in the unresolved bucket (they're var reads, not calls) but
  silently break dir arithmetic — needs a constants-table pass (emitter).
- **`throw`** has no parser statement support — `throw EXCEPTION(x)` sites
  (~10 paradise `numIfError` family) drop or misfire; catch-var binding also
  binds the exception *message string*, not the datum (emitter-owned
  approximation). `EXCEPTION()` itself is now a real datum ready for it.
- **`rand_seed`** left unmapped: honest seeding needs one shared RNG instance
  across all helpers (they call `System.Random.Shared` directly); a partial
  walk-only seed would fake it. 1 site each corpus.
- **`issaved`, `IsByondMember`, `run`, `Robotize`/`Alienize`/`slimeize`,
  `is_station_level`** — var-flag tracking, user procs, or macros; one-off
  corpus calls deliberately not chased per task rules.
- **`locate` residual honesty**: ref-format lookup matches our `REF[0x…]`
  encoding (and BYOND-style `[0x…]` substrings); `locate()` inside
  `for(x in locate(...))` list contexts returns the single found datum like
  BYOND. `DMLocate` (the old top-level stub) is left in place outside this
  region — still referenced by legacy emission paths, now superseded.
- **`walk*` first-step timing**: a walk registered mid-tick takes its first
  step on the next tick boundary (scheduler ordering), matching BYOND's
  lag-then-step model within a tick of ordering tolerance.
- Stub surface kept honest per spec: `browse`, `call_ext`, `alert`, `input`,
  `refcount`, `winset`, `winget`, `link`, `openToolTip`, `closeToolTip`,
  `browse_rsc`, `ftp` + new `winexists`/`winshow`/`winclone`/`shell`.
