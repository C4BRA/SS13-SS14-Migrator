# Plan 11 — Full-Codebase Adversarial Audit: Findings Report

Audit executed 2026-08-02 (findings-only mode; no source fixes). 13 parallel workstreams
(WS1-13) across the full pipeline: lexer → parser → preprocessor → IR → emitter → YAML →
builtin mappings → embedded C# runtime → DMI/PNG/RSI media → DMM/map media → GUI/CLI/
pipeline → audit-harness integrity. Every finding was proven with a repro (DM input,
fixture, or request → observed vs expected); semantics claims were verified against
BYOND reference docs and, where cheap, executed under dotnet 10 against the converted
runtime.

**Totals: 200 findings — 56 🔴 / 64 🟠 / 56 🟡 / 24 🟢.**

| WS | Module | 🔴 | 🟠 | 🟡 | 🟢 |
|---|---|---:|---:|---:|---:|
| WS1 | lexer | 3 | 3 | 2 | 2 |
| WS2 | parser | 4 | 8 | 6 | 2 |
| WS3 | preprocessor | 6 | 5 | 7 | 2 |
| WS4 | IR/symbols | 4 | 5 | 2 | 1 |
| WS5 | emitter | 7 | 10 | 2 | 1 |
| WS6 | YAML | 4 | 3 | 3 | 1 |
| WS7 | builtins | 6 | 9 | 4 | 1 |
| WS8 | runtime core | 11 | 7 | 1 | 1 |
| WS9 | runtime builtins | 5 | 3 | 3 | 0 |
| WS10 | DMI/PNG/RSI | 3 | 7 | 4 | 1 |
| WS11 | DMM/maps | 2 | 3 | 6 | 4 |
| WS12 | GUI/CLI/pipeline | 0 | 1 | 6 | 4 |
| WS13 | harness integrity | 1 | 0 | 10 | 4 |

Evidence scaffolding was kept in `$TMPDIR` (`/var/folders/.../T/opencode/ws{1-13}`); the
repo's `src/` was not modified by this audit.

---

## 1. Headline REDs (what a future fix wave must land first)

1. **Generated C# breaks on legal DM names** — `operator""` procs, dot-paths
   (`/obj/weapon.sword`), dotted proc names (`foo.bar`), case-colliding procs → CS1003/
   CS0246/CS0111 (WS5-1..5). Hostile corpus: build fails with 11 error classes.
2. **`/global/var/` decls dropped in production** — `index.ts:82` never passes globals to
   the emitter; `GLOB.x` reads Null in every transpiled solution (WS4-4, WS5-13).
3. **Type-path case-insensitivity ignored** — `/OBJ/x` vs `/obj/x` = two types, duplicate
   YAML ids, disjoint registries, wrong synthesized parents (WS4-1).
4. **`JsonEscape` emits invalid JSON** for `"`, `\`, `\n`, `\r`, `\t` (template escape
   collapse) — `json_encode` silently corrupts (WS9-1, confirmed by WS13-7).
5. **RSI direction swap** — DMI 4-dir rows (S,N,E,W) copied verbatim into SS14 indices
   (S,E,N,W): North and East sprites are swapped (WS10-1, color-row proof).
6. **MapConverter chunk serialization broken** — tile lines emitted as siblings of
   `chunks:` (wrong indent) → every converted map loses all tiles; tile prototypes
   (`TurfFloor`) don't exist in SS14 (WS11-1, WS11-2).
7. **Divide/Modulo semantics broken by Plan-10 rework** — `7.0/2` → 3, `7.5 % 2` → 1.5,
   div-by-zero → 0; 3 of the 5 failing semantic probes trace here (WS8-1..3).
8. **Step-range `for` + `continue` = infinite loop** — label prefix mismatch
   (`__dmForInCont` vs `__dmForCont`) → the 5th failing probe **times out** (WS5-8,
   WS13 root-cause table).
9. **`copytext`/`FindText` negative-end dead branch** — negative end is clobbered before
   it is tested (WS13 root-cause; WS7-12).
10. **PNG decoder: no CRC, no IHDR validation, no bounds checks** — corrupted/hostile
    PNGs decode silently wrong; a ~1 KB PNG declaring 100000×100000 **hung the process**
    (WS10-2, WS10-3).
11. **YAML scalar/escape corruption** — `yes`/`123`/`0x1F` deserialize to non-strings;
    `\"` inside a string breaks the whole document; `shape:` loses `type: PhysShapeAABB`
    (WS6-1..3).
12. **Preprocessor divergences at corpus scale** — 34 tgstation files' `#define`s
    truncated at `//`-in-string (including all `byond://` hrefs); `#if NUM` wrong;
    `#elif`/`#error` unhandled; exponential macro expansion **hangs** (WS3-1..6).
13. **`in` precedence** — BYOND's own doc example parses backwards (`var/x = y in z`
    should be `(x = y) in z`) (WS2-1).
14. **GUI symlink escape proven end-to-end** — `outputPath` through a home symlink wrote
    `Content.sln` into `/Users/Shared`; the 429 single-flight guard is a no-op (two
    concurrent conversions both run) (WS12-1, WS12-2).
15. **Harness undercounts** — 52% of "broken builtin prop reads" (`.len/.x/.y/.z`) are
    runtime-handled; stub builtins (sound/locate/icon/animate… ~4,500 tgstation sites)
    count as zero loss (WS13-1, WS7-16).

## 2. Baselines (before == after; this audit changed no source)

| Metric | Before (2026-08-02) | After | Delta |
|---|---:|---:|---|
| `npm run build` (tsc strict) | clean | clean | 0 |
| `npm test` | green (engine check skipped: no repo-relative RobustToolbox) | green | 0 |
| Semantic probes | **129/134** (5 fail, §3) | 129/134 (same 5) | 0 |
| Loss sites — tgstation | 105,097 | 105,097 | 0 |
| Loss sites — tgmc | 44,745 | — | — |
| Loss sites — paradise | 58,493 | — | — |
| Loss sites — beestation | 72,900 | — | — |
| Unknown builtin calls — tgstation | 3,360 | 3,360 | 0 |
| Compile-proof (1,500 sampled procs, real engine) | **0 errors**, 46,374 CS0162 warnings | 0 errors, same warnings | 0 |

