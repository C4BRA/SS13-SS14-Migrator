# dm2ss14 — Audit (single source of truth)

**Last updated:** 2026-10-11 · **HEAD baseline:** `328ea54` (wave-5 closeout)  
**Severity:** 🔴 Critical · 🟠 High (silent wrong) · 🟡 Medium · 🟢 Fixed / low  

This file replaces the former split of `AUDIT.md`, `FIDELITY-AUDIT.md`,
`docs/audit/11-findings.md`, and `docs/audit/12-findings.md`. Machine-readable
corpus snapshots remain under `docs/audit/*.json`. Implementation plans stay in
`docs/plans/`.

---

## 0. Current status (read this first)

**Wave-5 closeout (2026-10-11):** W-K master controller (concrete-subtype instantiation, `Initialize()` ordering, throw/`/exception` + abstract_type) · W-L real paradise station map end-to-end (variant protos `__mv<N>` for 18,184 braced-attr atoms, RSI dup-stateId dedupe, 3-step perf profile 91s/20.4GB → 22.8s/6.5GB) · W-M UI strategy (text-protocol bridge viable; ui_interact/ui_act→BUI = M2 north star) · W-N round-flow (bare-global binding, `var/list` expr-init seeding, +5 builtins). Open follow-ups in `docs/plans/{31,32,33,34}-*.md`: real-map `step_*`/`Move` no-op (turf Enter veto inside converted paradise code), `{attached}` autocmd resolves client uid not server mob, `StartWorld` picks first-sorted map file, `doMove` NRE, missing RSI states (`power_cond_white`), held-key repeat, multi-client.

| Gate | Result |
|---|---|
| `npm run build` | clean (tsc strict) |
| `npm test` | green; generated solution builds vs real RobustToolbox |
| Semantic probes | **329 / 329** (`npm run audit:semantics`) |
| Compile-proof (tgstation) | **45,183 procs → 0 C# errors** (real engine, `engine.pin`) |
| Loss sites (honest, wave-4) | tg **22,616** · paradise **21,311** (W-D/W-F/W-I waves; tgmc/bee not re-measured) |
| Stubbed procs (wave-4) | tg **773** · paradise **905** (was 3,062 / 1,915) |
| Paradise boot DM-errors | **189** lines (was **9,464** — W-I corpus playability pass) |
| Unresolved bare calls (tg) | **138** (item 67 — remainder are user procs resolved by the registry at call time) |
| Parse diagnostics | **tg 0 · tgmc 0 · paradise 0 · bee 0** (item 56 — all four corpora parse clean) |
| Subsystems firing (paradise) | **90 ticking on world.time grid** (W-K — was silently 0; SS_NO_FIRE 9.9k → 0) |
| Real-map gate (boxstation) | convert **22.8s** · **36,392** map entities · server Ready **~147s** · click dispatches converted `Click()` (W-L) |
| Round-flow slice | **5/5** `scripts/m2-round.sh` — SSticker → lobby → job → landmark spawn (W-N) |
| RSI duplicate stateIds | **0** (was 168 excess across 32 files — content-hash dedupe, W-L) |
| Open fix wave | **none — all 67 PLAN.md items + wave-5 complete** |

**Bottom line:** The converter is semantically healthier than its own harness
admits. Plan 11 REDs are largely fixed. Remaining work is (1) measurement honesty,
(2) a short list of proven silent bugs, (3) large product gaps (`new`, props,
stubs, live server).

---

## 1. Open findings — Plan 12 (latest adversarial re-audit)

Findings-only audit 2026-08-02. Methodology: `docs/plans/12-adversarial-audit.md`.  
**48 findings: 8 🔴 / 22 🟠 / 10 🟡 / 8 🟢-confirmed-fixed.**  
Baselines: `docs/audit/12-baseline-{before,after}.json` (src untouched).

### 1.1 Headlines (fix first)

#### 🔴 Harness overstates loss by ~24k (tgstation) — **RESOLVED (item 55, 12.1)**

