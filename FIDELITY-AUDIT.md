# dm2ss14 — Fidelity Audit (full-codebase)

Independent audit of semantic fidelity: how much of the original BYOND/DM behavior
survives conversion. Measured three ways:

1. **Semantic differential probes** — tiny DM snippets with known BYOND behavior,
   converted, compiled, and **executed** against the converted runtime
   (`npm run audit:semantics`; dotnet required).
2. **Loss-site instrumentation** — `src/audit/fidelityAudit.ts` walks the whole
   pipeline (preprocessor → parser → IR → emitter) and counts every construct that
   is dropped, degraded, or mis-compiled (`npm run audit:fidelity -- <repo>`).
3. **Compile proof** — `dotnet build` of a fully generated solution from a real
   codebase (tgstation, 44,829 sampled procs).

Corpus (all `master` as of 2026-07): tgstation 7,440 .dm files, tgmc 2,612,
paradise 3,779, beestation 5,195. Raw results: `*-audit.json` / `*-audit.txt`.

Severity: 🔴 Critical (generated code broken / core semantics destroyed) ·
🟠 High (silent wrong behavior) · 🟡 Medium · 🟢 Low.

---

## 1. Semantic differential results (91 probes, 91/91 preserved)

Each probe runs the *converted* code; expected = BYOND behavior, observed =
converted runtime.

| Probe | Expected | Observed | Status |
|---|---|---|---|
| findtext is 1-based | 2 | 2 | ✅ |
| `"0"` is falsy in conditions | 0 | 0 | ✅ |
| num2text(42) | 42 | 42 | ✅ |
| 1-based list indexing `L[1]` | 10 | 10 | ✅ |
| `"a" + 5` concatenates | a5 | a5 | ✅ |
| `for(x in 1..3)` sums range | 6 | 6 | ✅ |
| text equality is case-insensitive (`"ABC"=="abc"`) | 1 | 1 | ✅ |
| text `<` compares lexicographically (`"10"<"9"`) | 1 | 1 | ✅ |
| list equality is element-wise | 1 | 1 | ✅ |
| `null == ""` is true | 1 | 1 | ✅ |
| `\|\|` returns the operand value (`5 \|\| 3` → 5) | 5 | 5 | ✅ |
| `&&` short-circuits (`0 && (x=1)` leaves x=0) | 0 | 0 | ✅ |
| `L += x` appends to a list | [list] | [list] | ✅ |
| `L.len` reads list length | 2 | 2 | ✅ |
| negative list index `L[-1]` | 2 | 2 | ✅ |
| two `new /type()` are distinct objects | 0 | 0 | ✅ |
| `..()` executes the parent proc | 9 | 9 | ✅ |
| `world.time` is a number | 0+ | 0 | ✅ |
| text2num("0x1F") | 31 | 31 | ✅ |
| `break` exits a C-style for | 2 | 2 | ✅ |
| replacetext("aaa","a","b") | bbb | bbb | ✅ |
| `as /type` cast preserves the object | 0 | 0 | ✅ |
| istype(null, /datum) | 0 | 0 | ✅ |
| islist(list(1)) | 1 | 1 | ✅ |

**Current: 91 probes, 91/91 preserved** — the core 24 above plus 67 added by the
Plan 01 builtin batches (see §3e).

**All 24 core-semantics probes preserved** (Phase 0.5 semantic core, done 2026-08):
text semantics, operand-returning short-circuit `&&`/`||`, `DMList` (`len`,
negative indices, element-wise equality, `+=` append), `break`/`continue` with
switch `while(true)` wrappers, `..()` parent dispatch, `world` datum, hex
`text2num`, `replacetext`, `islist`, `as` casts. Compile blockers fixed in the
same pass: `DMValue.NotEquals`/`Power`, `DMIsType` for non-datum, IR
trailing-slash normalization.

---

## 2. Loss sites per codebase (counters, by total impact)

