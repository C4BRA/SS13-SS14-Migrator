# Plan 28 — W-G input polish: real WASD movement, real clicks, datum var seeding

Status: **executed 2026-10-10** · scope `src/project/ss14Template.ts`
(client-side input only: `Resources/keybinds.yml` + new
`Content.Client/DM/DMClientInput.cs` emission), append-only `// W-G input`
regions in `src/transpiler/csharpEmitter.ts` and
`src/runtimeTemplate/dmRuntimeCS.ts` (plus two minimal `// W-G` marked
hooks inside shared datum-init paths — flagged below), append-only probes
in `src/tests/fidelityDifferential.test.ts` and assertions in
`src/tests/runTests.ts`.

## Problem

Post-M1 (items 69–76), the converted world's only input path was typed
`dm*` console commands: `dmverb`/`dmclick`/`dmsay` forward to the server
through `IClientConsoleHost.ExecuteCommand`. Three gaps:

1. **No real movement.** WASD/arrow keys did nothing — the player had to
   type `dmverb step_north` per step.
2. **No real clicks.** The engine at pin 9cefa116 has no content
   click→interaction pipeline (only `ClickableComponentState`); nothing
   translated a windowed client mouse click into `Click()`.
3. **Empty `usr.name`/`mob.name`.** Datum `name` (and `desc`/`gender`/
   scalar custom vars) were never seeded from the type's declared
   defaults — `DMNew` created a bare `DMRuntime`, so M1-CLICK printed
   `usr.name == ""`.
4. **Verb discoverability.** `dmverbs` listed verbs only to whoever
   already knew to type it.

## Movement: keybind → Command → dmverb (option (a), chosen per task)

The task offered (a) client-side command keybinds vs (b) a real input
event → shared component → server system → `MoveAtomTo`. **(a) chosen.**

Pin-verified mechanism (`Robust.Client/Input/InputManager.cs:391`):
a `type: Command` keybind runs its whole `function` string through
`IClientConsoleHost.ExecuteCommand` on `BoundKeyState.Down` — identical
to the proven autocmd/typed-console channel, so the command executes
server-side with `shell.Player` = this session and `usr` binds to the
attached mob. `Resources/keybinds.yml` (emitted in B-6) gains:

- `W`/`S`/`D`/`A` and `Up`/`Down`/`Right`/`Left` → `dmverb step_*`,
  `commandWhenUIFocused: false` (default is `true` — without it, typing
  `w` in the debug console `LineEdit` also steps the mob);
- `MouseLeft` → `dmclickpick` (below).

Option (b) was not trivial: it needs a shared input component, a client
event hook that distinguishes world clicks from UI, and a server mover —
real plumbing for zero behavioural gain this wave. (b) remains the right
shape when movement needs server-side speed/prediction.

## Clicks: `dmclickpick` client command

New emitted file `Content.Client/DM/DMClientInput.cs` (auto-registered:
`ConsoleHost` reflects `IConsoleCommand` over the content assembly):

- `MouseGetControl(mouse)` first — a UI control under the cursor (console
  window, menus) means the click was for the interface; the world pick is
  skipped entirely. Verified windowed: `MainViewportContainer` reports
  hovered on every world click (it owns the map viewport), so only
  **non-viewport** controls count as a UI click — without that exception
  every world click is swallowed.
- `ScreenToMap` → iterate `EntityQueryEnumerator<SpriteComponent,
  TransformComponent>` → `SpriteSystem.CalculateBounds` (the renderer's
  own bounding box, world-rotated by `CurrentEye.Rotation`) → topmost hit
  by `SpriteComponent.DrawDepth` (uid tie-break for determinism).
- **Picked entity → `dmclick x,y,z`, not `dmclick @uid`**: EntityUid is
  per-side — client uid 4 was the button while server uid 4 was a mob
  (verified live: `dmclick @4` clicked a mob, silently no-op). Forwarding
  the picked entity's floored world tile + its parent-grid z routes the
  SAME semantics (server `x,y,z` resolver returns the non-turf atom at
  the tile — the picked entity).
- Bare ground: same `dmclick x,y,z` with z from the player's parent grid
  name `grid_z<N>`, default 1.

`dmclick` already resolves `/type/path` and `x,y,z` targets and
binds `usr` — same session binding as a typed command, no server-side
changes needed (`DMPermissions.Allowed` unchanged; `dmclickpick` is
client-local, never crosses the wire).

## usr.name / datum var seeding

BYOND order at datum creation: **var defaults → loc → New()**. Neither
`DMNew` nor `OnDMComponentInit`/`RegisterGrid` applied type defaults.

