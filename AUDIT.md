# dm2ss14 — Code Audit & Fix Log

Audit performed against the full pipeline: DM source → preprocessor → lexer/parser
→ DM-IR → YAML prototypes + embedded C# runtime → `dotnet build` of the generated
solution. A 4-construct repro DM file produced **21+ C# build errors** before the
fixes below; the same constructs now compile cleanly and are covered by regression
tests in `src/tests/csharpEmitter.test.ts` plus the integration fixture in
`src/tests/runTests.ts`.

Severity: 🔴 Critical (generated output broken) · 🟠 High (silent wrong behavior) ·
🟡 Medium · 🟢 Low/Info.

---

## 🔴 CRITICAL — generated C# does not compile for common constructs

| # | Finding | Evidence (before) | Fix |
|---|---------|-------------------|-----|
| 1 | Index read emits a type-mismatched call | `comp.GetVar("stuff")).AsList()?.Get(DMValue.FromNumber(1))` — `DMList.Get` takes `int` → CS1503 | New `DMListGet(comp, key)` helper; emitted as `DMListGet(comp.GetVar("stuff"), DMValue.FromNumber(1))` |
| 2 | Index assignment emits an invalid lvalue | `(comp.GetVar("stuff")).AsList()?.Set(...)` assigned to → CS0131/CS0200 | New `DMListSet(comp, key, value)` statement |
| 3 | Zero-arg method calls emit empty name + trailing comma | `DMCallProc((comp.GetVar("stuff")).AsComponent()?.GetVar("zero") ?? DMValue.Null, "", )` → CS1002/CS1525 | `transpileCall` emits `"zero"` as the proc name with `comp.GetVar("stuff")` as target; no trailing comma |
| 4 | Proc args named after C# keywords break the build | `var event = args.Length > 0 ? args[0] : DMValue.Null;` (`event`, `object`, `args`, `src`, `usr`) → CS1041/CS1001 | Args stored on the component: `comp.SetVar("event", args.Length > 0 ? args[0] : DMValue.Null);` |
| 5 | `rand()` emits a runtime method that doesn't exist | `DMRuntimeHelpers.Rand()` → CS0103 | `Rand(DMValue a = default, DMValue b = default)` with DM semantics: `rand()` → float `[0,1)`, `rand(a)` → `1..a`, `rand(a,b)` → closed interval |

All five verified by `dotnet build` of the generated solution before/after.
Files: `src/transpiler/csharpEmitter.ts`, `src/runtimeTemplate/dmRuntimeCS.ts`.

---

## 🟠 HIGH — silent wrong behavior (no error, wrong output)

| # | Finding | Evidence (before) | Fix |
|---|---------|-------------------|-----|
| 6 | `1..5` lexed as the single number `1` (`readNumber` consumed `.` even when not followed by a digit) | `for(x in 1..5)` iterated once, no diagnostics | `readNumber` only consumes `.` when the next char is a digit; `..` now lexes as an operator; `MakeRange` helper (ascending + descending); range precedence 5 |
| 7 | `{1, 2, 3}` list literals rejected | 4 parser errors ("Unexpected token '{'") | `parsePrimary` list-literal branch with proper `}` tracking; `MakeList(...)` emission |
| 8 | `do/while` rejected | 8 parser errors | `DoWhileStatement` parsed; emitted as `do { } while (...)` |
| 9 | Type-level vars with expression values rejected | `var/list/stuff = list(1,2,3)` → "Unexpected token '(' in type block" | `parseInitialValueText` consumed at all three type-level var-value sites |
| 10 | `usr`/`src`/`args` skipped `parsePostfix` | `src.zero()` → "Unexpected token 'zero'" | Keyword operands now flow through `parsePostfix`; `src.method()` emits `DMCallProc(DMValue.FromComponent(comp), "method")` |
| 11 | `spawn(n) { body }` emitted an invalid call | `await DMCallProc(...)` with no matching overload; body lost | Emits `async () => { /* body */ }` (valid `Func<Task>` for the scheduler). Note: `x = spawn(2)` (spawn as *expression*) is still rejected — spawn is a statement in DM; documented limitation |
| 12 | Multi-Z DMM maps silently dropped | Only `grids[0]` was converted; z>1 levels and their origin cells lost with no warning | `mapConverter` rewritten: every grid emitted as its own `MapGrid` entity; world coords origin-aware (`x + originX`, `originY + height - 1 - y`); definition-less maps warned and skipped |

## 🟡 MEDIUM

| # | Finding | Fix |
|---|---------|-----|
| 13 | DMI `iTXt` chunks unparsed: 5-NUL header skipped, compressed payload fed raw to tag map | Full parse: NUL-separated fields, `compressionFlag` byte, `zlib.inflateSync` payload |
| 14 | RSI delays not sliced per direction | `rsiWriter` slices `s.delays` to `s.frames` per direction |
| 15 | Lexer: UTF-8 BOM broke first token of Windows files; unterminated block comments silently dropped; inconsistent indentation silently treated as full dedent; duplicate TypePath branch | BOM stripped in constructor; "Unterminated block comment" error; inconsistent-indent warning; dead branch removed |
| 16 | GUI server: unbounded request body (memory DoS), no zip entry/compressed-size limits (zip-bomb), temp input dir leaked when transpile threw, bound to all interfaces | 2 GiB upload cap, 50k-entry / 4 GiB-uncompressed limits, `finally` cleanup, binds `127.0.0.1` |
| 17 | Duplicate expression transpiler: `expressionTranspiler.ts` shadowed the real `csharpEmitter` and was used only by tests → divergent behavior, dead weight | Deleted; regression tests now assert golden strings against the real emitter (`src/tests/csharpEmitter.test.ts`) |

## 🟢 LOW / Info

| # | Finding | Resolution |
|---|---------|-----------|
| 18 | `DMNew()` is a placeholder returning `comp` while docs claimed full `new` support | Doc comment corrected to state the limitation honestly |
| 19 | `findFiles` crashed on broken symlinks in the input tree | `statSync` wrapped in try/catch; symlinks skipped |
| 20 | PLAN.md claimed "Symbol resolution pass" complete | Marked not-implemented in `PLAN.md`; runtime registry resolves `(typePath, procName)` at runtime; unknown targets → `DMValue.Null` (documented limitation) |
| 21 | Zip-slip (`zip.extractAllTo` path traversal) | Verified adm-zip 0.6 sanitizes paths — already mitigated, no action needed |
| 22 | Stray artifacts (`temp_test_dmi.png`, `src/tests/debugParser.ts`) | Deleted |

---

## Verification

- `npm run build` — clean (tsc strict, TS 7.0.2)
- `npm test` — all suites green: DMI parser (32), DMM parser (36), C# emitter regression (40), preprocessor (20), integration (transpile real fixture + ZIP flow + **`dotnet build` of generated solution, exit 0**)
- Regression coverage added for every 🔴/🟠 item in `src/tests/csharpEmitter.test.ts`; the `runTests.ts` integration fixture now exercises index access, `rand()`, brace lists, ranges, `do/while`, C-style `for`, `spawn`, and keyword-named args end-to-end through the C# compiler
- New behavior documented in `README.md` (feature list, multi-Z maps, architecture) and `PLAN.md` (completed items + honest "not implemented" markers)

## Remaining limitations (accepted)

- No symbol-resolution pass — unknown proc targets resolve to `DMValue.Null` at runtime
- `x = spawn(2)` (spawn as expression) unsupported; `DMNew` is a placeholder
- Argument macros, screen/overlay/appearance, verb→command mapping, real RobustToolbox interop (vendored shim only) — see `PLAN.md` "Out of scope"
