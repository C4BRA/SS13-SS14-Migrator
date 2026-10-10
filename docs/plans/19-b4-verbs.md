# Plan 19 — B-4 verbs / input / interaction layer (item 72)

Status: implemented on `devin/b4-verbs-input`. Predecessor: item 76 (B-8 speed).
Verification: `npm run build` clean; `npm test` green incl. generated-solution
`dotnet build` vs pinned RobustToolbox (9cefa116); `npm run audit:semantics`
222/222 probes (218 baseline + 4 new); `bash scripts/boot-smoke.sh` PASS.

## Problem

Converted mobs spawned and ticked (B-1/B-2) but could not *do* anything:
`/verb` decls parsed into the proc registry but were unreachable, `world <<`
went to a host-console `WriteLine` no player ever saw, `mob.client` was a
typed var with no session, and there was no click/interact path at all.

## What landed

**Runtime (`DMRuntimeHelpers.cs` tail, `// ==== B-4 verbs/input ====`):**

- `DMVerbRuntime` — engine-free verb/input support:
  - `CallVerbAsUsr(target, usrMob, procName, args)` — BYOND verb semantics:
    `src` = the verb's datum, `usr` = the *caller's* mob (they differ for
    obj/turf verbs). Mirrors `CallProc`'s registry walk (exact → inherited →
    `/proc`) plus the assoc-list→named-arg binding used by `call()`/arglist.
  - `HasProc`, `DatumForEntityId`, `DatumForPath`, `DatumAt(x,y,z)` — the
    datum lookups command args resolve through.
  - `OutputBridge` — `Action<DMValue,DMValue>?` the engine adapter installs;
    null engine-free (stdout fallback preserved).
- `DMValue.Output(target, message)` is now the real `<<` dispatcher: list
  LHS appends (copy-on-write), datum LHS sends through the bridge/stdout and
  returns the target so `usr << a << b` chains, everything else shifts.
- `ProcRegistry.EnumerateProcs(typePath)` — every callable proc incl.
  inherited (verb panel / `dmverbs`).
- `DMRuntimeHelpers.Output(params)` — the `output()` builtin now routes its
  message arg through `<<` instead of silently returning Null.
- `Winset`/`Winget` explicit Null stubs (were emitted as unbound proc calls).

**Emitter (`csharpEmitter.ts`, `// B-4 (item 72)`):**

- `x << y` emits `DMValue.Output(x, y)` everywhere (expression position too).
- Statement-level `x << y` on a local var emits the compound writeback
  `comp.SetVar("x", DMValue.Output(x, y))` — `n << 2` shifts n, `L << x`
  appends to L. `src`/`usr`/`world`/`args` are runtime-bound and
  property/index LHS have no writeback (send side effect still runs).
- Generated `ConvertedDMSystem.cs` gains, appended after `DMTilePrototype`:
  - `DMCommands` helpers — `MobDatum` (session→attached entity→runtime
    component→DM datum), `ResolveTarget` (`@uid` / bare digits → entity,
    `/type/path` → live datum, `x,y,z` → atom at DM tile coords),
    `ParseArg`/`ParseArgs` (positional literals; all-`k=v` collapses to an
    assoc list for BYOND named-arg binding), `Fire` (fire-and-forget with
    error reporting to the shell).
  - `DMVerbCommand` (`dmverb <proc> [args]`) — mob's own verbs, src=usr=mob.
  - `DMVerbOnCommand` (`dmverbon <target> <proc> [args]`) — obj/turf verbs,
    src=target, usr=caller's mob. The honest stand-in for context-menu verbs.
  - `DMClickCommand` (`dmclick <target>`) — fires the atom's `Click()` proc
    with BYOND args (location=clicked atom, control=null, params=empty list),
    src=clicked atom, usr=caller's mob. This is M1's "interacts with one
    object" — the engine has **no** server-side click pipeline at pin
    9cefa116 (verified: only `ClickableComponentState`), so the interaction
    event is a command until the client entry (B-5) sends a real one.
  - `DMSayCommand` (`dmsay`) — routes through the mob's `say` proc/verb when
    the codebase defines one, else broadcasts `name: text` to all InGame
    session consoles.
  - `DMOocCommand` (`dmooc`) — broadcast OOC to all InGame sessions.
  - `DMTopicCommand` (`dmtopic <href>`) — `world.Topic(href)` dispatch; the
    browse/link equivalent for a world with no browse controls.
  - `DMVerbsCommand` (`dmverbs`), `DMLocCommand` (`dmloc`) — verb listing
    (inherited-aware) and mob coords for `dmclick x,y,z`.
  - `DMPermissions` — `IConGroupControllerImplementation` installed at
    Initialize: **required**, because `ConGroupController.CanCommand` is
    `Implementation?.CanCommand(...) ?? false` — without it every
    client-typed command dies as "Unknown command". Allows only the eight
    `dm*` commands for player sessions; server console bypasses the check.
