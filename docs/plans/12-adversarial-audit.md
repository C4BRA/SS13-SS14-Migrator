# Plan 12 — Full Agentic Adversarial Re-Audit (post Plan-11 fix wave)

Status: **planned, not executed** · ~16 parallel agent workstreams · findings-only
Target artifacts: `docs/audit/12-findings.md`, `docs/audit/12-baseline-{before,after}.json`
Predecessor: Plan 11 (`docs/plans/11-adversarial-audit.md`, 200 findings, fix wave
11.1–11.13 shipped) — probes **139/139**, tgstation loss sites **54,457**, full-scale
45,183-proc real-engine compile **0 C# errors** (`FIDELITY-AUDIT.md` §3j).

Mode: **findings report only** — no `src/` edits during the audit. Every finding is
proven with evidence (repro + observed vs expected) and ranked for a future fix wave
(Plan 12.x batches).

Verification depth: **full** — semantic differential probes under dotnet 10, real-engine
compile-proof against pinned RobustToolbox (`engine.pin`), 4-corpus sweeps
(tgstation / tgmc / paradise / beestation under
`~/Documents/antigravity/ss13-audit-corpora/`), hostile corpora, grammar-aware fuzzing,
security attack harness, and harness-integrity checks ("audit the auditor").

---

## 0. Why a second full audit (not just "run Plan 11 again")

Plan 11 was a pre-fix-wave audit. The 11.1–11.13 wave rewrote large surfaces
(emitter identifier sanitization, GlobalVars wiring, `DMValue.IsInt` provenance, PNG
CRC/IHDR, RSI dir remap, map chunk YAML, GUI realpath, IR case-folding, ~20 builtin
semantics). A re-audit must:

1. **Regression-lock** every Plan-11 RED/ORANGE claim (confirm fixed, not merely
   claimed fixed; catch incomplete or incorrect fixes).
2. **Hunt fix-induced regressions** — new silent wrong behavior introduced by the wave
   (classic example from Plan 11 itself: Plan-10 Divide rework broke `7.0/2`).
3. **Attack residual loss** that Plans 01–08 still track as open (symbol resolution,
   appearance, `new /type`, remaining bare calls, live-server gap).
4. **Go deeper** on surfaces Plan 11 under-covered or that only became reachable after
   fixes unblocked them (e.g. GlobalVars now live → initializer order bugs matter;
   bitwise now emitted → signedness/overflow matters).
5. **Scale verification** beyond the 1,500-proc spot checks used mid-wave: full 45k
   compile-proof + 4-corpus loss re-baseline + probe suite growth for every confirmed
   residual.

This is not a code-reading pass. It is an **agentic adversarial campaign**: parallel
specialist agents, shared attack infrastructure, synthesis + cross-verification, then
a ranked fix-wave input.

---

## 1. Objectives

1. Cover **every module** of the pipeline end-to-end:
   ```
   preprocessor → lexer → parser → IR/symbols → emitter → YAML
        ↘ runtime (embedded C#) ↘ builtins
        ↘ DMI/PNG/RSI ↘ DMM/maps
        ↘ GUI/CLI/project template
        ↘ audit harness + probe suite + test runner  ("audit the auditor")
   ```
2. Use **adversarial technique, not just reading**: differential probes vs BYOND ground
   truth, corpus sweeps with error-class triage, hostile compile-proof, grammar-aware
   fuzzing, round-trips, pathological inputs, HTTP attack harness, mutation of fix-wave
   patches.
3. **Triage every Plan-11 finding** (200 rows) into: still-broken / fixed-and-locked /
   fixed-but-incomplete / fixed-but-wrong / no-longer-applicable.
4. Produce a ranked findings report (`docs/audit/12-findings.md`) that is the sole
   input to fix batches 12.1+.
5. Leave the repo **untouched** (evidence only in `$TMPDIR`); prove via before/after
   baselines.

---

## 2. Ground truth & severity

**Ground truth hierarchy** (a claim is only valid against the highest applicable tier):

1. BYOND reference docs (`byond.com/docs/ref`) — authoritative for semantics.
2. Real corpus behavior (4 pinned corpora) — authoritative for frequency/impact.
3. Converted-runtime behavior — never assumed correct.
4. Plan-11 findings + fix-wave claims — hypotheses to re-prove, not facts.

