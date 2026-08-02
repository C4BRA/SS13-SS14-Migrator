# dm2ss14 — Audit (single source of truth)

**Last updated:** 2026-08-02 · **HEAD baseline:** `4699c83` (Tier-3 builtins) + Plan 12 re-audit  
**Severity:** 🔴 Critical · 🟠 High (silent wrong) · 🟡 Medium · 🟢 Fixed / low  

This file replaces the former split of `AUDIT.md`, `FIDELITY-AUDIT.md`,
`docs/audit/11-findings.md`, and `docs/audit/12-findings.md`. Machine-readable
corpus snapshots remain under `docs/audit/*.json`. Implementation plans stay in
`docs/plans/`.

---

## 0. Current status (read this first)

| Gate | Result |
|---|---|
| `npm run build` | clean (tsc strict) |
| `npm test` | green; generated solution builds vs real RobustToolbox |
| Semantic probes | **151 / 151** (`npm run audit:semantics`) |
| Compile-proof (tgstation) | **45,183 procs → 0 C# errors** (real engine, `engine.pin`) |
| Reported loss sites | tg **54,160** · tgmc **26,928** · paradise **39,362** · bee **45,043** |
| Corrected loss (approx) | tg **~30,020** after removing ~24k harness-false sites |
| Unresolved bare calls (tg) | **572** |
| Parse diagnostics (tg) | **3,746** errors (needs class triage — §2) |
| Open fix wave | **Plan 12.1–12.11** (not started) |

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

#### 🔴 Harness overstates loss by ~24k (tgstation)

`src/audit/fidelityAudit.ts` `totalLossSites` still charges ops the pipeline handles:

| Counter | tg count | Reality |
|---|---:|---|
| `numParentCall` (`..()`) | **23,040** | emits `await comp.CallParentProc(...)` |
| `numUnaryTilde` | **1,048** | emits `DMValue.BitwiseNot(...)` |
| `numTry` / `numLabeledBlock` | 17 / 32 | try/catch emitted; label body kept |
| `numParentTypeDecls` | 3 | IR sets `parentPath` from `parent_type` |

`numNew` label still says “returns caller as placeholder”; emission is
`await DMNew(comp, path)` (fresh datum). Residual: no full `New()`/loc/entity.

**Corrected ballpark:** 54,160 − 24,140 ≈ **30,020**.

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

#### 🔴 Parse-error count unexplained

Measured **3,746** tgstation parse errors vs older docs (~170). Counter is real
`collector.errors.length`. Types still parse at scale (46,995 types / 64,794 procs).
Needs class triage before treating as fidelity collapse.

### 1.2 Residual product loss (real, after harness correction)

| Class | tgstation | Notes |
|---|---:|---|
| Partial `new /type` | 12,872 | fresh datum; New()/loc/entity incomplete |
| Broken prop reads | 6,251 | `.loc` 3070 · `.type` 2021 · `.dir` 589 · `.contents` 449 · `.overlays` 122 |
| Stubbed builtins | 5,352 | animate/sound/image/winset/… → Null (honest) |
| Unresolved bare calls | 572 | span_*, unit_test helpers, filter, winget, oviewers, stack_trace… |
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

**WS7 Builtins** — 🔴 case fold · 🟠 572 bare · 🟡 MAPPED=133 STUBBED=21  

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
| **12.1** | Harness truth (drop false counters/labels) | −24k fake loss; restore trust |
| **12.2** | Builtin case-fold + top bare calls | stop silent Null on `Pick`/`crash` |
| **12.3** | Default args + assoc identifier keys | correctness |
| **12.4** | operator registry keys, `escapeString` `\0`, label break | dispatch + safety |
| **12.5** | Lexer `.5` / brace-lists / `1...5` | parse fidelity |
| **12.6** | Props `.loc/.type/.dir` (Plan 07) | −6k sites |
| **12.7** | `new`/New()/entity (Plan 08) | −12k semantic hole |
| **12.8** | PLAN status rows consistency | **done** — folded into the universal linear plan (`PLAN.md`) |
| **12.9** | Parse-error class triage (3746) | explain noise vs real |
| **12.10** | CLI output path validation | security parity w/ GUI |
| **12.11** | Appearance stubs / live-server prep (05/04) | product |

The 12.1–12.11 batches are tracked linearly as items 55–67 in `PLAN.md` (universal plan).

---

## 2. Fidelity measurement

### How we measure

1. **Semantic differential probes** — DM snippets with known BYOND behavior, converted, compiled, executed (`npm run audit:semantics`).
2. **Loss-site instrumentation** — `npm run audit:fidelity -- <repo>` walks preprocessor → parser → IR → emitter (`src/audit/fidelityAudit.ts`).
3. **Compile-proof** — `dotnet build` of generated solution vs pinned RobustToolbox (`engine.pin`, commit `9cefa116`).

Corpora (master @ 2026-07): tgstation 7,440 .dm · tgmc 2,612 · paradise 3,779 · beestation 5,195  
under `~/Documents/antigravity/ss13-audit-corpora/`.

### Latest corpus snapshot (Plan 12)

| | tgstation | tgmc | paradise | beestation |
|---|---:|---:|---:|---:|
| Parse errors | 3,746 | 1,249 | 10,306 | 2,339 |
| Types / procs | 46,995 / 64,794 | 26,853 / 23,519 | 28,849 / 38,763 | 34,803 / 44,822 |
| Reported loss | **54,160** | **26,928** | **39,362** | **45,043** |
| Unresolved bare | 572 | 328 | 552 | 468 |
| Stubbed builtins | 5,352 | 2,939 | 3,584 | 4,564 |

JSON history: `docs/audit/10-tgstation-audit.json`, `11-tgstation-audit-post.json`,
`12-baseline-*.json`.

### Probe suite

**151/151 passing.** Core semantics (truthiness, lists, `..()`, short-circuit,
ranges, text, json_encode escapes, float division provenance, step-range continue)
plus builtin batches and Tier-3 (regex, astype, roll, values_*, world.view/tick_lag, …).

### Loss scoreboard (tgstation, honest view)

```
reported totalLossSites          54,160
  − false ..()                   −23,040
  − false unary ~                 −1,048
  − false try/label/parent_type      −52
≈ corrected                      ~30,020
  heavy real buckets:
    new (partial)                 12,872
    broken props                   6,251
    stubs                          5,352
    unresolved bare                  572
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