| Loss class | tgstation | tgmc | paradise | beestation | Σ | Verdict |
|---|---:|---:|---:|---:|---:|---|
| `..()` parent calls → `null` | 22,927 | 8,544 | 13,436 | 16,392 | **61,299** | 🔴 core inheritance dead |
| bitwise ops `& \| ^ ~ << >>` → `null` | 18,043 | 7,595 | 8,163 | 10,821 | **44,622** | 🔴 flag logic dead |
| `new` → same object, identity broken | 12,665 | 8,146 | 12,353 | 10,798 | **43,962** | 🔴 |
| `break`/`continue` (counted as dropped) | 5,694 | 2,532 | 3,447 | 4,410 | **16,083** | ✅ handled (emitter emits them; audit 2026-08-02: harness counter stale by 6,018) |
| world refs (`world.*`) → `null` | 3,705 | 1,748 | 3,160 | 3,843 | **12,456** | 🟠 |
| GLOB.x reads → `null` | 6,384 | 3,970 | 5,738 | 5,780 | **21,872** | ✅ resolved (3d) |
| for-as loop filters | 3,899 | 304 | 761 | 2,036 | **7,000** | 🟠 |
| `!=`/`~!` in value position | 2,939 | 1,160 | 1,835 | 3,632 | **9,566** | ✅ resolved (`NotEquals` exists; counter stale) |
| `**` (Power) | 971 | 87 | 123 | 632 | **1,813** | ✅ resolved (`Power` exists; counter stale) |
| `as` casts → `null` | 227 | 228 | 255 | 288 | 998 | 🟠 |
| `#define` truncation at `//` | 102 | 377 | 188 | 270 | 937 | 🟢 |
| `new` in type decls, verb decls, client decls | 12–753 / file | — | — | — | 🟡 | client/verb conversion absent |
| GOTO | 2 | 4 | 5 | 2 | 13 | 🟢 |
| **Total loss sites** | 200,400 | 78,836 | 110,495 | 141,149 | **530,880** | |

Parse errors (unsupported syntax, source dropped): tgstation 5,359 · tgmc 7,327 ·
paradise 14,118 · beestation 16,003 — beestation/paradise lose whole files.

### The two biggest silent buckets (tgstation)

- **Unknown builtins: 42,852 sites** — `isnull` 7,716 · `get_step` 5,647 ·
  `isnum` 1,122 · `CRASH` 991 · `sqrt` 93 · `log`/`sin`/`cos` 44–36 · `isnan`/`isinf`
  16 · `alist` 28 · `filter` 12 … (15,086 / 18,110 / 27,278 on tgmc/paradise/beestation).
  Every one compiles but returns `null` at runtime.
- **Bare global proc calls: 36,789 sites** (13,063 / 23,492 / 26,271) — global
  helpers like `message_admins()`, `to_chat()`, `alert()` resolve through the
  runtime registry; missing targets → `null`. Most converted globals are never
  registered, so this is effectively dead.

---

## 3. Compile-proof findings (tgstation, 44,829 procs sampled)

- **CS0111 duplicate methods** (6 errors): `/obj/item/clothing/head/chaplain/`
  (trailing slash, `religious.dm:1`) and `/obj/item/clothing/head/chaplain` become
  distinct IR keys but identical C# method names (`Proc_ObjItemClothingHeadChaplain_Pipe_eject`,
  `Proc_DatumOutfitWaystation_Pre_equip`). Corpus-wide trailing-slash decls:
  tgstation 2 · tgmc 21 · paradise 7 · beestation 4 → **CS0111 risk on every
  codebase**.
- `!=`/`~!` in **condition position compiles** (`!(a==b).IsTrue()`) — correct.
  In **value position** it emits `!DMValue.Equals(...)` → **CS0023**.
- `**` emits `DMValue.Power(...)` which does **not exist** in
  `src/runtimeTemplate/dmRuntimeCS.ts` → **CS0103**.
- ~44,829 procs → solution builds after the 6 CS0111 lines are removed; no other
  hard compile breakers surfaced at this scale.

### 3b. Corpus compile proof — VERIFIED (2026-08)