**Severity** (repo convention):

| Sev | Meaning |
|---|---|
| 🔴 Critical | generated output broken / core semantics destroyed / exploitable security |
| 🟠 High | silent wrong behavior (compiles, wrong result, no diagnostic) |
| 🟡 Medium | corner cases, degraded fidelity, harness miscounts |
| 🟢 Low | cosmetic, docs, dead code, tooling hygiene |

**Finding template** (every workstream, every finding):

```
ID: 12-<ws>-<n>        Sev: 🔴/🟠/🟡/🟢
Module: <file(s)>
Claim: <one sentence, falsifiable>
Plan-11 link: <11-ws-n | NEW | REGRESSION-OF-11.x>
Evidence: <repro → observed vs expected, file:line>
Impact: <corpus frequency if measurable; compile/runtime/security>
Fix suggestion: <for Plan 12.x>
Test-lock suggestion: <probe or regression that would lock the fix>
```

---

## 3. Current known surface (seed, not ceiling)

These are starting hypotheses from post-11 state. Agents must confirm/refute and
discover beyond them.

### 3a. Headline metrics to re-baseline

| Metric | Claimed post-11 | Plan-12 action |
|---|---|---|
| Semantic probes | 139/139 | re-run; expand suite for residual classes |
| tgstation loss sites | 54,457 | full 4-corpus re-run → new baseline |
| unresolved bare calls (tg) | 1,012 | triage top names; macro vs real |
| parse errors (tg) | 170 | class triage + silent-misparse hunt |
| compile-proof | 45,183 procs, 0 CS errors | full re-run + hostile-name corpus |
| Open plans | 01, 02, 03?, 04, 05, 06, 07, 08 | residual loss attack streams |

Note: PLAN.md still lists 03-bitwise / 07-props / 08-new-type as "not started" even
though 11.x claimed partial landing — **status drift is itself a harness finding**.

### 3b. Residual product gaps (Plans 01–08)

| Gap | Approx impact | Attack angle |
|---|---|---|
| Bare global / unknown builtins (~1k tg) | silent Null | top-N name frequency → BYOND vs stub vs missing |
| Symbol resolution absent | wrong target / Null | resolve order vs runtime registry divergence |
| `new /type(...)` | identity/args | Plan 08 backlog + IR/runtime path |
| Appearance / overlays / animate | thousands of sites | stub-return honesty + diagnostic |
| Live server (Robust.Server/Client) | whole verification gap | out-of-scope confirm + document boundary |
| `parent_type` / type identity edge cases | IR wrong parents | case-fold + parent_type residual |
| Verb → command mapping | stubbed | confirm still stub + no false claims |

### 3c. Fix-wave regression hotspots (priority seed)

Places where 11.x *changed* behavior and is most likely to have new bugs:

1. **Emitter sanitization** (`csharpEmitter` path/name mangling) — over-sanitize →
   collisions; under-sanitize → residual CS errors on new patterns.
2. **`DMValue.IsInt` provenance** — float literals, coercion chains, `round`/`%`/`/`.
3. **Bitwise + `<<` shift-vs-output disambiguation** — wrong branch on edge exprs.
4. **GlobalVars production wiring** — init order, assoc sets, case-insensitive Get/Set.
5. **try/catch + labels now emitted** — empty catch, label collision, break-to-label.
6. **PNG CRC + IHDR** — false rejects of valid DMI; CRC on wrong chunk range.
7. **RSI `[0,2,1,3]` remap** — 1-dir / 8-dir / multi-frame interactions.
8. **Map chunk list-item YAML** — indent edge cases; multi-Z; empty grids.
9. **GUI realpath + 429 single-flight** — TOCTOU, concurrent cleanup, zip edge.
10. **IR lowercasing** — locale / non-ASCII path segments; collision with distinct types
    that only differ by case *intentionally* (should not exist in DM, verify).
11. **JsonEscape rewrite** — surrogate pairs, U+2028/U+2029, control chars beyond
    classic set.
12. **Preprocessor work budget** — legitimate deep macros truncated; wrong branch.

---

## 4. Workstreams (16 parallel agent tasks)

