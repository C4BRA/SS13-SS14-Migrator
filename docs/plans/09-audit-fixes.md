# Plan 09 — Adversarial Audit Fix Wave

Status: **in progress** (2026-08-02) · Owner: full-pipeline adversarial audit (8 parallel workstreams, GitHub issue #1)

## Why this exists

The audit found the pipeline's reported numbers were partially illusory and that
silent misparses corrupt corpus-wide output. Fix dependency order matters: parser
REDs corrupt everything downstream, so they land first. No feature work resumes
until the wave closes and the audit is re-run for a corrected baseline.

## Corrected headline numbers (from the audit, pre-fix)

| Metric | Old | Corrected |
|---|---|---|
| `totalLossSites` (tgstation) | 119,801 | **~105,198** (−708 double-count, −7,877 stale compile-break counter, −6,018 handled break/continue) |
| Unresolved builtins | 708 | **~593** (−113 unexpanded tgstation macros, −2 case mismatches) |
| Parse errors | 178 | consistent internally; excludes silent misparse classes + `tools/` fixture noise |

## Fix checklist (29 REDs, in dependency order)

### B1 — Parser (land first; corrupts everything downstream)
- [ ] Precedence table: `?` must bind looser than `||`; `<<`/`>>` split from `||`; `&`/`^`/`|` split from relational (`dmParser.ts:1849`)
- [ ] Lexer: `/`+alpha mid-expression must be division, not TypePath (`dmLexer.ts:131-135`)
- [ ] Single-line statement bodies: `if (x) return` (`dmParser.ts:1352-1358`)
- [ ] String interpolation `[expr]` → real AST node; emitter emits `Text(...)` (runtime helper exists)
- [ ] `in`-clause proc args: `M as mob in oview()` — no phantom params (`dmParser.ts:434-485`)
- [ ] Leading-slash-less declarations: `mob/verb/x` (`dmLexer.ts:131` + `dmParser.ts:121`)
- [ ] Assoc literal values: `list("a" = 1)` (`dmParser.ts:1545-1553`)

### B2 — Emitter
- [ ] Switch: terminating `break` after the if/else chain; single-evaluate `switchCond` (`csharpEmitter.ts:231-252`)
- [ ] `continue` in C-style `for` must execute the increment; `continue` inside switch-in-loop targets the for (`csharpEmitter.ts:343-347`)
- [ ] Missing overloads → CS1501: `text2num(t,radix)`, `num2text(n,l,s)`, `findtext(h,n,s,e)`, `replacetext(h,n,r,s,e)`, `splittext(t,sep,start)`, `step_towards(a,b,speed)`, `step_away(a,b,max,speed)`, `rgb(r,g,b,a,space)`, `jointext(L,sep,start,end)`, `initial(x,y)` (`builtinMappings.ts` + runtime)
- [ ] `pathToClassName` collisions → CS0102 (`csharpEmitter.ts:655-658`)

### B3 — Runtime
- [ ] `ReplaceText` empty-needle infinite loop — guard like `ReplaceTextEx` (`dmRuntimeCS.ts:675-694`)

### B4 — IR
- [ ] Special-parent synthesis order: process by path length, not name length (`dmIRGenerator.ts:34,41-43`)
- [ ] Cross-file type split: merge nodes instead of last-wins (`dmIRGenerator.ts:28-31`)
- [ ] `/global/var/` initializer round-trip: preserve string-ness; no `comp` refs in `GlobalVars` (`dmParser.ts:494-531` + `csharpEmitter.ts:147-151`)
- [ ] Trailing-slash base-type check: normalize path before comparing (`dmIRGenerator.ts:137-151`)

### B5 — Harness
- [ ] Remove `numUnresolvedCalls` double-add from `totalLossSites` (`fidelityAudit.ts:400-414`)
- [ ] Drop stale break/continue loss counter (`fidelityAudit.ts:231-232`)
- [ ] Drop stale `numCompileBreak` (`!=`/`~!`/`**`) counter (`fidelityAudit.ts:269-270`)

### B6 — Security
- [ ] `/api/convert`: Origin/Host validation + session token + `outputPath` root validation + request concurrency + decompressed-size enforcement (`gui/server.ts:24-27,66-78`)

### B7 — Media
- [ ] DMI state regex: `state = "x"` (`dmiParser.ts:164-166`)
- [ ] iTXt: 3 NULs, not 5 (`dmiParser.ts:107`)
- [ ] RSI: per-state sprites, direction-major slicing, frame-major delay indexing (`rsiWriter.ts:29-41`)
- [ ] DMM: TGM multi-line defs; per-column sections merge into one grid (`dmmParser.ts:51,81-92,133-137`)
- [ ] MapConverter: real SS14 YAML schema (`uid`/`type`, MapGrid `chunks`); `z` from grid z (`mapConverter.ts:74-93`)

## Probes & tests to add (lock the fixes)

- Switch: runs once, correct case, `break`/`continue` through cases (no infinite loop)
- Precedence combos: `x == b ? c : d`, `a || b << c`, `a | b & c`
- `a/b` division with var; single-line `if (x) return`; interpolation `"[5 + 1]"`; `list("a" = 1)`
- `continue` in C-style `for`; `text2num("ff", 16)`; `replacetext("abc","","x")`; global string/list init
- Cross-file type split + `/obj/item/foo` vs `/obj/ItemFoo` collision (IR/emitter tests)
- Harness: counter unit test (no double-count) on a tiny fixture
- DMI: `state = "x"` syntax, iTXt 3-NUL, multi-state RSI output; DMM: TGM multi-line, negative coords
- GUI: request without Origin/token → 403 (if a test harness for the server is added)

## Deferred (ORANGEs, next wave)

Runtime: `Divide` int truncation, `EqualsValue` 1e-9 tolerance, `FindText` case, `isnull("")`,
`Sign` text branch, `Text2Num` prefix, assoc equality/`in`, culture-dependence, `params2list`
URL-decoding, UTF-16 vs code points, `ispath("x")`. Emitter: `copytext(...,0)`, `for step N`,
`for(var/type)` iteration, `arglist` plain lists, `spawn()` `return`, `+=` list aliasing,
`"x" + null`. Parser: `0x`/`0b`, `1.#INF`, text macros, `@"raw"`, CRLF indentation. Harness:
macro-miscount (span_*), JSON snapshot maps, build sampling, timeout status, `parent_type`,
corpus scoping, silent parse-error content drop. Media: IHDR validation, deciseconds, neg
coords, 515 keys. Preprocessor (own batch): `#if` numeric eval, `//`-in-defines, multi-line
string expansion, `#elif`, `#error`, include-once.

## Structural (GPT review, deferred with triggers)

- Emitter state → `EmissionContext` object: **adopt** with B2 (switch/continue rework)
- AST node split: defer until B1 lands; `ExpressionNode` 18-member union
- Emitter file split: trigger at ~1,500 lines (currently 664)
- IR immutability: only if an optimization pass appears; the real bug was merge logic

## Dynamic-semantics risk register (Phase 3+)

From the GPT review + audit gap analysis — the hard endgame, priced as future phases:
`set waitfor`, by-reference args, appearance inheritance, overlays/underlays, filters,
animation, savefiles, world tick/networking (Phase 3 live server), `world.*` statics.
Foundations to fix first (deferred ORANGEs above): value semantics, list semantics,
control flow — everything else is built on these.
