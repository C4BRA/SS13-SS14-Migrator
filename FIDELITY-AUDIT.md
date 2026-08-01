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

## 1. Semantic differential results (24 probes, 24/24 preserved)

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
| `break`/`continue` dropped | 5,694 | 2,532 | 3,447 | 4,410 | **16,083** | 🔴 loops wrong |
| world refs (`world.*`) → `null` | 3,705 | 1,748 | 3,160 | 3,843 | **12,456** | 🟠 |
| GLOB.x reads → `null` | 6,384 | 3,970 | 5,738 | 5,780 | **21,872** | 🟠 |
| for-as loop filters | 3,899 | 304 | 761 | 2,036 | **7,000** | 🟠 |
| `!=`/`~!` in value position → **CS0023** | 2,939 | 1,160 | 1,835 | 3,632 | **9,566** | 🔴 won't compile |
| `**` → **CS0103** (`Power` missing) | 971 | 87 | 123 | 632 | **1,813** | 🔴 won't compile |
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

---

## 4. Ranked fix backlog

**Tier 0 — unblocks compilation (small, high value)**
1. Strip trailing `/` when normalizing type paths in the IR → kills CS0111 on all corpora.
2. Emit `DMValue.NotEquals(a, b)` for value-position `!=` (runtime: `!Equals`); keeps
   condition-position form → 9,566 sites un-break.
3. Add `Power(a, b)` to the runtime (`Math.Pow`) → 1,813 sites.

**Tier 1 — restores core semantics (biggest behavioral wins)**
4. Parent dispatch: runtime registry walks the DM type hierarchy on
   `..()`/unknown-target `CallProc` → revives 61,299 `..()` sites + global proc calls.
5. Real object creation: `new` allocates a fresh component carrying its DM type
   (path → parent chain) → revives 43,962 sites, fixes object identity.
6. Bitwise ops on `DMValue` (ints via unchecked ops) → revives 44,622 flag sites.
7. Loop control: emitter tracks loop nesting; emit `break`/`continue` as structured
   C# (loop-local flag or real statements) → 16,083 sites.
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
13. `GLOB` as a real static class; `var/global/GLOB/x` declarations populate it →
    21,872 sites.
14. `world.*` → static world state (time, tick) → 12,456 sites.

**Tier 4 — parser gaps & acceptance**
15. Triage top parse-error classes (14k on paradise, 16k on beestation); fix the
    top 5 patterns by frequency.
16. Verb declarations: map to SS14 commands or document as unsupported (tgmc has 268).

## Verification
- `npm run build` clean; `npm run audit:semantics` → 24 probes run under `dotnet`
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
now 24/24 preserved — the Phase 0.5 semantic-core backlog is complete (text/list
semantics, short-circuit ops, break/continue, `..()`, world statics, builtins).
Remaining work is Tier 3+ scope: `GLOB` statics, bitwise ops, more builtins, and
corpus-scale compile proof.