Each workstream: **scope + attack playbook + pre-seeded suspects + deliverables**.
Cap ~25 highest-value findings per WS. Evidence in `$TMPDIR/dm2ss14-audit12/wsN/`.

### Wave A — Parser stack (parallel)

#### WS1 — Lexer regression + residual (`src/parser/dmLexer.ts`)

Playbook:
- Re-prove Plan-11 lexer REDs fixed: nested block comments, quote-aware interp,
  text macros (`\improper`/`\the`/…), `\xHH`/`\uHHHH`.
- Residual attacks: `1...5`, `1.`, `.5`, `1.#INF`/`1.#IND`, `0x`/`0b` empty, `{"a","b"}`
  brace-list vs template, `@…@` / `@@…@` unterminated, tabs-vs-spaces indent stack,
  `/`+alpha TypePath vs division reconstruction handoff, `#` line-swallow fallback,
  BOM/CRLF/mixed, NUL, 10 MB line, 50k nest.
- Determinism: tokenize twice → identical stream.
- Fuzz: 2,000 mutated tokens from corpus lines; invariant = no hang/crash.

Deliverables: triage table for Plan-11 WS1 findings; residual findings; fuzz summary.

#### WS2 — Parser residual (`src/parser/dmParser.ts`)

Playbook:
- Precedence table vs BYOND for every op post-11 (`in` lowest, division postfix,
  ternary vs `:`-dynamic-access, `..` range, `**`, `::`).
- Silent drops still present: default args, `as` return types, `in`-clause args,
  array-length exprs, `set` statements, path assignments, FileLiteral kind,
  `assoc_pair` identifier keys, `pick(a;b)` weights.
- Error recovery: 24+ `matchPunctuation` sites — find swallowed following statements.
- Child-type blocks / top-level `var/x` / initializer depth clamp (11.1 claims).
- `for` head forms, switch case forms, single-line bodies ending at TypePath.
- Token splice mutation / parse-twice determinism.
- Corpus: sample 50 of the 170 tgstation parse errors → minimal repro each class.

Deliverables: precedence appendix; silent-drop with downstream trace; parse-error class
repros.

#### WS3 — Preprocessor residual (`src/preprocessor.ts`)

Playbook:
- Re-verify: `#if` numeric/relational, `#elif`, `#error`, include-once, string-aware
  `//` strip, multi-line defines, named variadics, `##`/`...` string-awareness,
  interp-macro expansion (Plan 10 root cause of ~2,400 bare calls).
- Residual: seed-pass context-blind defines (comments / inactive `#if` / after
  `#undef`), first-wins across files, include path resolution depth, non-`.dm`
  includes, recursive include policy, `blockCommentState` shared across includes,
  line-number drift after joins, `{"…"}` template lines starting `#`, work-budget
  false truncation of legal macros, define-after-include order.
- Corpus: re-count `numIfNumeric` / define-truncation / include-once effects;
  grep top remaining macro-shaped bare calls.

Deliverables: confirmed residual REDs with corpus frequency; macro expansion hang bound
proof.

#### WS4 — IR + SymbolTable (`src/ir/*`)

Playbook:
- Case-insensitive identity (11.13): `/OBJ/x` ≡ `/obj/x`; collision with intentionally
  distinct paths; YAML id + registry consistency.
- `parent_type` honored end-to-end (decl → IR parent → emitter registry walk →
  `..()` / `istype`).
- `normalizeValue` TRUE/yes/numbers; `customVars` untracked shapes → YAML.
- Cross-file type-split merge; DFS parent-first synthesis; trailing-slash.
- Static vs dynamic classification wrong → missing `DMRuntime` or unnecessary.
- SymbolTable vs runtime registry resolve-order divergence (Plan 02 gap).
- Synthesized parents (`/atom/movable`) id collisions.

Deliverables: IR invariant list (tested vs untested); residual type-identity findings.

### Wave B — Emit / runtime / builtins (parallel)

#### WS5 — Emitter (`src/transpiler/csharpEmitter.ts`)

Playbook:
- **Hostile-name corpus v2**: operator procs, dot-paths, case-colliding procs,
  empty/digit-only names, C# keywords as proc/var names, unicode (if lexer admits),
  very long names, `#define`-injected quotes into identifiers → `dotnet build` collect
  every CS####.
