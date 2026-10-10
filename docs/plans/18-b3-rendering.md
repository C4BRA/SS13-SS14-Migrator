# Plan 18 — B-3 Rendering/appearance layer (item 71)

Status: **executed 2026-10-10** · scope `src/dmi/rsiWriter.ts`,
`src/transpiler/yamlGenerator.ts`,
`src/transpiler/csharpEmitter.ts` (append-only `// B-3 (item 71)` region
+ named-arg intercept in `transpileCall`),
`src/runtimeTemplate/dmRuntimeCS.ts` (append-only `// ==== B-3 appearance ====`
region + two one-line hooks in existing members),
`src/transpiler/builtinMappings.ts` (STUBBED list only),
`src/tests/fidelityDifferential.test.ts`, `src/tests/rsiWriter.test.ts`
· PLAN.md item 71.

## Problem

Emitted entity prototypes carried `DMRuntime` components but no visual
content: no `Sprite` component, no appearance channel, `dmTile` protos had
no texture so converted maps rendered blank tiles, `overlays`/`underlays`
/`image()` existed only as datum-level lists with no visual meaning, and
`animate()`/`flick()` sat on `STUBBED_BUILTINS` returning Null. The RSI
converter also wrote a state-name-as-directory layout the pinned engine
cannot read.

## Engine facts verified at the pin (RobustToolbox @ 9cefa11)

- `SpriteComponent` is **client-only** (`Robust.Client`); the server calls
  `RegisterIgnore` for `Sprite`, `GenericVisualizer`, `AnimationPlayer`,
  `Input`. Server-visible appearance mutation goes through
  `AppearanceComponent.SetData` (`SharedAppearanceSystem.SetData(uid,
  Enum key, object value)`). Static YAML `Sprite` components still carry
  the *initial* visual to the client at map load — so YAML keeps the
  Sprite and all runtime writes go through the appearance channel.
- YAML `sprite:` field resolves to `TextureRoot / value` = `/Textures/<v>`;
  `state:` must be the verbatim RSI state name. `offset` serializes a
  `Vector2` via `Vector2Serializer` — scalar `"x,y"` string, not a seq.
- RSI loader at the pin is v1 and **flat**: `<rsi>/<stateName>.png`
  (per-state subdirs are *not* read), cells packed **dir-major**
  (all dir-0 frames left-to-right, then dir-1 on the next row), optional
  per-dir `delays` arrays in `meta.json`. `/` inside a state name resolves
  as a subdirectory and is legal; `..`, `\`, empty and leading-`/` names
  must be rejected.
- `RsiDirection` at the pin is `S=0, N=1, E=2, W=3, SE,SW,NE,NW` —
  identical to DMI `DIR_ORDER`, so dir indices pass through unremapped
  (the old `[0,2,1,3]` remap was wrong).
- **DMI cells are frame-major** (`for frame: for dir`), addressed by
  `srcCell = stateBase + f*dirs + d` over `gridwidth = sheet.width/icon.width`.
  The old writer assumed dir-major rows — silently scrambled art.
- `ITileDefinition.Sprite` must be a **raw PNG**, height 32, width
  `32*Variants` — the Clyde tile-atlas builder throws on anything else.
- `PointLightComponent` is server-registerable at the pin (`radius`,
  `energy`, `color`, `offset`, `softness`, `castShadows`, `enabled`).

## Approach

### 1. Entity sprites (goal 1)

`yamlGenerator` emits on every `/obj|/mob|/turf|/area` proto (and the
player-mob fallback proto):

```yaml
- type: Sprite
  sprite: <dmi>.rsi        # 'icons/mob/human.dmi' -> 'icons/mob/human.rsi'
  state: <icon_state>      # verbatim state name
  color: <color>           # when the type declares one
  offset: "<px/32>,<py/32>" # pixel_x/pixel_y in tile units (Vector2 scalar)
- type: Appearance          # runtime appearance channel
- type: PointLight          # when light_range|luminosity > 0
  radius: <lum>
  energy: <light_power>     # optional
  color:  <light_color>     # optional
