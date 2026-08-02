# Plan 01 — Builtin Proc Coverage

Status: in progress · Owner: transpiler/runtime · Effort: weeks · Impact: **3,553 loss sites → <300**
(2026-08-02: pure-function + file-ops + movement batches landed — 42 procs mapped, 41 probes
green; audit 3,345 → **708** unresolved bare calls, 0 regressions. Movement batch also fixed
the arg order of the pre-existing range/view/oview mappers to BYOND's (dist, center).
2026-08-02 Plan 11 re-run: **3,360 unresolved bare calls** — the §3e-era 708 did not
reproduce; the re-run counts unexpanded fn-macro call sites again (`span_*`, `EXAMINE_HINT`,
`AREACOORD`, `ADMIN_*`, `FORMAT_*` ≈ 2,400 of 3,360). Miscount analysis is a Plan 10 B4 /
Plan 11.12 item. See `AUDIT.md` §3h.)

## Goal

Eliminate "unknown builtin call → `CallProc -> DMValue.Null`" sites on tgstation. The
audit (`src/audit/fidelityAudit.ts`) counts any builtin-looking call that is neither in
`MAPPED_BUILTINS` nor a parsed user proc. Current tgstation baseline (re-run
2026-08-01): **3,553 sites** across a finite list of ~50 procs (down from 42,852 after
the Phase 0 builtin expansion).

## Current state

- `src/transpiler/builtinMappings.ts` — `MAPPED_BUILTINS` (~55 names) + `transpileBuiltinCall()`
  switch mapping each to a generated C# expression.
- `src/runtimeTemplate/dmRuntimeCS.ts` — `DMRuntimeHelpers` class holds the runtime
  helpers (pick, rand, text2num, splittext, ...). Engine-free; probe-testable.
- Unknown builtins fall through to `DMCallProc` → registry miss → `DMValue.Null` silently.
- Probe harness: `src/tests/fidelityDifferential.test.ts` (compile + execute a DM
  snippet, assert BYOND-known result). Golden emitter tests: `src/tests/csharpEmitter.test.ts`.

## Remaining builtins (all >15 sites, 46 procs ≈ 3,300 of 3,553)

```
562 arglist   191 SpacemanDMM_unlint  135 deconstruct  110 floor  108 orange
100 fdel       99 file    93 sqrt     93 ceil        88 regex   87 astype
 86 json_encode 82 ref    78 step     75 ckey        71 copytext_char
 62 viewers    60 winset  50 html_encode 49 isfile   44 sin    40 icon_states
 39 span_notice 38 fcopy  37 rgb2num  36 log        35 cos    35 get_step_away
 34 length_char 31 sign   30 list2params 28 alist   28 html_decode 27 sorttext
 26 get_step_towards 26 span_warning 26 step_towards 25 text2ascii
 23 time2text 21 fcopy_rsc 21 replacetextEx 20 isicon 17 arccos 17 link
 17 span_danger 16 get_stickyban_from_ckey
```

## Triage (step 1)

Classify each into one of:

| Class | Examples | Handling |
|---|---|---|
| Pure functions | floor, ceil, sqrt, sin, cos, sign, arccos, log, rgb2num, ckey, sorttext, copytext_char, length_char, text2ascii, ascii2text, html_encode/decode, json_encode, time2text, isfile, isicon, replacetextEx | New `DMRuntimeHelpers` static; add to `builtinMappings.ts`; one probe each |
| File ops | fdel, fcopy, fcopy_rsc, file, fexists, ref | Runtime helpers backed by `System.IO` (engine-free, sandboxed dir); `file()` needs DMFile datum |
| Regex | regex, isregex | DMRegex datum wrapper over `System.Text.RegularExpressions`; DM regex syntax is BYOND-flavored (partial translate) |
| Movement/space | step, step_towards, step_away, get_step_towards, get_step_away, orange, viewers, range | These touch the world model — implement against the DMRuntime map grid (see Plan 04/05 for the entity bridge); semantics: turfs/atoms adjacency |
| UI/verbs | winset, winclone, link, winget, browse_rsc | Stub-to-console + documented mapping (see Plan 04); UI is out of scope → reduce to console-log helpers so behavior is visible, not Null |
| Misc | arglist, alist, list2params, params2list (done), SpacemanDMM_unlint | `arglist` (562 — biggest!) needs emitter/IR support, see below |
| Misclassified | span_notice, span_warning, span_danger, deconstruct, astype, get_stickyban_from_ckey | These are TG defines/procs that failed to expand or resolve — fix the **collection/expansion** path, not a runtime helper |

