# Plan 11 — Full-Codebase Adversarial Audit

Status: **executed + fix wave 11.1-11.13 shipped** (2026-08-02) · 13 parallel workstreams ·
findings in `docs/audit/11-findings.md` (200 findings: 56 🔴 / 64 🟠 / 56 🟡 / 24 🟢) +
baselines `docs/audit/11-baseline-{before,after}.json`.
Fix-wave verification: semantic probes 129/134 → **139/139**; tgstation loss sites
105,097 → **54,457**; hostile-name corpus + 1,500-proc real-engine compile-proof both
**0 C# errors** (`FIDELITY-AUDIT.md` §3j).
Mode: **findings report only** — no source fixes during the audit; every finding is proven
with evidence (repro + observed vs expected) and ranked for a future fix wave.
Verification depth: **full** — semantic differential probes under dotnet 10, real-engine
compile-proof against pinned RobustToolbox (`engine.pin`, commit `9cefa116`), and 4-corpus
sweeps (tgstation / tgmc / paradise / beestation in `~/Documents/antigravity/ss13-audit-corpora/`).

Baseline = current working tree (Plan 10 ORANGE wave in progress, uncommitted changes in
9 src files: `fidelityAudit.ts`, `dmLexer.ts`, `dmParser.ts`, `preprocessor.ts`,
`dmRuntimeCS.ts`, `csharpEmitter.ts`, 3 test files).

---

## 1. Objectives

Produce a defensible, evidence-backed adversarial audit that:

1. Covers **every module** of the pipeline (lexer → parser → preprocessor → IR → emitter →
   YAML → runtime → DMI/DMM media → GUI server → CLI → audit harness) plus the embedded C#
   runtime, the test infrastructure, and the audit tooling itself ("audit the auditor").
2. Uses **adversarial technique, not just code reading**: differential probes against BYOND
   ground truth, corpus sweeps with error-class triage, hostile compile-proof, grammar-aware
   fuzzing, round-trip checks, pathological inputs, and an HTTP attack harness.
3. Triages **every pre-seeded suspect** below (≈60 items, all with `file:line`) to one of:
   confirmed-with-evidence / refuted / documented-nonissue.
4. Produces a ranked findings report (`docs/audit/11-findings.md`) with repro snippets,
   severity, and fix recommendations — the direct input to a future Plan 11 fix wave.
5. Leaves the repo **untouched** (no src edits; evidence scaffolding only in `$TMPDIR`),
   and proves that via before/after baseline metrics.

## 2. Ground truth & severity

**Ground truth hierarchy** (a claim is only valid against the highest applicable tier):

1. BYOND reference docs (`byond.com/docs/ref`) — authoritative for semantics.
2. Real corpus behavior (the 4 pinned corpora) — authoritative for frequency/impact.
3. Current converted-runtime behavior — never assumed correct.

**Severity rubric** (matching repo conventions):