Notes: the full 44,826-proc compile proof (0 C# errors) was last published in
FIDELITY-AUDIT.md §3b-3e; this session re-verified at 1,500 procs (fresh, real-engine,
green). CS0162 (unreachable code) confirms WS5-18 at corpus scale. `npm test`'s
engine-build step looks for RobustToolbox at repo-relative path and skipped; with
`SS14_ENGINE_DIR` set it builds green.

## 3. The 5 failing semantic probes — root causes

| Probe | Expected → Observed | Root cause | WS |
|---|---|---|---|
| assoc key on global list persists | 5 → **BUILD FAILED CS0201** | GlobalVars assoc assignment emitted as parenthesized `(await GlobalVars.Set(…))` statement; emitter strips parens only for calls, not index_assignments (`csharpEmitter.ts:509-510`) | WS8/WS13 |
| step_away() moves one step away | 4 → 3 | 2-arg overload passes max=0 → `Math.Max(1,0)=1`; BYOND default Max=5 (unlimited=0) (`dmRuntimeCS.ts:1195-1212`) | WS7-10 |
| division with a fractional operand | 3.5 → 3 | `7.0` and `7` are indistinguishable doubles; floor test `dividend == Math.Floor(dividend)` misclassifies `7.0/2` as int division (`dmRuntimeCS.ts:149`) | WS8-1 |
| copytext with negative end | "b" → "bc" | `if (endIdx <= 0) endIdx = cpLen+1` runs before `else if (endIdx < 0)`; negative branch dead (`dmRuntimeCS.ts:1913-1914`; same in startIdx :1906 and FindText :1933) | WS13/WS7-12 |
| for range step with continue | 6 → **ETIMEDOUT** | Label `__dmForInContN` vs prefix test `__dmForCont`; plain `continue` skips the increment → infinite `while` (`csharpEmitter.ts:343,445`) | WS5-8 |

---

## 4. Findings by workstream

### WS1 — Lexer (`src/parser/dmLexer.ts`)

**11-WS1-01 🔴 :280-292** Block comments not nested (BYOND nests them) — `/* a /* b */ c */` re-lexes the inner content as code, zero diagnostics. Fix: depth counter. Lock: `/* a /* b */ c */ x()` → only `x()`.
**11-WS1-02 🔴 :409-421** DM text macros corrupted: `"\x41"` → `x41`, `"\u0041"` → `u0041`, `"\the [x]"` → TAB; `"\improper CPU"` loses the marker. Fix: macro table before single-char fallback.
**11-WS1-03 🔴 :384-408** Interpolation scan not quote-aware: `"foo [bar("\"]")]"` → 3 tokens + error. Fix: quote-aware bracket matching. Lock: one token, no diagnostics.
**11-WS1-04 🟠 :146-161,203-207** DM arbitrary-delimiter regex/raw literals unsupported (`new(@/(\d+)/)` errors); invalid `@abc@` accepted silently.
**11-WS1-05 🟠 :234-237** `#` mid-line silently deletes the rest of the line (`var x = 5 # y = 3` drops `y = 3`, no diagnostic).
**11-WS1-06 🟠 :90-105** Trailing whitespace on the final line emits a phantom unbalanced `Indent` token.
**11-WS1-07 🟡 :111-119** Inconsistent indent = warning only; block structure silently guessed (DM errors).
**11-WS1-08 🟡 :572-579** `1.#INFERNO` fabricates `Infinity` (no trailing delimiter on `INF`).
**11-WS1-09 🟢 :361-408** FileLiteral `'a [b'` runs the string interpolation scanner → spurious errors (interp is double-quote-only).
**11-WS1-10 🟢 :436-463** Doc strings keep escapes raw (`{"a\nb"}` = literal `\n`; DM applies escapes).

Verified clean: `0x`→error+fabricated `0` (design), `{"a","b"}` one token (correct per DM), unterminated constructs error cleanly, no hangs (50k parens 241 ms; 10 MB line 2.2 s linear), determinism byte-identical.

### WS2 — Parser (`src/parser/dmParser.ts`)

**11-WS2-01 🔴 :1946** `in` at equality precedence; BYOND's doc example `has_thing = thing in src` parses backwards.
**11-WS2-02 🔴 :1488-1496** Division reconstruction never runs postfix: `return x/b(...)` → ghost `call ".."()` + error.
**11-WS2-03 🔴 :366-398** Bare relative child type in a block (`/obj/item` + `sword` + indented members) silently dropped; members attach to parent.
**11-WS2-04 🔴 :366-379** Absolute sub-path in block doubles the parent (`/obj/item/obj/item/sword`); `sword/name = "x"` → junk type.
**11-WS2-05 🟠 :176-194,303-309** Top-level `var/x = 5` / `var/list/x[6]` misparse to `/var/x` junk types; initializer silently dropped.
**11-WS2-06 🟠 :521-546** Stray `}` in a type initializer drives depth negative → swallows the next declaration, no diagnostics.
**11-WS2-07 🟠 :1462-1479** Ternary-`:` heuristic misbinds when the true-branch is a call/chained deref (`a ? f(x):y : z`).
**11-WS2-08 🟠 :1611-1623** Identifier-keyed assoc `list(a = 1)` → `assignment` node → emitter emits `SetVar` side effect, not a key/value.
**11-WS2-09 🟠 :1132-1140** Multi-var for-heads lose variables (`for(var/gas_path, amount in x)` drops `amount`; two-`in` form explodes the enclosing proc).
**11-WS2-10 🟠 :1160,1164,1273,1918** Unbalanced `)`/`]`/`}` never reported — next statement silently absorbed (`for(var/x in list` + indented body; `f(x` swallows `return 2`).
**11-WS2-11 🟠 :1237-1293** `switch(x) if(1) return 2` (same line) → zero cases; the `if` leaks into enclosing scope.
**11-WS2-12 🟠 :91-95,129-134** Parser state not reset on second `parse()` (returns `[]`); splice mutates caller token array → nondeterministic reuse.
**11-WS2-13 🟡 :497-500,206-211** Proc-arg default values and `as` return types consumed + dropped (no AST surface).
**11-WS2-14 🟡 :761-773+907-919,504-507,321-333,1719-1722** Five silent drops: `set` (dead duplicate handler at :907), `in`-clause args, stray identifiers, `/savefile/byond_version = 516`, FileLiteral kind.
**11-WS2-15 🟡 :1855-1858** `var/to = 5; return to` errors → null literal (keyword-as-identifier inconsistent).
**11-WS2-16 🟡 :1766-1799** `var/x = new` (no type) accepted silently with empty typePath.
**11-WS2-17 🟡 :1893-1897** Weighted `pick(20;"brown",30;"grey")` flattens to a plain arg list — identical shape to unweighted pick.
**11-WS2-18 🟡 :600-692** `var/global/y` inside a type block loses the global flag (`varType: "/global"`).
**11-WS2-19 🟢 :1258-1316** Same-line brace switch with `;` separators: correct AST + spurious error.
**11-WS2-20 🟢 :1934-1958** Precedence verified vs BYOND: all rows match except `in` (WS2-01); `..`/`as`/`to` unverifiable (not BYOND binary ops); `<>`/`<=>` unlexed.

### WS3 — Preprocessor (`src/preprocessor.ts`)

**11-WS3-01 🔴 :1008-1027** `#if` reduces non-identifier operands to `defined()`: `#if VERSION >= 514` (VERSION=500) → HIGH; `#if 1` → OFF; BYOND's own doc pattern. tgstation: `code/__byond_version_compat.dm:6`.
**11-WS3-02 🔴 :87,493-496** `stripComment` string-unaware: 34 tgstation files truncate `#define`s at `//`-in-string — all 32 `byond://` href defines (22 in `admin.dm`).
**11-WS3-03 🔴 :22,599,616-620** Depth cap bounds recursion, not work: `#define A B B` + `#define B A A` → exponential blowup, **8 s+ hang** (linear recursion OK).
**11-WS3-04 🔴 :189-193** `#elif` unhandled → `#if 0/#elif 1/#else` selects `#else`; tgstation 2 files.
**11-WS3-05 🔴 :189-193** `#error` downgraded to a warning, processing continues; tgstation 6 files.
**11-WS3-06 🔴 :183-188** `#pragma once` no-op; double include expands twice (BYOND includes-once by default).
**11-WS3-07 🟠 :666-685** Named variadic params (`rest...`) don't absorb extras — `F(1,2,3)` → `[1][2]`; 35 tgstation variadic files.
**11-WS3-08 🟠 :244-255** A line starting `#` breaks paren/template joining — corrupts `{"...\n#foo\n..."}` and multi-line macro args.
**11-WS3-09 🟠 :1034-1077** Seed pass context-blind (collects defines inside comments/`#if 0`/after `#undef`), first-wins by unsorted `readdirSync` order (OS-dependent).
**11-WS3-10 🟠 :197-204,29** Block-comment state desyncs across inactive `#if` boundaries → stray `*/` tokens.
**11-WS3-11 🟠 :183-186** All real pragmas (`multiple`, `push/pop`, `warn`, `syntax`, …) warned-and-ignored.
**11-WS3-12 🟡 :669-672** Macro arity mismatches silent (`F()` → `[][]`; `F(1,2,3)` drops extra).
**11-WS3-13 🟡 :680-683** `##`/`...` rewriting applied inside string literals for function macros (`#define F() "a##b"` → `"ab"`).
**11-WS3-14 🟡 :745** `#param` stringification doesn't escape quotes (`Q(a"b")` → broken literal).
**11-WS3-15 🟡 :215-260** Diagnostics report post-join line numbers (a `#warn` on original line 9 reported at 3:1).
**11-WS3-16 🟡 :169-172** Existing non-`.dm` includes silently skipped, no diagnostic.
**11-WS3-17 🟡 :55-58** Recursive include: error at 0:0, rest of chain still emitted.
**11-WS3-18 🟡 :122-146 vs index.ts:51-61** Use-before-define expands only if the seed pass collected it — silent order dependence.
**11-WS3-19 🟢 :124** (pre-seeded suspect DISPROVED) `#define FOO (x) (y)` correctly object-like.
**11-WS3-20 🟢 :76,53-65** CRLF + cross-run determinism verified OK.

### WS4 — IR / SymbolTable (`src/ir/dmIRGenerator.ts`, `symbolTable.ts`)

**11-WS4-1 🔴 :31-40 + symbolTable.ts:66-70** Case-insensitive type identity broken: `/OBJ/Item/Foo` + `/obj/item/foo` → 2 IR types, duplicate YAML ids, disjoint ProcRegistry keys, wrong parents (`/OBJ`→`/datum` vs `/obj`→`/atom/movable`).
**11-WS4-2 🔴 :91-99,160-166** `density = TRUE`/`yes` → `Boolean(Number("TRUE"))=false` — walls become passable (works only when a corpus `#define TRUE 1` exists).
**11-WS4-3 🔴 :52-57,100-103** `parent_type` silently ignored — prefix parent used, inheritance lost, var forced dynamic.
**11-WS4-4 🔴 src/index.ts:82** `emitCSharpSystems(irMap, dir)` never passes `parser.globalVars` → production GlobalVars empty, `GLOB.x` always Null (tests/audit pass globals; production doesn't).
**11-WS4-5 🟠 :79-84** Bare `var/name`/`var/desc` → literal `"null"` strings overwrite inherited values.
**11-WS4-6 🟠 yamlGenerator.ts:118** Custom var named `type` dropped from initialVars.
**11-WS4-7 🟠 :34-36** `generateIR` mutates caller AST nodes — subset re-run leaks other files' vars/procs.
**11-WS4-8 🟠 dmRuntimeCS.ts:504-515 vs symbolTable.ts:85-93** Runtime `TryGetInherited` walk lacks SPECIAL_PARENTS (`/obj`→`/atom/movable`) → `..()` in /obj|/mob subtree resolves Null.
**11-WS4-9 🟠 :160-166** customVars all raw text: `10` ≡ `"10"`, `TRUE`, `list(1,2)` mangled to `"list ( 1 , 2 )"`.
**11-WS4-10 🟡 yamlGenerator.ts:13-14** `/proc` namespace leaks as YAML prototype `id: proc, parent: BaseItem`; verb decls lose metadata.
**11-WS4-11 🟡 parser.ts:95,164-171** Duplicate `/global/var/x` across files: silent last-wins, no diagnostic (DM errors).
**11-WS4-12 🟢** Verified OK: cross-file merge, DFS synthesis, trailing-slash merge, ensureBaseTypes non-mutation, synthesized `/atom/movable` merges with real decls.

### WS5 — Emitter (`src/transpiler/csharpEmitter.ts`)

**11-WS5-1 🔴 :79,102** `operator""` proc names → invalid C# in registration + member decl → CS1003 (cascades to 8+ secondary classes).
**11-WS5-2 🔴 :79,102,823** Dot-paths (`/obj/weapon.sword`) → `Proc_ObjWeapon.sword_Foo` → CS0246/CS0106/CS0538.
**11-WS5-3 🔴 :78-79,102** Dotted proc names (`/proc/foo.bar()`) → same break.
**11-WS5-4 🔴 :752** `initial(x, "name")` 2-arg path interpolates the name without `escapeString` → CS1003 on quoted names.
**11-WS5-5 🔴 :78-79** Case-colliding procs on one type (`foo`/`Foo`) → duplicate member → CS0111.
**11-WS5-6 🔴 :258-264** Default-only switch emits a bare `else` → CS8641.
**11-WS5-7 🔴 :545 + builtinMappings.ts:28-29** `spawn()` as expression: void call in value position → CS1503; body dropped.
**11-WS5-8 🟠 :343 vs 445** Step-range `for` `continue` emits plain `continue` (label prefix mismatch) → **infinite loop** (suite probe times out).
**11-WS5-9 🟠 :524-525** TryStatement + LabeledBlockStatement bodies → `// Unknown statement` (try/catch and labels silently dropped).
**11-WS5-10 🟠 :678-679,689** Bitwise `& | ^ ~` → `DMValue.Null`.
**11-WS5-11 🟠 :651,653,677** `~=`/`~!` → exact Equals; `%%` ≡ `%` (distinct DM semantics lost).
**11-WS5-12 🟠 :674** `as` cast is a no-op.
**11-WS5-13 🟠 :155-164 + index.ts:82** GlobalVars never wired in production (dup of WS4-4).
**11-WS5-14 🟠 :807-809** `\0` corrupts to `0`; escapeString misses `\a\b\f\v\e`; raw control bytes land in emitted .cs.
**11-WS5-15 🟠 :721-724 vs 777-780** Calling a var holding a `call()` proc-ref dispatches by name → Null (only direct `call(...)(args)` works).
**11-WS5-16 🟠 :102 + registry** Case-sensitive registration/lookup vs case-insensitive DM — `CallProc("Hello")` vs registered `hello` → Null.
**11-WS5-17 🟠 :339,336-338** `continue` outside a loop silently commented; in switch-without-loop becomes `break` (DM errors).
**11-WS5-18 🟡 :98,470,490** Unconditional trailing `return comp.GetVar(".")` → CS0162 everywhere (46,374 at corpus scale); unreferenced `__dmForInCont` labels → CS0164.
**11-WS5-19 🟡 :321-327** Top-level `break` → raw CS0139 from C# instead of a transpiler diagnostic.
**11-WS5-20 🟢 :85,297-303** Verified safe: C#-keyword var/arg names (`event`, `class`, `new`), 510-char names, `__dmIterN` uniqueness. Hostile corpus overall: **build FAILED** (11 CS classes).

### WS6 — YAML (`src/transpiler/yamlGenerator.ts`)

**11-WS6-1 🔴 :136** YAML 1.1 scalar trap: `yes`→bool, `001`→int 1, `0x1F`→31, `123`→int, `null`/`~`→None (empirical PyYAML round-trip).
**11-WS6-2 🔴 :137** Backslash before `"` unescaped → invalid YAML, whole `converted_entities.yml` rejected (`"say \"hi\""` → ParserError).
**11-WS6-3 🔴 :118** `type` key skipped at ALL depths → `shape:` emits empty (loses `PhysShapeAABB`) for every dense entity.
**11-WS6-4 🔴 :91-93** `pathToId` collisions: `/obj/item/a_b` ≡ `/obj/item/a/b`, case variants → duplicate prototype ids, ambiguous parents.
**11-WS6-5 🟠 :25** `.dmi`→`.rsi` case-sensitive → `ICON.DMI` never rewritten (asset path mismatch).
**11-WS6-6 🟠 :118** `var/type` dropped from initialVars; empty `initialVars:` → None.
**11-WS6-7 🟠 :101-102** `name`/`description` emitted bare → `desc = "0"` → int 0, `desc = "yes"` → bool.
**11-WS6-8 🟡 :101** Bare `var/name` → `name: null` (YAML null, unquoted) — entity with null display name.
**11-WS6-9 🟡 :122-126** `list(...)` initializers stringified (`"list ( \"yes\" , 123 )"`); array branch dead code.
**11-WS6-10 🟡 :77-89** `/datum` children get `parent: BaseItem`; dense `/turf/*` children → `BaseFloor` chain (density ignored below root).
**11-WS6-11 🟢 :96-110** Indentation, `- type: entity` header, punctuation scalars verified sound.

### WS7 — Builtins (`src/transpiler/builtinMappings.ts` + runtime)

**11-WS7-01 🟠 :25 + fidelityAudit.ts:244** Exact-case dispatch: `Pick(`/`RAND(`/`NAMEOF(`/`FLOOR(`/`CEILING(` (corpus hits) silently miss → Null; detection accurate, production broken.
**11-WS7-02 🔴 :4-22** `findtextEx` unmapped → Null (13 tgstation calls incl. 4-arg forms).
**11-WS7-03 🔴 :182-183 + runtime :2007** `log(X,Y)` mapped to 1-arg `Log` → CS1501 on every 2-arg call (≥7 tgstation) — counted as resolved.
**11-WS7-04 🔴 :68-69 + :1970-1978** `round(A,B)` = nearest multiple in BYOND; runtime does decimal places (565 two-arg calls mis-round).
**11-WS7-05 🔴 :118-119 + :911-927** `turn` rotates clockwise; BYOND counterclockwise (`turn(1,90)`=EAST, should be WEST; 159 calls).
**11-WS7-06 🔴 :196-197 + :2060-2064** `sorttext` sign reversed (`sorttext("A","B")` = −1; ascending comparators become descending; 27 calls).
**11-WS7-07 🔴 :98-101 + :749-758** `isloc`/`ismovable` hardwired to `/atom`/`/atom/movable` string bases that never match real type paths → always 0 (229 ismovable + 4 isloc calls).
**11-WS7-08 🟠 :182-209,234-243** Six BYOND-legal arities → CS1501/CS7036: `time2text` 3-arg (37 calls), `get_step_away` 3-arg (2), `replacetextEx` 4-arg, `splittext` 4-arg, `prob()` (8), `turn()` 0-arg.
**11-WS7-09 🟠 :1722-1736** `rand(N)` returns 1..N; BYOND 0..N (26 literal 1-arg calls).
**11-WS7-10 🟠 :1195-1198** 2-arg `step_away` max=0 → clamped 1 (BYOND default Max=5); Speed treated as steps not pixels (12 calls).
**11-WS7-11 🟠 :2048-2058** `ckey` keeps spaces (`"John_Doe"` → `"john doe"` vs `"johndoe"`; 100 calls).
**11-WS7-12 🟠 :1924-1946** `findtext` End inclusive vs BYOND exclusive (16 four-arg calls).
**11-WS7-13 🟠 :765-804** `replacetext` doesn't preserve found-text case (`"One on one"`→`"two on two"` vs `"Two on two"`; 295 calls).
**11-WS7-14 🟡 :1358-1382** `jointext` End inclusive + no negative End (218 calls).
**11-WS7-15 🟡 :1879-1897** `num2text` 2-arg = sig-figs/scientific in BYOND; runtime treats as min-width (71 calls).
**11-WS7-16 🟠 :13-21,154-169,222-233 + audit :244** Stub set counted as RESOLVED: animate 939, image 678, icon 313, matrix 254, input 244, flick 201, sound 183, locate 1813, refcount 11 — all silent Null, zero loss attributed.
**11-WS7-17 🟠 :28-29** spawn-as-expression drops body + void-call (dup of WS5-7).
**11-WS7-18 🟡 :2184-2204** `time2text` default format `"hh:mm:ss"` vs BYOND's `"DDD MMM DD hh:mm:ss YYYY"`; DDD/Month/Day unsupported.
**11-WS7-19 🟡 :1633-1651** `call(/proc/MyProc)(args)` path form never invokes (empty ProcName → registry miss).
**11-WS7-20 🟢 :1095-1132** `block()` coord form arg order wrong (x1,y1,z1,x2,y2,z2 vs x1,y1,x2,y2,z); `max(L)`/`min(L)` list form returns the list.

Verdict table (46 audited): 22 OK* · 15 WRONG-SEMANTICS · 5 ARITY/CS1501 · 5 STUB · 2 ORDER-SWAPPED · 2 UNVERIFIABLE (see WS7 agent output for the full table).

### WS8 — Runtime core semantics (`src/runtimeTemplate/dmRuntimeCS.ts`)

**11-WS8-1 🔴 :149-150** Floor-division heuristic misclassifies float values — `7.0/2`→3, `7/2.0`→3, `-7.0/2`→−4 (proven; the suite's own probe fails).
**11-WS8-2 🔴 :153** `%` doesn't truncate operands: `7.5 % 2`→1.5 (BYOND 1).
**11-WS8-3 🟠 :145,153** Div/mod by zero → 0 (BYOND runtime error).
**11-WS8-4 🔴 :170** Text `<`/`>` case-INsensitive; BYOND case-SENSITIVE (`"a" < "B"`→1, BYOND 0).
**11-WS8-5 🟠 :75** `"0"` treated falsy; BYOND: only 0/""/null falsy → `if("0")` is true.
**11-WS8-6 🟠 :251-260** `null == 0/""/"0"` → 1; BYOND ref: null equals only null (docs explicit; flagged for live-BYOND re-verification before shipping).
**11-WS8-7 🔴 :1443-1452** `rgb()` no clamp: `rgb(300,0,0)`→`#12C0000` (7 digits), `rgb(-5,0,0)`→10-digit two's-complement.
**11-WS8-8 🔴 :1970-1978** `round(2.5)`→3 (BYOND floor → 2); 2-arg = decimal places, not nearest multiple (dup root cause of WS7-4).
**11-WS8-9 🔴 :1889-1897** `num2text(123.456,2)`→"123.456" (BYOND "1.2e2") (dup of WS7-15).
**11-WS8-10 🔴 :2046** `ascii2text(128512)`→U+F600 (16-bit truncation; BYOND 😀).
**11-WS8-11 🟠 :2038-2044** `text2ascii("😀")`→55357 surrogate half, not 128512 code point.
**11-WS8-12 🟠 :1690-1694,1338-1341** `for(x in "a😀b")` runs 4 iterations (BYOND 3); `splittext(t,"")` splits surrogate pairs.
**11-WS8-13 🔴 :106-107** `+` gives lists precedence: `"a" + list(1)` → `list(a,1)` (BYOND text concat "alist(1)").
**11-WS8-14 🔴 :681-686** `arglist(assoc list)` discards keys → named-arg call returns 0 (BYOND 3).
**11-WS8-15 🔴 :2206-2217** `list2params(assoc)` → `"null=null&null=null"` (Count-vs-PositionalCount).
**11-WS8-16 🟡 csharpEmitter.ts:600** `1e20` literal → `DMValue.FromNumber(100000000000000000000)` → CS1021.
**11-WS8-17 🟢 :1982** `uppertext` culture-sensitive ("straße"→"STRAßE" en-DE; Turkish-I latent).
**11-WS8-18 🟢 :1665-1736** `new Random()` per call (ms-seeded; correlated within a tick).
**11-WS8-19 🟡 :91** `DMValue.ToString` renders lists as `[list]` placeholder (BYOND `list(...)`).
**11-WS8-20 🟢 :714-731,408-415** COW/refcount verified correct under the transpiled pipeline (3 probes pass).

Probe table: 38 PASS / 32 FAIL / 12 INFO across 82 probes (details in WS8 agent output).

### WS9 — Runtime builtins (`src/runtimeTemplate/dmRuntimeCS.ts`, TS side)

**11-WS9-1 🔴 :2157-2176** `JsonEscape` invalid for `"`/`\`/`\n`/`\r`/`\t` — TS template escape collapse (`sb.Append("\"")` etc.); only `\uXXXX` correct. `json_encode(list("a\"b"))` → `"a"b"` (JsonDocument.Parse fails).
**11-WS9-2 🔴 parser interaction** `text("[x] [y]", 1, 2)` → `""`: parser pre-interpolates the format literal (BYOND's own example).
**11-WS9-3 🔴 :409-421** Lexer drops backslashes of unknown escapes → `json_encode("a\b")` becomes `"ab"` before encoding.
**11-WS9-4 🔴 :857-875** `typesof()` misses var-only types (registered only when ≥1 proc).
**11-WS9-5 🔴 :1148-1164** World-bounds clamping dead: `world.xmax/ymax` never set → `step()` walks off the map (x=100→101).
**11-WS9-6 🟠 :1790-1817** `Text()` ignores `[#x]`, `[x:N]`, `[]`; list args → `[list]`.
**11-WS9-7 🟠 :2270-2281** `RustGHttpRequestAsync` always GET, no body (proven with a local HttpListener).
**11-WS9-8 🟠 :2259-2268** Non-sha256 algorithms pass input through unmodified.
**11-WS9-9 🟡 preprocessor.ts:248-251** Real newlines inside string literals in call args → replaced with space.
**11-WS9-10 🟡 runtimeTemplate.test.ts:28-32** Backtick-balance test can't detect escape collapse (WS9-1 passes it today).
**11-WS9-11 🟡 :1584-1595** `json_decode` invalid → silent Null; encode/decode round-trip failures undetectable.

Verified OK: Turn() exact for 45° multiples, get_dist/get_dir flags, range/view/oview/orange/block/viewers/hearers approximations, file ops, Time2Text formats, sleep(0) floor, template integrity basics (0 `${`, 6 files).

### WS10 — Media (`src/dmi/dmiParser.ts`, `pngCodec.ts`, `rsiWriter.ts`)

**11-WS10-1 🔴 rsiWriter.ts:68-87** **Direction swap (color-row proof)**: DMI rows S=red,N=green,E=blue,W=yellow → decoded dir0=red, dir1=green, dir2=blue, dir3=yellow — N and E occupy the wrong SS14 slots.
**11-WS10-2 🔴 pngCodec.ts:39-74 + dmiParser.ts:72** CRC never validated: wrong-CRC IEND decodes fine; a flipped byte in tEXt changes `width` 32→932 silently.
**11-WS10-3 🔴 pngCodec.ts:56-101** No IHDR validation/bounds checks: valid-IDAT PNG declaring 100000×100000 → **no return in 180 s** (swap storm); nested-chunk IHDR → ~1.2e9-row loop; interlace ignored (Adam7 → 17/64 channels); truncated scanlines → silent black.
**11-WS10-4 🟠 :77,103-131** Invalid colorTypes 1/5 decode "successfully" as transparent black.
**11-WS10-5 🟠 :122-127** Indexed bitDepth<8 reads per-byte instead of per-bit → all-magenta output.
**11-WS10-6 🟠 rsiWriter.ts:36-38** Decode failure swallowed → RSI with meta.json and ZERO sprites, no warning.
**11-WS10-7 🟠 :68-87 + dmiParser.ts:182** `dirs = 8` no warning; 8 sprites emitted (SS14 supports 1/4).
**11-WS10-8 🟠 :70-86** Sheet smaller than metadata → OOB crops silently black + row-wrapped garbage.
**11-WS10-9 🟠 dmiParser.ts:181-186** `dirs = 0`/`frames = 0` silently → 1, no warning.
**11-WS10-10 🟠 :188** Delay `0`/non-numeric → 1; negatives kept (−5 passes through to RSI).
**11-WS10-11 🟡 :77-79** Multiple `# BEGIN DMI` chunks concatenated; states merge, last width wins.
**11-WS10-12 🟡 pngCodec.ts:40-42** Signature checked on 4 of 8 bytes (dmiParser correctly checks all 8).
**11-WS10-13 🟡 :52-71 + dmiParser.ts:63-85** Lying chunk lengths silently tolerated (truncated data "succeeds"; DMI metadata lost).
**11-WS10-14 🟡 :134-157** encodePNG no validation: fractional dims truncate in IHDR; negative width → raw RangeError through convertDMIToRSI.
**11-WS10-15 🟢 rsiWriter.ts:99-101** `sanitizeStateName` collisions (`a/b` vs `a_b`) overwrite earlier state; top meta lists both.

Verified OK: delays verbatim + decisecond units consistent (frame-major→per-dir correct), encode→decode round-trip byte-identical, colorTypes 0/2/3/4/6@8 decode correctly, gray16 MSB, iTXt/zTXt inflate, legacy `state "x"`.

### WS11 — Maps (`src/dmm/dmmParser.ts`, `mapConverter.ts`)

**11-WS11-1 🔴 mapConverter.ts:113,141-147** **Chunk serialization structurally broken**: tile lines at 4-space indent under 6-space chunk key → PyYAML tree `chunks: {"0,0": None}` + tiles as siblings — every converted map loses all tiles (format-2 requires list items `- lx,ly: tile` under the chunk key).
**11-WS11-2 🔴 :89-98,116-119** Invented prototypes (`TurfFloor`, `TurfPlating`, `obj_structure_table`) don't exist in SS14 → prototype resolution fails on load.
**11-WS11-3 🟠 dmmParser.ts:189-195** `}`/`;`/`=` inside quoted attr values corrupt the tile path itself (regex `[^}]*`), no warning.
**11-WS11-4 🟠 :57-64,100-102** Unterminated def swallows the grid header + every row → whole map becomes one warning, zero entities.
**11-WS11-5 🟠 :80** Header whitespace (`(1, 2, 3) = {`) and trailing comments → unrecognized lines, grid lost.
**11-WS11-6 🟡 :252-257** keyLen from first def only — mixed-length keys mis-split (tiles dropped, no hard error).
**11-WS11-7 🟡 mapConverter.ts:45-49** Per-attr warning inside the per-cell loop → N identical warnings (a 256×256 map → 65k).
**11-WS11-8 🟡 dmmParser.ts:187 + mapConverter.ts:57-71** Interior whitespace in quoted paths → `floor_`/`TurfFloor_`; leading space → item misclassified as entity proto `_obj_item_sword`.
**11-WS11-9 🟡 mapConverter.ts:56-62** Two turfs on one tile → duplicate `lx,ly` lines (invalid map; last-wins).
**11-WS11-10 🟡 :57** Area-only keys emit nothing → silent holes in the grid.
**11-WS11-11 🟡 dmmParser.ts:231-239** Space-separated rows + 1-char keys decode spaces as keys → grid 7 wide, tiles shifted.
**11-WS11-12 🟢 mapConverter.ts:64-70** No grid `parent` on item entities (map-rooted; OK today, fragile to grid offsets).
**11-WS11-13 🟢 :141-147** Item-only z-level emits empty `chunks:` (null); empty defs skip the whole grid.
**11-WS11-14 🟢 :122** Every map named `ConvertedStation` (grid-name collisions).
**11-WS11-15 🟢 :52-54,100-114** Verified OK: y-flip, negative-coord chunk floor-div math, multi-z grids, gap padding, `)`-in-comment non-issue.

### WS12 — GUI / CLI / pipeline (`src/gui/server.ts`, `cli.ts`, `index.ts`, `fidelityAudit.ts`)

**11-WS12-1 🟠 server.ts:94-101** **Symlink escape proven end-to-end**: `outputPath=$HOME/ws12-link/x` (link→`/Users/Shared`) accepted; POST → 200 and `Content.sln` written outside home.
**11-WS12-2 🟡 :41-51,107-116** 429 single-flight guard is a no-op — `handleConvertRequest` returns before the `end` listener fires; two concurrent conversions both run (raced on the same output dir).
**11-WS12-3 🟡 :189-191** 500 echoes raw `err.message` (absolute paths: `mkdir '/Users/russellrozario/ws12-link-etc/ws12-x'`).
**11-WS12-4 🟡 :160-170** Zip guard sums attacker-controlled `header.size`; a patched STORED zip (declared 100, real 20 MiB) bypasses the cap and extracts fully.
**11-WS12-5 🟡 :172-173** Temp dir `temp_gui_input_<ts>` in cwd, `mkdirSync({recursive})` follows pre-planted symlinks → extraction redirection.
**11-WS12-6 🟡 fidelityAudit.ts:578-579** `spawn('dotnet build … -p:EngineDir="${engineDir}"', {shell:true})` — shell-in-string injection proven with a benign echo payload; `runTests.ts:313` uses the safe array form.
**11-WS12-7 🟡 cli.ts:10-12 / server.ts:60** Occupied port → unhandled `'error'` event → crash with stack trace (EADDRINUSE).
**11-WS12-8 🟢 index.ts:119-137** Diagnostics throw leaves a 19-file partial solution on disk.
**11-WS12-9 🟢 server.ts:94-101** `~/x` and `%2e%2e/x` accepted literally (never expanded/decoded → literal `~/` dirs).
**11-WS12-10 🟢 cli.ts:9,42-44** No-args CLI starts a blocking GUI server instead of usage; `--output /` unvalidated.
**11-WS12-11 🟢 :136,200-230** Multipart: only first file part used; missing CRLF truncates 2 bytes → 500; boundary-in-binary corrupts uploads.

Verified clean: Host/Origin/token checks (403 incl. `localhost.`, `Origin: null`, evil-prefix hosts), entry-count + declared-size caps, oversized-header 431, validateOutputPath rejects `/etc/passwd`/NUL/`..`, adm-zip zip-slip sanitize, no SSRF surface, `ss14Template` constant-templates (no injection).

### WS13 — Harness integrity (`src/audit/fidelityAudit.ts`, test infra)

**11-WS13-1 🔴 :75,294-297** `BROKEN_PROP_NAMES` miscounts runtime-handled props: `.len/.x/.y/.z` = 6,837 of 13,144 (52%) counted as broken while probes pass.
**11-WS13-2 🟡 :42,402,421** `numClassicGlobalVars` counted as loss but printed "emitted into GlobalVars registry" (paradise 16, tgmc 17, beestation 1) — and they genuinely ARE dropped (fixture: registry empty).
**11-WS13-3 🟡 :640-650** JSON export zeroes nested Maps (`unknownBuiltins[].contexts`, `errorClasses[].tokens` → `{}`).
**11-WS13-4 🟡 :139,152** Source-level regex counters fire on comments/strings (`// goto`, `"GLOB.x"` — 33-50% false positives at corpus scale).
**11-WS13-5 🟡 :68,91,646,359-361** Dead `topFiles` (never populated) + `fileLoss` placeholder.
**11-WS13-6 🟢 :396-408** `totalLossSites` arithmetic VERIFIED: 105,097 exactly; caveat "unknown builtin calls 3360" + "unresolved bare calls 3360" print the same number (reader summing gets 108,457).
**11-WS13-7 🟡 fidelityDifferential.test.ts:304-307** `json_encode` probe exercises no escape path — passes while JsonEscape emits invalid JSON (confirms WS9-1).
**11-WS13-8 🟡 :63-66** `L += x` probe checks `[list]` (universal list ToString) — content-blind.
**11-WS13-9 🟡 :349-352,487-495** Radius/type-blind probes claim more than they test (viewers/hearers/global-new).
**11-WS13-10 🟡 :756-760** dotnet-skip branch unreachable (missing dotnet = hard exit 1).
**11-WS13-11 🟢 :811-813** Exact-match verdict; `/PROBE_RESULT:(.*)$/m` truncates at first newline.
**11-WS13-12 🟡 runTests.ts:27-33,14-21** 7 hardcoded suites, abort-on-first-failure; verified gaps: cli.ts 0 tests, pngCodec no suite, GUI multipart untested, repoAudit/--build outside CI.
**11-WS13-13 🟡 fidelityAudit.ts:97-114 vs index.ts:139-159** Audit walk vs transpiler findFiles diverge (symlinked dirs, `.DM` case) — audited ≠ converted.
**11-WS13-14 🟢 :650** JSON output deterministic (byte-identical across runs).
**11-WS13-15 🟢 :542-549** `--build-max-procs` = first-N-per-type (deterministic, but at corpus scale only the first proc per type — typically `New` — is ever build-proven).

---

## 5. Proposed fix-batch structure (for the next wave)

**STATUS: ALL BATCHES 11.1-11.13 EXECUTED 2026-08-02 — the fix wave is complete.
Verification: semantic probes 129/134 → 139/139; npm test green; tgstation loss sites
105,097 → 54,457; hostile-name corpus (`operator""`, dot-paths, case-procs,
spawn-expr, bitwise, 1e20, try/catch) builds with 0 C# errors; corpus compile-proof
(1,500 procs, real engine) 0 errors. See `FIDELITY-AUDIT.md` §3j.**

Dependency order (mirrors Plan 09/10 conventions):

- **11.1 Parser/lexer REDs** — WS1-1..3, WS2-1..4, WS3-1..6 (nested comments, text macros, interp quoting, `in` precedence, division postfix, child-type blocks, `#elif`/`#error`/`#if`-numeric, `//`-in-define, expansion work-budget).
- **11.2 Emitter compile-breaking REDs** — WS5-1..7 + WS2-5..6 (name sanitization, default-only switch, spawn-expr, top-level vars, initializer depth).
- **11.3 GlobalVars production wiring** — WS4-4/WS5-13 (index.ts pass-through) + WS5-16 case-insensitive registry.
- **11.4 Runtime value semantics** — WS8-1..6, WS8-13..15 (Divide provenance, Modulo truncation, zero-div errors, text compare case, `"0"` truthiness, null equality, text+list, arglist-assoc, list2params).
- **11.5 Builtins** — WS7-2..13 (findtextEx, log arity, round, turn, sorttext, isloc/ismovable, arities, rand, step_away, ckey, findtext End, replacetext case) + WS7-16 stub-loss accounting.
- **11.6 Control flow** — WS5-8 (step-range continue label), WS5-9 (try/catch, labels), WS5-10..12 (bitwise, ~=, %%, cast), WS5-17..19 diagnostics.
- **11.7 Runtime builtins** — WS9-1..6 (JsonEscape raw template, text() format literals, lexer backslash passthrough, typesof registration, world bounds) + WS8-10..12 unicode + WS8-7..9 rgb/round/num2text.
- **11.8 YAML** — WS6-1..7 (scalar quoting, backslash escaping, shape type, pathToId collisions, name/description) + WS4-5/6.
- **11.9 Media** — WS10-1..5 (direction remap, CRC, IHDR validation, colorTypes, indexed depths) + WS10-6..10.
- **11.10 Maps** — WS11-1..5 (chunk list serialization, prototype mapping, attr state machine, def-swallow cap, header tolerance).
- **11.11 Security** — WS12-1..6 (symlink realpath, real promise for 429, sanitize 500, per-entry extraction caps, mkdtemp, spawn array form) + WS12-7.
- **11.12 Harness** — WS13-1..5 (BROKEN_PROP_NAMES split, classic-globals classification, nested-Map JSON, token-based counters, dead code) + probe hardening WS13-7..10 + WS7-16 stub buckets.
- **11.13 IR** — WS4-1..3, WS4-7..9 (case-insensitive type identity, TRUE/yes coercion, parent_type, non-mutation, typed values).

## 6. Pre-seeded suspect triage summary

All 130 pre-seeded suspects were triaged across the 13 workstreams. ~90 confirmed with
evidence (all listed above), ~30 refuted/documented-nonissue (e.g. WS3-19 define
classification, WS10-15 delays units, WS11-15 geometry, WS12 Verified-clean block, WS1
number/range edge cases, WS4-12 IR invariants, WS5-20 identifier safety, WS6-11 YAML
structure, WS8-20 COW). Notable *disproved* suspects: `{"a","b"}` brace-template
(WS1 — correct per DM), `)`-in-comment paren balance (WS11-15), `#define FOO (x) (y)`
misclassification (WS3-19).

## 7. Acceptance-criteria status

| Criterion | Status |
|---|---|
| All 13 modules have ≥1 documented adversarial pass | ✅ (this report) |
| All 130 pre-seeded suspects triaged | ✅ (§6) |
| Zero unhandled crashes/hangs in fuzzing/pathological rounds | ⚠️ 3 hangs found: WS3-3 (macro expansion), WS10-3 (PNG decode), WS5-8/WS13 (step-continue infinite loop) — all reported as findings |
| Baselines before == after | ✅ (§2, verified by re-run) |
| Findings report = sole source for the next fix wave | ✅ (§5) |