- `Initialize()` wires `DMVerbRuntime.OutputBridge = DmOutput` and the shim.
- `SpawnPlayerMob` calls `BindClientDatum(session, uid)`: mints a `/client`
  datum with `mob` backref, `key`/`ckey`/`address`, and a `__session` tag
  (NetUserId) so `mob.client`, `client.mob`, and `client << x` resolve.
- `DmOutput` routing: `world << msg` → every InGame session console via
  `IServerConsoleHost.WriteLine` **plus** the server log; mob/client datum
  targets → their owning session's console (`__session` → session-by-id,
  else `client` var → session-by-entity); unbound datums → server log.

**`builtinMappings.ts`:** `winget` added to MAPPED+STUBBED (was unmapped →
proc-call warning), explicit `winset`/`winget` cases → the new stubs.

## Client boundary (B-5/B-6 owns the real client)

Everything above works for **any `IConsoleShell`** — the server console and
connected clients alike, today, through the in-game console. A real
Robust.Client integration needs:

1. Chat/console input that forwards `dm*`-prefixed text via
   `RemoteExecuteCommand` (or binds keys/verb-panel clicks to `dmverb`).
2. A click path: client click → either `dmclick <uid>` or a content-defined
   interaction event → `DMVerbRuntime.CallVerbAsUsr(target, usr, "Click")`.
   `ClickableComponent` state exists engine-side; the interaction event
   pipeline is Content-level (not in RobustToolbox at this pin).
3. Verb panel / right-click menu fed by `dmverbs` output (or a replicated
   proc list).
4. Chat UI rendering `IServerConsoleHost.WriteLine` output — already reaches
   the session's console window; a chat box just needs to render the same.
5. `Browse`/`winset`-style windows have **no** equivalent — they stay Null
   stubs; `dmtopic` is the href-routing substitute.

## Verification

- `npm test` — all suites green; real-engine generated-solution build exit 0
  (the emitted `dm*` command classes compile against pinned RobustToolbox).
- `npm run audit:semantics` — **222/222** (218 baseline + 4 new probes:
  `<<` dispatch on list/number/datum targets, `<<` chaining, `CallVerbAsUsr`
  src/usr binding, assoc-list named-arg binding).
- `dotnet build` of a generated paradise solution — 0 errors.
- `bash scripts/boot-smoke.sh` — PASS.
- New emitter assertions (csharpEmitter.test.ts 45/46) lock the `<<`
  emission shapes and every `dm*` command class in the generated system CS.

**Needs a live client to prove (B-6):** an actual connected player typing
`dmverb`/`dmsay`/`dmclick` and seeing `world <<`/`mob <<` text arrive in
their console/chat. Server-side dispatch, usr/src binding, output routing,
and the permission shim are all proven compile-clean and probe-tested here.

**Live-server verification (E2E, headless console):** a converted fixture
world was built against the pinned engine and the dm* bridge exercised via
the server console — all 8 commands dispatch (unregistered commands are
rejected as unknown), `dmverbon`/`dmclick` resolve `@uid`, `/type/path` and
`x,y,z` targets, positional and `k=v` named args bind, `Click()` and
`world.Topic` fire, `world <<`/`usr <<` land in the server log via sawmill
`dm.out`, and session-less commands report `no DM mob attached` honestly.
Fix from that run: `world.log` is now bound to the world datum so
`world.log << x` routes through the output bridge (was a silent shift).

## Known limits

- `/verb` metadata (`set src in view()`, `set category`, `set hidden`) is
  parsed then dropped — parser out-of-scope; every callable proc is treated
  as a verb (superset of BYOND's verb panel, documented).
- Statement-level `x << y` writes back only for local vars; property/index
  LHS (`a.b << n`) performs the send/shift but does not write back (rare).
- `dmclick` uses the command arg forms `@uid | /type/path | x,y,z` — a real
  click ray is B-5's client event.
- `alert()`/`input()` remain Null stubs (no modal UI to answer them); verbs
  that require an answer get Null — consistent with pre-existing stub policy.
