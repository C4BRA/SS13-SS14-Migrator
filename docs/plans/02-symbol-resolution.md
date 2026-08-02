# Plan 02 — Symbol Resolution + Global Procs

Status: in progress (2026-08-02: symbol table + audit triage landed; emitter resolution pending) · Owner: parser/emitter ·
Effort: 2–4 weeks · Impact: **36,911 bare global proc call sites made deterministic**

## Goal

Replace silent runtime resolution with compile-time symbol verification:

1. Every bare call `foo()` resolves to a known global proc (`/proc/foo`) or type proc.
2. Every `obj.foo()` resolves through the object's type hierarchy.
3. Unresolved targets produce **diagnostics**, never silent `Null`.
4. When the target is statically known, emit a direct static call (perf + correctness).

## Current state

- **2026-08-02 milestone 1 (done):** `src/ir/symbolTable.ts` (TypeSymbol/SymbolTable +
  `computeParentPath` with BYOND special roots: /obj,/mob → /atom/movable; /turf,/area →
  /atom). `fidelityAudit.ts` now parses each file once, accumulates the table corpus-wide,
  buckets bare calls by enclosing type path, and resolves them in a post-pass. tgstation
  triage: **93,573 verified** (35,937 via /proc globals + 57,636 via calling type
  hierarchy), **3,345 unresolved** — of which ~3,233 are BYOND builtins missing from
  `MAPPED_BUILTINS` (Plan 01 backlog: arglist 579, SpacemanDMM_unlint 228, floor 112,
  orange 110, fdel 104, file 102, ceil 97, sqrt 94, json_encode 93, regex 90, ...) and
  112 are function-macro names. `dmIRGenerator.computeParentPath` now delegates to the
  shared function (fixes /obj,/mob IR inheritance).
- **2026-08-02 update:** Plan 01 batches 1-3 removed ~2,637 of those builtin sites
  (pure functions + file ops + movement landed: arglist, floor, ceil, sqrt, sin, cos, log,
  sign, text/color/json/time/params helpers, file/isfile/fdel/fcopy/fcopy_rsc/flist/ref/
  refcount, SpacemanDMM_unlint, step/step_towards/step_away/get_step_away/get_step_towards/
  orange/viewers/hearers) → unresolved now **708**.
- Runtime fallback (works but unverified): generated procs register in
  `ProcRegistry` (`src/runtimeTemplate/dmRuntimeCS.ts` — `Register`, `TryGet`,
  `TryGetInherited` walking type ancestors); bare calls emit
  `DMCallProc(..., "/proc/foo")` which hits the registry or returns `Null`.
- Audit labels the class **"resolved at runtime via /proc fallback"** —
  `numBareGlobalProcCalls 36,911` on tgstation — so the mechanism exists but there is
  no compile-time verification that the target exists.
- The parser already collects full type/proc inventory during parse
  (`dmParser.ts`; `procNames` set used by `fidelityAudit.ts`), but nothing persists
  it into the emitter.
- `..()` parent calls (22,935 sites) also rely on runtime registry walk; no
  emit-time parent-chain check.

## Design

### 1. Symbol table pass (`src/ir/symbolTable.ts`, new)

After parsing a corpus run, build:

```
interface TypeSymbol {
  path: string;            // "/datum/foo/bar"
  parentPath: string | null;
  procNames: Set<string>;  // declared or inherited
  varNames: Map<string, DMGlobalVarDeclNode>;
}
interface SymbolTable {
  types: Map<string, TypeSymbol>;
  globalProcs: Set<string>;        // /proc/foo declared anywhere
  rootPath: string;                // /datum
}
```

- Reuse the parse pass; the parser's `procNames`/type inventory is already there —
  hoist it into an explicit table that both the audit and emitter consume.
- Handle DM's implicit inheritance (`/obj/item` → `/obj` → `/datum`); ancestor walk
  is already mirrored in `TryGetInherited` — reuse the same path grammar.

### 2. Emit-time resolution (`src/transpiler/csharpEmitter.ts`)

- `transpileCall` gains a resolver:
  - bare `foo(...)` → `globalProcs.has("foo")` ? direct emit : diagnostic (warning),
    then emit runtime fallback (so output still builds).
  - `target.foo(...)` → resolve `target`'s static type when known (var decl types,
    `new /type` results, `list(/type)` iteration vars); walk ancestors; miss →
    warning + fallback.
  - `..()` → resolve parent chain for the current proc's type; if no parent proc
    exists, warning (currently silent `Null`).
- Direct-call optimization: when resolved, emit `await DMRuntime.CallProc`
  via registry still (keep semantics) but with a **static fast path**
  (`ProcRegistry.GetStatic(type, proc)` cached delegate) — no dictionary walk per call.

### 3. Diagnostic policy

- **Warnings** (not errors) for unresolved targets — corpus must stay buildable.
- `DiagnosticCollector` already exists (`src/diagnostics.ts`); thread the
  symbol-table misses through it with `(file, line)` positions.
- New audit counter: `numUnresolvedCalls` (replaces the label-only
  `numBareGlobalProcCalls`); the counter must go **to 0 or to a documented list**.

### 4. Procmacro support (unblocks TG)

TG uses `procmacro` (e.g. `#define procmacro foo(...) ...`) and runtime-defined
procs. Triage the 36,911: how many are declared in the parsed corpus at all? Expect
the bulk to resolve cleanly; the residual is `procmacro`-generated names — collect
them in the symbol pass (`src/preprocessor.ts` emits proc-like defines; register
their names as synthetic globals).

## Implementation steps

1. Extract the parser's type/proc inventory into `symbolTable.ts`; unit test the
   table on a small fixture corpus.
2. Wire the resolver into `transpileCall` + `..()` handling; add
   `numUnresolvedCalls` to `fidelityAudit.ts`; run tgstation audit → bucket the
   unresolved (expect mostly procmacro + genuinely-runtime-defined names).
3. Add procmacro name collection; re-run → drive `numUnresolvedCalls` down.
4. Static fast-path in the runtime registry; add a probe that proves a resolved
   global proc call hits the fast path (behavioral identity + a timing sanity check
   is optional — keep it behavioral).
5. Diagnostics polish: warnings grouped, one per (proc, target) not per site.
6. Re-audit + compile proof.

## Verification

- `numUnresolvedCalls` → 0 on tgstation (or ≤ documented procmacro list).
- Corpus compile proof stays green (`--build`, real engine).
- Probes: bare global call, inherited proc call, `..()` with and without parent,
  procmacro call — each with the expected BYOND behavior and expected warning output.
- `npm test` green.

## Success criteria

- Zero silent `Null` from missed call targets; every miss emits a warning.
- Resolved calls use the static fast path; `numBareGlobalProcCalls` counter becomes
  "verified" (0 unresolved).
- PLAN.md Phase 3 symbol-resolution checkbox flips to done.

## Risks / decisions

- **Runtime-defined procs** (created via `new /datum` + `proc` statements in code
  paths, or `call()` on strings) cannot be statically known — these must remain
  runtime-resolution with a **documented whitelist**, not warnings.
- **Perf**: static fast-path must be measured on the compile proof's proc sample;
  if the registry delegate cache is already effectively O(1), skip the fast path
  and keep the plan to diagnostics only.
- **`..()` 22,935 sites**: the current runtime dispatch is correct per probes
  (24/24 include parent dispatch); this plan only adds the emit-time *check*.