~~`src/audit/fidelityAudit.ts` `totalLossSites` still charges ops the pipeline handles:~~
Removed from `totalLossSites` (kept printed for visibility); reported == corrected now:

| Counter | tg count | Reality |
|---|---:|---|
| `numParentCall` (`..()`) | **23,040** | emits `await comp.CallParentProc(...)` |
| `numUnaryTilde` | **1,048** | emits `DMValue.BitwiseNot(...)` |
| `numTry` / `numLabeledBlock` | 17 / 32 | try/catch emitted; label body kept |
| `numParentTypeDecls` | 3 | IR sets `parentPath` from `parent_type` |

`numNew` label now says "fresh datum; New() args + atom loc resolved (item 63); SS14 entity integration pending".

**Result:** 54,160 − 24,140 ≈ **30,020** (tg) — matches the estimate exactly; tgmc 17,982 · paradise 25,635 · beestation 27,758.

#### 🔴 Builtin map is case-sensitive

`MAPPED_BUILTINS.includes(name)` is exact-match; DM is case-insensitive.
`Pick` / `crash` / `replacetextex` → `DMCallProc` → Null. (`pick` / `findtextEx` work.)

#### 🔴 Identifier assoc keys miscompile

`list("a" = 1, b = 2)` emits `MakeListAssoc(..., comp.SetVar("b", ...))` — mutates
locals instead of assoc entries. String keys OK.

#### 🔴 Proc default arguments dropped

`proc/test(a = 1)` → `args.Length > 0 ? args[0] : DMValue.Null` — default never applied.

#### 🔴 `operator[]` registry key stripped

```
operator""  → Register(..., "operator\"\"", ...)
operator[]  → Register(..., "operator", ...)   // [] lost
```
C# method names dedupe (`Operator` / `Operator_2`) so **build** stays green.

#### 🔴 Parse-error count unexplained — **RESOLVED (item 56, 12.9)**

Measured **3,746** tgstation parse errors vs older docs (~170). Counter is real
`collector.errors.length`. Types still parse at scale (46,995 types / 64,794 procs).
Root causes triaged and fixed: DM literal-bracket escapes (`\[`, `[[`), nested-string
quote tracking (own-quote-char + sub-interpolation), `@{"…"}`/`@{…}` verbatim
strings, `"}`-direct template closes, `\"` escapes in preprocessor scanners,
`#ifdef` inside multi-line macro calls, and parser gaps (parent-call `..()` vs range,
switch clause bodies after comment-only cases, inline `try`, brace-form type bodies,
macro-expanded loop-var/var names, `return` at EOF). **All four corpora now parse at
0 files / 0 errors (tg 3,746 → 0; tgmc 1,249 → 0; paradise 10,306 → 0; bee 2,339 → 0).**

### 1.2 Residual product loss (real, after harness correction)

| Class | tgstation | Notes |
|---|---:|---|
| Partial `new /type` | 12,872 | fresh datum; New() args + atom loc resolved (item 63); entity integration pending |
| Broken prop reads | 3,229 | `.loc` only — type/dir/contents/overlays now runtime-resolved (item 62) |
| Stubbed builtins | 4,172 | animate/flick/winset/alert/input/… → Null (honest); image/sound/matrix/icon real datums (item 65) |
| Unresolved bare calls | 407 | span_*, unit_test helpers, filter, winget, oviewers, stack_trace… (was 572 — item 57 case-fold resolved 165) |
| `as` casts | 247 | dynamic no-op (often OK) |
| Appearance / verbs / client | — | Plans 05; stubbed / folded |
| Symbol resolution | — | Plan 02; audit-only `SymbolTable` |
| Live Robust.Server/Client | — | Plan 04; Content.Server builds only |

### 1.3 Findings by module

**WS1 Lexer** — 🟠 `.5` not float; `{"a","b"}` one raw token; `1...5` orphan dot · 🟢 nested comments OK  

**WS2 Parser** — 🔴 assoc id keys · 🟠 default args dropped; `set`/verb meta dropped; `in` precedence lock needed  