- Sanitizer collision hunt: two distinct DM names → one C# symbol (CS0111 silent merge
  of different procs = 🔴 semantic).
- Control flow: try/catch emission correctness; labeled blocks; switch `while(true)`;
  `break`/`continue` outside loops; spawn lambda return/break; step-range continue
  labels (was infinite loop).
- Bitwise emission + `<<` shift vs output; `%%`; `as` cast; unknown op → Null.
- GlobalVars production path from `index.ts`; initializer expr kinds; named arglist
  param registration.
- `escapeString` residual (`\0`, other controls); `initial` 2-arg escape.
- Golden-string drift: re-run `csharpEmitter.test.ts` expectations against hostile
  inputs not in suite.

Deliverables: CS-error class table; sanitizer-collision proofs; control-flow matrix.

#### WS6 — YAML (`src/transpiler/yamlGenerator.ts`)

Playbook:
- Round-trip: emit → parse with YamlDotNet (throwaway) + a JS YAML parser; report
  mismatches for yes/no/on/off/null/~ / numbers / hex / backslashes / unicode.
- `pathToId` collision residual after 11.8 dedupe; parent-link through lossy transform.
- `.dmi→.rsi` case-insensitive claim; missing icon fallback honesty.
- Parent mapping ambiguity (`/datum`/`/atom` → BaseItem); synthesized types as protos.
- `shape.type` survival; `name`/`description` quoting; array items through scalar path.
- Fixture: generate YAML from a mini hostile type set; load shape in isolation.

Deliverables: deserializer mismatch table; collision residual list.

#### WS7 — Builtin mappings (`src/transpiler/builtinMappings.ts`)

Playbook:
- Full 112+ name table vs BYOND ref: arity, arg order, case-insensitivity
  (`crash`/`Pick`/`replacetextex`).
- Stub set honesty: `animate`/`image`/`flick`/`sound`/`matrix`/`browse`/`call_ext`/
  appearance-adjacent — return value + harness loss count (must be counted as loss).
- `is*` path strings vs BYOND base paths.
- Remaining unresolved bare-call top-50 on tgstation: classify
  macro-miss / real-missing / stub / intentional-null.
- Spawn-as-expression residual.

Deliverables: per-builtin verdict table; top-50 bare-call triage.

#### WS8 — Runtime core (`src/runtimeTemplate/dmRuntimeCS.ts` value/list/call)

Playbook (each divergence → differential probe in `$TMPDIR`):
- `Divide`/`Modulo`/`IsInt` matrix: int×int, float×int, `7.0/2`, `7/2.0`, negatives,
  div-by-zero (throws?), near-2^53.
- `EqualsValue` / truthiness / `Compare` (text case rules post-11), null rules.
- `Add`/list concat / `"a"+list` / assoc preservation.
- `DMList`: 1-based, negative index, OOR Set, COW cost, Count vs PositionalCount,
  assoc Get/Set, `L += x` content.
- `CallProc` / `..()` / registry case-insensitivity / named args via arglist.
- `GlobalVars` init order, forward refs, assoc keys.
- `DMNew` identity + args; `DMDelete`.
- Unicode code-point path residual on list string iteration.
- Culture invariance of number formatting under non-en_US locale (run probes with
  `LANG=tr_TR.UTF-8` / `LC_ALL=de_DE.UTF-8`).

Deliverables: probe results table; locale-sensitivity results.

#### WS9 — Runtime builtins assembly (same file, builtin half + template integrity)

Playbook:
- `JsonEscape` exhaustive: `" \ / \b \f \n \r \t`, controls 0x00–0x1F, U+2028/U+2029,
  surrogates, non-BMP → validate with `System.Text.Json` + `JSON.parse`.
- `text()` format residual (`[]`, `[#x]`, width).
- `typesof` var-only types claim; `world.xmax/ymax` bounds.
- File ops exception swallowing; `fcopy_rsc`; fake `ref`/`refcount`.
- RustG stubs honesty.
- Template integrity: zero unescaped `${` in backticks; pin file count; backtick balance
  (`runtimeTemplate.test.ts`).
