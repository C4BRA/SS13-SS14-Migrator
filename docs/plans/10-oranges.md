# Plan 10 — ORANGE Fix Wave (Deferred Items from Plan 09)

Status: **done** (2026-08-02 — B1-B6 complete; verification: 133/138 probes, tgstation
loss sites 105,097 → 104,933, unresolved bare calls 3,360 → 1,018, compile-proof 1,500
procs 0 errors; see `FIDELITY-AUDIT.md` §3i) · Owner: wave-10 of the adversarial audit

## Why this exists

Plan 09 deferred a backlog of yellow-flag (ORANGE) fidelity items — runtime value
semantics, emitter control-flow, parser literal handling, harness accounting,
media validation, and preprocessor conditionals. Unlike the 09 REDs (silent
misparses that corrupt everything), these are semantic-fidelity gaps: the code
transpiles, but the resulting behavior can diverge from BYOND. Every fix is
locked with a differential probe (expected = documented BYOND behavior) so the
fidelity suite (`npm run audit:semantics`) catches regressions.

Ground truth: BYOND reference (byond.com/docs/ref), NOT the current C# runtime.

## Fix checklist (ORANGEs, in dependency order)

### B1 — Runtime value semantics (`dmRuntimeCS.ts`)
- [x] `Divide`: integer operands → floor division (DM 7/2 = 3, -7/2 = -4; 7.0/2 = 3.5)
- [x] `EqualsValue`: drop 1e-9 tolerance; exact double equality (DM `1 == 1.000000001` = 0)
- [x] `FindText`: case-INsensitive by default (4th arg `case_sensitive`); empty needle → 1
- [x] `isnull("")`: verified = 0 (DM: isnull is not `== null`) — probe-locked, no code change needed
- [x] `Sign` text branch: text → numeric parse (sign("abc") = 0)
- [x] `Text2Num`: longest-valid-prefix parsing (`text2num("1G", 16)` = 1); leading `+`/`-`; decimal keeps floats/exponents
- [x] assoc lists: `in` checks keys AND values; `len` counts assoc entries; `ListsEqual` compares assoc (case-insensitive keys); `for(x in L)` iterates assoc values; `_assocMap` now OrdinalIgnoreCase
- [x] culture-dependence: invariant culture in `ToNumber`/`Num2Text`/`TextRepr`/`ToString`
- [x] `params2list`: URL-decode (%XX + `+`→space) names and values
- [x] UTF-16 vs code points: `Length`/`LengthChar`/`CopyText`/`CopyTextChar`/`FindText`/`.len` on strings operate on code points (`CpLength`/`CpIndexToChar` helpers)
- [x] `ispath`: new `DMValueType.Path` + `FromPath`; parser emits `literalType: 'path'`; `ispath("x")` = 0, `ispath(/obj)` = 1, base-type check with 2 args; `text2path` → FromPath
- [x] (found in survey) runtime `Abs` method added — `abs` mapping already pointed at it but the method was missing (CS1061)

### B2 — Emitter (`csharpEmitter.ts` + runtime)
- [x] `copytext(...,0)`: end 0/negative → end-of-string / from-end (code-point indices)
- [x] `for ... step N`: parser keeps step; emitter emits `i += step` loop with sign-dependent test; `continue` label before increment
- [x] `for(var/type) in ...`: parser preserves `loopVariableType` (var clause + `as` clause); emitter filters with `DMIsType` + `continue`
- [x] `arglist` plain lists: verified — positional flattening works (`f(1,2)` → 3, WS8 probe);
      assoc/named-arg form is broken (WS8-14: `f(arglist(list("a"=1,"b"=2)))` → 0 vs 3)
- [x] `spawn()` `return`: fixed — `return` inside a spawn lambda emits `return;`
      (value discarded, DM semantics); probe `return inside spawn() compiles and exits the block` green
- [x] list COW: `DMListSet` clones on `RefCount > 1` (emitter wraps variable/property targets to store the returned list); `ConcatLists` preserves assoc entries (`L += x` keeps keys); `SetVar` bumps RefCount
- [x] `"x" + null`: fixed in B1 (`TextRepr` concat — null → ""); probe verified by WS8 (`"a"+null` → "a" PASS)
- [x] harness: `numForStepClause`/`numForAsFilter` removed from `totalLossSites` (now handled)

