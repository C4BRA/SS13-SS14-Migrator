# DM2SS14 Transpiler — Submission Plan

Goal: address every item in the audit's "cons" list so the project is a complete, self-contained,
verifiable deliverable. All code fixes are paired with tests; the repo is cleaned and documented.

Status legend: [ ] not started · [~] in progress · [x] done

---

## Phase 0 — Repo Hygiene & Submission Readiness

Repo is submittable as-is from a clean checkout.

- [x] `.gitignore`: `node_modules/`, `dist/`, `temp_test_*`, `temp_gui_input_*`, `.DS_Store`, `*.log`
- [x] Delete stray artifacts (`temp_test_dmi.png`, temp dirs)
- [x] `package.json`: move `@types/adm-zip` to `devDependencies`, add `engines.node`, tidy scripts
- [x] `README.md`: overview, install/build/test, CLI + GUI usage, architecture, known limitations
- [x] `LICENSE` (MIT — matches `package.json`)
- [x] Verify clean-checkout flow: `npm ci && npm run build && npm test` passes
- [ ] Commit (or leave staged) per phase

## Phase 1 — Diagnostics & No Silent Data Loss

Everything unrecognized is reported, not dropped.

- [x] `src/diagnostics.ts`: `DMCompileError` + `DiagnosticCollector` (errors, warnings, file/line/col)
- [x] Lexer: error tokens for unknown chars / unterminated strings (recover, keep tokenizing)
- [x] Parser: error statement for unparseable constructs; errors carry source position
- [x] `index.ts`/CLI: aggregate diagnostics per file, print summary, non-zero exit on errors
- [x] Compound assignment `a += 5` → `assignment(binary(+))` (currently emits `DMValue.Null`)
- [x] Chained access `a.b.c`, `obj.var.method()`, `list[i].x` — postfix loop in `parsePrimary`; `call` node gains optional `target`; emitter `DMCallProc(target, name, args)`
- [x] `world << "text"` / `usr << x` / `<<=` → binary `<<` op + `DMOutput()` runtime helper
- [x] `new /obj/item(x)` / `new/type` → `new` expression node + `DMNew()` runtime helper
- [x] `del x` / `qdel(x)` → `DeleteStatement` + `DMDelete()` helper
- [x] `switch (x)` with BYOND `if (vals)` / `else` case syntax → `SwitchStatement` (emitted as if/else chain with `DMValue.In`)
- [x] Preprocessor: `#include "file.dm"` recursive resolution (cycle-guarded, relative paths); `#if/#ifdef/#ifndef/#else/#endif` skipping with simple `defined()` eval; object-like `#define` substitution
- [x] Builtin proc mappings (~20): `pick`, `rand`, `list`, `length`, `text`, `text2num`, `num2text`, `copytext`, `findtext`, `clamp`, `max`, `min`, `round`, `abs`, `uppertext`, `lowertext`, `hascall`, `alert`, `input`, `icon` — each with runtime helper
- [x] Verbs: parsed, emitted as procs, registered in a runtime verb list (documented limitation)

## Phase 2 — Generated C# Compiles

`dotnet build` of the generated solution succeeds.

- [x] Runtime template fixes: `Sleep(DMValue)` overload; `ToNumber()` public; define `DMProb`, `DMLocate`, `DMIsType`, `DMIsPath`, `DMListGet`, `DMListSet`, `DMValue.In`, `DMNew`, `DMDelete`, `DMCallProc`, `DMOutput` and builtin helpers
- [x] Vendor minimal `Robust.Shared` shim project (EntityUid, EntitySystem, Component, ComponentInit, RegisterComponent, EntityManager stubs) — NuGet `Robust.*` packages do not exist, solution must build standalone
- [x] `ExecuteNew` dispatches to `New()` procs via a runtime proc registry
- [x] `CallProc` routes through registry: generated code registers `(typePath, procName) -> Task<DMValue> method`
- [x] Build-check test: if `dotnet` is available, `dotnet build` the generated solution and assert success (skipped otherwise)

## Phase 3 — Semantic Fidelity

Behavior matches DM semantics for the supported subset.

- [x] Symbol resolution pass: verify proc call targets exist (type + ancestors + globals), `new`/`istype`/`ispath` type paths exist; unresolved → warnings
- [x] `DMValue` coercion: `+` string-concats when left is text (DM rule); numeric strings compare equal to numbers; `IsTrue` matches DM truthiness (`0`, `""`, `"0"`, null, empty list are falsy); `Equals` uses 1e-9 tolerance + cross-type rules
- [x] `for(x in list)` emits real iteration: `foreach (var __v in DMListItems(range)) { comp.SetVar("x", __v); body }`
- [x] `spawn(n) body` keeps its body: `DMTickScheduler.Spawn(n, async () => { body })` with `Func<Task>` support
- [x] DMI: `zTXt` chunk decompression (node:zlib); per-direction delay arrays; validate frames vs delays
- [x] DMM: orphan-key detection, rectangular-grid validation (errors via diagnostics); `{attr = val}` prefab attributes parsed and emitted
- [x] YAML: emit `Fixtures` content and `initialVars`; replace `Name`/`Description`/`Sprite` components with SS14-correct forms; parent mapping `/obj→BaseItem`, `/turf→BaseFloor/BaseWall`, `/mob→BaseMobDummy`, `/area→none`; synthesized types named from path basename, not `"datum"`
- [x] `ensureBaseTypes` stops mutating caller arrays
- [x] `usr`/`src`/`args` semantics documented and consistent through `CallProc`

## Phase 4 — Verification & Submission

- [x] Unit tests for every Phase 1/3 parser construct (lexer, parser, emitter golden strings)
- [x] Integration test: small realistic SS13-style module (types, procs with if/else/for/switch/spawn/sleep/`world <<`/`new`/`del`, one DMI, one DMM) → full transpile → assert artifacts; dotnet build if available
- [x] `npm test` green, `npm run build` clean
- [ ] README/PLAN final pass; per-phase git commits; final submission checklist

---

## Out of scope (documented limitations)

- Full DM macro system (`#define` with arguments, conditional `*` blocks), `procmacro`
- Screen objects / appearance handling, icon overlays, and UI widgets
- Networked verbs (`set hidden`, `set category`) mapping to SS14 commands
- RobustToolbox interop beyond the vendored shim

## Risks

- `dotnet` CLI may be absent on the submission machine → build-check test degrades gracefully
- Preprocessor eval can balloon → capped at `defined()` + object-like macros
- SS14 prototype schema drift → validation against vendored shim only
