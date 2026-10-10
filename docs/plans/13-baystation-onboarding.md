# Plan 13 — Baystation12 corpus onboarding

Status: **executed 2026-10-10** · baystation parses at **0 failing files** (baseline 12),
paradise still 0, `npm test` green, probes **171/171** · fidelity snapshot
`docs/audit/13-baystation-audit.json`.

Corpus: `Baystation12/Baystation12` (shallow clone, `~/ss13-corpora/baystation`),
**3,851** `.dm` files. Joins tgstation / tgmc / paradise / beestation as the fifth
parse corpus; the testing corpus going forward is tgstation + baystation + paradise.

## Baseline (pre-fix)

`node dist/tests/repoAudit.js ~/ss13-corpora/baystation`:

- **12 failing files** / **259** total errors / 734 global vars.
- Top `firstErrorCauses`: `Unexpected token '&&'` (4), `Unexpected token 'var'` (3),
  `Unterminated regex literal` (2), `'='`, `')'`, `'(' in type block`.

## Error classes, root causes, fixes

All fixes in `src/preprocessor.ts`, `src/parser/dmLexer.ts`, `src/parser/dmParser.ts`.
Regression coverage: `src/tests/preprocessor.test.ts` tests 29–35.

1. **Stray `}` eaten by initializers** (`recipes_furniture.dm`, expanded PADDED_CHAIR
   macro). `parseInitialValueText` consumed a `}`/`]`/`)` at depth 0, so brace-form
   type blocks `/a/b{ x = 1 }` never closed and swallowed every following
   declaration. → `dmParser.parseInitialValueText` now stops at a depth-0 closer
   *without consuming it*, so `parseTypeBlock` sees its closing `}`.
2. **`@/pattern/` slash-delimited regex literals** (`player_list.dm`,
   `browserOutput.dm`) unsupported by the lexer. → `DMLexer.readSlashRegex()`:
   scans to the unescaped `/` outside `[...]` classes (`]` right after `[`/`[^` is
   literal), emits a StringLiteral.
3. **Same regex inside the preprocessor's scanners**. `parenBalance` and
   `expandMacros` treated `'`, `(` and `/` inside `@/.../` as syntax — in
   `browserOutput.dm` the `ICONSTATE='([^']+)'` pattern toggled icon-string state
   and glued the whole rest of the file into one line. → both scanners now skip
   `@/.../` literals verbatim (escape- and class-aware).
4. **Function-like macro applied to a wrong-arity call** (`spawn_sync.dm`,
   `modules.dm`, `utility.dm`, `combat.dm`). baystation12.dme defines
   `#define check(c) (c && c.valid())` in `ConnectionManager.dm` (dme line ~3436)
   while `check()` 0-arg *procs* are called in files included far earlier
   (line ~131). The audit's global define map expanded `check()` to
   `( && .valid())`. BYOND never applies a macro to a call with the wrong arity. →
   function-like macro expansion now requires matching arity (variadic macros
   accept any count ≥ required params); a mismatch leaves the call as code.
5. **`var/...` declaration in expression position** (`helpers.dm`, `core_field.dm`)
   — the UNLINT idiom `SpacemanDMM_unlint(var/weakref/dw = data[i])`. →
   `parsePrimary` accepts `var/path/name = expr` and `var/name = expr` in
   expression position, emitting an `assignment` node (the declaring scope is
   accepted loss — the emitter maps `assignment` to the assigned value).
6. **`operator[]=` and the operator-overload family** (`_shared_list.dm`) —
   `operator[]=`, `operator+`, `operator+=`, `operator-`, `operator-=`,
   `operator|`, `operator|=`. → `procMatch` appends any Operator token after
   `operator`, plus the `=` of `operator[]=`.
7. **`for(mob in list)` bare type-path loop var** (`randomverbs.dm`). →
   `parseForStatement` accepts a bare TypePath or keyword head and splits the
   last `/` into `loopVar`/`loopVarType` (`for(mob in ...)`,
   `for(mob/M in ...)`).
8. **`#ifdef` inside a `\`-continued expression** (`Diagnostic.dm` MULTIZAS
   list). `joinContinuations` used to glue directive lines verbatim. → it now
   keeps a local conditional stack: `#if`-family lines inside a join are
   evaluated and inactive segments dropped; an `#elif`/`#else`/`#endif` with no
   local frame belongs to the main loop's `condStack` and terminates the join
   (the dangling `\` is stripped). `joinParenBlocks` had the same swallow for
   outer-owned directives — same fix — and now evaluates `#elif` like the other
   joiners. `joinContinuations` also simulates the file's sequential
   `#define`/`#undef`/file-level `#if` state so a same-file define is visible to
   a later continuation-embedded conditional (in production the collected-define
   seed already covers it).

## Final numbers

- **Parse**: 3,851 / 3,851 files clean, **0 errors**, 11 warnings, 731 global vars.
- **Fidelity** (`dist/audit/fidelityAudit.js`): 25,301 types, 26,982 procs,
  totalLossSites **18,153**, unresolved bare calls **494**, stubbed builtins
  **3,336**, `new` 5,150, `..()` 8,743, bitwise 9,607 — full breakdown in
  `docs/audit/13-baystation-audit.json`.
- **Regression**: paradise re-audit 3,842 / 3,842 clean (**0 failing**), `npm test`
  all green, `npm run audit:semantics` **171/171**.

## Known limits

- `var/x = e` in expression position emits an `assignment` node; the declaring
  scope is accepted loss (the emitted C# assigns the value).
- `joinParenBlocks` evaluates continuation-embedded conditionals against the
  defines visible after `joinContinuations` — in production the collected-define
  seed makes them global anyway; a same-file `#define` *after* an `#undef` inside
  the same file follows the sequential simulation only in `joinContinuations`.
- Non-conditional directives (`#define`, `#include`) inside an open paren block
  are still dropped inline (historical behavior, no corpus occurrence).