- `Rand`/`Pick`/`DMProb` RNG quality (per-call `new Random()` residual?).
- `rgb` clamp; `round` half-down; `num2text` sigfigs; `findtext` end exclusive;
  `replacetext` case-preserving; `step_away` Max=5; `rand(N)` 0..N.

Deliverables: JSON validity matrix; builtin residual list; template integrity proof.

### Wave C — Media / maps / shell / harness / product gaps (parallel)

#### WS10 — DMI / PNG / RSI (`src/dmi/*`)

Playbook:
- Re-prove: CRC rejects corrupt; IHDR sanity; bitDepth<8; BEGIN-DMI independent chunks;
  dirs/delay validation; 4-dir N/E remap `[0,2,1,3]` with color-row proof.
- Residual: interlaced PNG; colorTypes 1/5; 16-bit; palette OOR; dirs=8; state-name
  sanitize collisions; sheet undersized; decode-failure warning path; delay units
  (deciseconds vs seconds); multi-frame multi-dir delay slicing; encode→decode
  round-trip own output.
- Hostile PNG corpus (1 KB bombs, bad CRC, lying lengths) — must throw, not hang/OOM
  (30s timeout each).
- SS14 meta.json format-2 shape check.

Deliverables: PNG variant matrix; RSI direction proof images; hang/OOM results.

#### WS11 — DMM / maps (`src/dmm/*`)

Playbook:
- Re-prove: chunk tiles as list items under chunk key; real SS14 turf protos;
  quote-aware attrs; longest-match keys; space rows; multi-Z grids.
- Residual: `//`/`#` continuation drops; `)` in comments; mixed key lengths;
  header whitespace; attr `}`/`;`/`=`; non-rectangular; orphan keys; y-flip;
  duplicate `lx,ly`; tilemap last-segment collisions; attributes dropped.
- Invariant: sum of chunk tile entries == rectangular grid cell count.
- Round-trip emit → YAML parse → count.

Deliverables: chunk-count invariant results; residual map findings.

#### WS12 — GUI / CLI / pipeline / security (`src/gui/server.ts`, `cli.ts`, `index.ts`,
`project/ss14Template.ts`, `diagnostics.ts`)

Threat model: local attacker able to reach loopback; CSRF token is not an auth boundary.

Playbook:
- Re-prove: realpath + `~` expansion blocks symlink escape; 429 single-flight is real
  (two concurrent conversions → one 429); sanitized 500s; post-extract zip-bomb bound;
  `mkdtemp`; array-form spawn; EADDRINUSE graceful.
- Residual attack harness (raw sockets):
  - multipart boundary-in-binary, missing boundary, partial body, oversized headers
  - forged zip sizes, duplicate entries, zip-slip variants, symlink entries
  - `Origin: null` / absent / evil; `Host` trailing-dot / IPv6
  - outputPath: `..`, `%2e%2e`, unicode dots, trailing spaces, NTFS ADS-style, `~user`
  - concurrent cleanup races (conversion A fails while B starts)
- CLI: unvalidated `outputDir`, missing `--help`/unknown flags, path traversal via
  `--output`.
- Pipeline: partial output on diagnostic throw; `findFiles` symlink-dir follow vs audit
  walk divergence; broken symlink skip.
- `ss14Template` inertness (constants only).
- Hygiene: stale `dist/` after source deletes; `temp_test_dmi.png` residual.

Deliverables: attack scripts in `$TMPDIR`; confirmed residual vulns with severity.

#### WS13 — Harness integrity (`src/audit/fidelityAudit.ts`, `tests/*`)

Playbook:
- Counter arithmetic on tiny fixtures: every term in `totalLossSites` proven
  include/exclude; stub-builtin bucket; BROKEN_PROP split; parent_type; comment-aware
  GLOB; nested-Map JSON export.
- Probe veracity: every probe tests its claim; exact-string verdicts; no false greens.
- PLAN.md / README / FIDELITY-AUDIT status drift (03/07/08 "not started" vs 11.x claims).
- Sampling bias of `--build-max-procs` (first-N vs uniform).
- `runTests` abort-on-first; coverage gaps (`cli.ts` 0 tests, GUI multipart, pngCodec
  error paths, `runBuildProof` manual-only).
