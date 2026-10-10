# W-F (item 27): `new` semantics — loc-arg threading + New() arg fidelity

`numNew` was the largest single emit-loss bucket on tg (~13.3k sites).
Bucketing the counter showed the sites are not one problem but several:
the loc split + New() call already worked (item 63), so the remaining
charge was dynamic typepaths, named args, list/arglist forms, nested
contexts, and BYOND's implicit `..()` constructor chain that was never
emitted at all. This wave fixes the emit side; each section below names
the bucket, the rule, and what is still lossy.

## What `numNew` actually counted (tg bucketing)

~13.3k `new` sites on tg station break down roughly as:

| Bucket | Sites | State |
|---|---|---|
| `new /type(positional args)` | ~10.8k | worked since item 63 (loc split + args to New) |
| bare `new` / `new()` | ~3.3k | works — `/datum` (item 62); typed-local narrowing lost upstream |
| `new /type()` no args | ~2.1k | worked |
| `new <ident>` single-seg var-held typepath | ~0.5k+ | **fixed** — `DMNewPath` |
| `new T(k = v)` named args | ~0.14k | **fixed** — DMNamedArg markers |
| `new x.y` dotted member paths | ~0.1k | parser-level misparse — flagged, not fixed here |
| `new /list` | ~52 | **fixed** — emits a DMList |
| `new T(arglist(L))` | ~14 | **fixed** — DMArgsConcat spread |
| field `var/x = new /path` | ~30 | **fixed** — VarInit seeding |
| `new /a { overrides }` block form | rare | unparseable upstream — documented |

The bucket script is `/tmp/bucket-new.mjs` (reuses the real preprocessor
+ parser, classifies every `new` node's shape).

## 1. Dynamic single-segment paths — `DMNewPath`

`new spawn_type(loc)` — a var holding a typepath — is the top unfixed
bucket (~500+ sites on tg: `type`, `path`, `spawn_type`, `mob`, `turf`,
`item`, `name`…). The parser lowers both `new x` (identifier) and
`new /x` (rooted literal) to the same `typePath: "/x"` AST node, so the
emitter cannot statically distinguish them.

Emission (`// W-F new` region of `csharpEmitter.ts`): any single-segment
typePath emits

```csharp
(await DMNewPath(comp, comp.GetVar("x"), "/x", ...args))
```

and the runtime resolves it: a `Path` value or a typepath-shaped string
(`/seg/seg`, alnum+underscore only — `/icon/x.dmi` is rejected) in the
var wins; otherwise the literal one-segment path stands. Globals-mode
initializers read `GlobalVars.Get("x")` instead.

Known edge (documented, parser-borne): rooted `new /x` together with an
`x` var holding a path in the same scope resolves to the var. BYOND's
own rule for unrooted `new x` is var-first, so this only mis-fires on
rooted literals shadowed by a var — rare in corpus.

## 2. Named args — `DMNamedArg` markers bound on New()

`new T(k = v)` parsed as an `assignment` node and used to emit a real
assignment that wrote the *caller's* `k` and leaked the value
positionally. The emitter now emits `DMRuntimeHelpers.DMNamedArg("k", v)`
markers (the same 2-element list convention `..()`, `animate`, `flick`
and `image` already use), and the `New` chain binds them against the
resolved `New()`'s declared parameter names via the existing
`BindParentCallArgs` — positionals fill the remaining slots in order,
unmatched names drop (BYOND bad-arg), caller vars untouched.

## 3. Atom loc split with named args

`new /atom(L, a, b)` consumes the first *positional* argument as loc for
`MoveAtomTo` + the entity spawn bridge (item 63/69 behavior kept). When
every argument is named, a `loc` marker supplies it. `New()` still
receives the full argument array — corpus `New(loc, ...)` procs bind loc
from their own first parameter — now through the by-name binder.

## 4. BYOND's implicit `..()` New() chain — `CallNewChain`

The big behavioral fix: BYOND runs the *entire* ancestor chain of
`New()` on every construction — each body gets an implicit `..()`
appended — derived first, top of the tree last. The old path ran a
single `CallProc("New")` hop, so parent constructors never fired.

`DMNew` now calls `datum.CallNewChain(args)`: resolve the concrete
type's New (or nearest ancestor's), run it, then keep walking
`TryGetInherited` from the cursor — `NewChainCursor`, an
`AsyncLocal<string>` on `DMRuntimeHelpers` that tracks how deep the
chain has advanced on this logical call stack. `DMNew` saves/restores
the cursor around its chain so a `new` nested inside a New body runs an
independent chain. `CallParentProc` loops for `procName == "new"`: an
explicit `..()` inside a body continues the *same* chain (running all
remaining ancestors once) instead of restarting it — matching BYOND,
where explicit `..()` in New is just the implicit chain made early.