**WS3 Preprocessor** — 🟢 `//` in define strings, `#if` numeric, `##` paste OK  

**WS4 IR** — 🟢 `parent_type` + case-fold OK · 🟠 SymbolTable not in production  

**WS5 Emitter** — 🔴 `operator[]` key · 🟢 try/catch, bitwise, `CallParentProc`, name dedupe · 🟠 label=`//` only; `escapeString` raw `\0`; `new` partial  

**WS6 YAML** — 🟢 yes/123 quoted; pathToId dedupe (`a_b` vs `a/b`)  

**WS7 Builtins** — 🟢 case fold (item 57: 572 → 407 bare) · 🟡 MAPPED=133 STUBBED=21  

**WS8/9 Runtime** — 🟢 IsInt/Divide, JsonEscape, probes · 🟠 world.time not live clock · 🟡 `new Random()` ×7  

**WS10 Media** — 🟢 PNG CRC + IHDR bomb reject; RSI `[0,2,1,3]`  

**WS11 Maps** — 🟢 chunk list items + real turfs (integration tests)  

**WS12 GUI/CLI** — 🟢 429 single-flight, realpath, lexer diags merged · 🟠 CLI `--output` unvalidated  

**WS13 Harness** — 🔴 false losses + stale labels + parse/doc drift  

**WS15 Live engine** — 🟠 builds vs `Robust.Shared`; no live server/client boot  

### 1.4 Plan 11 → Plan 12 disposition

| Plan-11 RED | Status now |
|---|---|
| Hostile names break C# | **Fixed** compile; residual registry-key strip |
| `/global/var/` dropped | **Fixed** |
| Type path case-insensitivity | **Fixed** |
| JsonEscape invalid | **Fixed** |
| RSI N/E swap | **Fixed** |
| Map chunks lost / fake turfs | **Fixed** |
| Divide / step-continue / copytext | **Fixed** (151/151) |
| PNG hang / no CRC | **Fixed** |
| YAML scalar traps | **Fixed** |
| GUI symlink / 429 / shell spawn | **Fixed** |
| try/catch + labels dropped | **Fixed** emit; harness still counts loss |
| bitwise / `~` → Null | **Fixed** emit; harness still counts `~` |
| parent_type ignored | **Fixed** IR; harness label stale |
| `..()` → Null | **Fixed** `CallParentProc`; harness +23k false |
| Harness undercount stubs | Flipped to **overcount** of handled ops |

### 1.5 Fix batches (12.x)

| Batch | Theme | Impact |
|---|---|---|
| **12.1** | Harness truth (drop false counters/labels) | **done** (item 55) — tg 54,160 → 30,020, reported == corrected |
| **12.2** | Builtin case-fold + top bare calls | **done** (item 57) — unresolved bare (tg) 572 → 407; `Pick`/`crash`/`replacetextex` resolve instead of Null |
| **12.3** | Default args + assoc identifier keys | **done** (item 58) — missing args bind declared defaults; `list(a = 1)` / `{a = 1}` emit `MakeListAssoc` pairs; probes → 155/155 |
| **12.4** | operator registry keys, `escapeString` `\0`, label break | dispatch + safety |
| **12.5** | Lexer `.5` / brace-lists / `1...5` | **done** (item 60) — leading-dot floats; `{"a", "b"}` lists vs templates |
| **12.6** | Props `.loc/.type/.dir` (Plan 07) | **done** (item 62) — type/dir/contents/overlays runtime-resolved; tg 6,251 → 3,229 (loc stays — item 63) |
| **12.7** | `new`/New()/entity (Plan 08) | **done** (item 63) — atom loc var + New arg passthrough; entity integration pending |
| **12.8** | PLAN status rows consistency | **done** — folded into the universal linear plan (`PLAN.md`) |
| **12.9** | Parse-error class triage (3746) | **done** (item 56) — tg 197 files → 0; all four corpora parse clean (tg/tgmc/paradise/bee 0 files) |
| **12.10** | CLI output path validation | **done** (item 61) — routes through the GUI realpath check |
| **12.11** | Appearance stubs (Plan 05) | **done** (item 65) — image/sound/matrix/icon real datums + /matrix procs; stubbed 5,352 → 4,172 |

