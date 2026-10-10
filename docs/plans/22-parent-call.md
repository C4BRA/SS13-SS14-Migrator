# Plan 22 — `..()` parent-call defining-type plumbing (W-A)

Status: implemented on `devin/w-a-parent-call`. Verification: `npm run build`
clean; `npm test` green incl. generated-solution `dotnet build` vs pinned
RobustToolbox (9cefa116); `npm run audit:semantics` **245/245** probes
(238 baseline + 7 new); `bash scripts/boot-smoke.sh` PASS; paradise corpus
transpile + `dotnet build` 0 errors.

## Problem

`..()` re-resolved the proc through the datum's **concrete** `DMTypePath`:

```csharp
// old runtime
ProcRegistry.TryGetInherited(DMTypePath, procName, out var handler)
```

`DMTypePath` is the instance's runtime type, not the type whose body is
executing. The moment a `..()` ran inside a body that was *not* the most
derived implementation, resolution landed on the same body again:

- `/datum/mid/stamp` calling `..()` on a `/datum/mid/leaf` instance →
  nearest ancestor of `/datum/mid/leaf` defining `stamp` = `/datum/mid`
  itself → the same body → **infinite recursion → stack overflow / hang**.
- Same trap for plain inheritance with no override: a base-defined body
  running on a subtype re-resolved itself.

BYOND semantics: `..()` invokes the implementation on the type **strictly
above the one that declares the executing body** — a static, lexical
property of the body, not a dynamic property of the instance.

## What landed

**Emitter (`csharpEmitter.ts`, `// W-A parent-call (item 22)`):**

- `..()` now emits the **defining type path** as a literal:
  `comp.CallParentProc("/datum/mid", "stamp", ...)`. The emitter already
  knows it — procs emit per type declaration (`currentTypePath`).
- No-arg `..()` forwards the **current values of the declaring proc's
  parameters** (`comp.GetVar("a")` per declared arg, tracked in
  `currentProcArgs`) — BYOND: `..()` without arguments passes the same
  arguments the current proc received. Previously it passed an empty arg
  list, so parents always saw defaults.
- `..(x = v)` named args emit `DMNamedArg` markers (the animate/flick/image
  convention) bound **by name** to the resolved ancestor's params.
- `..(arglist(L))` keeps the existing `DMArgsConcat` spread path.
- `..()` inside a `/proc` global body or a global initializer emits an
  awaitable `DMValue.Null` — BYOND has no parent body there (await-wrapped
  so a statement-position `..()` stays a valid C# expression-statement).

**Runtime (`dmRuntimeCS.ts`, `// W-A parent-call (item 22)`):**

- `DMRuntime.CallParentProc(definingTypePath, procName, args)` walks
  `TryGetInherited(definingTypePath)` — the ancestors of the *declaring*
  type — keeping the `/proc` global-proc fallback.
- `usr` is **not rebound** (the handler is invoked directly, not through
  `InvokeWithUsr`): BYOND propagates the caller's `usr` into the supercall,
  so a verb's `..()` on another atom keeps the mob that ran it.
  `InvokeWithUsr` would have relabelled `usr = src` — same result for
  direct `src.proc()` calls, wrong for `CallVerbAsUsr`.
- `ProcRegistry.TryGetInherited(..., out handler, out resolvedPath)` —
  overload that also reports the ancestor path the proc was found on.
  `..()` argument binding uses the **resolved ancestor's** declared params
  (e.g. `/datum/mid/addem(a,b) -> ..()` binds against `/datum/addem(a,b)`,
  whose names may differ from the child's).
- `BindParentCallArgs(resolvedPath, name, args)`: `DMNamedArg` markers bind
  by name (unmatched names drop — BYOND bad-arg error approximated),
  positional args fill in order with overflow appended, a single assoc
  list gets the same arglist-style named binding `CallProc` applies.
  `TryUnwrapParentNamedArg` mirrors `DMRuntimeHelpers.TryUnwrapNamedArg`
  locally so the shared helper surface stays untouched.

**Tests:**

- `fidelityDifferential.test.ts` +7 probes: override→grandparent-once
  (3-level chain, observed `111`), base-defined body on a subtype instance
  (parent-of-defining, `11`), explicit positional args (`11`), named-arg
  binding on the resolved parent (`-8`), no-arg forwarding of current arg
  values (`42`), `..()` in a `/verb` body (`11`), top-of-chain `..()` →
  null (`1`).
- `csharpEmitter.test.ts` test-20 assertions updated to the new emitted
  shape (`CallParentProc("/obj/foo", "run", ...)`).

## Marker discipline

All edits sit inside `// W-A parent-call (item 22)` regions in
`csharpEmitter.ts` and `dmRuntimeCS.ts` (plus the proc-context bookkeeping
lines feeding them: `currentProcArgs` field + one assignment). No shared
signatures outside the marker were changed — `TryGetInherited` gained an
**overload**, not a signature change; `ReorderNamedArgs` stays owned by
`CallProc` and is mirrored, not refactored, inside the marker. One stale
assertion in `csharpEmitter.test.ts` (test 20) was updated to the new
emission shape — the only non-append edit in `src/tests/`.

## Known limits

- Dispatch remains **prefix-parent**: `TryGetInherited` walks path
  segments, so `parent_type` overrides are ignored — a uniform limitation
  of every runtime dispatch (`CallProc`, verbs, typesof), unchanged here.
- `..()` on a body whose args were passed a *positional* 2-element list
  `[name, value]` collides with the `DMNamedArg` marker shape — only
  unwraps when the name matches a declared param (documented heuristic,
  same trade-off as `animate()`).
- Implicit `..()` inside `New()`/`Del()` — BYOND auto-chains parent
  constructors when the body does not call `..()` itself — is still
  unhandled: `DMNew` invokes the most-derived `New` only. That is a
  separate New-dispatch feature (would need per-invocation "did `..()`
  run" tracking), flagged for the orchestrator.
- `..()` in a `/proc` global body returns Null; BYOND rejects it at
  compile time, we degrade quietly.
