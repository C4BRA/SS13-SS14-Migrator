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
| Semantic probes | **298 / 298** (`npm run audit:semantics`) |
| Compile-proof (tgstation) | **45,183 procs → 0 C# errors** (real engine, `engine.pin`) |
| Loss sites (honest, wave-4) | tg **22,616** · paradise **21,311** (W-D/W-F/W-I waves; tgmc/bee not re-measured) |
| Stubbed procs (wave-4) | tg **773** · paradise **905** (was 3,062 / 1,915) |
| Paradise boot DM-errors | **189** lines (was **9,464** — W-I corpus playability pass) |
| Unresolved bare calls (tg) | **138** (item 67 — remainder are user procs resolved by the registry at call time) |
| Parse diagnostics | **tg 0 · tgmc 0 · paradise 0 · bee 0** (item 56 — all four corpora parse clean) |
| Open fix wave | **none — all 67 PLAN.md items complete** |

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

### 1.6 Review — W-M / W-N wave (#30, #32, #33), 2026-10-11

Code review of the three PRs merged on 2026-10-11. Findings only: nothing
below has been fixed. Line numbers are at `410d0c3`.

| ID | Sev | PR | Finding | Where | Suggested fix |
|---|---|---|---|---|---|
| R1 | 🟠 | #30 | `?…;verb=x` hrefs call **any** proc, not just verbs, on **any** datum named by `src=` (ref, `/type/path` or entity id). `dmpanel` also lists every proc on the mob (`EnumerateProcs`) as a clickable verb. If a player puts a link in text that ends up in a `browse()` page (for example paper contents), whoever clicks it calls that proc. | `dmRuntimeCS.ts:6694` `RouteHref`; `csharpEmitter.ts:1817` | Allow `verb=` only for procs declared as verbs (the parser already records them, item 34), and resolve `src=` only to datums the page itself registered. |
| R2 | 🟠 | #30 | `ResolveTopicSrc` matches by substring in both directions (`kv.Value.Contains(v)`). A numeric `src=1` matches `REF[0x1]`, `REF[0x10]` and so on, so the entity-id branch is never reached when the digit appears in any ref. | `dmRuntimeCS.ts:6744` | Match the ref string exactly, then try a type path, then an entity id. |
| R3 | 🟠 | #30 | `DMUiRuntime.Answer` skips the owner check when the answering session has no DM mob (`usr == null`). Prompt ids are sequential, so a session in the lobby can answer another player's `input()`/`alert()`. | `dmRuntimeCS.ts:6503` | Reject the answer when `usr == null` and the prompt has an owner. |
| R4 | 🟡 | #30 | A bare `input()`, `alert()` or `browse()` is routed to the UI bridge before user procs are resolved. A type that defines its own `proc/browse()` and calls it bare gets the bridge instead. | `csharpEmitter.ts:2883` | Check `symbols.resolveBareProc(currentTypePath, name)` first, then confirm BYOND's precedence with a probe. |
| R5 | 🟡 | #30 | An answered prompt resumes its DM proc inside the `dmanswer` command handler (TaskCompletionSource continuation), outside `DMTickScheduler.PumpGate`. On a live server this is the same thread, so there's no race, but DM code runs in the middle of a command instead of on a tick. `dmverb` behaves the same way today. | `dmRuntimeCS.ts:1580` | Resume through `DMTickScheduler.SpawnExpr(0, …)` so it lands on the next pump. |
| R6 | 🟡 | #33 | `typeDeclaresVar` walks `computeParentPath` (the path prefix) instead of the IR's `parentPath`, so it ignores `parent_type` reparenting (WS4-3). It can then disagree with the IR about whether a name is a field or a global. | `csharpEmitter.ts:2596` | Walk `irType.parentPath`. |
| R7 | 🟡 | #33 | A comment and docs/plans/34 say the IR drops bare `var/x` decls, so a bare field that collides with a global resolves to the global. That's wrong: bare decls are in `customVars` with a `null` value (verified), so the field correctly wins. | `csharpEmitter.ts:2607`, `docs/plans/34-round-flow.md` | Correct the comment and the doc. |
| R8 | 🟡 | #33 | Locals and globals are matched case-insensitively (`toLowerCase`), but DM var names are case-sensitive, so a local `Foo` hides a global `foo`. | `csharpEmitter.ts` `isBareGlobalName`, `collectProcLocals` | Compare names as written. |
| R9 | 🟡 | #33 | Subsystem `Initialize()` runs at construction, in construction order, with no `timeofday` argument. BYOND's MC sorts by `init_order` and calls `Initialize(REALTIMEOFDAY)`, so on real corpora subsystems that depend on each other (jobs before ticker) can initialize in the wrong order. | `csharpEmitter.ts:1005` | Collect the subsystems, sort by `init_order` (descending, as the MC does), then call `Initialize` with a time argument. |
| R10 | 🟡 | #33 | The `subtypesof` builtin rebuilds the whole type set and walks every type's ancestor chain on every call. With 46k types on tg, and many calls during init, that's slow. | `dmRuntimeCS.ts:1013` | Cache results per path; layouts are fixed after `RegisterProcs`. |
| R11 | 🟡 | #33 | The join flow depends on `/world/proc/on_player_join`, a hook that neither BYOND nor Paradise defines; only the test fixture provides it (marked shim). On a real converted corpus, joining never reaches job assignment or spawn. The PR and docs/plans/34 describe this as running "on converted paradise". | `csharpEmitter.ts:1177`, `tests/m2-round/code/m2r.dm:112` | Either generate the hook from the corpus's real login path (`/mob/new_player` → `AttemptLateSpawn`), or say clearly that it's fixture-only. |
| R12 | ❓ | #33 (and #26) | `tests/m2-round/code/paradise_*.dm` (about 1,075 lines) and `tests/m2-slice/code/paradise_*.dm` are verbatim Paradise code, which is AGPL-3.0. They sit in this MIT repo with no license notice. | `tests/m2-round/code/`, `tests/m2-slice/code/` | **Owner decision:** add an AGPL notice and license file for those folders, or replace them with original fixtures. |

#32 (keybinds `type: Function` → `State` + `canFocus`) is correct: at the pinned engine, `KeyBindingType` is `Unknown`/`State`/`Toggle`/`Command` (`Robust.Client/Input/InputManager.cs:952`).

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