The 12.1–12.11 batches are tracked linearly as items 55–67 in `PLAN.md` (universal plan).

---

## 2. Fidelity measurement

### How we measure

1. **Semantic differential probes** — DM snippets with known BYOND behavior, converted, compiled, executed (`npm run audit:semantics`).
2. **Loss-site instrumentation** — `npm run audit:fidelity -- <repo>` walks preprocessor → parser → IR → emitter (`src/audit/fidelityAudit.ts`).
3. **Compile-proof** — `dotnet build` of generated solution vs pinned RobustToolbox (`engine.pin`, commit `9cefa116`).

Corpora (master @ 2026-07): tgstation 7,440 .dm · tgmc 2,612 · paradise 3,779 · beestation 5,195  
under `~/Documents/antigravity/ss13-audit-corpora/`.

### Latest corpus snapshot (refreshed Oct 2026 — 5 corpora incl. baystation)

| | tgstation | baystation | paradise | tgmc | beestation |
|---|---:|---:|---:|---:|---:|
| Parse errors | 14 * | **0** (was 259) | 0 | 0 | 183 * |
| Types / procs | 49,102 / 67,350 | 25,305 / 26,976 | 29,408 / 39,866 | 27,035 / 24,071 | 35,524 / 46,192 |
| Reported loss | 26,136 | 18,153 | 23,229 | 15,928 | 24,522 |
| Unresolved bare | 139 | 494 | 348 | 177 | 220 |
| Stubbed builtins | 4,209 | 3,336 | 2,510 | 2,112 | 3,606 |
| Convert exit | 0 | 0 | 0 | 0 | 0 |
| `dotnet build` | 0 errors | 0 errors | 0 errors | 0 errors | 0 errors |

