# DM2SS14 — Universal Plan (single linear tracker)

One plan, one sequence, linear progression. Everything — history and open work — is a
numbered item; progress is simply "the highest numbered `[ ]` we are working on".
Open findings live in **`AUDIT.md`** (single source of truth); per-wave implementation
notes are archived in `docs/plans/` (appendices, not trackers).

**Legend:** `[x]` done · `[~]` in progress · `[ ]` not started

## Progress summary (2026-08-03)

| Gate | Value |
|---|---|
| Items done / open (Part A) | **67 / 0** — the conversion pipeline is complete |
| Items done / open (Part B) | **1 / 8** — playability phases; 68 done |
| Semantic probes | **171 / 171** (`npm run audit:semantics`) |
| Boot gate | **4 / 4 corpora boot clean** — tgstation 45,967 · tgmc 26,853 · paradise 28,849 · beestation 34,803 types: transpile seconds → build 0 errors → server Ready, port 1212 |
| Perf audit | 427× emission duplication fixed (17.9 GB → 46 MB tgmc); streaming output; COW define maps (parse −28%); split emitted classes (CLR 65,536 method/type cap); full loop-advance hang audit: **no hang paths found** |
| Loss sites (honest, post-12.1) | tg **25,882** (tgmc/paradise/bee rows stale — refresh in item 75) |
| Unresolved bare calls (tg) | **138** |
| Parse diagnostics | **tg 0 · tgmc 0 · paradise 0 · bee 0** |
| Playability | **~15–20%** — the pipeline is done; the game layers (entity integration, rendering, tick, verbs, client) are Part B |

---

## Part A — Completed progression

### Foundation (Phase 0 — real engine ground truth)

1. [x] Clone + pin real RobustToolbox (`scripts/setup-engine.sh`, `engine.pin`, commit `9cefa116`); `dotnet build Robust.Shared` clean (net10.0).
2. [x] `SS13.DM.Runtime` decoupled from the engine: `DMRuntime` datum (vars, `CallProc`, `ProcRegistry`), zero RobustToolbox references; `DMNew` allocates a real object.
3. [x] Generated output split: `ConvertedDMProcs.cs` (engine-free procs + registry) + `ConvertedDMSystem.cs` (real `EntitySystem` adapter, `[RegisterComponent]`).
4. [x] `ss14Template` emits a solution referencing real RobustToolbox via `EngineDir` / `SS14_ENGINE_DIR`; fabricated shim deleted.
5. [x] Engine-free semantic probes — 24/24 (was 7/24).
6. [x] Build loop: `scripts/build-loop.sh` (npm ci → build → test incl. real-engine build → probes).
7. [x] Corpus-scale compile proof: tgstation 44,826 sampled procs → **0 C# errors** (all CS classes fixed).
8. [x] Builtin expansion (~43: predicates, `CRASH`, `nameof`, `typesof`, `initial`, `call`, movement/position, text/json/params helpers) + `/proc` registry fallback — unknown-builtin sites **−88…−91%**; probes 24 → 40/40.
9. [x] GLOB statics: `/global/var/` → `GlobalVars` registry (lazy `EnsureInit`, `GLOB.x` → Get/Set); 21,872 sites resolved; probes 40 → 49/49.

### Semantic core (Phase 0.5)

10. [x] `DMValue` text semantics: case-insensitive `==`, lexicographic `<`, `null == ""`.
11. [x] `&&`/`||` short-circuit returning operands (emitted ternaries).
12. [x] `DMList`: `len`, negative indices, element-wise equality, `+=` append.
13. [x] `break`/`continue` emission (loop nesting; switch `while(true)` wrappers).
14. [x] `..()` parent dispatch (registry walk with current-proc context).
15. [x] `world` datum, `text2num` hex, `replacetext`, `islist`, `as` casts.
16. [x] Compile blockers: `DMValue.NotEquals`/`Power`, `DMIsType` non-datum → 0, IR + `new` trailing-slash normalization.

### Repo hygiene & submission readiness

17. [x] `.gitignore` (`node_modules/`, `dist/`, `temp_*`, `.DS_Store`, `*.log`).
18. [x] Stray artifacts deleted (`temp_test_dmi.png`, temp dirs).
19. [x] `package.json`: devDependencies split, `engines.node`, tidy scripts.
20. [x] `README.md` (overview, install/build/test, CLI + GUI, architecture, limitations).
21. [x] `LICENSE` (MIT).
22. [x] Clean-checkout flow verified: `npm ci && npm run build && npm test` green.

