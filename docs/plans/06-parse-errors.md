# Plan 06 — Parse-Error Reduction

Status: in progress (2026-08-02 Plan 11 re-run: **170** errors on TG; target <500 reached) ·
Owner: lexer/parser/preprocessor · Effort: 2–4 weeks · Impact: 170 errors → <500

## Goal

Drive tgstation parse diagnostics from **2,473 errors / 40 warnings** down to a
documented floor (<500), and eliminate the *silent* parser-level loss classes (no
error emitted — worse than an error).

## Current state

- Error sites are a small, fixed set:
  - `src/parser/dmParser.ts`: top-level token (325), type-block token (385), `do`
    while (887), switch token (997), ternary `:` (1290), list-literal `}` (1374),
    expression token (1506), identifier after `.` (1523).
  - `src/parser/dmLexer.ts`: unexpected char (220), unterminated block comment
    (268), interpolation (343), string (367), template string (398), regex (427).
- Loss-site classes that parse *silently* (audit counters, tgstation):
  `for ... as type in` **3,899**, `continue` 4,549, `break` 1,150, `world` refs
  3,712, `set` modifiers 153, multi-var `for` 150, `client` decls 182, `world`
  decls 87, `#if` numeric 53, weighted `pick(a;"x")` 18, labeled blocks 20,
  `goto` 2.

## Step 1 — Error-class triage (new tooling)

Add `--error-classes` to `src/audit/fidelityAudit.ts`: aggregate
`collector.errors` by message template (strip file/line/col), print the top 25
classes with file samples. This turns "2,473 errors" into a prioritized backlog.
Expected top classes (hypothesis, confirm at triage):

- `Unexpected token '<x>' in expression` — the catch-all; dominated by
  constructs the parser doesn't model (e.g. `#` directives mid-expression,
  `isnull(x) && ...` patterns, `\.` escaping, `{ }` blocks in expressions).
- `Unexpected top-level token` — unparseable file-level lines (DMM-style data,
  binary assets, `#if` leftovers).
- Unterminated string/regex/template — mostly escaped-quote and
  multi-line-string lexer gaps (multiline strings are legal DM; lexer must carry
  string state across lines — the preprocessor already does for parens).

## Step 2 — Lexer/parser fixes per class (each: repro → fix → golden test)

Priority order by combined (error + silent-loss) impact:

1. **`for ... as type in ...` (3,899 silent)** — `for(var/obj/x in world)` filters
   by type. Parser already handles `in`; the type-filter form drops the body or
   misparses. Add `ForAsTypeStatement` → emit `foreach` + `ispath` filter.
2. **Multiline strings** — lexer: carry `inString` across lines (string state in
   the lexer class, reset on `"` close), mirroring the preprocessor's paren/comment
   state. Expected to kill a large share of unterminated-string errors.
3. **`break`/`continue` (5,699 sites)** — already emitted in loops/switch
   (Phase 0.5); the audit counts sites in *unsupported contexts* (e.g.
   `continue` inside `switch` case without loop, or in `spawn` bodies). Triage:
   emit warnings for out-of-context uses instead of counting as loss.
4. **`#if` numeric/relational (53)** — `#if 1 == 1` — extend `evalIf` in
   `src/preprocessor.ts` to parse numeric comparisons (`==`, `!=`, `<`, `>`,
   `&&`, `||`) — currently "comparisons ignored".
5. **Multi-var `for` (150)**, `for ... step n` (23) — parser loops.
6. **`set` modifiers (153)** / `client` (182) / `world` (87) decls — parse and
   emit as data (verb metadata table; client/world var decls onto the runtime
   `world`/client datum), moving them from "dropped" to "mapped".
7. **Weighted `pick(a;"x")` (18)** — assoc syntax in `pick`; runtime helper
   already supports weights (`DMRuntimeHelpers.Pick`) — parse the `;"` form.
8. **`goto` (2)** / labeled blocks (20) — parse `label:` + `goto` → emit as
   `DMLabel`/`DMGoto` runtime jumps (or warning + structured workaround).

## Step 3 — Error-diagnostic quality

- Every new error class must include the offending token + a hint ("did you mean
  `for(var/x in list)`?"). Low-cost, high-debug-value.
- Parse errors must never be *silent* — the audit's silent-loss counters are the
  real enemies; keep them surfaced in the audit output.

## Verification

- Triage script produces the top-25 class list (checked in with the audit output
  for tgstation).
- Re-audit after each class fix: `parseErrors` and the relevant silent counter
  both drop; golden tests for each repro; `npm test` green.
- Compile proof re-run at the end.

## Success criteria

- `parseErrors < 500` on tgstation with the top-10 classes documented as
  intentionally-unsupported (each with a sample + reason).
- `for-as-type`, multi-var `for`, `for-step`, weighted pick, `set` modifiers,
  `client`/`world` decls move from "dropped" to "mapped" (audit label change).
- `#if` numeric comparisons evaluated correctly (probe).

## Risks / decisions

- **Multiline strings** are the biggest single lever but touch the lexer's core;
  the golden-test corpus must include pathological cases (escaped quotes, `#` in
  strings, interpolation spans).
- **`client`/`world` decls** partially depend on Plan 04 (server world model) —
  parse-and-store now, wire runtime semantics in Plan 04.
- Some "errors" are actually *comments-as-data* artifacts (e.g. `/*README*/`
  blocks) — triage must not "fix" away correct behavior (the preprocessor already
  handles these; confirm the residual count is genuinely parse failures).