| Sev | Meaning | Example |
|---|---|---|
| 🔴 Critical | generated output broken (won't compile / crashes), core semantics destroyed, or exploitable security vuln | `operator""` proc name breaks generated C#; zip-slip |
| 🟠 High | silent wrong behavior (compiles, wrong result, no diagnostic) | `7.0/2` → 3; `JsonEscape` invalid JSON; RSI direction swap |
| 🟡 Medium | wrong only in corner cases, degraded fidelity, or harness miscounts | `UpperText` Turkish-I; stale `BROKEN_PROP_NAMES` |
| 🟢 Low | cosmetic, docs, dead code, tooling hygiene | `topFiles` never populated; stale `dist/` artifacts |

**Finding template** (every finding returned by every workstream):

```
ID: 11-<ws>-<n>        Sev: 🔴/🟠/🟡/🟢
Module: <file(s)>
Claim: <one sentence, falsifiable>
Evidence: <repro DM snippet (or input) → observed output vs expected, file:line refs>
Fix suggestion: <for the future fix wave>
Test-lock suggestion: <probe or regression test that would lock the fix>
```

## 3. Workstreams (13 parallel agent tasks)

Each workstream: scope (files) + attack playbook + pre-seeded suspects (the `*` rows in
§4) + deliverables (findings in the template, capped at ~30 highest-value each).

### WS1 — Lexer (`src/parser/dmLexer.ts`)

Playbook:
- Number literal edge cases: `1...5`, `1.` , `1..`, `.5`, `0x`/`0b` with no digits,
  `1.#INF`/`1.#QNAN`/`1.#IND` variants, `2e`, `1e+`, huge exponents, `1_000`-style
  separators (DM doesn't have them — must be a parse error, not silent corruption).
- `/`-ambiguity: `/`+alpha always lexes TypePath (`:131`); division reconstruction is the
  parser's job (`dmParser.ts:1488-1496`) — find tokens that break the round-trip
  (`a/b/c`, `a / b`, `(a)/b`, `a//b` comment edge, path with digits).
- `#` fallback at `:234-237` swallows the rest of the line silently — find reachable
  inputs (define body containing `#`, unterminated directive leftovers).
- String interpolation is not quote-aware (`:384-408`): `"foo [bar("]")]"` terminates at
  the `]` inside the inner string; also nested `[[ ]`, unbalanced `[`/`]`, `[expr]` with
  strings/`{}` inside.
- `{"…"}` template vs `{`-brace-list of strings (`:222-225`): `{"a","b"}` lexes as ONE
  token — confirm and quantify; `{"a"}` vs `{ "a" }` with space.
- `@…@` regex / `@@…@` raw strings: unterminated forms, `@`-in-string, `@@`-collisions.
- Indent stack (`:63-122`): tabs=4sp assumption (`:77`), inconsistent-indent is a warning
  not error (`:111-119`) — find cases where a *silent wrong block structure* results.
- TypePath scanning with `.` (`:309-318`) and `operator""` (`:319-323, 599-604`).
- Determinism: tokenize the same input twice → identical token streams.
- Pathological inputs: NUL bytes, UTF-8 BOM (stripped `:42`), 10 MB single line, 50k-deep
  nesting, binary-as-`.dm`, empty file, only-comments file, CRLF vs LF vs mixed.
- Every silent recovery in §4 WS1 list must be reduced to a concrete input.

Deliverables: token-stream traces for edge inputs; findings list.

### WS2 — Parser (`src/parser/dmParser.ts`)

Playbook:
- Precedence table (`:1934-1958`) audited against BYOND for every binary/unary/ternary
  combo: `? :` vs `:`-dynamic-access disambiguation (`:1462-1479`), `<<`/`>>` at prec 9,
  `..` range at prec 11 (check `1..5 + 1`, `1..5 * 2` → `1 .. (5*2)`), `**` prec 13,
  `::`/`:`/`[` prec 14, `in`/`as`/`to` prec 7, assignment right-assoc prec 0.
- Silent drops (each must be confirmed with a repro and its downstream effect traced):
  proc default arg values `:497-500`; `as` return type `:206-211, 251-256, 708-713`;
  `in`-clause args `:504-507`; array-length exprs `:650-654, 673-680, 952-957`; top-level
  stray identifiers `:321-333`; `set` statements `:761-773` + dead duplicate `:907-919`;
  path assignments `/savefile/byond_version = 516` `:303-309`; FileLiteral kind lost
  `:1719-1722`.
- Silent error-recovery: unbalanced `)`/`]`/`}` in 24+ `matchPunctuation` sites (list at
  `dmParser.ts:224, 269, 299, 653, 679, 727, 783, 805, 843, 1086, 1160-1207, 1223-1273,
  1586, 1667, 1918-1925`) — find a case where recovery silently swallows a following
  statement (e.g. `for(var/x in list` + next statement becomes loop body).
- `parseInitializerTextToExpr` round-trip (`:521-563`): negative depth on stray `}` (`:545`),
  doubled-quote escapes (`"say ""hi"""`) mis-re-quoted; `try/catch → null` swallows bugs.
- `assoc_pair` off-interface node (`:1621`): identifier-keyed `list(a = 1)` miscompiles as
  assignment; string-keyed `list("a" = 1)` works — confirm both through the emitter.
- Single-line bodies (`:740-751`): `if (x) return x /b` splitting at TypePath.
- `pick(a;b)` weight separator vs statement `;` (`:1894-1897`).
- `for` head forms (`:1099-1235`): C-style vs multi-var vs `to`/`step`, `for(var/type) in`,
  malformed-for silent null statement (`:1402`).
- Switch (`:1237-1346`): `switch(x)` on same line as body, `if (v1, v2)` case forms.
- `to` as variable/proc name hits null-literal fallback (`:1855-1858`).
- Token-array mutation (`:129-134` splice) — parse same tokens twice, behavior difference.
- Determinism: parse twice on one instance (state not reset `:91-95`).

Deliverables: precedence-verified table appendix, silent-drop findings with downstream
trace, error-recovery findings.

### WS3 — Preprocessor (`src/preprocessor.ts`)

Playbook:
- `stripComment` string-unaware (`:493-496`, used at `:87`): `#define URL "https://…"`
  truncated to `"https:`; also `#if/#include` lines with `//`-in-string.
- `evalIf` (`:982-1029`): `#if 1` → false (numeric ignored); `#if VERSION >= 514` →
  `defined(VERSION)`; find corpus frequency (counters `numIfNumeric` exist).
- `#elif` and `#error` have no handler (`:189-193`) — unknown-directive warning, `#elif`
  leaves branch state unchanged → wrong branch selected after `#else`.
- `#pragma once` accepted but no-op (`:183-186`) — duplicate include double-expansion.
- Macro expansion: depth cap silent (`:599, 616-620`); `##` token-paste and `...`
  variadic applied INSIDE string literals (`:680-683`); `#name` stringification without
  quote escaping (`:745`); `##`-pasting only fires when followed by word char (`:731-734`);
  non-greedy params regex `#define FOO (x) (y)` misread as function-like (`:1052`);
  missing args → `''`, extra args silently ignored (`:669-672`).
- Seed pass `collectDefinesFromFiles` (`:1034-1077`): context-blind (defines inside
  comments / inactive `#if` / after `#undef` seeded globally; first-wins across files);
  `catch { continue; }` on unreadable file (`:1041`).
- Includes: single-dir resolution (`:161`), non-`.dm`/`.dme` includes silently skipped
  (`:169-172`), recursive include → whole file dropped with error (`:57-58`).
- Shared `blockCommentState` across includes and inactive regions (`:29, 197-204`).
- Line-number drift after `joinContinuations`/`joinParenBlocks` (`:215-260`).
- `{"…"}` template line starting with `#` breaks the join and drops the template tail (`:246`).
- Define visibility: define-after-include invisible to the included file (order-dependent).

Deliverables: findings with repro for each; corpus frequency for the confirmed ones
(counters or fresh grep).

### WS4 — IR + SymbolTable (`src/ir/dmIRGenerator.ts`, `src/ir/symbolTable.ts`)

Playbook:
- Case-insensitive type paths: `/OBJ/Item/Foo` vs `/obj/item/foo` are the SAME type in DM
  but distinct IR entries → duplicate C# class names and YAML prototype ids. Trace the
  full downstream (emitter + yaml) and produce a repro.
- Cross-file type split merge (`:30-40`), DFS parent-first synthesis (`:42-55`),
  trailing-slash normalization (`:129-131`), base-type normalize check (`:133-149`).
- `normalizeValue` (`:160-166`): raw-text truthiness — `density = TRUE`/`yes` →
  `Number("TRUE")=NaN → false` (`:92,95,98`); `"10"` stays quoted string vs number.
- `customVars: Map<string, any>` — untracked shapes flowing to YAML emitter.
- `parent_type` decls: count + verify IR uses them (harness B4 item).
- Classification: static vs dynamic — find a type wrongly classified static (custom var
  missed) or dynamic (no runtime need) and its YAML/behavior consequence.
- SymbolTable (audit-only, `:49-63`): `resolveBareProc`/`resolveTypeProc` mirror the
  runtime registry — find divergence between the two resolution orders.
- Synthesized parents: `/atom/movable` always synthesized (special-parent map
  `:78-83`) → emitted YAML proto that never existed; verify no id collisions with real
  types.

Deliverables: findings; a note on which IR invariants are tested vs untested.

### WS5 — Emitter (`src/transpiler/csharpEmitter.ts`)

Playbook:
- **Identifier sanitation** (the top RED family): DM-derived identifiers interpolated raw
  into C# string literals / method names at `:75, 79, 85, 102, 163, 297, 301-303, 399,
  412, 458-459, 470, 476, 480, 545, 554-561, 567-580, 622-623, 730-732, 740-752, 765-780,
  795-798`. Confirmed breakers: `operator""` proc names, dot-paths (`/obj/weapon.sword`
  → `Proc_ObjWeapon.sword_Run`). Find more: names with quotes via `#define` substitution,
  empty proc names, names that are only digits, `\` in identifiers (lexer is ASCII-only
  `:262-264` so unicode is out — verify).
- `escapeString` (`:807-809`) covers `\ " \n \r \t` only — `\0` and other control chars
  pass raw into `.cs`. `initial(x,"name")` 2-arg path does NOT escape (`:752`).
- Silent drops: `TryStatement` and `LabeledBlockStatement` bodies → `// Unknown statement`
  comment (`:524-525`) — confirmed; also `spawn`-as-expression body (`builtinMappings.ts:28-29`),
  unknown binary op → `DMValue.Null` (`:679`), bitwise (`:678, 689`), `~=`/`~!` → exact
  Equals (`:651, 653`), `%%` ≡ `%` (`:649, 677`), `as`-cast no-op (`:674`).
- Control flow: switch `while(true)` + terminating break (`:243-270`); continue-goto
  labels (`:329-434`); `break`/`continue` inside spawn lambda → comment (`:324-326, 339`);
  unconditional trailing `return comp.GetVar(".")` dead code (`:98`, CS0162 warning).
- Name mangling: `pathToClassName` (`:819-832`) no invalid-char stripping; `capitalize`
  (`:834-837`) first-char only; dedupe `_2` (`:816-817, 48-49`); case-collision `foo`/`Foo`
  → CS0102; registration key case sensitivity (`:102`) vs runtime lookup.
- GlobalVars: initializer order (`:163`), forward refs read Null (`:132`), raw-text
  fallback heuristic (`:159-163`).
- Assemble a hostile corpus: take 1,500 sampled procs, inject hostile-but-legal DM names
  (operator procs, dot-paths, case-variant paths, `args`-named args, C#-keyword-named
  vars/procs, long names, `_`-heavy names) → `dotnet build` → collect every CS#### class.

Deliverables: every confirmed compile-breaker with repro + CS error code; silent-drop
list with downstream consequence.

### WS6 — YAML generator (`src/transpiler/yamlGenerator.ts`)

Playbook:
- `yamlScalar` (`:134-138`): unquoted scalars matching `[A-Za-z0-9_.\/-]+` — YAML 1.1
  boolean/int trap (`yes`, `no`, `on`, `off`, `true`, `false`, `null`, `~`, `123`, `1.5`);
  backslashes NOT escaped in quoted path (`C:\foo` → `\f` form-feed corruption).
- `type`-key dropped from `initialVars` (`:118`).
- `pathToId` collisions (`:91-93`): `/obj/item/a_b` vs `/obj/item/a/b`, case variants →
  duplicate prototype ids, no dedupe; parent links through the same lossy transform
  (`:88`) can resolve to the wrong duplicate.
- `.dmi`→`.rsi` replace case-sensitive (`:25`); missing icon → hardcoded fallback sprite.
- Parent mapping (`:77-89`): `/turf`→BaseWall/BaseFloor by density, `/mob`→BaseMobDummy,
  `/obj`→BaseItem, `/datum`/`/atom` children → BaseItem ambiguity, synthesized
  `/atom/movable` emitted as a prototype.
- Array items bypass `yamlScalar` (`:125`).
- Round-trip check: parse generated YAML with a real YAML parser (YamlDotNet via a
  throwaway dotnet script) and report deserialization mismatches.

Deliverables: findings with before/after YAML snippets and deserializer evidence.

### WS7 — Builtin mappings (`src/transpiler/builtinMappings.ts`)

Playbook:
- **Case sensitivity** (top class): `MAPPED_BUILTINS` `.includes` exact-match
  (`fidelityAudit.ts:244`) and emitter `switch` exact (`:25-251`) vs case-insensitive DM:
  `crash()`, `Pick()`, `replacetextex`, `spacemandmm_unlint` etc. silently miss → runtime
  miss → Null. Corpus-frequency each confirmed case.
- Arg-order/arg-count audit of all 112 against BYOND ref (Plan 09 already fixed 10
  trailing-arg forms — hunt the rest): `text2num`, `num2text`, `findtext`, `replacetext`,
  `splittext`, `step_*`, `rgb`, `jointext`, `initial`, `range`/`view`/`oview` dist-first.
- Stubbed builtins (`animate`, `image`, `flick`, `sound`, `matrix`, `browse`, `call_ext`,
  `__detect_rust_g`) — verify each returns Null/0 and is counted as resolved by the audit.
- `is*` predicates composed from `DMIsType` (`:90-107`) — verify path strings match
  BYOND base paths (`/mob/living`, `/mob/living/carbon`, …).
- `spawn` as expression → body dropped (`:28-29`).

Deliverables: per-builtin verdict table (correct / wrong-args / wrong-semantics / stub),
case-sensitivity findings with corpus counts.

### WS8 — Runtime core value semantics (`src/runtimeTemplate/dmRuntimeCS.ts`, C# side)

Playbook (each divergence gets a differential probe in `$TMPDIR`):
- `Divide` (`:142-152`): WIP floor logic — `7.0/2` → 3 (int/float distinction lost in
  `double` DMValue; the Plan 10 probe expects 3.5 — verify it FAILS); div-by-zero → 0
  (DM runtime-errors); near-2^53 precision.
- `Modulo` (`:153`): fractional operands (`7.5 % 2` → 1.5 vs DM 1); sign matches DM; `/0`→0.
- `EqualsValue` (`:244-277`): exact doubles (`1 == 1.000000001` → 0 ✓); NaN; 2^53+
  integer precision; `null == "0"`; list equality incl. assoc.
- `Add`/`ConcatLists` (`:103-139`): `"x" + null` → "x"; assoc preservation; list + list.
- `Compare` (`:167-172`): text lexicographic case-insensitive; null vs number.
- Truthiness (`:69-82`): `"0"` falsy, `"00"`, `"-0"`, `"0.0"`, empty list.
- `ToNumber`/`ToString`/`TextRepr` (`:84-97, 174-184, 230-242`): culture-invariant (done
  per Plan 10); exponent formats (`1E+20`); list repr `[list]` vs DM `list(...)`.
- Unicode: `CpLength`/`CpIndexToChar` (`:43-61`) vs UTF-16 builtins (`Text2Ascii`
  `:2038-2044`, `Ascii2Text` `:2046`, `SplitText` `:1335`, `ReplaceText` `:788-801`,
  `DMListItems` string iteration `:1692`).
- `DMList` (`:306-367`): `Set` out-of-range silently ignored (DM errors); `Get(0)` → Null;
  COW refcount never decremented (`:312-315, 413, 714-731`) — per-write clone cost;
  `DMListToArray`/`DMArgList` Count-vs-PositionalCount (`:681-686`); `List2Params` same
  bug (`:2206-2217`).
- `Rand`/`Pick`/`DMProb` `new Random()` per call (`:1665-1736`).
- `Num2Text` huge-double cast (`:1889-1897`); `Round` AwayFromZero (`:1970-1978`);
  `RGB` no clamp (`:1443-1452`); `RGB2Num` alpha not implemented (`:2092-2096`);
  `UpperText`/`LowerText` culture (`:1982-1984`).
- Stubs: `Animate/Image/Flick/Sound/Matrix/Browse/CallExt/Alert/Input/Icon/Locate`
  → Null (`:1655-1661, 1701-1706, 2232-2236`); `RefCount` → 0 (`:1563`);
  `SpacemanUnlint` → Null; `world.xmax/ymax` never set → Step clamps inert (`:613-618`).

Deliverables: per-semantic-area probe results table (expected vs observed), each 🔴/🟠
with a probe snippet.

### WS9 — Runtime builtins & assembly (`src/runtimeTemplate/dmRuntimeCS.ts`, TS side)

Playbook:
- **`JsonEscape` (`:2157-2176`)**: under-escaped Appends — `"` `\` `\n` `\r` `\t` produce
  invalid JSON (verified byte-level). Prove with a probe: `json_encode(list("a\"b"))` and
  validate output with a real JSON parser. Check the TS backtick-escape asymmetry
  (:2164-2168) and confirm the case-label doubles are correct.
- Template-assembly: verify zero `${` in backticks (grep), 6-file pin
  (`runtimeTemplate.test.ts:34`), backtick balance guard (`:30-32`).
- `Text()` (`:1790-1817`): no `[]` splice, `[#x]`, `[x:len]` formatting.
- `Time2Text` (`:2184-2204`): partial format support.
- `TypesOf` (`:857-875`): only `RegisteredPaths` — types without procs missing.
- File ops: `FileDel/FileCopy/FList/Length(File)` swallow exceptions → 0 (`:1489-1535,
  1781-1782`); `fcopy_rsc` = `fcopy` (`:1511-1514`); `Ref` fake ids (`:1547-1557`).
- `JsonDecode` → Null on JsonException (`:1591-1594`).
- RustGAdapterStubs (`:2255-2289`): sha256-only hash, GET-only HTTP ignoring method/body,
  hardcoded SQL result.
- `DMTickScheduler.Sleep` `Math.Max(1, ms)` (`:529-533`).

Deliverables: findings + a JSON-validity probe result; template-integrity confirmation.

### WS10 — Media (`src/dmi/dmiParser.ts`, `src/dmi/pngCodec.ts`, `src/dmi/rsiWriter.ts`)

Playbook:
- **CRC validation is absent everywhere** (`dmiParser.ts:72`, `pngCodec` decode) — corrupt
  chunks accepted silently; quantify the risk (SS14 loader may reject corrupted RSIs).
- `pngCodec.decodePNG` (`:39-132`): 4-byte signature check only; lying chunk lengths →
  truncated data + out-of-bounds skip (silent); incomplete IDAT → inflate throw caught
  upstream (`rsiWriter.ts:36-38`); colorTypes 1/5 → channels 0 → garbage (table `:77`);
  interlaced PNGs decode as garbage; truncated scanlines → silent black pixels; palette
  OOR → magenta fallback (`:125-126`); IHDR fields unvalidated.
- `pngCodec.encodePNG` (`:134-157`): zero/negative/fractional dimensions → raw RangeError;
  no width/height sanity.
- `dmiParser` (`:152-213`): `state = "x"` vs legacy `state "x"`; dirs 1/4/8 validation;
  `parseFloat(...) || 1` coerces invalid/zero delays; frames*dirs mismatch warning only;
  duplicated `# BEGIN DMI` text chunks concatenated (`:77-79`); compression-method byte
  unvalidated; empty `catch {}` → defaultMeta (`:45-47`).
- **`rsiWriter` direction-order bug** (`:68-87`): DMI 4-dir rows are S,N,E,W; SS14 RSI
  direction indices are S,E,N,W — rows copied verbatim → N/E/W swapped. dirs=8 emitted
  though SS14 supports 1/4. Delays: DMI deciseconds vs SS14 seconds — verify unit
  consistency (`:46-52`, Plan 10 B5 item). Sheet smaller than metadata → silent black
  frames (no bounds check). Decode failure → metadata-only RSI without warning.
  `sanitizeStateName` collisions (`:99-101`) → state overwrite. Per-state meta uses
  `find` first-match (`:88-92`).
- Round-trip: encode → decode own output; DMI→RSI→SS14 loader expectations (format 2
  meta.json shape).

Deliverables: findings; a decode-correctness matrix for PNG variants (indexed, 16-bit,
interlaced, corrupt).

### WS11 — Maps (`src/dmm/dmmParser.ts`, `src/dmm/mapConverter.ts`)

Playbook:
- TGM multi-line defs: continuation line starting `//` or `#` dropped (`:53`) → unterminated
  def; `)` inside `//` comment balances parens prematurely (`:152`).
- Key decoding: `keyLen` derived from FIRST def key only (`:252-257`) — mixed-length keys
  in one map mis-split; malformed line → space-split fallback → one bogus key (`:225-240`).
- Coordinates: no whitespace tolerance in header regex (`:80`) — `(1, 1, 1)` unmatched;
  negative coords OK; 515-style multi-char keys vs single-char.
- `parseEntry` (`:186-197`): attr values containing `}`/`;` mis-parse; attr truncated at
  first `=` (`:193-194`); quoted-path regex strips only edge quotes.
- Non-rectangular sections: warning + `''` padding (`:264-269`); orphan/undefined keys
  (`:127-136`).
- `mapConverter` (`:121-152`): format-2 YAML — no grid `parent` on entities (map-rooted
  items); invented tile/proto ids (`TurfFloor`, `obj_item_sword`) that don't exist in
  SS14 content (`:89-119`); tilemap last-segment collisions (`/turf/floor` vs
  `/turf/simulated/floor` → both `floor`); duplicate `lx,ly:` lines per tile (no dedup);
  per-tile attributes dropped with warning (`:45-49`); y-flip math (`:52-54`); z-levels
  as separate grids; chunk floor-div math (`:100-114`).
- Round-trip: emit → re-parse with a YAML parser; verify chunk sums equal tile counts.

Deliverables: findings + a chunk-count invariant check.

### WS12 — Shell, security, pipeline (`src/gui/server.ts`, `src/cli.ts`, `src/index.ts`,
`src/diagnostics.ts`, `src/project/ss14Template.ts`)

Playbook:
- **GUI security** (threat model: local attacker able to reach loopback; token is a
  CSRF/DNS-rebinding defense, not an auth boundary):
  - `err.message` returned verbatim on 500 (`:189-191`) — leaks absolute paths; prove
    with a request that triggers an input-dir error.
  - `validateOutputPath` (`:94-101`): symlink escape — `$HOME/…/link` → outside home;
    HOME fallback to `/tmp` (`:98`); trailing-dot/`..`/`%2e%2e` variants.
  - Temp dir `temp_gui_input_<Date.now()>` predictable, cwd-relative (`:172`) — symlink
    pre-creation race (mkdirSync recursive follows).
  - Forged zip header sizes (`:160-170`); in-memory decompression DoS window (2 GiB
    upload → multi-GiB alloc); entry-count parse cost before limits.
  - Hand-rolled multipart (`:200-230`): boundary-in-binary-data corruption, no per-part
    limits, no part-name validation beyond `file`/`outputPath`.
  - `Origin: null`/absent accepted (`:80-85`); Host trailing-dot and IPv6 forms not
    checked (`:74-78`).
  - HTTP attack harness (raw sockets): malformed multipart, oversized headers, partial
    body, `Host: localhost.`, `Origin: null`, duplicate zip entries, traversal variants.
- CLI (`src/cli.ts`): `outputDir` completely unvalidated (`:42-43`); no `--help`/
  `--version`/unknown-flag validation; GUI-server start `error` event unhandled → crash
  (port in use); missing-arg handling.
- Pipeline (`src/index.ts`): partial output left on disk when diagnostics throw
  (`:119-137`); `findFiles` follows symlinked dirs (`:139-159`) vs audit walk which
  doesn't; broken-symlink skip (`:149`).
- `ss14Template.ts`: verify inert (all emitted XML/C# constant, `:28-33`) — expected
  confirmation, no findings unless contradicted.
- Hygiene: stale `dist/transpiler/expressionTranspiler.js` + `dist/tests/debugParser.js`
  (sources deleted); `npm run build` has no clean step; root `temp_test_dmi.png` ignored.
- `fidelityAudit` shell-in-string spawn (`:578-579`): `-p:EngineDir="${engineDir}"` via
  `shell: true` — prove command injection with a hostile `SS14_ENGINE_DIR`.

Deliverables: findings with raw-socket repro scripts (saved in `$TMPDIR`).

### WS13 — Harness integrity (audit the auditor) (`src/audit/fidelityAudit.ts`,
`src/tests/repoAudit.ts`, `src/tests/runTests.ts`, `src/tests/fidelityDifferential.test.ts`)

Playbook:
- Counter accuracy: `totalLossSites` arithmetic (`:396-408`) unit-tested on tiny fixtures
  (double-count / stale-class checks); `numClassicGlobalVars` in total but labeled
  "emitted into GlobalVars registry" (`:402` vs `:421`) — contradictory with excluded
  `numGlobalVars` (`:420`); `BROKEN_PROP_NAMES` (`:75`) includes `len`/`x`/`y`/`z` which
  are handled (probes pass) — miscounted losses; `topFiles` declared `:68` never
  populated; `fileLoss` placeholder dead (`:359-361`); JSON export loses nested Maps
  (`:644-650`); source-level regex counters count comments/strings (no stripping,
  `:118-154`).
- Probe veracity: read all 91 probes and check each tests what its name claims;
  `json_encode` probe never exercises escapes; `7.0/2` probe vs WIP Divide (expected 3.5,
  currently fails); probe count vs README/FIDELITY claims (91/91).
- Probe-runner integrity: skip-branch unreachable (`:757-760` — missing dotnet = hard
  exit 1); `dotnet run` invocation (`:795-801`); exact string match verdicts (`:813`);
  scratch dir collision between parallel runs.
- runTests: hardcoded 7 suites (`:27-33`), abort-on-first-failure (no isolation);
  coverage map of what's NOT tested: `cli.ts` (0 tests), `index.ts` findFiles symlinks,
  `pngCodec` error paths, `mapConverter` beyond one fixture, GUI multipart malformed
  cases, `fidelityAudit.runBuildProof` (manual only), `repoAudit.ts` (manual).
- Build-proof sampling bias: `--build-max-procs` takes first N per type (`:541-550`);
  propose/verify a uniform-random alternative.
- Baseline integrity: run all baselines twice → identical results (determinism of the
  audit itself).

Deliverables: counter-correction list with arithmetic proofs; probe-veracity table;
coverage-gap list.

## 4. Pre-seeded suspect list (triage targets, all file:line verified by recon)

Each row: `* WS# · target (file:line) · expected finding class`. Agents must triage
every row (confirm/refute/document) in addition to their own discoveries.

**WS1 Lexer**
1. `dmLexer.ts:234-237` · `#` fallback swallows rest of line silently
2. `dmLexer.ts:384-408` · interp `[…]` not quote-aware; closes on `]` inside strings
3. `dmLexer.ts:222-225` · `{"a","b"}` lexes as ONE template token (brace-list of strings broken)
4. `dmLexer.ts:111-119` · inconsistent indent = warning → silent wrong block structure
5. `dmLexer.ts:514-515` · invalid hex `0x` → error + fabricated `0`
6. `dmLexer.ts:131` · `/`+alpha always TypePath (division reconstruction burden)
7. `dmLexer.ts:42` · BOM strip (benign — confirm)
8. `dmLexer.ts:280-292` · unterminated block comment consumes to EOF (recovery only)

**WS2 Parser**
9. `dmParser.ts:1934-1958` · precedence table vs BYOND (`..` prec 11, `<<` prec 9, ternary prec 1)
10. `dmParser.ts:1462-1479` · `?`-ternary vs `:`-dynamic-access disambiguation
11. `dmParser.ts:1488-1496` · TypePath-after-expr guessed as division
12. `dmParser.ts:497-500` · proc default arg values parsed + dropped
13. `dmParser.ts:504-507` · `in`-clause args consumed + dropped
14. `dmParser.ts:206-211/251-256/708-713` · proc return type after `as` dropped
15. `dmParser.ts:650-654/673-680/952-957` · array-length exprs parsed + dropped
16. `dmParser.ts:321-333` · top-level stray identifier consumed silently
17. `dmParser.ts:761-773` + dead `:907-919` · `set` dropped; duplicate unreachable handler
18. `dmParser.ts:303-309` · `/savefile/byond_version = 516` path assignments dropped
19. `dmParser.ts:555-563` · `parseInitializerTextToExpr` try/catch → null (swallows bugs)
20. `dmParser.ts:521-546` · `parseInitialValueText` depth can go negative (stray `}`)
21. `dmParser.ts:1621` · `assoc_pair` off-interface; identifier keys miscompile as assignment
22. `dmParser.ts:1894-1897` · `pick(a;b)` weight `;` vs statement `;`
23. `dmParser.ts:740-751` · single-line bodies end at TypePath (division misparse)
24. `dmParser.ts:1402` · malformed `for` → null statement silently
25. `dmParser.ts:129-134` · token-array splice mutation (determinism)
26. Unbalanced `)`/`]`/`}` silent continues (24 sites listed in WS2) · swallowed statements
27. `dmParser.ts:1719-1722` · FileLiteral kind lost
28. `dmParser.ts:1558-1571` · `::`/`:`/`?:` at EOF → empty property name silently

**WS3 Preprocessor**
29. `preprocessor.ts:493-496` + `:87` · `stripComment` not string-aware (`#define URL "https://…"`)
30. `preprocessor.ts:982-1029` · `evalIf` ignores numeric/comparison (`#if 1` → false)
31. `preprocessor.ts:189-193` · `#elif`/`#error` unhandled (branch state wrong)
32. `preprocessor.ts:183-186` · `#pragma once` no-op
33. `preprocessor.ts:680-683` · `##` token-paste + `...` applied inside string literals
34. `preprocessor.ts:745` · `#name` stringification without quote escaping
35. `preprocessor.ts:1052` · non-greedy `#define FOO (x) (y)` misread as function-like
36. `preprocessor.ts:669-672` · missing args → `''`; extra args silently ignored
37. `preprocessor.ts:599/616-620` · macro depth cap silent
38. `preprocessor.ts:1034-1077` · seed pass context-blind (comments/`#if`/`#undef` ignored)
39. `preprocessor.ts:1041` · seed read failure `catch { continue }` (file skipped silently)
40. `preprocessor.ts:161/169-172` · include single-dir; non-`.dm` includes skipped silently
41. `preprocessor.ts:57-58` · recursive include → whole file dropped
42. `preprocessor.ts:29/197-204` · shared `blockCommentState` across includes/inactive regions
43. `preprocessor.ts:246` · `{"…"}` template line starting `#` breaks join, drops tail
44. `preprocessor.ts:215-260` · line-number drift after joins

**WS4 IR**
45. `dmIRGenerator.ts:31-40` · cross-file type-split merge (confirm correct after B4 fix)
46. `dmIRGenerator.ts:42-55` · DFS parent-first synthesis order
47. `dmIRGenerator.ts:92/95/98` · `Boolean(Number(val))` on raw text (`TRUE`/`yes` → false)
48. `dmIRGenerator.ts:160-166` · `normalizeValue` strip-quotes semantics
49. `dmIRGenerator.ts:129-131` · trailing-slash normalization (case variants not merged)
50. `symbolTable.ts:78-83` · special-parent synthesis → `/atom/movable` always emitted

**WS5 Emitter**
51. `csharpEmitter.ts:102` + `:79/85/163/545-561/622-623/730-752` · unescaped DM identifiers into C# string literals / method names (`operator""`, dot-paths)
52. `csharpEmitter.ts:524-525` · `TryStatement`/`LabeledBlockStatement` bodies dropped
53. `csharpEmitter.ts:807-809` · `escapeString` misses `\0`/control chars
54. `csharpEmitter.ts:752` · `initial(x,"name")` 2-arg path not escaped (inconsistent)
55. `csharpEmitter.ts:678/689` · bitwise `& | ^ ~` → `DMValue.Null` (silent)
56. `csharpEmitter.ts:651-653` · `~=`/`~!` approximated as exact Equals
57. `csharpEmitter.ts:649/677` · `%%` ≡ `%` (floor-modulo wrong for negatives)
58. `csharpEmitter.ts:674` · `as`-cast no-op
59. `csharpEmitter.ts:819-837` · `pathToClassName` no invalid-char strip; `_2` dedupe; case collisions → CS0102
60. `csharpEmitter.ts:98` · unconditional trailing `return comp.GetVar(".")` dead code
61. `csharpEmitter.ts:243-270` · switch `while(true)` wrapper + terminating break

**WS6 YAML**
62. `yamlGenerator.ts:134-138` · YAML 1.1 boolean/int trap (`yes`/`123` unquoted); backslash unescaped in quoted path
63. `yamlGenerator.ts:118` · `type` key dropped from `initialVars`
64. `yamlGenerator.ts:91-93` · `pathToId` collisions → duplicate prototype ids (no dedupe)
65. `yamlGenerator.ts:25` · `.dmi`→`.rsi` case-sensitive
66. `yamlGenerator.ts:77-89` · parent mapping ambiguity (`/datum`/`/atom` children → BaseItem)
67. `yamlGenerator.ts:125` · array items bypass `yamlScalar`

**WS7 Builtins**
68. `builtinMappings.ts:25-251` + `fidelityAudit.ts:244` · case-sensitive matching vs case-insensitive DM (`crash()`/`Pick()` miss)
69. `builtinMappings.ts:28-29` · `spawn`-as-expression body dropped
70. `builtinMappings.ts:90-107` · `is*` predicate path strings
71. Stub set: `animate`/`image`/`flick`/`sound`/`matrix`/`browse`/`call_ext` → Null

**WS8/9 Runtime**
72. `dmRuntimeCS.ts:142-152` · `Divide` floor logic loses int/float distinction (`7.0/2` → 3)
73. `dmRuntimeCS.ts:142-152` · div-by-zero → 0 (DM runtime-error)
74. `dmRuntimeCS.ts:153` · `Modulo` fractional operands wrong
75. `dmRuntimeCS.ts:244-277` · `EqualsValue` 2^53+ precision; NaN; null rules
76. `dmRuntimeCS.ts:681-686` · `DMListToArray`/`DMArgList` Count-vs-PositionalCount
77. `dmRuntimeCS.ts:2206-2217` · `List2Params` same bug
78. `dmRuntimeCS.ts:312-315/413/714-731` · COW refcount never decremented (per-write clone)
79. `dmRuntimeCS.ts:1692` · `DMListItems` string iteration splits surrogate pairs
80. `dmRuntimeCS.ts:2038-2046` · `Text2Ascii`/`Ascii2Text` UTF-16
81. `dmRuntimeCS.ts:1335/788-801` · `SplitText`/`ReplaceText` windows UTF-16
82. `dmRuntimeCS.ts:1665-1736` · `Rand`/`Pick`/`DMProb` `new Random()` per call
83. `dmRuntimeCS.ts:2157-2176` · **`JsonEscape` under-escaped → invalid JSON** (verified)
84. `dmRuntimeCS.ts:1443-1452` · `RGB` no 0-255 clamp
85. `dmRuntimeCS.ts:2092-2096` · `RGB2Num` alpha not implemented
86. `dmRuntimeCS.ts:1982-1984` · `UpperText`/`LowerText` culture-sensitive
87. `dmRuntimeCS.ts:1889-1897` · `Num2Text` huge-double cast
88. `dmRuntimeCS.ts:1790-1817` · `Text()` no `[]`/`[#x]`/formatting
89. `dmRuntimeCS.ts:857-875` · `TypesOf` misses no-proc types
90. `dmRuntimeCS.ts:613-618` · `world.xmax/ymax` never set → Step clamps inert
91. `dmRuntimeCS.ts:1655-1661/1701-1706/2232-2236` · stub builtins → Null
92. `dmRuntimeCS.ts:2255-2289` · RustGAdapter stubs (GET-only HTTP, hardcoded SQL, sha256-only)
93. `dmRuntimeCS.ts:529-533` · `Sleep` `Math.Max(1, ms)`

**WS10 Media**
94. `dmiParser.ts:72` + `pngCodec.ts` decode · CRC never validated
95. `pngCodec.ts:77` · colorTypes 1/5 → channels 0 → garbage
96. `pngCodec.ts:39-132` · interlaced PNGs decode silently wrong; truncated scanlines → black
97. `pngCodec.ts:134-157` · `encodePNG` no dimension validation
98. `rsiWriter.ts:68-87` · **DMI 4-dir order (S,N,E,W) vs SS14 (S,E,N,W) — sprites swapped**
99. `rsiWriter.ts:68-87` · dirs=8 emitted though SS14 supports 1/4
100. `rsiWriter.ts:36-38` · decode failure → metadata-only RSI, no warning
101. `rsiWriter.ts:99-101` · state-name sanitize collisions → overwrite
102. `dmiParser.ts:45-47` · empty `catch {}` → defaultMeta
103. `dmiParser.ts:77-79` · duplicated `# BEGIN DMI` chunks concatenated

**WS11 Maps**
104. `dmmParser.ts:53` · multi-line def continuation starting `//`/`#` dropped
105. `dmmParser.ts:152` · `)` inside `//` comment balances parens prematurely
106. `dmmParser.ts:252-257` · keyLen from first def only (mixed-length keys mis-split)
107. `dmmParser.ts:80` · coord header regex no whitespace tolerance
108. `dmmParser.ts:186-197` · attr values with `}`/`;`/`=` truncate
109. `mapConverter.ts:89-119` · invented tile/proto ids not in SS14 content
110. `mapConverter.ts` · no grid `parent` on entities; duplicate `lx,ly:` lines

**WS12 Shell/security**
111. `server.ts:189-191` · `err.message` leaked verbatim (absolute paths)
112. `server.ts:94-101` · symlink escape in `validateOutputPath`; HOME fallback `/tmp`
113. `server.ts:172` · predictable cwd-relative temp dir (symlink race)
114. `server.ts:160-170` · forged zip header sizes; in-memory decompression DoS
115. `server.ts:80-85` · `Origin: null`/absent accepted
116. `server.ts:200-230` · hand-rolled multipart: boundary-in-binary, no per-part limits
117. `cli.ts:42-43` · outputDir unvalidated in CLI mode
118. `cli.ts` · no `--help`/unknown-flag validation; GUI `error` event unhandled → crash
119. `index.ts:119-137` · partial output left on disk on error
120. `fidelityAudit.ts:578-579` · shell-in-string spawn with env-derived path (injection)
121. `dist/` · stale `expressionTranspiler.js`/`debugParser.js` (sources deleted)

**WS13 Harness**
122. `fidelityAudit.ts:75` · `BROKEN_PROP_NAMES` includes handled `len`/`x`/`y`/`z` (miscount)
123. `fidelityAudit.ts:402` vs `:421` · `numClassicGlobalVars` counted as loss but labeled emitted (contradiction)
124. `fidelityAudit.ts:68/359-361` · `topFiles` never populated; `fileLoss` dead
125. `fidelityAudit.ts:644-650` · JSON export loses nested Maps
126. `fidelityAudit.ts:118-154` · regex counters count comments/strings
127. `fidelityAudit.ts:541-550` · `--build-max-procs` biased (first N per type)
128. `fidelityDifferential.test.ts:757-760` · skip-branch unreachable (missing dotnet = exit 1)
129. `fidelityDifferential.test.ts:304-307` · `json_encode` probe never exercises escapes
130. `runTests.ts:27-33` · hardcoded suites; abort-on-first-failure; coverage gaps (`cli.ts` 0 tests, `pngCodec` error paths, GUI multipart)

## 5. Cross-cutting adversarial techniques

Applied by every workstream where relevant; the heavy ones are shared infrastructure:

1. **Differential probes** — every semantic claim proven by compiling + running a DM
   snippet through the existing probe-harness pattern (`fidelityDifferential.test.ts:762-810`
   mechanics; scratch project in `$TMPDIR/dm2ss14-audit11`). Expected = BYOND ground truth
   (tier 1/2), observed = converted runtime. Findings-only: probes are evidence, not
   suite additions.
2. **Corpus sweeps** — `npm run audit:fidelity -- <corpus>` on all 4 corpora
   (`SS14_ENGINE_DIR` set). Parse-error class triage per corpus; each top class reduced
   to a repro; claimed-clean classes spot-checked.
3. **Compile-proof** — baseline real-engine `dotnet build` (44,826 sampled procs, 0 CS
   errors expected); then **hostile compile-proof**: inject legal-but-pathological DM
   names (operator procs, dot-paths, case-variant types, keyword-adjacent names, long
   names, `_`-heavy) into the sampled corpus → collect every CS#### class.
4. **Grammar-aware fuzzing** — a small DM generator (valid programs, invalid programs,
   mutated corpus lines, random identifier characters): invariants = no crash, no hang,
   diagnostics-not-death, and determinism (same input twice → identical tokens/AST/
   emitted text). Run bounded (e.g. 2,000 inputs per module, 30 s timeout each).
5. **Round-trip** — emitted YAML re-parsed by a real YAML parser (throwaway dotnet
   script with YamlDotNet); generated C# always through `dotnet build`; DMI→RSI→re-decode;
   emitted C# re-lexed (nothing to re-lex, but verify no backtick/`${` leakage).
6. **Pathological inputs** — deep nesting (50k parens), 10 MB single-line file, NUL
   bytes, BOM variants, binary-as-`.dm`, empty/1-byte files, huge identifier names,
   mixed tabs/spaces.
7. **HTTP attack harness** — raw-socket requests against the GUI: malformed multipart,
   missing/injected boundary, oversized headers, partial body, traversal variants
   (`..`, `%2e%2e`, symlink, `~`), duplicate zip entries, forged sizes, `Origin: null`,
   IPv6 `Host`, trailing-dot `localhost.`.
8. **Harness-integrity** — counter arithmetic unit tests on tiny fixtures (verify
   `totalLossSites` per counter), probe-claim audit (all 91), sampling-bias analysis,
   audit determinism (run baselines twice).

## 6. Execution model (agentic orchestration)

- **Wave A (parallel)**: WS1-4 — parser stack first; REDs here corrupt everything
  downstream, and their findings feed WS5-7.
- **Wave B (parallel)**: WS5-9 — emitter/runtime/builtins.
- **Wave C (parallel)**: WS10-13 — media/maps/shell/harness, plus corpus sweeps +
  fuzzing + hostile compile-proof (can run concurrently; dotnet builds are serialized
  via the in-flight lock if sharing a machine).
- **Synthesis pass** (single agent): merge findings, dedupe, cross-verify (each 🔴/🟠
  re-verified by a second WS's evidence or a fresh probe), rank, assign fix-batch ids
  (11.1, 11.2, …) for the future fix wave.
- **Verification pass**: re-run the full baseline suite; results must be unchanged
  (findings-only); any delta is itself a finding.

## 7. Baselines (captured before AND after — EXECUTED 2026-08-02)

Status: **execution complete** — findings-only audit, repo untouched, before == after.
Full machine-readable snapshots: `docs/audit/11-baseline-{before,after}.json`.

| Metric | Expected (pre-execution) | Measured (2026-08-02) | After |
|---|---|---|---|
| `npm run build` | clean (tsc strict) | clean | clean |
| `npm test` | green | green (engine-build step skips without repo-relative RobustToolbox; green with `SS14_ENGINE_DIR`) | green |
| `npm run audit:semantics` | 91/91 probes | **129/134** — suite has 134; 5 pre-existing failures root-caused (§3 of `docs/audit/11-findings.md`) | 129/134 (same 5) |
| Parse errors, tgstation | 178 | **170** | 170 |
| Unresolved builtins, tgstation | ~593 | **3,360 unresolved bare calls** (≈2,400 are unexpanded fn-macros — §3g "~113" estimate disproved; counter-rebaseline note in `FIDELITY-AUDIT.md` §3h) | 3,360 |
| `totalLossSites`, tgstation | ~105,198 | **105,097** | 105,097 |
| Other corpora | tgmc/paradise/beestation baselines (§2) | tgmc 44,745 · paradise 58,493 · beestation 72,900 | — |
| Compile-proof | 0 C# errors @ 44,826 procs (prior published) | 1,500-proc fresh re-run: **0 errors, 46,374 CS0162 warnings** (confirms WS5-18) | unchanged |

Captured to `docs/audit/11-baseline-before.json` and `-after.json`.

## 8. Deliverables & acceptance criteria

**Deliverables**
1. `docs/plans/11-adversarial-audit.md` (this document).
2. `docs/audit/11-findings.md` — ranked findings table (severity → fix-batch), every
   finding with repro + observed-vs-expected + `file:line` + fix/test-lock suggestions.
3. `docs/audit/11-baseline-before.json` / `docs/audit/11-baseline-after.json`.
4. Appendices: precedence-table verification, per-builtin verdict table (112), probe
   veracity table (91), PNG decode matrix, hostile-compile CS-error class list,
   counter-correction arithmetic.
5. One entry appended to `FIDELITY-AUDIT.md` §3h and `AUDIT.md` summarizing the audit
   (post-acceptance of findings).

**Acceptance ("all bases covered")**
- All 13 modules have a documented adversarial pass with ≥1 concrete attack class
  applied and results recorded.
- All 130 pre-seeded suspects triaged: confirmed-with-evidence / refuted / documented-nonissue.
- Zero unhandled crashes or infinite hangs in fuzzing/pathological rounds.
- Baselines before == after (repo untouched by the audit).
- Findings report is the sole source for the next fix wave (Plan 11 fixes, mirroring
  Plans 09/10 structure: REDs → ORANGEs → deferred).

## 9. Constraints

- **Findings-only**: no edits to `src/`, `scripts/`, `package.json`, or committed docs
  except the plan itself + `docs/audit/` artifacts + the two audit-log appendices after
  acceptance. Evidence scaffolding lives only in `$TMPDIR`.
- Working tree has uncommitted Plan 10 WIP — do not let audit runs be confused by it;
  record the working-tree state (git diff stat) in the baseline JSON.
- `rm -rf dist && npm run build` before running any audit script (stale dist artifacts
  confirmed present).
- dotnet builds: single-process (`-m:1 -nodeReuse:false --disable-build-servers`), 30 min
  SIGKILL timeout; serialize concurrent builds.
- Each workstream returns ≤30 highest-value findings in the template (§2).
