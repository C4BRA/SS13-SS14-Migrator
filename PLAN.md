# DM2SS14 Transpiler — Submission Plan

Goal: address every item in the audit's "cons" list so the project is a complete, self-contained,
verifiable deliverable. All code fixes are paired with tests; the repo is cleaned and documented.

Status legend: [ ] not started · [~] in progress · [x] done

---

## Phase 0 — Real Engine Ground Truth (re-foundation)

The fabricated `Robust.Shared` shim is gone. Generated solutions now build against the **real
RobustToolbox** (`engine.pin`, verified commit `9cefa116`), and `SS13.DM.Runtime` is a pure,
engine-free datum runtime. "Compiles" now means compiles against the real engine.

- [x] Clone + pin real RobustToolbox (`scripts/setup-engine.sh`, `engine.pin`); `dotnet build
      Robust.Shared` clean with dotnet 10 SDK (net10.0)
- [x] `SS13.DM.Runtime` decoupled from the engine: `DMRuntime` datum (vars, `CallProc`,
      `ProcRegistry`) with zero RobustToolbox references; `DMNew` allocates a real object
      (identity probe now passes)
- [x] Generated output split: `ConvertedDMProcs.cs` (engine-free procs + registry) and
      `ConvertedDMSystem.cs` (real `EntitySystem` adapter — `SubscribeLocalEvent` with
      `ComponentEventRefHandler`, `ComponentInit : EntityEventArgs`, `[RegisterComponent]`
      component with `[DataField]`s, all verified against the cloned engine source)
- [x] `ss14Template` emits a solution referencing real RobustToolbox via `EngineDir`
      MSBuild property (`-p:EngineDir=` / `SS14_ENGINE_DIR`); fake shim project deleted
- [x] Semantic probes run engine-free (pure runtime console project) — 24 probes,
      count **24/24** (7/24 at Phase 0; Phase 0.5 semantic core completed below)
- [x] Build loop: `scripts/build-loop.sh` (npm ci → build → test incl. real-engine build → probes)
- [x] Corpus-scale compile proof against the real engine (fidelity audit `--build` path;
      **tgstation: 44,826 sampled procs from 45,502 types → 0 C# errors**, real-engine
      `dotnet build` green; all error classes fixed — CS1061/CS0201/CS0136/CS7036/CS1501/
      CS1503/CS0029/CS1632/CS1026)
- [x] Builtin expansion (~43 more: `isnull`/`isnum`/`istext`, type predicates,
      `CRASH`, `nameof`, `typesof`, `initial`, `call()` proc refs, `turn`, position
      builtins `get_step`/`get_dist`/`get_dir`/`get_turf`/`range`/`view`/`oview`/`block`,
      `splittext`/`jointext`/`params2list`/`rgb`/`json_decode`/...) + `/proc` registry
      fallback for bare global proc calls → unknown-builtin sites drop **−88…−91%**
      across the 4 corpora; probes **24 → 40/40**