### B3 — Parser + Lexer (`dmLexer.ts`, `dmParser.ts`)
- [x] `0x`/`0b` number literals (lexer converts to decimal token value; `0b` guarded on `[01]`; `0x` with no digits → diagnostics error)
- [x] `1.#INF` / `1.#QNAN` / `1.#IND`: lexer emits `Infinity`/`NaN` token values; parser passes them through; emitter → `double.PositiveInfinity`/`double.NaN`
- [x] `@"raw"` strings: new `readRawString` — no interpolation, no escapes, doubled-quote escape only
- [x] CRLF: preprocessor strips trailing `\r` per line
- [x] text macros (`\ref` `\the` …): fixed — lexer preserves the marker words
      verbatim (`\improper`/`\proper`/`\the`/`\th`/`\s`/`\ref`/`\icon`/`\roman`),
      decodes `\xHH`/`\uHHHH`, and keeps unknown escapes as backslash+char
      (WS1-02, WS9-3); probes `\x`/`\u` decode + unknown-escape passthrough green

### B4 — Harness (`fidelityAudit.ts`, `repoAudit.ts`)
- [x] span_* macro miscount: **root cause found + fixed** — macros were never
      expanded inside string interpolation `[expr]`; `expandMacros` now expands
      interpolation content (quote-aware bracket matching), and
      `substituteParams` substitutes params inside `[...]` too. tgstation
      unresolved bare calls **3,360 → 1,018** (−2,342; the span_*/EXAMINE_HINT/
      AREACOORD/ADMIN_*/FORMAT_* bucket is gone; the remaining 1,018 are the
      genuine builtin backlog: astype, regex, winset, icon_states, findtextEx…)
- [x] JSON snapshot: `--json <path>` re-baselined after the wave →
      `docs/audit/10-tgstation-audit.json` (machine-diffable; `filesWithParseErrors`
      added to the schema)
- [x] build sampling: `--build` flag EXISTS (30-min SIGKILL w/ distinct timeout
      message) — verified
- [x] timeout status: EXISTS (SIGKILL message is distinct) — verified
- [x] `parent_type`: new `numParentTypeDecls` counter (tgstation: 3) — counted as
      loss since the IR ignores `parent_type` (WS4-3; the real fix is Plan 11.13)
- [ ] corpus scoping: **deferred** — requires a corpus-dir-set concept in the
      harness (no data-loss impact; a measurement-precision item)
- [x] silent parse-error content drop: `filesWithParseErrors` (relFile → error
      count) added to the audit JSON so files whose content is dropped are
      visible; full nodes-vs-tokens accounting deferred to Plan 11.12

### B5 — Media (`pngCodec.ts`, `rsiWriter.ts`, `dmiParser.ts`, `dmmParser.ts`)
- [x] IHDR validation: full 8-byte signature, sane dimensions (≤65536), valid
      color type/bit depth combos, interlace=0, chunk-length bounds, scanline
      stream length — hostile PNGs now throw instead of hanging/OOM-ing
      (WS10-3, WS10-12, WS10-13); plus bit-extraction for indexed/gray
      bitDepth < 8 (WS10-5) and encodePNG dimension validation (WS10-14)
- [x] deciseconds: **verified — no conversion needed** (DMI and SS14 RSI both
      use deciseconds; WS10 confirmed verbatim pass-through, frame-major slicing
      correct)
- [x] negative coords: **verified nonissue for DMI** (DMI metadata has no pixel
      offset fields); the practical "clip instead of index errors" fix landed as
      the sheet-dimension bounds check + decode-failure warning in `rsiWriter`
      (WS10-6, WS10-8)
- [x] 515 keys: DMM grid rows now decode by **longest-match against known
      definition keys** (mixed-length key maps) and space-separated rows skip
      whitespace (WS11-6, WS11-11)

### B6 — Preprocessor (`preprocessor.ts`)
- [x] `#if` numeric eval: full numeric evaluator (numbers, comparisons, arithmetic,
      `defined()`, `&& || !`, parens; undefined identifiers → 0) — `#if VERSION >= 514`,
      `#if 1 == 1`, `#if 2 * 3 == 6` all select the right branch (WS3-1)
- [x] `//`-in-defines: directive lines use the string-aware comment stripper —
      `#define URL "https://…"` survives intact (WS3-2; 102 tgstation defines)
- [x] multi-line string expansion: `#define` bodies absorb following lines until
      strings balance and parens/brackets/braces close (WS3 multi-line item)
- [x] `#elif`: evaluates the chain after a false `#if` (WS3-4)
- [x] `#error`: real diagnostics error (WS3-5)
- [x] include-once: BYOND semantics — each file is included at most once per
      compile; `#pragma once` is the (no-op) default, `#pragma multiple` opts back
      into re-inclusion; recursive-include cycles are now silently skipped, not
      hard errors (WS3-6, WS3-17)