\* tg + bee errors are confined to `tools/` (intentionally malformed linter fixtures
and 3rd-party libs, not game code). Bay parse was onboarded in this wave: 7 real
gaps fixed (slash-regex literals, operator-overload proc family, wrong-arity macro
expansion, expression-position `var/x = e`, brace-type-block closer consumption,
for-in bare-path loop vars, #if in continuations) → its unresolved bucket collapsed
8,960 → 494 (`to_chat` was hidden behind a parse-error file).

Compile-proof: **5/5 corpora** emit solutions that build against pinned
RobustToolbox (9cefa116) with 0 C# errors; tg + paradise + converted fixture reach
server Ready (boot-smoke PASS, spawn-bridge materializes DM atoms, DM world/New
executes). Speed: full-corpus convert on paradise = 22.2s wall (was 62.5s, B-8).

JSON history: `docs/audit/10-tgstation-audit.json`, `11-tgstation-audit-post.json`,
`12-baseline-*.json`, `docs/audit/13-baystation-audit.json`.

### Probe suite

**298/298 passing** (engine-free differential probes). Wave-4 additions: `..()` parent-of-defining (W-A), `new` loc/named/dynamic/field-init/`new /list`/arglist/`..()`-in-New (W-F), datum var seeding (W-G), W-D builtins (locate/step_to/walk/gradient/vector/icon+matrix), M2 door slice semantics (W-H). Core semantics (truthiness, lists, `..()`, short-circuit,
ranges, text, json_encode escapes, float division provenance, step-range continue)
plus builtin batches, Tier-3 (regex, astype, roll, values_*, world.view/tick_lag, …),
B-2 tick (sleep/spawn FIFO, world.time grid), B-1 loc/contents bridges, tier-4 builtins
(file2text/md5/url_*/_char family/ohearers/bounds_dist/generator), B-4 verbs/output
(<< dispatch, CallVerbAsUsr, named-arg binding) and B-3 appearance (var defaults,
overlays/underlays, animate/flick/image named args).
item-58 (default args omitted/overridden/expression, assoc identifier keys) and item-59 (labeled continue/break).

### Loss scoreboard (tgstation, honest view — post-12.1)

```
totalLossSites (12.1: false counters removed)    26,136 (tg, Oct-2026)
  heavy real buckets:
    new (partial)                 ~12,9k
    broken props (loc only)          ~3.2k (datum-level .loc now real — B-1)
    stubs                          4,209
    unresolved bare                  139
    as / set / client / verb / …    rest
```

---

## 3. Shipped fix history (condensed)

### Early pipeline audit (pre–Plan 09)

Compile breakers fixed: index get/set, zero-arg calls, keyword arg names, `rand()`.
Semantics: ranges `1..5`, brace lists, do/while, `usr`/`src` postfix, multi-Z maps,
DMI iTXt, GUI upload caps / loopback bind. Duplicate `expressionTranspiler` removed.

### Phase 0 — Real engine

Fabricated Robust.Shared shim deleted. Generated solutions reference real
RobustToolbox via `EngineDir` / `SS14_ENGINE_DIR`. `SS13.DM.Runtime` engine-free.
Probes engine-free. `scripts/setup-engine.sh`, `build-loop.sh`, `engine.pin`.

### Phase 0.5 — Semantic core

24 core probes → green: text `==`/`<`, `&&`/`||` operands, DMList, break/continue,
`..()`, world, hex text2num, etc.

### Plans 09–10

Adversarial RED/ORANGE waves: runtime value semantics, emitter control flow,
preprocessor `#if`/`#elif`/include-once, media validation, harness accounting.
Probes 24 → 129+; large builtin expansion; GLOB/GlobalVars.

### Plan 11 (200 findings) + fix wave 11.1–11.13 — **done**

Shipped: identifier sanitize, GlobalVars in production, case-insensitive IR,
JsonEscape rewrite, RSI dir remap, map chunk YAML, PNG CRC/IHDR, GUI realpath +
429, try/catch + labels emitted, bitwise ops, `CallParentProc`, parent_type IR,
float `IsInt` division, etc. Probes → **139/139**; tg loss 105k → ~54k; hostile
names + full compile-proof 0 errors.

### Tier-3 builtins (§ post-11) — **done** (`4699c83`)

regex/astype/isicon/icon_states/arctan/roll/values_*/findlasttext/regex_quote;
UI stubs → STUBBED bucket; world.* statics. Probes → **151/151**; bare calls
1,012 → **572**.

### Plan 12 re-audit — **findings done; fix wave open**

This document §1. No src changes during audit.

---

## 4. Verification commands

```bash
npm ci && npm run build && npm test
export SS14_ENGINE_DIR=../RobustToolbox   # or scripts/setup-engine.sh
npm run audit:semantics
npm run audit:fidelity -- /path/to/tgstation
npm run audit:fidelity -- /path/to/tgstation --build /tmp/cp --build-max-procs 45000
bash scripts/build-loop.sh
```

---

## 5. Known limitations (accepted / phased)

- Full arg macros / procmacro; screen/overlay/appearance (Plan 05)
- Verb → SS14 command mapping stubbed
- Live Robust.Server / Robust.Client (Plan 04) — Content.Server builds only
- Static symbol-resolution pass not in production (Plan 02)
- See `PLAN.md` for open big-ticket plans 01–08 and 12.x batches

---

## 6. Document map

| Path | Role |
|---|---|
| **`AUDIT.md`** (this file) | Sole human audit report |
| **`PLAN.md`** | **Universal plan — single linear tracker** (items 1-54 done, 55-67 open, in progression order) |
| `docs/plans/*.md` | Archived per-wave implementation detail (incl. 11/12 audit playbooks) |
| `docs/audit/*.json` | Machine baselines / corpus snapshots |
| `engine.pin` | RobustToolbox commit + API notes |
| `README.md` | User-facing summary (points here) |
