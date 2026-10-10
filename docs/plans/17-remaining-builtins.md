# Plan 17 — Remaining BYOND builtins (corpus-driven tier-4 wave)

Status: **executed 2026-10-10** · scope `src/transpiler/builtinMappings.ts`,
append-only region in `src/runtimeTemplate/dmRuntimeCS.ts`,
`src/tests/fidelityDifferential.test.ts` (append-only probes) · PLAN.md item 71
(semantic-fidelity catch-up; reduces `numUnresolvedCalls` / `numStubbedBuiltin`).

## Problem

The corpus fidelity audits still report hundreds of unresolved bare calls per
codebase (paradise: 488 sites). Intersecting paradise's top-unresolved list
with real BYOND builtins left a tier-4 backlog of text/file/crypto/math/
audience builtins that were still emitted as `-> CallProc -> Null`. Every one
of them is a straight `DMRuntimeHelpers.*` port — no engine integration needed.

Owned elsewhere and therefore deliberately skipped:

- `walk`, `step_to`, `step_*`, `get_step_*`, `walk_*` — movement semantics
  (B-1 session).
- `to_chat`, `SPAN_*`, `TEST_*`, `ASSERT`, `EXCEPTION`, `EQUIPMENT` — user
  procs / already-expanded macros, not real builtins.
- `winget` / `winset` / `winexists` / `winshow` / `winclone` / `shell` /
  `browse` / `alert` / `input` — UI/OS surface, stays stubbed by policy.
- `animate` / `flick` / `Blend` / appearance helpers (`MapColors`,
  `SwapColor`, `SetIntensity`, `Shift`, `Multiply`) — B-3 session.
- `.` — parser artifact (method chains misparsed as bare calls), not a proc.

## Approach

26 new `MAPPED_BUILTINS` entries + `transpileBuiltinCall` cases, all emitting
`DMRuntimeHelpers.<Name>(args)`; implementations appended to a single marked
`// ==== Tier-4 builtins ====` region at the end of `DMRuntimeHelpers` so
parallel sessions editing the same file don't conflict.

| builtin | semantics (verified against BYOND ref / OpenDream natives) |
|---|---|
| `file2text` | read real file contents from the process scratch/CWD; `null` when missing or on I/O error |
| `text2file` | append text to file; `1`/`0` |
| `md5` | lowercase-hex MD5 of UTF-8 text, or of file bytes when the arg is a `file()` value (`System.Security.Cryptography`) |
| `addtext` | concatenates the `ToString()` of every arg, nulls as empty |
| `trimtext` | leading+trailing whitespace strip |
| `cmptext` / `cmptextEx` | 1/0 case-insensitive / case-sensitive equality over all args |
| `findtext_char` / `findlasttext_char` / `splittext_char` / `findtextEx_char` / `replacetext_char` / `text2ascii_char` | `_char` variants delegate to the existing code-point-indexed helpers (the runtime is already char-based) |
| `nonspantext` / `spantext` | OpenDream parity: offset of first needle-set char (or chars-from-start) / length of the leading needle-set run |
| `url_encode` / `url_decode` | format-0 percent-encoding (uppercase hex) and its inverse |
| `ckeyEx` | BYOND ref example verified: strips `^` and all chars outside `A-z`, `0-9`, `@`, `-` (`OhSoWe'ReKeeping!MyCapitalLetters?Now` → `OhSoWeReKeepingMyCapitalLettersNow`) |
| `sorttextEx` | case-sensitive ordinal compare → `-1`/`0`/`1` |
| `lerp` | `A + (B - A) * factor` |
| `trunc` | truncate toward zero (`Math.Truncate`) |
| `tan` / `arcsin` | degrees in / degrees out, matching the runtime's existing `sin`/`cos`/`arctan` convention |
| `ohearers` | mobs within hearing range of a center (default 7 tiles, Chebyshev, center excluded) — same `MobScan` filter as `hearers`/`viewers` |
| `bounds_dist` | pixel distance between atoms' 32px-default bounding boxes; `∞`-class value (`1.7976931348623157E+308`) when a z-level differs or an arg is not an atom |
| `generator` | `/generator` datum; `Rand()` dispatches on `type`/`A`/`B`/`rand` vars: `num` uniform (+ midpoint gaussian when `rand==1`), `normal`/`gauss` Box–Muller, `binomial`, `poisson`, `geometric`, `choice`, `sequential` (cycles `A..B`), `vector`/`square`/`cube`/`box`, `circle`/`sphere` |

One `PROBES` entry per builtin, appended at the end of the existing list
(append-only, no reordering) — 26 probes.

## Verification

- `npm run build` clean (tsc strict).
- `npm test` all green, including the generated-solution compile against the
  pinned RobustToolbox on this VM (`exit 0`).
- `npm run audit:semantics` — **198/198** probes under dotnet 10
  (171 pre-existing + 27 new tier-4: one per builtin, plus a second
  `file2text` missing-file case).

`numStubbedBuiltin` is unchanged by design: that counter tracks call sites of
builtins that are *deliberately* stubbed (UI/engine surface — `winget`,
`winset`, `animate`, …). The new mappings move sites out of *unresolved*,
not out of the intentional-stub bucket.

## Numbers — paradise (`node dist/audit/fidelityAudit.js ~/ss13-corpora/paradise`)

| metric | before | after | Δ |
|---|---|---|---|
| unresolved bare calls | 488 | 352 | −136 |
| stubbed builtin calls | 2,510 | 2,510 | 0 |
| total loss sites (approx) | 23,229 | 23,093 | −136 |

Unresolved sites cleared by name (paradise): `file2text` 32, `md5` 30,
`addtext` 15, `url_encode` 14, `text2file` 12, `generator` 6, `ckeyEx` 6,
`findtext_char` 5, `cmptext` 3, `splittext_char` 2, `findtextEx_char` 2,
`replacetext_char` 2, plus one-site stragglers of the other names.

## Known limits

- `file2text` / `text2file` resolve paths against the probe scratch dir /
  process CWD — BYOND resolves against the .dmb environment dir; equal for
  relative paths in probes, differs for absolute or resource paths.
- `ohearers` / `bounds_dist` operate on `DMRuntime` live-datum vars (`x`, `y`,
  `z`, `bound_width`, `bound_height`); correctness in probes is real, but
  in-game fidelity needs engine entity coordinates (item 65 territory).
- `generator` covers every distribution the ref documents; `choice`/`sequential`
  argument semantics were terse in the ref and follow OpenDream's reading.
- Remaining paradise unresolved (~350) are now dominated by macros
  (`EQUIPMENT` 140, `ASSERT` 63), user-space items (`EXCEPTION` 24, `.` 23),
  movement procs (B-1: `walk` 19, `step_to` 16, …), and UI stubs
  (`winget`/`winshow`/`winclone`/…, stays stubbed) — all owned elsewhere or
  out of scope.