Run: `node dist/audit/fidelityAudit.js <tgstation> --build temp_test_corpus_build --build-max-procs 1500`
with `SS14_ENGINE_DIR` set to a pinned RobustToolbox (`engine.pin`, commit `9cefa116`).

- **44,826 sampled procs from 45,502 types → real-engine `dotnet build` green, 0 C# errors.**
- Error classes fixed along the way (146,874 → 4 → 12,984 → 228 → 10 → **0**):
  - **CS1061** — `Task<DMValue>` / bool `.IsTrue()`: parens around awaited calls
    (`(await DMCallProc(...))`), parenthesized `&&`/`||`/ternary emissions.
  - **CS0201** — expression statements: call statements strip parens (guarded by
    startsWith/endsWith); assignments / index-assignments / non-calls emit `_ = expr;`.
  - **CS0136** — `__dmIter` collisions: unique `__dmIter${n}` per `foreach`.
  - **CS7036** — `DMIsType`/`DMIsPath`/`DMLocate` default `typePath`; `Num2Text` 2-arg overload.
  - **CS1503** — `arglist()` → `DMArgsConcat`/`DMArgList`; raw `args` → `DMValue.FromList(__dmArgs)`.
  - **CS0029** — `DMDelete` returns `DMValue` (`return qdel(x)`).
  - **CS1632** — `break` inside `spawn()` lambda: emitter resets loop/switch depth and
    comments the `break` out.
  - **CS1026** — unguarded paren-strip truncated builtin calls (`MRuntimeHelpers.Alert`).
- Audit harness: build timeout raised to 30 min; timeouts are now reported distinctly
  from compile failures (a 131 MB generated file takes ~15 min to build at 44,826 procs).