### Phase 1 — Diagnostics & no silent data loss

23. [x] `src/diagnostics.ts`: `DMCompileError` + `DiagnosticCollector` (file/line/col).
24. [x] Lexer error recovery: error tokens for unknown chars / unterminated strings.
25. [x] Parser error statements with source positions; aggregate + non-zero exit in CLI.
26. [x] Compound assignment (`a += 5` → `assignment(binary(+))`).
27. [x] Chained access (`a.b.c`, `obj.var.method()`, `list[i].x`) → `DMCallProc(target, name, args)`.
28. [x] `world << x` / `usr << x` / `<<=` → `DMOutput()` helper.
29. [x] `new /obj/item(x)` → `new` node + `DMNew()` helper.
30. [x] `del x` / `qdel(x)` → `DMDelete()` helper.
31. [x] `switch` with BYOND `if (vals)` / `else` cases → `SwitchStatement` + `DMValue.In`.
32. [x] Preprocessor: recursive `#include` (cycle-guarded), `#if/#ifdef/#ifndef/#else/#endif` with `defined()`, object-like `#define`.
33. [x] Builtin mappings (~20 core: `pick`, `rand`, `list`, `length`, `text`, `text2num`, `num2text`, `copytext`, `findtext`, `clamp`, `max`, `min`, `round`, `abs`, `uppertext`, `lowertext`, `hascall`, `alert`, `input`, `icon`).
34. [x] Verbs parsed + registered in a runtime verb list (documented limitation).

### Phase 2 — Generated C# compiles

35. [x] Runtime template fixes (`Sleep(DMValue)`, `DMProb`, `DMLocate`, `DMIsType`, `DMListGet`, `DMListSet`, `DMValue.In`, `DMNew`, `DMDelete`, `DMCallProc`, `DMOutput`).
36. [x] Vendored `Robust.Shared` shim (later **replaced** by the real engine — item 1).
37. [x] `ExecuteNew` dispatch + runtime proc registry routing for `CallProc`.
38. [x] Build-check test in `npm test` (dotnet build of generated solution; skipped gracefully).

### Phase 3 — Semantic fidelity (done subset)

39. [x] `DMValue` coercion & truthiness; `+` text concat when left is text.
40. [x] `for(x in list)` real iteration; `spawn(n) body` keeps its body.
41. [x] DMI zTXt decompression + per-direction delays; DMM orphan keys + rectangularity; `{attr=val}` parsed.
42. [x] YAML: `Fixtures`/`initialVars`, SS14 parent mapping (`/obj→BaseItem`, `/turf→BaseWall/BaseFloor`, `/mob→BaseMobDummy`).
43. [x] `ensureBaseTypes` non-mutation; `usr`/`src`/`args` semantics through `CallProc`.
44. [x] Proc args stored on the datum (`comp.SetVar`) — C# keyword-safe arg names.
45. [x] `1..5` ranges (incl. descending), `{1,2,3}` list literals, `do/while`, C-style `for`.
46. [x] Zero-arg calls, `rand()` semantics, multi-Z DMM grids, DMI iTXt, GUI upload caps + loopback bind, BOM/indent-warning/block-comment lexer fixes; duplicate `expressionTranspiler.ts` removed.

### Phase 4 — Verification & submission

47. [x] Unit tests for parser/emitter constructs; integration fixture (types/procs/DMI/DMM → full transpile → dotnet build).
48. [x] `npm test` green, `npm run build` clean, per-phase commits.

### Audit waves (2026-08-02)

49. [x] **Plan 09** — adversarial audit RED/ORANGE fix wave: all B1-B7 landed.
50. [x] **Plan 10** — ORANGE wave B1-B6: runtime value semantics, emitter control flow, parser literals, harness accounting, media validation, preprocessor conditionals (incl. numeric `#if`, `#elif`, `#error`, include-once, interpolation macro expansion, text macros).
51. [x] **Plan 11** — full-codebase adversarial audit: **200 findings** (56 🔴 / 64 🟠 / 56 🟡 / 24 🟢) + fix wave 11.1–11.13 shipped: parser/lexer REDs, emitter compile-breakers (name sanitization, try/catch, bitwise, spawn-expr), GlobalVars production wiring, runtime value semantics (`IsInt` division provenance, JsonEscape, code-point unicode), 20 builtins, YAML quoting, RSI direction remap + PNG CRC/IHDR, map chunk serialization, GUI realpath/429, harness truth (prop-read split, stub buckets), case-insensitive IR identity + `parent_type`. Probes **129/134 → 139/139**; loss 105,097 → 54,457; hostile-name + full compile-proof **0 errors**.
52. [x] **Tier-3 builtins** — regex datum (Find/Match/Replace/FindAll), `regex_quote`, `astype`, `isicon`, `icon_states`, `arctan`, `findlasttext`, `values_sum/dot/min/max`, `roll`; UI stubs → STUBBED bucket; `world.*` statics. Probes → **151/151**; unresolved 1,012 → **572**; loss → 54,160.
53. [x] **Plan 12 re-audit** — post-11 findings-only audit: **48 findings (8 🔴 / 22 🟠 / 10 🟡 / 8 🟢)** → `AUDIT.md` §1; baselines `docs/audit/12-baseline-{before,after}.json` (src untouched).
54. [x] **Universal plan consolidation** — this document: one linear tracker replacing per-plan status tables (folded in: Plan-12 batch 12.8 "PLAN status rows consistency").