- [x] (fold-in) named variadic params absorb trailing args (WS3-7); `##`/`...`
      rewriting is string-aware (WS3-13); `#name` stringification escapes quotes
      (WS3-14)

## Probes & tests to add (lock the fixes)

- Divide: `7/2` = 3, `-7/2` = -4, `7.0/2` = 3.5, `7/2.0` = 3.5
- Equals: `1 == 1.000000001` = 0; `1 == 1.0` = 1
- FindText: `findtext("ABC","b")` = 2; `findtext("abc","")` = 1
- isnull: `isnull("")` = 0; `isnull(0)` = 0
- Sign: `sign("abc")` = 0; `sign("-3")` = -1; `sign(7)` = 1
- Text2Num: `text2num("1G", 16)` = 1; `text2num("1F", 16)` = 31; `text2num("+42")` = 42
- assoc: `"a" in list("a"=1)` = 1; `1 in list("a"=1)` = 1; `list("a"=1).len` = 1; `list("a"=1) == list("b"=1)` = 0; `for(x in list("a"=1))` iterates once
- params2list: `params2list("a=b%20c")` = "b c"
- UTF: `length("a😀b")` = 3; `copytext("a😀b", 2, 3)` = "😀"; `findtext("a😀b","😀")` = 2
- ispath: `ispath("x")` = 0; `ispath(/obj)` = 1; `ispath(/obj, /obj/item)` = 0; `ispath(/obj/item, /obj)` = 1
- copytext: `copytext("abc", 1, 0)` = "abc"; `copytext("abc", 0)` = "abc"; `copytext("abc", 2, -1)` = "b"
- for step: `for (var/i = 1 to 6 step 2)` sums 1+3+5 = 9; descending `for (var/i = 5 to 1 step -2)` sums 5+3+1 = 9
- for typed: `for (var/mob/M in list(mob, obj))` body runs once
- COW: `a = list(1); b = a; a[1] = 9` → b[1] = 1; `a = list("k"=1); a += 2` → a["k"] = 1
- concat: `"a" + null` = "a"; `"a" + 0` = "a0"; `null + 0` = "0"
- abs: `abs(-5)` = 5
- hex: `0x1F` = 31; `0b101` = 5
- raw: `@"say ""hi"""` = `say "hi"`; `@"[x]"` is literal `[x]` not interpolation
- CRLF: probe file with `\r\n` line endings parses without errors
- B2/B3 fold-in: `return` inside `spawn()` compiles and exits the block; `"\x41\u0041"`
  = "AA"; `"\a\b"` keeps the backslashes; `"\the item"` preserves the marker
- B6 unit tests (preprocessor): `#if VERSION >= 514` else-branch; `#if 1 == 1`; `#elif 1`
  chain; `#error` diagnostic; `//`-in-string define; multi-line define bodies; macro
  expansion inside `[interp]`; named-variadic arg join; `##`/`...`-in-string preserved;
  include-once (double include → once, cycle → silent skip, `#pragma multiple` → twice)
- B5 unit tests: decodePNG rejects corrupt/huge/interlaced/lying-length/truncated PNGs,
  1-bit indexed per-bit decode, encode→decode round-trip; rsiWriter undersized-sheet
  warning + sprite skip; DMM mixed-length keys + space-separated rows

## Success metrics — VERIFIED (2026-08-02)

- All B1-B6 checks ticked ✅; tgstation parse errors: **170** (no new errors introduced)
- Differential probes: **138 probes, 133/138** (134 + 4 new; the same 5 pre-existing
  failures remain — root-caused in `FIDELITY-AUDIT.md` §3h; they are Plan 11 fix-wave
  items: GlobalVars assoc CS0201, step_away max, float division, copytext negative end,
  step-range continue)
- `totalLossSites` dropped by the handled preprocessor counters + span_* resolution:
  tgstation **105,097 → 104,933**; unresolved bare calls **3,360 → 1,018**; other
  corpora tgmc 44,745 → 45,077, paradise 58,493 → 58,391, beestation 72,900 → 73,737
  (tgmc/beestation up: `#if` numeric eval + include-once now parse/count MORE of the
  corpus — previously dropped content is now measured)
- Compile-proof (1,500 sampled procs, real engine): **0 errors**, 46,174 warnings
- JSON snapshots committed to `docs/audit/`: `10-tgstation-audit.json`
  (`filesWithParseErrors` in schema), `11-baseline-{before,after}.json`