- Audit determinism: run baselines twice → identical JSON (modulo timestamps).
- Dotnet-missing skip branch reachable and honest.

Deliverables: counter-correction proofs; probe-veracity table; coverage-gap list;
doc-drift findings.

#### WS14 — Residual product gaps (Plans 01, 02, 05, 08) — NEW

Not a pure module audit — a **loss-class campaign** across the stack:

- **Builtins residual (Plan 01)**: top unresolved names across 4 corpora; propose
  map-vs-stub-vs-ignore with impact.
- **Symbol resolution (Plan 02)**: build a static resolve pass over IR for one corpus
  slice; measure wrong-target / missing-target rates vs runtime Null.
- **Appearance (Plan 05)**: inventory all appearance-touching constructs; confirm stub
  returns + whether harness counts them; document Phase-3 boundary.
- **`new /type` (Plan 08)**: identity, args, type path edge cases, `new loc`,
  `new typepath(arg)` through emitter+runtime probes.
- Output: a loss-class scoreboard that becomes Plan 12 fix-batch grouping alternate
  to pure module batches.

#### WS15 — Live-engine boundary (Plan 04) — NEW

Playbook (findings + boundary, not implementation):
- What the generated solution can do today vs what a live Robust.Server needs
  (EntitySystem adapter surface, prototype load, map load, client RSI).
- Attempt minimal `dotnet` load of generated Content.Server against real engine
  (not full server run if blocked) — record exact API/missing-piece failures.
- Confirm out-of-scope claims in README/PLAN are still accurate (no false "works").
- Deliverable: honest Phase-3 gap list with file:line of current adapter limits.

#### WS16 — Cross-cutting adversarial infrastructure (shared)

Owns shared attack assets used by all WS:

1. **Differential probe harness** — clone of probe pattern in `$TMPDIR`; batch runner;
   locale variants.
2. **Hostile DM corpus generator** — legal pathological names, deep nesting, mixed
   encodings, macro bombs (budget-bounded).
3. **Grammar-aware fuzzer** — 2,000 inputs/module, 30s timeout, invariants:
   no crash, no hang, diagnostics-not-death, determinism.
4. **4-corpus sweep driver** — `npm run audit:fidelity` ×4; parse-error class export;
   delta vs `docs/audit/11-tgstation-audit-post.json`.
5. **Compile-proof driver** — full 45k + hostile-name injection; serialize builds
   (`-m:1 -nodeReuse:false --disable-build-servers`), 30 min SIGKILL.
6. **HTTP attack scripts** — raw socket suite for WS12.
7. **Round-trip helpers** — YamlDotNet script, PNG round-trip, RSI meta schema check.

