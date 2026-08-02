# Plan 05 — Appearance / Icon / Overlay System

Status: not started (largest architectural item; today out of scope) · Owner: runtime + render bridge ·
Effort: months (phased) · Impact: unlocks the visual layer — `animate` (939), `image` (678),
`overlays` props (126), `icon_states` (55), `matrix` (254), `flick` (201), `sound` (183),
screen objects, verbs UI — 2026-08-02 Plan 11 re-run counts (all currently stub → Null;
WS7-16)

## Goal

A faithful DM *appearance model* converted to SS14's component/render model, in
phases that each ship something visible:

- **P1** Appearance as data (icon, icon_state, dir, color, transform, layer, pixel
  offsets, overlays, appearance_flags) on `DMRuntime`, no renderer needed.
- **P2** Render bridge: DMRuntime appearance → SS14 `SpriteComponent`/`IconComponent`
  at entity creation and on appearance mutation.
- **P3** `animate()` tweening (color/transform/icon_state) on the engine's animation
  or tick interpolation.
- **P4** Screen objects (`screen_loc`, `plane`, `layer`) → SS14 overlay/UI layer.
- **P5** Input (`mouse_opacity`, click interactions) — only if P4 lands.

## Current state

- DMI→RSI asset conversion exists (`src/dmi`, `scripts`; per-direction delays,
  `iTXt`/`zTXt` handled) and YAML `Sprite` component mapping exists
  (`src/transpiler/yamlGenerator.ts`).
- `animate`, `image`, `flick`, `sound`, `matrix` are in `MAPPED_BUILTINS` but emit
  **stubs**; `overlays`/`appearance` props are in `BROKEN_PROP_NAMES` → `Null`
  (see Plan 07 for the prop plumbing).
- No runtime appearance type exists; `DMRuntime` is a bare var bag + proc registry.

## Design

### P1 — `DMAppearance` data model (`dmRuntimeCS.ts`, engine-free)

```csharp
class DMAppearance {
  DMValue Icon;        // /icon datum or icon file path
  string IconState;
  int Dir;             // 1..8 (BYOND N/S/E/W/NE/...)
  DMValue Color;       // "#rrggbb", "rgb(r,g,b)", or "#rrggbbaa"
  Matrix Transform;    // existing DMMatrix stub → real 3x3 (a,b,c,d,e,f)
  double Layer, Plane, PixelX, PixelY, PixelW, PixelZ;
  DMList Overlays;     // list of /image or appearance refs
  int AppearanceFlags; // LONG_GLIDE, PIXEL_SCALE, ...
  int GlideSize;       // for smooth movement
}
```

- `DMRuntime` gets an `Appearance` slot; every entity-typed datum carries one.
- Overlays semantics: `obj.overlays += /image/x` appends; `overlays.Cut()` clears;
  BYOND culls identical overlays — implement `DMList`-compatible add/cut with
  BYOND's dedup rules.
- Pure data → fully probe-testable engine-free (this is the part that makes the
  plan tractable).

### P2 — Render bridge (`ConvertedDMSystem.cs`)

- On entity creation (Plan 04's `DMNew` bridge): if the datum has an appearance,
  `EntityManager` + `SpriteComponent` with `RSI = icon path`, `State = icon_state`,
  `Color`, `Transform`, `Layer` from the appearance.
- Mutation sync: `appearance` changes go through a single `SetAppearance()` choke
  point that emits a component update event (`AppearanceChangedEvent`); the system
  applies it. This is the SS14-idiomatic part and the main correctness risk.
- `icon` datum (`/icon`): `icon('file.dmi')` already exists as a helper — promote it
  to a real `DMIcon` datum wrapping an RSI/`SpriteSpecifier`; `icon_states()` reads
  states from the converted RSI metadata (already parsed by the DMI pipeline).

### P3 — `animate()`

- BYOND `animate(atom, time, loop, flags, ...)` with `transform = matrix(...)`,
  `color = ...`, `icon_state = ...`, `alpha`/`filters` — one-shot + looping.
- Two candidate engines:
  - **A**: Robust's tween/animation support (if `TransformSystem`/client-side
    animation covers it) — preferred if available in pinned engine.
  - **B**: runtime-side tick interpolation over `GlideSize`/duration using
    `DMTickScheduler` + per-tick appearance updates (portable, engine-free-testable).
- Decision gate: spike both with one probe (`animate` color fade over 10 ticks);
  pick A if it survives the pinned engine, else B. `flick()` = one-shot
  icon_state change → RSI animation state (SS14 RSI animations already support
  per-direction delays).

### P4 — Screen objects / UI

- `screen_loc` parsed (`loc:`/`map:` forms) → SS14 `UIBox`/`Control` overlay; `plane`
  → SS14 `SpriteComponent` plane IDs (document mapping: BYOND plane −1..200+ →
  SS14 `ContentEntitySystem` planes).
- Verbs UI (`set category/name/hidden` — 153 dropped set-modifier sites) → SS14
  context menu/command registration; only if the headless server story (Plan 04)
  is healthy — otherwise keep documented stubs.

## Implementation steps

1. P1: `DMAppearance` + overlays semantics + probes (engine-free). Re-audit
   `overlays`/`appearance` prop reads (117) — they must now resolve (Plan 07).
2. P2: entity-bridge appearance sync; one render probe (converted DMI →
   SpriteComponent fields asserted in YAML/entity data).
3. P3 spike A vs B; implement chosen path; animate probes (color, transform,
   icon_state, loop, callback `animate(... , 0, 0, , /proc/x)`).
4. P4 (optional/decision): screen objects minimum viable (screen_loc → overlay),
   plane mapping.
5. Re-audit: `animate`, `image`, `flick`, `sound`, `matrix` sites lose the
   "stub" label; visual-fidelity smoke via the live server (Plan 04).

## Verification

- P1: engine-free probes for appearance data ops (overlays add/dedup/cut, dir,
  color parse).
- P2: converted entity's `SpriteComponent` fields match the DM source values in a
  server-side assertion scenario.
- P3: animate reaches the expected end state (tick-count assertion), loop count
  correct, callback fires.
- Audit counters: `animate`/`image`/`matrix`/`sound`/`flick` move from "stub" to
  "mapped+verified" in the audit labels; `numBrokenPropRead` overlays → 0.
- `npm test` + compile proof green.

## Success criteria

- An icon/overlay/animate mini-gameplay (e.g. a sprite changing color/icon_state
  with overlays over time) renders identically in converted form per log/state
  assertions.
- 100% of P1/P2/P3 probes green; audit shows the appearance class as verified.
- Screen objects (P4) gated on Plan 04 health — document the decision in this plan.

## Risks / decisions

- **Biggest risk**: BYOND mutates appearance synchronously and per-tick; SS14
  wants declarative component state + events. The `SetAppearance()` choke point
  must catch every mutation path (var sets on `appearance`, `overlays +=`, `color =`
  directly on atom) — inventory these during P2 and fail loudly on uncaught paths.
- **RSI fidelity**: BYOND `icon_state` with dirs maps to SS14 RSI `state_dirs`;
  verify the DMI→RSI pipeline already emits these (it handles per-direction
  delays — assert state naming parity in P2 probes).
- **Filter/lighting** (`filters`, `luminosity`, `light_color`) — defer to P5;
  document as known loss until then.