## Design decisions

### 1. `arglist` (562 sites — 16% of the class)
`arglist(list)` splats a list into call arguments. Requires IR/emitter support:
- New IR node type `ArglistNode` (or `call` node with `arglist: true` on an argument).
- Emitter: when an argument is `arglist(x)`, emit a single `params DMValue[]` style
  forwarding — in C#, the argument becomes `await DMCallProc(target, name,
  DMArglist(x))` where `DMArglist` is a marker; the runtime expands it before dispatch.
- `alist` (28): BYOND persistent assoc list — map to `DMList` (lossy but not Null).

### 2. Misclassified builtins
- `span_*` (82 sites): `#define span_notice(text) ...` function-like macros that did
  not expand. Triage why: likely `#define` inside a file whose collection happened
  after use, or `##` body edge cases in `substituteParams`. Fix in
  `src/preprocessor.ts` collection (multi-pass until fixpoint) → these disappear
  without runtime code.
- `deconstruct`, `astype`, `get_stickyban_from_ckey`: user procs in TG — audit says
  "unknown builtin" only because `procNames` missed them (proc declared after call
  site or via `procmacro`). Symbol-resolution pass (Plan 02) fixes the accounting.

## Implementation steps

1. **Triage audit**: dump the full distribution + per-proc samples from
   `*-audit-current.json`; classify per table above. Add a `--builtins` mode to the
   audit that prints class membership, so progress is measurable per class.
2. **Pure-function batch (highest count first)**: floor, ceil, sqrt, sin, cos, sign,
   arccos, log, copytext_char, length_char, text2ascii, ckey, rgb2num, sorttext,
   json_encode, html_encode/decode, replacetextEx, time2text, list2params. Each:
   - implement helper in `dmRuntimeCS.ts` `DMRuntimeHelpers`,
   - add mapping in `builtinMappings.ts`,
   - one probe in `fidelityDifferential.test.ts` (BYOND-verified expected value).
   - Estimated: 19 procs ≈ 1,100 sites (≈31% of class).
3. **File batch**: `file`, `isfile`, `fdel`, `fcopy`, `fcopy_rsc`, `fexists`, `ref`.
   Sandbox the file root under a `DMRuntime` data dir; `ref()` → object-id string
   (registry index) — used by TG for `/datum` persistence.
4. **Regex batch**: `regex`, `isregex`. DMRegex datum (compile flags `i g m`,
   `.Find`/`.Match`/`.Replace` proxied to the standard library; BYOND uses its own
   flavor — document the translation table; probes for the common patterns TG uses).
5. **Movement batch**: `step`, `step_towards`, `step_away`, `get_step_towards`,
   `get_step_away`, `orange`, `viewers` — coordinate math on `DMRuntime` grid state
   (world bounds from the parsed `world` decl). Do the pure-math parts now; wire
   actual turf/mob mutation in Plan 04.
6. **UI batch**: `winset`, `link`, `winclone`, `winget`, `browse_rsc` — emit
   console-visible stubs (`DMRuntimeHelpers.UIStub(name, args)`) that log, so sites
   are "covered" but honest; revisit under Plan 04.
7. **Special cases**: `arglist` IR + runtime `DMArglist`; `SpacemanDMM_unlint` → no-op
   helper (it only matters for the linter); `alist` → DMList; `get_stickyban_from_ckey`
   etc. — fix the symbol table.
8. **Fixpoint re-audit**: re-run audit; drive the number down per class; confirm the
   remaining sites are genuinely unsupported (UI/live-server-bound) and documented.

## Verification

- `npm run audit:fidelity -- <repo> --json out.json` → `numUnknownBuiltin` 3,553 → <300.
- One differential probe per new helper (compile + execute, assert BYOND semantics).
- Corpus compile proof (`--build`): new helpers must not introduce C# errors.
- `npm test` green (golden emitter strings for `arglist` and the new mappings).

## Success criteria

- `numUnknownBuiltin ≤ 300`, all remaining sites classified and documented.
- 100% of the "pure function" and "file" classes covered with probes.
- `arglist` splat works in probe (incl. nested calls).

## Risks / decisions

- **Movement/UI** classes can only be finished after the live-server/entity bridge
  (Plans 04/05); phase 1 ships the math/log parts to avoid dead-end helpers.
- **DM regex flavor** differs from .NET regex — keep a translation table; TG's usage
  is small enough (~90 sites) that a documented subset is acceptable.
- **`ref()` persistence** implies object-id stability across saves — defer the
  persistence half; return a stable in-process id first.
