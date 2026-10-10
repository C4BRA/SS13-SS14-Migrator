# W-B (item 75): visual fidelity wave — ambient light + oversized-tile downscale

Two gaps blocked the converted world from looking like an SS13 station:
unlit map regions rendered pure black (no ambient light was ever seeded),
and any DMI tile state whose source frame was not exactly 32×32 px was
dropped by the engine's tile-atlas loader — on Paradise that was ~24% of
all dmTile protos. This wave seeds a server-side ambient baseline and
emits an always-32×32 tile sprite variant.

## Ambient light — `SeedAmbientLight()` in the generated system

### The API at the pin

`Robust.Shared/Map/Components/MapLightComponent.cs` —
`[NetworkedComponent]` with `[DataField] AmbientLightColor`
(default `Color.FromSrgb(Color.Black)`), changed at runtime via
`SharedMapSystem.SetAmbientLight(MapId, Color)` (`EnsureComp` + `Dirty`,
so it replicates to late-joining clients). On the client,
`Clyde.LightRendering.DrawLightsAndFov` clears each viewport's light map
to `GetClearColor(mapUid)` → `MapLightComponent.AmbientLightColor`; the
final composite multiplies the world pass by that light map. The field
is annotated linear-light — srgb values must go through
`Color.FromSrgb()` or they arrive ~2.2× too dark.

So a server-side ambient API exists at the pin; no per-grid fallback was
needed. (`MapComponent.LightingEnabled` defaults true and
`EyeComponent.DrawLight` defaults true, so the light pass runs on the
generated world with no proto changes.)

### What is emitted — `// W-B light` region in `csharpEmitter.ts`

`StartWorld()` calls `SeedAmbientLight()` right after map load:

```csharp
private static readonly Color DmAmbientSrgb = new Color(0xB0, 0xB0, 0xB0);
private void SeedAmbientLight()
{
    var mapId = EntityManager.GetComponent<MapComponent>(_defaultMap).MapId;
    _map.SetAmbientLight(mapId, Color.FromSrgb(DmAmbientSrgb));
}
```

`0xB0` srgb gray (≈0.69 srgb → 0.434 linear): bright enough that every
entity in the world is clearly visible, dim enough that converted
`PointLight`s still read as lights. The seed is one call on the loaded
map's `MapId`; failures log and never abort world init.

### Verification — windowed client, live A/B/C

Windowed run per docs/plans/20 on the m1-demo (llvmpipe mitigations:
`xrandr 1024x768`, `--connect`). The generated server logged

```
[INFO] dm: World init: ambient light "(0.4341537, ..., 1)" (srgb "(0.6901961, ...)") on map "1"
```

then on the running server console (`setambientlight <map> <r> <g> <b> <a>`,
which routes through the same `SetAmbientLight` → replication):

| Ambient set | Mob sprite pixel | Button sprite pixel | Screen |
|---|---|---|---|
| `0 0 0` (pre-change default) | gone — pure black | gone | world invisible |
| `176 176 176` (our seed) | `(38,116,52)` | `(137,24,24)` | dimly lit, sprites clear |
| `255 0 0` (live probe) | `(60,0,0)` | `(200,0,0)` | whole scene tinted red |

All three while the client stayed connected — proving the seed
replicates and modulates the light pass. Screenshots in the PR body.

## Tile downscale — `.tile32.png`

### The constraint at the pin

`ClydeTileDefinitionManager` throws `NotSupportedException` unless each
tile sprite is a raw PNG of height `EyeManager.PixelsPerMeter` (32) and
width `32 × Variants`. DMIs routinely exceed that — Paradise walls are
32×40 cells, grass 50×50 — and the B-3 writer emitted `.tile.png`
(first-cell crop) at native size, which the atlas rejected.

### What is emitted — `src/dmi/imageScale.ts` + `rsiWriter.ts`

A **second** file per tile state, `<state>.tile32.png`, guaranteed
32×32:

- cell already 32×32 → byte-identical passthrough;
- anything else → **nearest-neighbour resample** to 32×32.

Nearest neighbour over bilinear deliberately: SS13 art is chunky
pixel-art; bilinear smears single-pixel outlines (wall rims, wire)
whereas nearest keeps hard edges and just squashes. Scale-to-fit was
chosen over centre-crop so a 32×40 wall loses ~20% height uniformly
instead of losing its top/bottom border rows entirely.

`yamlGenerator.ts` (`// W-B tiles/light`) now points `dmTile` protos at
`.tile32.png`. The B-3 `ValidateTileSprite` needs no wiring change —
`.tile32.png` satisfies its invariant (h=32, w%32=0, Variants=w/32) by
construction; its docstring was updated to say so. `.tile.png` still
emits unchanged for any consumer wanting native resolution.

### Numbers — Paradise

`npm run convert` on ParadiseSS13/Paradise:

| Metric | Count |
|---|---|
| dmTile protos emitted | 353 |
| …with a sprite | 347 |
| already 32×32 (passthrough) | 264 |
| **recovered by downscale** (was blank/error) | **75** |
| residual: proto references an icon_state absent from the DMI | 8 |

75 + 8 = 83, matching the previously-measured ~24% blank baseline; all
sized tiles now produce an atlas-legal `.tile32.png`. The 8 residuals
are source-data mismatches (protos name icon_states the DMIs don't
contain) — they still blank correctly, unchanged behaviour.

`tests/m1-demo` tiles are 32×32 so its `.tile32.png`s are identical to
`.tile.png`; m1-gate still 5/5 PASS.

## Probes added (append-only)

- `rsiWriter.test.ts`: `resampleNearest` 4→2 down + 2→4 up unit cases;
  `toTileImage32` passthrough / 32×40 squash / 16×16 upscale; integration
  test asserting a 4×3-cell state emits a 32×32 `tile32.png` while
  `tile.png` stays 4×3.
- `runTests.ts`: e2e asserts every `.tile.png` has a sibling
  `.tile32.png`; a direct `YAMLGenerator` probe asserts a turf proto's
  sprite is `…/icon.tile32.png` (and not `…/icon.tile.png`); emitted
  `system.cs` contains `SeedAmbientLight`/`SetAmbientLight`/`FromSrgb`.

All 238 baseline probes still green.

## Known limits

- **Windowed floors still error-tiles** — tile→atlas *registration* is a
  sibling item; this wave only fixed tile *size*. The black region in the
  screenshots is the void/missing-tile area, which ambient correctly does
  not paint (the light map multiplies only what renders).
- Ambient is one uniform map-level color; SS13's per-area `dynamic_lighting`
  is not modelled. `0xB0` is a chosen baseline, tweakable at `DmAmbientSrgb`.
- Downscale is scale-to-fit on the first cell only, matching `.tile.png`'s
  cell-selection; multi-frame tile animations still take cell 0.