Each hop re-binds the forwarded args against *that ancestor's* declared
parameters (implicit `..()` forwards the arguments the current proc
received). `/world` New, map-spawned entity `ExecuteNew`, and the
turf-mint path in the generated system call `CallNewChain` too, so every
construction site gets the chain.

## 5. Field var initializers — `RegisterVarInit` / `TryGetVarInit`

A type-level `var/x = new /path` reached the IR only as raw text in
`customVars` (field inits carry no expression AST) and landed in
`InitialVars` as the literal string `"new /path"`. The emitter now
re-lexes/re-parses those strings (`parseNewInitializer`) and emits a
`VarInit_<type>` member + `ProcRegistry.RegisterVarInit` registration
per type — including proc-less types, the common case. `DMNew` runs the
seeder before the New() chain (BYOND: field initializers evaluate at
construction); `ExecuteNew` does the same for entity-spawned datums so
their `new`-typed fields overwrite the string placeholders.

Cross-scope limit (flagged, not fixed here): `parseInitialValueText`
stores only the raw text — the declared var type is dropped, so bare
`= new`/`= new()` field inits stay `/datum` rather than the declared
type. Needs the parser to keep `varType` on field decls — sibling scope.

## 6. `new /list` and `arglist`

`new /list` returns a `DMList` (was a dead `/list` datum).
`new T(arglist(L))` — and `arglist` mixed with plain args — emits
`DMRuntimeHelpers.DMArgsConcat(DMArgList(...), ...)` like call sites;
the flattened `DMValue[]` flows through the same loc/named binding.

## Boundary: map-side `new`

`new /turf`/`new /area` on *map* paths is the DMM converter's domain —
map YAML mints turf datums via the turf-mint path in the generated
system (which now also runs VarInit + the New chain). Runtime
`new /turf(...)`/`new /area(...)` in proc bodies stays a datum-level
construction through `DMNew` — no duplication of the map pipeline. A
true turf *swap* semantic (BYOND replaces the tile) is out of scope —
documented, not implemented.

## Still lossy (honest edges)

- `new x.y` (~100+ sites): parsed as property access on `new /x` —
  parser fix required (dynamic member-typepath). Not touched (out of
  declared file scope).
- `new /a { var = v }` block form: parser doesn't produce it; sites that
  parse as postfix survive, others are parse errors upstream.
- `new (expr)` parenthesized constructor: falls to literal `/datum` —
  parse shape unhandled.
- Bare `new` in typed locals (`var/obj/x = new`) can't narrow to `/obj`:
  the local's declared type is dropped by the parser before the emitter
  sees the decl.
- A 2-element plain list passed as a `new` arg collides with the
  DMNamedArg marker shape — same accepted convention as `..()`/animate.
- `var/large/L = new /list` assoc-init `= list(...)` literals are
  already handled elsewhere; this wave only covers `new` inits.

## Files

- `src/transpiler/csharpEmitter.ts` — `// W-F new` emission in
  `case 'new'`, VarInit pass in `emitProcsCS`, `parseNewInitializer`,
  and the three `CallNewChain` dispatch sites in `generateSystemCS`.
- `src/runtimeTemplate/dmRuntimeCS.ts` — `// W-F new` regions: `DMNew`
  (list special-case, named-arg loc split, var-init, chain dispatch),
  `DMNewPath`/`ResolveNewPathExpr`/`LooksLikeTypePath`,
  `NewChainCursor`, `CallNewChain`, the `CallParentProc` "new" loop,
  `ProcRegistry.VarInits`.
- `src/tests/fidelityDifferential.test.ts` — 13 new probes (append-only).