- Regression guards: `src/tests/runtimeTemplate.test.ts` pins the runtime-template
  backtick structure (a stray backtick in a C# comment silently breaks the TS build).

### 3c. Builtin expansion + /proc fallback — VERIFIED (2026-08)

Batch: map ~43 additional builtins + resolve bare global proc calls in the runtime.

- **Builtins mapped** (with engine-free semantics): `isnull`/`isnum`/`istext`,
  `isturf`/`isobj`/`ismob`/`isarea`/`ismovable`/`isloc`/`isitem`/`iscarbon`/`isliving`
  (via `DMIsType`), `CRASH` (throws), `nameof` (last path segment), `typesof` (union of
  registered descendants), `initial` (first-assigned var value), `call()` proc refs +
  `f(...)` invocation, `turn` (45° clockwise rotation), `get_step`/`get_dist`/`get_dir`/
  `get_turf`/`range`/`view`/`oview`/`block` (by DM x/y/z vars over the live-datum
  registry), `splittext`/`jointext`/`params2list`/`text2path`/`rgb`/`fexists`/`isnan`/
  `isinf`/`json_decode`; recognized stubs: `animate`/`image`/`flick`/`sound`/`matrix`/
  `browse`/`call_ext`/`__detect_rust_g`.
- **`/proc` fallback**: `CallProc`/`CallParentProc`/`CanCallProc` now fall back to the
  `/proc` registry entry, so bare calls to global procs resolve at runtime instead of
  returning Null (36,789 sites on tgstation).
- **Fresh audit across all 4 corpora** (unknown builtin call sites):

  | corpus | before | after | drop |
  |---|---|---|---|
  | tgstation | 41,288 | 3,637 | −91% |
  | paradise | 17,346 | 2,127 | −88% |
  | tgmc | 14,541 | 1,639 | −89% |
  | beestation | 26,185 | 2,725 | −90% |

- Semantic probes **24 → 40/40** (16 new: /proc fallback, predicates, nameof, typesof,
  initial, call-refs, turn, position builtins, text/list builtins, json_decode, range).
- Compile proof **re-verified at 44,826 procs → 0 C# errors** with the new runtime
  (dotnet build green, 12 min).
- Audit harness hardened: `dotnet build` runs single-process
  (`-m:1 -nodeReuse:false --disable-build-servers`) with **live-streamed output** and a
  SIGKILL timeout — previously a stuck MSBuild build server could block the harness
  beyond its timeout, and buffered output made healthy builds look hung.

### 3d. GLOB statics — VERIFIED (2026-08)

Batch: materialize `/global/var/` declarations as a runtime `GlobalVars` registry;
`GLOB.x` reads/writes route through it instead of returning `null`.

- **Parser**: `/global/var/[type/]name = expr` initializers are re-parsed into full
  expression trees (`parseInitializerTextToExpr`; `DMGlobalVarDeclNode.initialValueExpr`).
- **Emitter**: `generateProcsCS(irMap, globals)` now emits `public static class GlobalVars`
  with a lazy `EnsureInit()` assigning every declared global in declaration order;
  `GLOB.x` reads → `(await GlobalVars.Get("x"))`, writes → `(await GlobalVars.Set("x", v))`
  (hooks in `transpileProperty`/`property_assignment`); undeclared names read as Null.
- **Global-initializer context**: `src` → Null, bare proc calls → `GlobalVars.CallGlobal`
  (routes through the `/proc` registry), `new /type()` → `DMNew(null, …)`.
- **Audit**: fixed a latent ordering bug (`numGlobalVars` was read before `parser.parse()`,
  so it was always 0 — tgstation actually declares 1,075 globals); `numGlobalVars`,
  `numGlobAccess`, and bare-global-call sites are reclassified as **resolved** (out of
  the loss total; bare globals resolve via the 3c `/proc` fallback).
- **Fresh 4-corpus audit** (loss sites, pre-GLOB batch → post):

  | corpus | global decls | GLOB.x sites | loss before | loss after | drop |
  |---|---|---:|---:|---:|---:|
  | tgstation | 1,075 | 6,384 | 161,185 | **118,012** | −43,173 |
  | paradise | 790 | 5,738 | 94,512 | **65,282** | −29,230 |
  | tgmc | 699 | 3,970 | 65,389 | **48,356** | −17,033 |
  | beestation | 991 | 5,780 | 116,596 | **84,545** | −32,051 |

- Semantic probes **40 → 49/49** (10 new: global defaults, writes, list defaults,
  cross-global initializers, `new` defaults, undeclared → null, cross-proc state,
  cross-type sharing, assoc keys on global lists).
- Compile proof **re-verified at 44,826 procs → 0 C# errors** (dotnet build green,
  ~11 min) with `GlobalVars` materializing all corpus globals.

### 3e. Plan 01: builtin batches 1–3 (pure functions, file ops, movement) — VERIFIED (2026-08)

`MAPPED_BUILTINS` grew to 112 names; the audit now resolves known builtin calls
instead of counting them unknown (baseline: 3,345 unresolved on tgstation, §3f).

- **Batch 1 — pure functions** (23): `arglist`, `floor`, `ceil`, `sqrt`, `sin`,
  `cos`, `arccos`, `log`, `sign`, `copytext_char`, `length_char`, `text2ascii`,
  `ascii2text`, `ckey`, `sorttext`, `replacetextEx`, `html_encode`, `html_decode`,
  `rgb2num`, `json_encode`, `time2text`, `list2params`, `alist` — probes 68/68,
  unresolved **3,345 → 1,740** (−1,605).
- **Batch 2 — file ops** (9): `file`/`isfile`/`fdel`/`fcopy`/`fcopy_rsc`/`flist`/
  `ref`/`refcount`/`SpacemanDMM_unlint` (new `DMValueType.File`; `fdel` must check
  existence first — .NET `File.Delete` silently succeeds on missing files) —
  probes 80/80, unresolved **1,740 → 1,080** (−660).
- **Batch 3 — movement** (8): `step`, `step_towards`, `step_away`,
  `get_step_away`, `get_step_towards`, `orange`, `viewers`, `hearers` — and fixed
  **`range`/`view`/`oview` arg order**: BYOND is `(dist, center)`, the mapping was
  `(center, dist)` and would have returned empty lists for every call site —
  probes 91/91, unresolved **1,080 → 708** (−372).