- [x] GLOB statics: `/global/var/` declarations materialized as a `GlobalVars` registry
      (lazy `EnsureInit`, declaration order; `GLOB.x` reads/writes → `Get`/`Set`;
      global-initializer context bridges `src`/bare calls/`new`); 21,872 GLOB.x sites
      resolved, loss drops **−29,230…−43,173** per corpus; probes **40 → 49/49**;
      compile proof still green at 44,826 procs (0 C# errors)

---

## Phase 0.5 — Semantic core (from FIDELITY-AUDIT.md fix backlog)

Done 2026-08 — all 24 differential probes pass (7/24 → 24/24):

- [x] `DMValue` text semantics: case-insensitive `==`, lexicographic `<`, `null == ""`
- [x] `&&`/`||` short-circuit returning operands (emitted ternaries)
- [x] `DMList`: `len`, negative indices, element-wise equality, `+=` append
- [x] `break`/`continue` emission (loop nesting in the emitter; switches wrapped
      in `while(true)` so case-body `break` is valid and correct)
- [x] `..()` parent dispatch (registry walk with current-proc context)
- [x] `world` datum, `text2num` hex, `replacetext`, `islist`, `as` casts
- [x] Compile blockers: `DMValue.NotEquals`/`Power`, `DMIsType` non-datum → 0,
      IR + `new`-expression trailing-slash normalization

Remaining (Phase 2+/Tier 3): bitwise ops, remaining builtins
(`sqrt`, `json_encode`, `regex`, `file`, `step`, `ckey`, `viewers`, `winset`,
`orange`, `floor`/`ceil`, `copytext_char`, `SpacemanDMM_unlint`), `world.*`
statics, top parse-error classes (paradise 14k / beestation 16k).

---

## Phase 0 — Repo Hygiene & Submission Readiness

Repo is submittable as-is from a clean checkout.

- [x] `.gitignore`: `node_modules/`, `dist/`, `temp_test_*`, `temp_gui_input_*`, `.DS_Store`, `*.log`
- [x] Delete stray artifacts (`temp_test_dmi.png`, temp dirs)
- [x] `package.json`: move `@types/adm-zip` to `devDependencies`, add `engines.node`, tidy scripts
- [x] `README.md`: overview, install/build/test, CLI + GUI usage, architecture, known limitations
- [x] `LICENSE` (MIT — matches `package.json`)
- [x] Verify clean-checkout flow: `npm ci && npm run build && npm test` passes
- [x] Commit (or leave staged) per phase

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

- [ ] Symbol resolution pass: verify proc call targets exist (type + ancestors + globals), `new`/`istype`/`ispath` type paths exist; unresolved → warnings. **Not implemented** — the runtime `CallProc` registry resolves by (typePath, procName) at runtime; unknown targets silently produce `DMValue.Null` (see `AUDIT.md`).
- [x] `DMValue` coercion: `+` string-concats when left is text (DM rule); numeric strings compare equal to numbers; `IsTrue` matches DM truthiness (`0`, `""`, `"0"`, null, empty list are falsy); `Equals` uses 1e-9 tolerance + cross-type rules
- [x] `for(x in list)` emits real iteration: `foreach (var __v in DMListItems(range)) { comp.SetVar("x", __v); body }`
- [x] `spawn(n) body` keeps its body: `DMTickScheduler.Spawn(n, async () => { body })` with `Func<Task>` support
- [x] DMI: `zTXt` chunk decompression (node:zlib); per-direction delay arrays; validate frames vs delays
- [x] DMM: orphan-key detection, rectangular-grid validation (errors via diagnostics); `{attr = val}` prefab attributes parsed and emitted
- [x] YAML: emit `Fixtures` content and `initialVars`; replace `Name`/`Description`/`Sprite` components with SS14-correct forms; parent mapping `/obj→BaseItem`, `/turf→BaseFloor/BaseWall`, `/mob→BaseMobDummy`, `/area→none`; synthesized types named from path basename, not `"datum"`
- [x] `ensureBaseTypes` stops mutating caller arrays
- [x] `usr`/`src`/`args` semantics documented and consistent through `CallProc`
- [x] Proc args are stored on the component (`comp.SetVar("name", args[i])`) instead of emitting `var name = ...` locals, so DM identifiers that are C# keywords (`event`, `object`, ...) no longer break the generated C#
- [x] `1..5` range operator (lexer no longer swallows `..` into the number token; `MakeRange` helper; descending ranges supported) and `{1, 2, 3}` list literals
- [x] `do { } while (cond)` and C-style `for(var/i = init, cond, incr)` parsed and emitted
- [x] Zero-arg method calls no longer emit a trailing comma; method name and target propagated correctly
- [x] `rand()` semantics: `rand()` → float in [0,1), `rand(a)` → 1..a, `rand(a,b)` → closed interval [a,b]
- [x] Multi-Z DMM maps: every z-level emitted as its own grid with origin-aware world coordinates; definition-less maps warned and skipped
- [x] DMI `iTXt` chunks parsed (5-NUL header, compression flag, zlib payload); RSI per-direction delays sliced to frame count
- [x] GUI server: 2 GiB upload cap, zip entry / total-size limits (zip-bomb guard), temp dir cleanup on error, binds to `127.0.0.1`
- [x] Lexer: UTF-8 BOM stripped, unterminated block-comment diagnostic, inconsistent-indent warning, duplicate TypePath branch removed
- [x] Removed duplicate `expressionTranspiler.ts` (only used by tests); regression suite moved to golden-string tests against the real emitter (`src/tests/csharpEmitter.test.ts`)

## Phase 4 — Verification & Submission

- [x] Unit tests for every Phase 1/3 parser construct (lexer, parser, emitter golden strings)
- [x] Integration test: small realistic SS13-style module (types, procs with if/else/for/switch/spawn/sleep/`world <<`/`new`/`del`, one DMI, one DMM) → full transpile → assert artifacts; dotnet build if available
- [x] `npm test` green, `npm run build` clean
- [x] README/PLAN final pass; per-phase git commits; final submission checklist

---

## Big-ticket implementation plans

Detailed, code-grounded implementation plans for the remaining loss classes
(baseline: tgstation audit re-run 2026-08-01, 118,030 total loss sites) live in
`docs/plans/`:

| Plan | Item | TG sites | Status |
|---|---|---|---|
| [01-builtins.md](docs/plans/01-builtins.md) | Builtin proc coverage | 3,553 unknown builtin calls | in progress (2026-08-02: 708 unresolved; pure + file + movement batches landed) |
| [02-symbol-resolution.md](docs/plans/02-symbol-resolution.md) | Symbol resolution + global procs | 36,911 bare global calls (runtime fallback) | in progress (2026-08-02: milestone 1 — symbol table + audit triage; 93,573 verified) |
| [03-bitwise.md](docs/plans/03-bitwise.md) | Bitwise operators | 18,060 binary + 1,038 unary → Null | not started |
| [04-live-server.md](docs/plans/04-live-server.md) | Live-server integration | whole-verification gap | not started |
| [05-appearance.md](docs/plans/05-appearance.md) | Appearance/icon/overlay system | animate 937, image 442, overlays 117, ... | not started |
| [06-parse-errors.md](docs/plans/06-parse-errors.md) | Parse-error reduction | 2,473 errors (+ silent classes) | in progress |
| [07-props.md](docs/plans/07-props.md) | Builtin property reads | 11,644 prop reads + 6,384 GLOB.x | not started |
| [08-new-type.md](docs/plans/08-new-type.md) | `new /type(...)` semantics | 12,675 sites | not started |

---

## Out of scope (documented limitations)

- Full DM macro system (`#define` with arguments, conditional `*` blocks), `procmacro`
- Screen objects / appearance handling, icon overlays, and UI widgets
- Networked verbs (`set hidden`, `set category`) mapping to SS14 commands
- RobustToolbox interop beyond: Content.Server builds against `Robust.Shared` (real engine);
  running a live server (Robust.Server) and client (Robust.Client) integration is Phase 3

## Risks

- Real-engine API drift on engine updates → mitigated by `engine.pin` + `scripts/build-loop.sh`
- `dotnet` CLI may be absent on the submission machine → build-check tests degrade gracefully
- Corpus-scale build against the real engine is heavier (NuGet restore + source generators);
  run via `npm run audit:fidelity -- <repo> --build` with `SS14_ENGINE_DIR` set