Deliverables: tooling under `$TMPDIR/dm2ss14-audit12/infra/`; no committed src unless
a harness bug is found (then it's a WS13 finding, still no fix during audit).

---

## 5. Cross-cutting techniques (required)

| # | Technique | Owner | Success criterion |
|---|---|---|---|
| 1 | Differential probes vs BYOND | WS8/9 + all semantic WSes | every 🔴/🟠 semantic claim has probe |
| 2 | 4-corpus fidelity sweeps | WS16 + WS13 | baselines committed; deltas explained |
| 3 | Full + hostile compile-proof | WS5 + WS16 | 0 unexpected CS classes; residual listed |
| 4 | Grammar-aware fuzz | WS1–3, WS16 | 0 hangs/crashes or hang=finding |
| 5 | Round-trips (YAML/C#/PNG/RSI/DMM) | WS6/10/11 | mismatches = findings |
| 6 | Pathological inputs | all | bounds held (time/memory) |
| 7 | HTTP attack harness | WS12 | each vector scripted + result |
| 8 | Plan-11 finding re-triage | all WS | 200/200 dispositioned |
| 9 | Fix-wave mutation testing | WS5/8/10 | "break the sanitizer" attempts |
| 10 | Locale / culture stress | WS8/9 | probes under tr_TR + de_DE |
| 11 | Harness self-audit | WS13 | counters proven on fixtures |
| 12 | Doc/claim drift audit | WS13/15 | README/PLAN/FIDELITY consistent |

---

## 6. Agentic orchestration

```
                    ┌─────────────────────────────┐
                    │  Orchestrator (this plan)   │
                    │  baselines · merge · rank   │
                    └─────────────┬───────────────┘
                                  │
        ┌─────────────────────────┼─────────────────────────┐
        ▼                         ▼                         ▼
   Wave A (//)               Wave B (//)               Wave C (//)
   WS1 Lexer                 WS5 Emitter               WS10 Media
   WS2 Parser                WS6 YAML                  WS11 Maps
   WS3 Preprocessor          WS7 Builtins              WS12 Security
   WS4 IR/Symbols            WS8 Runtime core          WS13 Harness
                             WS9 Runtime builtins      WS14 Loss-classes
                                                       WS15 Live-engine
                       WS16 Infra (shared, starts first)
                                  │
                                  ▼
                    ┌─────────────────────────────┐
                    │ Synthesis agent             │
                    │ dedupe · cross-verify 🔴/🟠 │
                    │ severity · fix-batch ids    │
                    │ 12-findings.md              │
                    └─────────────┬───────────────┘
                                  ▼
                    ┌─────────────────────────────┐
                    │ Verification agent          │
                    │ baselines after == before   │
                    │ any delta = finding         │
                    └─────────────────────────────┘
```

**Rules for agents**
- Findings-only: no edits under `src/`, `scripts/`, `package.json`. Evidence in
  `$TMPDIR/dm2ss14-audit12/` only.
- Every finding uses the template (§2). Cap ~25/WS; quality over volume.
- Re-use Plan-11 IDs when re-triaging (`Plan-11 link:` field).
- Dotnet builds serialized machine-wide; never parallel `dotnet build` of large corpora.
- Before any audit script: `rm -rf dist && npm run build`.
- Prefer Task/subagent parallelism matching Waves A/B/C; WS16 infra boots first.
- Cross-verify: each 🔴/🟠 must be re-checked by synthesis or a second WS before final
  inclusion.

**Execution order**
1. Capture baseline-before (build, test, semantics, 4-corpus, compile-proof sample).
2. Start WS16 infra scaffolding.
3. Launch Wave A (4 agents).
4. Launch Wave B (5 agents) as A results stream in (emitter benefits from parser REDs).
5. Launch Wave C (6 agents) overlapping B; corpus sweeps early for long tail.
6. Synthesis → `docs/audit/12-findings.md`.
7. Baseline-after; assert equality; write `12-baseline-*.json`.
8. Append summary stubs to `AUDIT.md` / `FIDELITY-AUDIT.md` only after acceptance
   (still no src fixes).

---

## 7. Baselines (capture before AND after)

| Metric | How | Expected band (post-11) |
|---|---|---|
| `npm run build` | tsc strict | clean |
| `npm test` | full suite | green (engine step needs `SS14_ENGINE_DIR`) |
| `npm run audit:semantics` | probes | **139/139** |
| Loss sites ×4 corpora | `audit:fidelity` | tg ~54,457 / tgmc ~27,001 / paradise ~39,475 / bee ~45,277 |
| Unresolved bare calls (tg) | fidelity JSON | ~1,012 |
| Parse errors (tg) | fidelity JSON | ~170 |
| Compile-proof | fidelity `--build --build-max-procs 45000` | 0 C# errors |
| Hostile-name compile | custom corpus | 0 C# errors (claim) |
| Git dirty state | `git status --porcelain` | recorded in baseline JSON |

Machine-readable: `docs/audit/12-baseline-before.json` / `12-baseline-after.json`.
Corpus JSON snapshots: `docs/audit/12-{tgstation,tgmc,paradise,beestation}-audit.json`.

---

## 8. Deliverables & acceptance

**Deliverables**
1. This plan: `docs/plans/12-adversarial-audit.md`.
2. `docs/audit/12-findings.md` — ranked findings; Plan-11 triage appendix (200 rows);
   fix-batch proposal § (12.1, 12.2, … dependency-ordered).
3. `docs/audit/12-baseline-{before,after}.json` + 4 corpus snapshots.
4. Appendices (inline or linked from findings):
   - precedence verification table
   - per-builtin verdict table (112+)
   - probe veracity table (139+)
   - PNG decode matrix
   - hostile-compile CS-error classes
   - counter-correction arithmetic
   - Plan-11 disposition matrix (fixed / residual / wrong-fix / n/a)
   - loss-class scoreboard (WS14)
   - live-engine boundary note (WS15)
5. Post-acceptance: short entries in `AUDIT.md` + `FIDELITY-AUDIT.md` §3k.
6. `PLAN.md` row for Plan 12 + status corrections for 01–08 drift if confirmed.

**Acceptance ("full agentic adversarial audit complete")**
- [ ] All 16 workstreams returned a written pass with ≥1 attack class applied.
- [ ] All 200 Plan-11 findings dispositioned.
- [ ] Every 🔴/🟠 has repro + observed-vs-expected + file:line.
- [ ] 4-corpus baselines captured; deltas vs Plan-11 post explained or filed as findings.
- [ ] Full compile-proof + hostile-name compile re-run; residual CS classes listed.
- [ ] Fuzz/pathological rounds: zero unhandled crashes; hangs bounded or filed.
- [ ] Security harness: every vector scripted; residual vulns severity-ranked.
- [ ] Baselines before == after (repo `src/` untouched).
- [ ] Findings report is sufficient to drive Plan 12.x fix wave without re-discovery.

---

## 9. Proposed fix-wave skeleton (filled after findings)

Dependency-ordered placeholder — synthesis renumbers by evidence:

| Batch | Theme | Depends on |
|---|---|---|
| 12.1 | Compile / security REDs (emitter collisions, GUI residual) | — |
| 12.2 | Runtime value semantics residuals | — |
| 12.3 | Parser/preprocessor silent drops still live | — |
| 12.4 | Builtin / bare-call top-N (Plan 01 residual) | 12.3 macros |
| 12.5 | IR / `new` / symbol resolution (Plans 02, 08) | 12.1 |
| 12.6 | Media/maps residual | — |
| 12.7 | YAML / prototype residual | 12.5 |
| 12.8 | Harness honesty + doc drift | all measurement |
| 12.9 | Appearance stubs honesty (Plan 05) / live-engine prep (Plan 04) | product call |

---

## 10. Constraints

- **Findings-only** during audit. Fixes are a separate Plan 12.x wave.
- Evidence scaffolding only under `$TMPDIR/dm2ss14-audit12/` (or
  `/var/folders/.../T/opencode/…`).
- `rm -rf dist && npm run build` before measurement.
- Dotnet: single-process, 30 min SIGKILL, serialize concurrent large builds.
- Do not mutate corpora under `~/Documents/antigravity/ss13-audit-corpora/`.
- Do not bump `engine.pin` during audit; API drift vs pin is a WS15 finding.
- Keep agent outputs structured (template); orchestrator merges — no drive-by refactors.
- Timebox: prefer depth on 🔴/🟠 over exhausting 🟢 lists.

---

## 11. Kickoff checklist (orchestrator)

```bash
# 0. Clean build
rm -rf dist && npm ci && npm run build

# 1. Baseline-before
npm test
npm run audit:semantics
# for each corpus in tgstation tgmc paradise beestation:
#   npm run audit:fidelity -- "$CORPUS_ROOT/$name" \
#     | tee docs/audit/12-$name-audit.json   # via harness JSON out if supported
# compile-proof (needs SS14_ENGINE_DIR):
#   npm run audit:fidelity -- "$CORPUS_ROOT/tgstation" --build /tmp/cp12 --build-max-procs 45000

# 2. Record git state + metrics → docs/audit/12-baseline-before.json

# 3. Launch WS16 infra, then Waves A → B → C agents per §6

# 4. Synthesis → docs/audit/12-findings.md

# 5. Baseline-after; assert equality; commit plan+audit artifacts only when asked
```

---

## 12. Success definition (one paragraph)

Plan 12 is successful when a skeptical reviewer can open `docs/audit/12-findings.md`,
see every pipeline module adversarially attacked with evidence, see every Plan-11 claim
dispositioned, see residual product gaps (Plans 01–08/04) scored by real corpus impact,
and hand the ranked batches to a fix wave without re-doing discovery — while
`src/` remains bit-identical to the pre-audit tree and baselines match.