- Compile proof re-verified at 44,826 procs → 0 C# errors after each batch.

### 3f. Plan 02 + Plan 06: symbol resolution & parse-error sweep — VERIFIED (2026-08)

- **Symbol table** (`src/ir/symbolTable.ts`): one pass over the merged IR builds
  per-type proc sets; the audit resolves bare calls against it (type-aware).
  **93,573 / 96,918 bare global calls now verified** (35,937 `/proc` + 57,636
  type-hierarchy); the remaining **3,345** are unknown builtins — the working
  baseline for Plan 01 (§3e).
- **Parse-error sweep** (Plan 06): `@\`@@\`` raw strings, `#INF` literals,
  multi-line `new()` args, `switch` dedents, bare-type C-`for`, `+=` in
  expressions, bare-C compound-assign `for` init — tgstation parse errors
  **1,285 → 178** (target <500 met).

### 3g. Full-pipeline adversarial audit — VERIFIED (2026-08-02)

Eight parallel workstreams (parser, preprocessor, runtime, emitter, IR,
harness, security, media) — **115 consolidated findings (29 🔴 / 44 🟠 /
42 🟡)**, published as GitHub issue #1. The harness findings correct the
headline numbers:

| Metric | Reported | Corrected | Cause |
|---|---|---|---|
| `totalLossSites` (tgstation) | 119,801 | **~105,198** | −708 unresolved double-counted (`fidelityAudit.ts:400-414`); −7,877 stale "won't compile" (`NotEquals`/`Power` exist); −6,018 handled break/continue |
| Unresolved builtins | 708 | **~593** | −113 unexpanded tgstation fn-macros (`span_*`, `REGEX_QUOTE`, `TEST_ASSERT` — preprocessor `[interpolation]` handling); −2 case mismatches (`Rand`/`Turn` — BYOND case-insensitive) |
| Parse errors | 178 | internally consistent | includes `tools/CatchUnescapedBrackets/fail.dm` fixture + `tools/` lints; files with parse errors drop their remaining content from every site counter |

Key REDs being fixed in Plan 09 (`docs/plans/09-audit-fixes.md`): parser
precedence table (`?` tighter than all binary ops; `<<`/`>>` at `||` level;
bitwise merged into relational), `/`+alpha lexed as TypePath (`a/b` → division
by `/b`), single-line `if (x) return` bodies dropped, `[expr]` interpolation
never transpiled, `list("a" = 1)` values dropped, `in`-clause phantom args,
leading-slash-less decls; emitter switch = infinite `while(true)` with no
terminating `break`, `continue` skips C-for increment / continues the switch
wrapper, 10 builtin trailing-arg forms → CS1501, `pathToClassName` collisions →
CS0102; runtime `replacetext` empty-needle hang; IR special-parent synthesis
order, cross-file type-split clobber, `/global/var/` string initializers →
CS0103, trailing-slash base clobber; GUI `/api/convert` = unauthenticated
arbitrary file write; DMI `state = "x"` regex misses `=`, iTXt needs 5 NULs
(real: 3), RSI emits one `texture.png` (frame-major → direction-major), TGM
maps unparseable → all grids skipped, mapConverter emits non-SS14 YAML schema.
Escape-collapse class, Zip-Slip, ~70 builtin arg orders, and the 91-probe
baseline were verified clean.

---

## 4. Ranked fix backlog

**Tier 0 — unblocks compilation (small, high value)**
1. ~~Strip trailing `/` when normalizing type paths in the IR~~ → **DONE** (CS0111 class fixed).
2. ~~Emit `DMValue.NotEquals(a, b)` for value-position `!=`~~ → **DONE** (runtime + emitter).
3. ~~Add `Power(a, b)` to the runtime (`Math.Pow`)~~ → **DONE**.

**Tier 1 — restores core semantics (biggest behavioral wins)**
4. Parent dispatch: runtime registry walks the DM type hierarchy on
   `..()`/unknown-target `CallProc` → revives 61,299 `..()` sites + global proc calls.