- Runtime (`dmRuntimeCS.ts`, `// W-G input`): `TypeVarInits`
  dictionary keyed by DM type path, `SeedVar` (writes `Variables` AND
  `InitialValues` — the *last* seed wins both, because the whole ancestor
  chain is "creation time" for `initial()`), and `ApplyTypeVarInits`
  (root→leaf prefix walk over the type path, same ancestor shape as
  `ProcRegistry.TryGetInherited`).
- Emitter (`csharpEmitter.ts`, `// W-G input`): every IR type gets a
  `TypeVarInits["/path"] = c => {...}` registration emitted in the
  proc-registration pass. Seeded: `name` (effective BYOND name — own
  declared, else nearest ancestor's declared, else basename), `desc`,
  `icon`/`icon_state`, `density`/`anchored`/`opacity` when true, and
  custom vars whose normalized initializer is an unambiguous scalar —
  number, bool literal (`true/yes/on/false/no/off`), `/type/path`, or
  identifier-safe bare text (quoted literals survive IR normalization
  quote-stripped; `gender` always forced to text). Expression
  initializers (`list()`, `new`, calls, arithmetic) stay unseeded — the
  IR's normalized text can't distinguish a quoted string from an
  identifier, and a mis-seeded string is worse than an unseeded var
  (documented loss).
- Call sites (minimal `// W-G` marked edits in shared datum-init code,
  flagged): `DMNew` (after `LiveDatums.Add`, before loc + `New()`),
  `OnDMComponentInit` (after DMTypePath, before proto `initialVars` so
  proto values still win, and before `New()`), `RegisterGrid` turf mint.

`initial()` reads `InitialValues`; because `SeedVar` records the
most-derived seeded value there, `initial(d.name)` now returns the
declared default — more correct than the first-write approximation.

## Verb visibility

`dmcontrols` client command (same emitted file): prints the input map
(WASD/arrows move, left-click clicks, Tilde console) and points at
`dmverbs` — the server-side listing already reaches the client's console
via the shell binding, so a command listing satisfies the "reachable"
requirement cheaply. For that to be *actionable* the emitted
`keybinds.yml` now also carries the standard text-editing binds
(`Return`/`NumpadEnter` → `TextSubmit`, `Escape` → `TextReleaseFocus`,
`Tab` → `TextTabComplete`, Up/Down history, BackSpace/Delete, cursor
keys, Home/End) — without them the console accepts typed text but can
never submit it (found by the recorded E2E pass). Arrow text binds
co-exist with the movement binds: while a LineEdit holds focus the
movement `Command` binds are suppressed by `commandWhenUIFocused:false`
and the `Function` binds route to the focused control; with nothing
focused the Function binds no-op and movement runs.

## Verification

- `npm run build` clean, `npm test` green incl. the real-engine generated
  build (0 errors), `npm run audit:semantics` **274/274** (267 baseline +
  +7 new W-G probes: declared/inherited/basename name seeding, runtime
  write wins, scalar custom var, desc, `initial()`).
- Emit assertions in `runTests.ts` pin the TypeVarInits registration,
  SeedVar emission, keybinds, and `DMClientInput.cs` contents.
- `scripts/m1-gate.sh` 5/5 PASS on this branch (E1 map, E2 attach,
  E3 sprite, E4 movement, E5 click) — incl. `M1-CLICK: m1 player
  pressed the button` (seeded name visible where it used to print empty).
- **Windowed xdotool evidence (live, `:0`, llvmpipe)**:
  - WASD: real X11 `key w`/`key d` presses → server log shows
    `con: player:dmverb step_north` + `M1-MOVE: mob moved to 1,2,1` /
    `1,3,1` / `2,3,1` — movement without typing any command.
  - Click: real X11 `click 1` over the rendered button sprite →
    `DMCLICKPICK hit uid=4 tile=5,5` → `con: player:dmclick 5,5,1` →
    `M1-CLICK client: you pressed demo button` (client console) and
    `M1-CLICK: m1 player pressed the button (01x)` (server+client).
  - Histogram-verified render: button `(200,40,40)` and mob
    `(60,170,80)` each exactly one 32×32 tile.

## Known limits

- Command binds fire once per keypress; held-key repeat is a later-wave
  nicety (`canRepeat` semantics at the pin need a state-machine check).
- `dmclickpick` hit-tests sprite bounds only — no icon-state pixel
  accuracy, no overlays/mouse_opacity, no range check (BYOND permits
  clicking out-of-view anyway).
- Seed coverage: scalars + identity vars only; `list()`/`new`/expression
  initializers still start null (BYOND would evaluate them at compile
  time).
- Declared-name-equal-to-basename is indistinguishable from undeclared in
  IR — same emitted value either way, no observable loss.
- A click during `world.Sleep`-blocked server frames queues like any
  command — same as typed dmclick.