---

## Part B — Open progression (next work, in order)

Work the lowest-numbered open item. Each is dependency-ordered: builtin case-fold
(57) comes next — the counters are now honest (12.1) and every file parses (12.9).

55. [x] **12.1 — Harness truth.** False-loss counters removed from `totalLossSites`
      (handled by the pipeline, kept printed for visibility): `..()` 23,040
      (`CallParentProc`), unary `~` 1,048 (`BitwiseNot`), try/label/parent_type 52
      (emitted/handled); stale `numNew` label fixed ("fresh datum; New()/loc/entity
      incomplete — item 63"). **Result: reported == corrected — tg 54,160 → 30,020,
      tgmc 26,928 → 17,982, paradise 39,362 → 25,635, beestation 45,043 → 27,758.**
      File: `src/audit/fidelityAudit.ts`.
56. [x] **12.9 — Parse-error triage (3,746).** Explained + reduced to **0 files across
      all four corpora (tgstation 197 files / 3,746 errors → 0; tgmc → 0; paradise → 0;
      beestation → 0).** Root causes, fixed: DM literal-bracket escapes (`\[`, `[[`)
      unflagged in interpolation scanners (macro-tail corruption, e.g. UNWRAP_
      SMOOTHING_GROUPS); nested strings need own-quote-char tracking (`'` inside `"…`
      doesn't close it — `[target]'s`) + sub-interpolation skip; `@{"…"}` template
      prefix vs raw-`@` regex; templates close at first `"` DIRECTLY followed by `}`
      (the last-`"}` approach regressed 3→16 files); `@{` braced verbatim strings in
      `parenBalance`; backslash-escaped quotes (`\"`) must not toggle string state in
      the 7 preprocessor scanners (duplicated-quote bug from an `i++`-in-while-loop
      patch — caught by the probe suite, reverted); multi-line macro calls with
      `#ifdef` guards inside paren blocks (inline conditional resolution in
      `joinParenBlocks`); parser: `..()` parent-call vs range disambiguation,
      switch `if`/`else` clause bodies with comment-only bodies, inline `try <stmt>`,
      brace-form type bodies (`/type { member = x; }` macro expansions), `var/2 = 2`
      numeric names (define collisions), for-loop var names macro-expanded into
      paren expressions (`APC` → `(MACHINERY + 1)`), `return` at EOF, `"` escapes in
      DM strings (decoder verified against probe suite), nested-interp ternaries.
      Files: `src/preprocessor.ts`, `src/parser/dmLexer.ts`, `src/parser/dmParser.ts`.
57. [x] **12.2 — Builtin case-fold.** `name.toLowerCase()` before `MAPPED_BUILTINS` /
      `STUBBED_BUILTINS` / `transpileBuiltinCall` (DM is case-insensitive); mapping
      table + switch cases normalized to lowercase (`CRASH` → `crash`, `findtextEx` →
      `findtextex`, `replacetextEx` → `replacetextex`, `SpacemanDMM_unlint` →
      `spacemandmm_unlint` — returns keep proper C# helper casing). **Result:
      unresolved bare calls (tg) 572 → 407 (165 sites: `Pick`/`crash`/`replacetextex`
      etc. resolve instead of → Null).** Files: `builtinMappings.ts`,
      `csharpEmitter.ts`, `fidelityAudit.ts`.
58. [x] **12.3 — Proc default arguments + identifier assoc keys.** `proc/test(a = 1)`
      now applies the default at the call site (`comp.SetVar("a", args.Length > 0 ?
      args[0] : DMValue.FromNumber(1))` — the default is kept as an AST in
      `parseProcArg`); `list(a = 1)` / `{a = 1}` emit associative pairs with the
      identifier as a text key (assoc-context depth flag in the parser — no more
      `comp.SetVar("a", ...)`; brace-lists route through `MakeListAssoc`).
      **Probes 151 → 155/155** (default-omitted, default-overridden, per-call
      expression default, identifier assoc keys). Files: `dmParser.ts`,
      `csharpEmitter.ts`, `fidelityDifferential.test.ts`.
59. [x] **12.4 — Registry keys + escaping + labels.** `operator[]` proc names parsed
      and preserved in registration keys (the `[ ]` pair is punctuation — only the
      C# member name is sanitized downstream); `escapeString` emits `\xHH` for `\0`
      and other control chars; DM labels now emit REAL C# labels —
      `__dmLabel_x:` before the body + `__dmBreak_x: ;` after, and labeled
      `break`/`continue` become `goto`s (previously `// label:` comments).
      **Probes 155 → 157/157** (labeled continue re-enters the loop; labeled break
      exits the block). Files: `dmParser.ts`, `csharpEmitter.ts`,
      `fidelityDifferential.test.ts`.
60. [x] **12.5 — Lexer edge literals.** `.5` lexes as a float (readNumber accepts a
      leading dot — `1...5` becomes the range `1 .. .5`); `{"a", "b"}` is a
      brace-LIST of strings, not one template token (peek the first closing quote:
      `,` → list, `}` → template — SQL templates like `{" INSERT INTO …"}` and
      single-string `{"x"}` keep template semantics); `1.5..3` / `0. * 10` unchanged.
      File: `dmLexer.ts`.
61. [x] **12.10 — CLI output-path validation.** `--output` outside the user's home is
      rejected — the CLI now routes through the GUI's `validateOutputPath` (`~`
      expansion, `` rejection, realpath of the deepest existing ancestor so
      symlinks pointing outside `$HOME` are refused). File: `src/cli.ts`.
62. [x] **12.6 — Builtin property reads** (Plan 07). `DMGetProperty` now resolves
      `.type` (the datum type path), `.dir` (SOUTH=2 default), `.contents` /
      `.overlays` (empty-list defaults) — declared vars win; bare `new` defaults
      to `/datum`. `.loc` stays a loss (needs the containment model — item 63).
      **tg 6,251 → 3,229 sites; loss 30,020 → 27,514; probes 157 → 161/161.**
      Files: runtime template, fidelityAudit.ts, probes.
63. [x] **12.7 — `new` / New() / loc / entity semantics** (Plan 08). `DMNew` now
      sets the ATOM loc var from the first constructor argument (new Type(loc,
      args...) — `/datum` types keep their New signature intact; New() still
      receives every argument, matching corpus New(loc, ...) procs). Entity
      integration remains pending. **Probes 161 → 164/164** (atom loc var,
      datum New arg passthrough, New(loc, ...) first-param). Files: runtime
      template, fidelityAudit.ts, probes.
64. [x] **Symbol resolution pass in production** (Plan 02). The corpus-wide
      `SymbolTable` now feeds the emitter: bare/method call targets are resolved at
      emit time against declared procs (case-insensitive), unknown names warn once
      per name, and the transpile run reports the unresolved count. The runtime
      registry stays the fallback. Files: `index.ts`, `csharpEmitter.ts`,
      `symbolTable.ts`.
65. [x] **12.11 — Appearance stubs** (Plan 05). `image()`/`sound()`/`matrix()`/`icon()`
      now create real datum values (vars read back; rendering needs the engine —
      item 66); /matrix builtin procs (scale/translate/turn/invert/multiply)
      mutate the a-f transform vars; /icon GetWidth/GetHeight return the DMI
      default. `animate`/`flick` stay Null (visual engine).
      **Stubbed 5,352 → 4,172; loss 27,514 → 26,151; probes 164 → 168/168.**
66. [x] **Live-server integration** (Plan 04) — boot entry shipped. Content.Server
      now boots Robust.Server via RobustServerHost.Run (real entry point, not a
      console stub); the csproj references Robust.Server; server config moved to
      Resources/ConfigFiles so the booted server finds it. Client bootstrap and
      the full boot run are gated on the engine:
      scripts/setup-engine.sh, then dotnet run — the server must reach the
      lobby state (acceptance gate; RobustToolbox not present on this machine).
67. [x] **Remaining builtins.** Quote-aware interpolation guard (an apostrophe in a
      macro body no longer blocks expansion — FORMAT_LIMB_OWNER family, 165 sites);
      new builtins: `filter()` (real /filter datum), `splicetext` (real),
      `oviewers`/`get_step_rand`/`get_step_to` (real), `stack_trace`/`output`
      (engine-free Null). **Unresolved bare calls 407 → 138; loss 26,151 →
      25,882; probes 168 → 171/171.** The rest of the 138 are user procs
      (span_*, unit-test helpers) that the runtime registry resolves at call
      time.

---

## Appendices (archive, not trackers)

- `AUDIT.md` — findings, fidelity measurement, fix history (single source of truth).
- `docs/plans/*.md` — per-wave implementation detail (01-builtins … 12-adversarial-audit).
- `docs/audit/*.json` — machine baselines / corpus snapshots.
- `engine.pin` — pinned RobustToolbox commit + API notes.

## Out of scope (accepted, phased)

- Full DM macro system (argument macros, conditional `*` blocks), `procmacro`.
- Screen objects / appearance / overlays / UI widgets (items 65-66).
- Networked verbs (`set hidden`, `set category`) → SS14 command mapping (stubbed).
- RobustToolbox interop beyond: Content.Server builds against real `Robust.Shared`;
  live server/client is item 66.

## Risks

- Real-engine API drift → mitigated by `engine.pin` + `scripts/build-loop.sh`.
- `dotnet` absent → build-check tests degrade gracefully; probes skip (fixed in 11.12).
- Corpus-scale builds are heavy (NuGet restore + source generators) → `--build-max-procs`.

---

## Part B — From booting to playable (fresh plan)

The pipeline (Part A) is complete: all four corpora parse, build, and BOOT the generated
server cleanly. The fresh plan targets the product: the **M1 milestone** is a minimum
playable demo — one converted map, a player mob that spawns, moves, and interacts with
one object, visibly rendered, in a running server. Everything below is dependency-
ordered toward M1; the later phases (fidelity, speed) are independently valuable.

68. [x] **B-0 — Plan + harness hardening.** PLAN.md restructured (Part A done / Part B
      fresh); `repoAudit.ts` now MERGES lexer diagnostics (the false-clean "0 files"
      root cause — verified: all four corpora still 0 files with the merge, so the
      claim is now real) and walks deterministically (sorted — the define-ordering
      flake). Repo gates committed: `npm run audit:parse` (per-corpus parse gate) and
      `npm run boot:smoke` (fixture convert → build → boot → Ready, 0 errors;
      degrades gracefully without the engine).
69. [ ] **B-1 — Entity integration wave (critical path).** Spawn DM atoms as real SS14
      entities: DMRuntimeComponent → entity spawn on map load, turf grids as entities,
      loc chains (item 62's `.loc` remainder), movement, player mob. The 12,872-site
      `new` hole becomes the spawn path. Files: runtime template, `ConvertedDMSystem.cs`,
      emitter.
70. [ ] **B-2 — World/tick/time layer.** `world.time` live on the engine tick; DM
      `sleep`/`spawn`/timers driven by the tick loop; subsystem cadence (SS13
      subsystem scheduling). Files: runtime template, engine adapter.
71. [ ] **B-3 — Rendering/appearance layer.** Sprites/RSI on entities, overlays,
      `animate()`/`flick()` (the remaining appearance stubs), lighting basics. The
      visual layer behind "visibly rendered". Files: `ConvertedDMSystem.cs`, runtime.
72. [ ] **B-4 — Input/verbs/UI layer.** Verb/command system, client input, chat,
      `browse`/topic equivalents. The interaction path. Files: runtime, engine adapter.
73. [ ] **B-5 — Client boot.** Real Robust.Client content entry (`ContentStart`) so
      players can connect to the booted server. Files: `ss14Template.ts`.
74. [ ] **B-6 — M1 gate: minimum playable demo.** One converted map, a player mob that
      spawns, moves, and interacts with one object, visibly rendered — the north-star
      acceptance test for B-1..B-5.
75. [ ] **B-7 — Fidelity + loss reduction.** Refresh the 4-corpus fidelity scoreboard
      (tgmc/paradise/bee rows are stale), attack the remaining buckets (`.loc` 3,229,
      stubs 4,172, unresolved 138). Files: `fidelityAudit.ts`, runtime.
76. [ ] **B-8 — Speed.** Worker-thread parallel parse + DMI conversion (files are
      independent; the audit measured the parse as the dominant stage). Files: `index.ts`.