5. Real object creation: `new` allocates a fresh component carrying its DM type
   (path → parent chain) → revives 43,962 sites, fixes object identity.
6. Bitwise ops on `DMValue` (ints via unchecked ops) → revives 44,622 flag sites.
7. Loop control: emitter tracks loop nesting; emit `break`/`continue` as structured
   C# (loop-local flag or real statements) → 16,083 sites.
   (Handled for `while`/`for-in`; Plan 09 fixes `continue` in C-style `for` — it
   skips the increment — and `continue` inside switch-in-loop.)
8. Text semantics: `DMValue.Equals` — if either side is text, case-insensitive
   compare; `null == ""` true; `<` on two texts → ordinal; `||` returns operand,
   `&&`/`||` short-circuit via emitted ternaries.

**Tier 2 — lists & casts**
9. `DMList`: `Len` property, negative-index reads, element-wise `Equals`, `+=` append
   (emit depends on lvalue kind) → `L.len`, `L[-1]`, `L == L2`, `L += x`.
10. `as` cast → `DMValue.AsType(path)` returning the component (not `null`) → 998 sites.
11. `for(x in list if(cond))` filter support → 7,000 sites.

**Tier 3 — builtins & globals**
12. Expand `MAPPED_BUILTINS`/runtime helpers: `isnull`, `isnum`, `get_step`,
    `CRASH` (throw), `sqrt`/`log`/`sin`/`cos`, `text2num` hex, `replacetext` (string
    replace — currently `null`), `findtext` (works) → the largest single bucket.
    (Done: the 3b builtin batch + `/proc` fallback + Plan 01 batches 1–3 (§3e);
    remaining: `regex`, `astype`, `winset`, `icon_states`, `span_*`,
    `findtextEx`, `arctan`, `isicon`, `link`, `gradient`, `filter`,
    `openToolTip`, `browse_rsc`, `closeToolTip`, `ftp`, `values_sum`…).
13. ~~`GLOB` as a real static class; `var/global/GLOB/x` declarations populate it~~ →
    **DONE (3d)**: `GlobalVars` registry, 21,872 sites resolved, probes 49/49.
14. `world.*` → static world state (time, tick) → 12,456 sites.

**Tier 4 — parser gaps & acceptance**
15. Triage top parse-error classes (14k on paradise, 16k on beestation); fix the
    top 5 patterns by frequency.
16. Verb declarations: map to SS14 commands or document as unsupported (tgmc has 268).

## Verification
- `npm run build` clean; `npm run audit:semantics` → 91 probes run under `dotnet`
  (scratch kept in `$TMPDIR/dm2ss14-fidelity`); `npm run audit:fidelity -- <repo>`
  reproduces all counters above; results archived in
  `~/Documents/antigravity/ss13-audit-corpora/`.
- Counters live in `src/audit/fidelityAudit.ts`; differential probes in
  `src/tests/fidelityDifferential.test.ts`.

## Accepted (by design, per PLAN.md)
No symbol-resolution pass; unknown procs → `null`; `spawn()` as expression;
DMI/RSI round-trips. **Update (Phase 0):** the generated solution now builds
against the real RobustToolbox engine (previously a fabricated shim); the DM
runtime is engine-free and the probe harness runs it standalone. Probe count is
now 91/91 preserved — the Phase 0.5 semantic-core backlog is complete (text/list
semantics, short-circuit ops, break/continue, `..()`, world statics, builtins,
`/proc` fallback, GLOB statics) and Plan 01 added its first three builtin batches
(pure functions, file ops, movement). The 2026-08-02 adversarial audit (§3g)
re-baselined the totals: **~105,198 real loss sites** (not 119,801) and **~593
real unresolved builtins** (not 708). Remaining work is Tier 3+ scope: bitwise
ops, remaining builtins (`regex`/`astype`/`winset`/`icon_states`/`span_*`…),
`world.*`, the Plan 09 fix wave, and corpus-scale compile proof.