```

`icon`/`icon_state` are also injected into `DMRuntime.initialVars` so the
datum reads back the same values the Sprite shows.

### 2. Tile sprites (goal 2)

`rsiWriter` now writes flat RSI v1 layout and, next to each
`<state>.png`, a `<state>.tile.png` first-cell (dir-0 frame-0) crop.
`dmTile` protos emit `sprite: /Textures/<rsi>/<state>.tile.png`. A
startup `ValidateTileSprite` pass in the generated system PNG-header-checks
each dmTile sprite (exists, PNG magic, `h == 32`, `w % 32 == 0`,
sets `Variants = w/32`) and drops bad sprites to a blank tile with a
warning instead of letting the client atlas builder crash.

### 3. overlays / underlays / image() (goal 3)

- `underlays` reads as an empty list by default (same as `overlays`).
- `image()` with named args: the parser represents `icon_state = "x"`
  inside a call as an `assignment` node — emitting it as an assignment
  writes the *caller's* vars. `transpileCall` now emits
  `DMRuntimeHelpers.DMNamedArg("name", value)` markers for
  `animate`/`flick`/`image` calls containing assignments, and routes
  `image` to the new `ImageNamed`, which sets named args as real vars on
  the `/image` datum (positional args keep BYOND order icon, loc,
  icon_state, layer, dir, pixel_x, pixel_y).
- `SerializeOverlayList(datum, "overlays"|"underlays")` flattens each
  entry to `"rsi|state|dir|layer|pixel_x|pixel_y|color|alpha"` — text
  entries resolve as an icon_state on the owner's icon, datum entries
  (/image, atoms) carry their own vars with owner-icon fallback — and
  publishes the list through the appearance channel for a client-side
  visualizer to compose (B-5 territory; no client renderer exists yet at
  this pin inside the server-only generated solution).

### 4. animate() / flick() (goal 4)

Real datum-side animation, stepped by `DMTickScheduler` (removed from
`STUBBED_BUILTINS` — no longer counted as loss):

- `Animate(target(s), named..., positional...)` — decodes DMNamedArg
  markers; control args `time/loop/easing/flags/delay` follow BYOND order
  (positional `time, loop, easing, flags, delay` or named). Queues per
  target like BYOND (default queues behind running anims,
  `ANIMATION_PARALLEL` runs concurrently, `ANIMATION_END_NOW` finishes
  and applies pending anims, `ANIMATION_RELATIVE` adds to current value).
  A pump on `RegisterTickCallback` lerps interpolable vars (alpha,
  pixel_*, layer, plane, light_*) each tick boundary; `dir` lerps
  shortest-arc over BYOND's 8-dir angles snapping to the nearest dir;
  `color`/`light_color` lerp #RGB[AA] strings; non-interpolable vars
  apply at segment end. `loop`/`loop=-1` re-queue.
- `Flick(icon_or_state, atom)` — string form swaps `icon_state`, datum
  form adds the /image to `overlays`, and a `Spawn` restores/removes
  after the RSI state's dir-0 delay sum (engine hook
  `RsiStateDurationDs` reads `meta.json` delays, cached per RSI;
  engine-free falls back to one `TickLag`).

Honest losses go to `DMRuntimeHelpers.AppearanceStubCount` — non-LINEAR
easing, `chain`, `transform` tweening, and overlay entries that resolve
to no icon.

### 5. Appearance vars (goal 5)

Every write through `DMRuntime.SetVar` (the single choke point) calls
`DMRuntimeHelpers.OnDatumVarChanged`; when the name is in
`AppearanceVarNames` (icon, icon_state, dir, color, alpha, pixel_*,
layer, plane, invisibility, opacity, mouse_opacity, luminosity,
light_*, overlays, underlays, transform, appearance, blend_mode,
vis_*, maptext*, render_*, screen_loc, gender, suffix, glide_size,
infra_luminosity, base_icon_state, appearance_flags) and the datum is
bound to an entity, `EntityAppearanceBridge` republishes the *whole*
appearance via `AppearanceComponent.SetData` under `DMAppearanceKey`
(wire-stable enum, append-only).

Unassigned reads fall through to BYOND defaults
(`AppearanceVarDefault`): alpha 255, mouse_opacity 1, icon_state "",
layer = area 0 / turf 1 / obj 3 / mob 4 / image -1, everything else 0 —
matching the BYOND ref. (`/obj`, `/mob` are lexical shorthand for
`/atom/movable/*`, so the atom check enumerates the top-level kinds —
the runtime's `IsType` is a path-prefix test.)

Var → engine mapping and limits:

| DM var | mapping |
|---|---|
| `icon`, `icon_state`, `dir` | `DMAppearanceKey.Icon/IconState/Dir` + YAML Sprite seed |
| `alpha`, `color` | appearance data (engine Sprite color is client-side; a visualizer combines them) |
| `pixel_x/y` (+z) | appearance data + YAML `offset` seed |
| `layer`, `plane` | appearance data (draw-order keys for the visualizer) |
| `invisibility`, `opacity`, `mouse_opacity` | appearance data; `opacity` also maps to the ATMOS-ish opacity semantic — engine consumption is visualizer/server-side work, not done here |
| `luminosity`, `light_range`, `light_power`, `light_color` | YAML `PointLight` seed + appearance data for runtime writes |
| `transform`, `appearance`, `blend_mode`, `vis_contents`, `maptext*`, `render_*`, `screen_loc` | stored + republish hooks; **no engine equivalent yet** — counted in `AppearanceStubCount` where applicable (documented stub) |

## Verification

- `npm run build` clean, `npm test` green (incl. generated-solution build
  against the pinned engine).
- `npm run audit:semantics`: **234/234** (218 baseline + 16 new B-3
  probes covering alpha/mouse_opacity/layer/invisibility/opacity/pixel
  defaults, icon_state/underlays defaults, write-back, overlays+=,
  animate time=0 + tween completion + named-arg isolation, flick
  icon_state + /image overlay restore, image() named args).
- Paradise conversion → `dotnet build Content.Server.csproj` = **0 errors**
  (a pre-existing master break — `url_encode(url, 1)` 2-arg call sites vs
  the Tier-4 wave's 1-arg helper — was fixed upstream by the B-4 merge,
  which added the 2-arg overload).
- `bash scripts/boot-smoke.sh` → **PASS** (Ready + spawn bridge).
- Generated-output spot check (paradise): `type: Sprite` with
  `sprite: icons/turf/floors.rsi`, `state: plating`; `type: Appearance`;
  `type: PointLight`; `dmTile.sprite:
  /Textures/icons/turf/floors.rsi/plating.tile.png` (file exists);
  `PushAppearanceData`/`EntityAppearanceBridge`/`ValidateTileSprite`
  emitted in `ConvertedDMSystem.cs`; `DMNamedArg`/`ImageNamed` in
  generated procs.
- Fidelity counter (paradise): `numStubbedBuiltin` ≈2525 → **1908**
  (animate ≈462 + flick ≈155 call sites now real; ± handfuls for
  method-form calls counted by name match).
- `rsiWriter.test.ts` rewritten for the flat/dir-major layout +
  frame-major DMI source indexing.

## Known limits

- **Nothing composes the appearance data into rendered pixels yet** — the
  generated solution is server-side; the client visualizer that turns
  `DMAppearanceKey` data into RSI states/overlays/colors is B-5 work.
  Static initial render comes from the YAML `Sprite`/`PointLight` seeds;
  runtime var writes are published and captured, just not yet drawn.
- Per-tile `dir`/`pixel_y`/`icon_state` overrides in `.dmm` map keys are
  still the pre-existing documented warning list (mapConverter scope).
- `animate` supports LINEAR easing only (others → loss counter); no
  `transform` interpolation; queued `chain` unsupported.
- `invisibility`/`mouse_opacity`/`opacity` are published but have no
  engine consumer yet (same visualizer gap).
- `/icon` datum rendering and `blend_mode` unimplemented (loss counter).
