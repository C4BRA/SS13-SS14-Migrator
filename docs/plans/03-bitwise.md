# Plan 03 — Bitwise Operators

Status: not started · Owner: runtime + emitter · Effort: 1–2 weeks ·
Impact: **19,009 binary + 1,083 unary sites** currently emitting `DMValue.Null`
(2026-08-02 Plan 11 re-run, tgstation: `& | ^ ~ >>` → Null 19,009, unary `~` → Null 1,083)

## Goal

Make `& | ^ ~ >> <<` and unary `~` behave per BYOND semantics, and disambiguate
`<<` (output vs shift). Also verify the `!= ~! **` compile-break accounting.

## Current state (ground truth from `src/transpiler/csharpEmitter.ts:489-541`)

- `transpileBinary`:
  - `& | ^ ~` → `'DMValue.Null'` (comment: "bitwise ops unsupported") — **19,009 sites**
    (2026-08-02 Plan 11 re-run; plan-creation snapshot was 18,060).
  - `<<` → `DMValue.Output(...)` unconditionally — **26,924 sites** (re-run). In DM, `a << b`
    is a *shift* in expression position and *output* only in statement position
    (`world << x`, `usr << x`, `src << x`); the unconditional output mapping is wrong
    for expressions.
  - `!=` → `DMValue.NotEquals` ✅, `~!` → `NotEquals` ✅, `**` → `DMValue.Power` ✅
    (runtime helpers exist, `dmRuntimeCS.ts`).
- `transpileUnary`: `~` → `'DMValue.Null'` — **1,083 sites** (2026-08-02 re-run; plan-creation snapshot was 1,038).
- Runtime (`src/runtimeTemplate/dmRuntimeCS.ts`): `DMValue` is double-based
  (`NumberValue`), no bitwise helpers. `DMValue.Null` for all bitwise results.
- Audit `numCompileBreak 7,172` counts `!= ~! **` — **stale/misleading**: the emitter
  already handles those; the counter counts sites, not failures. The real compile
  breaks must be measured by the compile proof, not this counter. Plan step 1 fixes
  the counter to only count operators the emitter actually drops.

## BYOND semantics to implement (per BYOND ref)

- Values are floats internally; bitwise ops act on the **32-bit two's-complement**
  integer representation: `ToNumber() -> (int)value` after BYOND's own conversion
  (truncation toward zero).
- `& | ^` — int AND/OR/XOR. `~x` — bitwise NOT.
- `x << n` / `x >> n` — shift by int count; BYOND masks shifts mod 32; `>>` is
  arithmetic (sign-preserving); `<<` preserves the low 32 bits (wraps).
- Results are returned as numbers (floats of the int result).
- Text operands: convert via `text2num` rules; null → 0.

## Design

### 1. Runtime helpers (`dmRuntimeCS.ts`)

Add to `DMValue` (or a `DMBitwise` static):

```csharp
public static DMValue BitAnd(DMValue a, DMValue b) => FromNumber(ToInt32(a) & ToInt32(b));
public static DMValue BitOr(...)   // | 
public static DMValue BitXor(...)  // ^
public static DMValue BitNot(...)  // ~ (unary)
public static DMValue ShiftLeft(...)  // << with & 31 mask, 32-bit wrap
public static DMValue ShiftRight(...) // >> arithmetic
private static int ToInt32(DMValue v) => unchecked((int)v.ToNumber());
```

`unchecked` matters: C# default is checked in some contexts; bitwise on `int` never
throws anyway, but conversion of large doubles must truncate like BYOND (document
edge: `text2num` behavior for string operands).

### 2. Emitter changes (`csharpEmitter.ts`)

- `transpileBinary`:
  - `& → BitAnd`, `| → BitOr`, `^ → BitXor`, `>> → ShiftRight`.
  - `<<` → **context-sensitive**:
    - statement-position `expr << value` where `expr` is `world`, `usr`, `src`,
      or any pure side-effect context → `DMValue.Output(left, right)` (unchanged).
    - expression/rvalue position (`x = a << b`, `f(a << b)`, `a << b as arg`) →
      `DMValue.ShiftLeft(left, right)`.
    - Heuristic: the emitter already knows statement vs expression contexts
      (assignment RHS, call args, return, binary operand). Implement the rule in
      `transpileBinary` via a `statementContext` flag propagated from the statement
      emitters, defaulting to shift (BYOND's actual default — output requires a
      receiver like `world`/`usr`/`src`).
- `transpileUnary`: `~` → `DMValue.BitNot(operand)`.
- `%=` and compound bitwise (`x &= y`, `x |= y`, `x ^= y`, `x <<= y`, `x >>= y`):
  check `AssignmentStatement` — if missing, add (BYOND supports them).

### 3. Audit counter fix (`src/audit/fidelityAudit.ts`)

- `numCompileBreak` should count only operators with no emitter mapping; move
  `!= ~! **` out (they map). Keep a `numBitwise` counter for `& | ^ ~ >> <<(shift)`.
- Update labels so the audit reflects reality.

### 4. Probes (`src/tests/fidelityDifferential.test.ts`)

- `12 & 10 == 8`, `5 | 3 == 7`, `6 ^ 3 == 5`
- `~0 == -1` (two's complement), `~5 == -6`
- `1 << 4 == 16`, `256 >> 4 == 16`, negative: `-8 >> 1 == -4`
- wrap: `1 << 40` → BYOND gives 256 (mod 32 shift); `0xFFFFFFFF` behavior
- string operand: `"10" & "12"` → 8 (text2num conversion)
- output vs shift: `var/x = 2 << 2` → 8; `world << "hi"` → output path
- compound: `x |= 3`

## Implementation steps

1. Fix the audit counter (split `numCompileBreak` / add `numBitwise`) and re-run for
   a clean baseline — confirm `numBitwise` ≈ 19,009 + expression-`<<` sites
   (2026-08-02 Plan 11 re-run).
2. Add runtime helpers + unit tests (golden C# + direct runtime tests).
3. Emitter: shift/output disambiguation with statement-context propagation; unary `~`.
4. Compound-assignment support if missing.
5. Probes; corpus compile proof; re-audit.

## Verification

- Probes: all bitwise semantics above pass with BYOND-expected values.
- Audit: `numBinaryNull → 0`; `<<` sites split correctly (output count ≈ statement
  sites; remaining `<<` in expressions are shifts, not losses).
- Corpus compile proof green; `npm test` green.

## Success criteria

- `numBinaryNull = 0`, `numUnaryTilde = 0`.
- `<<` disambiguation: 100% of expression-position `<<` are shifts; 100% of
  `world/usr/src << x` are outputs (probe-verified).
- Compile-break counter reflects only genuine emitter gaps (→ near 0).

## Risks / decisions

- **`<<` disambiguation risk**: DM parses `a << b` as shift except in statement
  context where the left is a *mob/client/world* receiver. The emitter's
  statement-context propagation must match the parser's AST shape; edge cases like
  `world << x << y` (chained) and `if (x << 1)` need explicit tests.
- **Float→int conversion**: BYOND truncates; NaN/Inf operands are undefined — pick
  documented behavior (0), cover with a probe.
- **Perf**: helpers are tiny; no concern.
