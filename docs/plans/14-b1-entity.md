# Plan 14 — B-1 Entity Integration Wave (item 69, remaining increments)

Status: **executed 2026-10-10** · branch `devin/b1-entity-wave`
Predecessor: PLAN.md item 69 first increment (spawn bridge + world/New on master @ acc9ff5).
Verification: `npm run build` clean · `npm test` ALL PASSED · `npm run audit:semantics`
**182/182** probes (baseline 171 + 11 new) · `scripts/boot-smoke.sh` **PASS**
(server Ready, 0 boot errors, spawn-bridge assertion green) against the pinned
RobustToolbox checkout (9cefa116, `engine.pin`).

## Problem

Item 69's first increment gave `new /obj|mob|turf|area` a real SS14 entity, but the
datum layer still lacked containment (`.loc` was a raw stored var, `contents` an
empty default), x/y/z were ignored, map YAML could not deserialize at the pinned
engine, map-spawned atoms had no datums, and there was no player attach path.

## What landed

### 1. `.loc` chains / containment (datum level, engine-free)

`DMRuntimeHelpers.MoveAtomTo` is now the single move path for `loc` writes:
`new /obj/x(parent)`, `x.loc = y`, and the `i.loc` setter all flow through it.

- `contents` membership is **computed, not stored**: `ContentsOf(datum)` scans
  `LiveDatums` — atoms whose stored loc var references the container, plus (for
  `/turf` only) positioned atoms whose loc is unset. This matches BYOND where
  `x.loc = t` both adds to `t.contents` and removes from the old container's.
- `ResolveLoc` returns the containing datum: an explicit container stored in the
  var wins; a positioned atom with no stored container resolves to the `/turf`
  datum at its x/y/z (map-spawned atoms never write the var). Approximation:
  `loc = null` on a positioned atom still resolves positionally (BYOND treats
  it as nullspace) — documented.
- `Enter`/`Entered`/`Exit`/`Exited` fire when defined in the proc registry,
  guarded by `CanCallProc` (absence is fine; `Exit`/`Enter` returning falsy
  vetoes the move; `Entered`/`Exited` are notifications).
- `for (var/o in x)` over an atom now iterates `x.contents` (DMListItems datum
  case).
- Bare `loc`/`contents` var reads in emitted procs route through
  `DMGetProperty` so computed semantics apply without the DM code naming a
  property. Writes to `loc`/`x`/`y`/`z` (property_assignment, assignment
  expression, AssignmentStatement) route through `DMSetProperty`.

### 2. x/y/z vars + movement, entity-bound

- Atom `x`/`y`/`z` read/write as numbers (0 = off-map), engine-free.
- `step` and coordinate writes go through `SetAtomPosition` which syncs the
  datum vars **and** the bound entity's transform when `EntityId != 0`.
- `RefreshTurfLoc` repairs a stale turf loc when a coordinate write crosses a
  tile boundary (set onto the turf now under the atom).
- `DMRuntime` gains three server bridges alongside `EntitySpawnBridge`:
  `EntityMoveBridge` (var writes → `SetCoordinates`), `EntityCoordBridge`
  (reads → live `TransformComponent` position, `z` from the parent grid's
  DM z-level), `EntityAttachBridge` (loc datum → `SetParent`, else
  `AttachToGridOrMap`). Engine-free runs never set them.
- DM tile coordinate convention: DM (x, y) = SS14 tile index (x−1, y−1);
  an atom's `x`/`y` is `floor(localPos) + 1`; `z` indexes the grid
  (MetaData name `grid_z<N>`).

### 3. Map-spawned atom runtimes

The map converter was rewritten for the pinned deserializer (the old output
used `format: 2`, string tilemap values, 3D positions, and 8×8 chunks — all
unreadable at pin 9cefa116 where OldestSupportedVersion=3):

- `meta.format: 6` + `postmapinit: true` (entities load live/unpaused; v7's
  `maps/grids/orphans/nullspace` lists aren't required at 6).
- `tilemap:` maps **int yaml tile ids → tile-def names** — names of new
  `type: dmTile` prototypes the yaml generator emits alongside each `/turf`
  entity proto (turfs are tile *definitions*, not entity protos, at this pin).
  `DMTilePrototype : ITileDefinition` is generated in ConvertedDMSystem.cs and
  `ConvertedDMSystem.RegisterTileDefs` registers all `dmTile` protos with
  `ITileDefinitionManager` before map load.
- Chunks are 16×16 (`size` default 16) binary blobs — node
  `{ind: "x,y", tiles: <base64>, version: 7}` with 7 bytes/tile
  (int32 yamlTileId, flags, variant, rotationMirroring) row-major.
- Each DMM z-level becomes one grid entity (`MetaData name: grid_z<N>`)
  parented to the map entity; entities are proto-grouped
  (`- proto: X` + `entities:`) with 2D `pos` at tile center
  (`worldX−0.5, worldY−0.5`) and `parent:` = grid yaml uid.
- `StartWorld` loads the first `/Maps/*.yml` via `MapLoaderSystem.TryLoadMap`
  (falls back to `CreateMap`), then `RegisterGrid` mints a `DMRuntime` datum
  per non-empty tile (dmPath taken from the `DMTilePrototype` that produced
  the tile) with correct x/y/z vars + `New()` dispatch — turf
  `contents`/`loc`/`type` work datum-side for map-spawned atoms.
  Note: ComponentInit on `MapGridComponent` belongs to SharedMapSystem at this
  pin (ComponentEvent lifecycle events allow one subscriber per comp+event —
  an extra subscription crashes at startup), so minting happens post-load.

### 4. Player mob

- `dm_player_mob` entity proto emitted unconditionally: `Eye` component (camera)
  + `DMRuntime` bound to `/mob/living/carbon/human` when the codebase defines
  it, else `/mob`, + a Sprite borrowed from the first iconned /mob type.
- `IPlayerManager.PlayerStatusChanged`: `Connected` → `JoinGame(session)`
  (converted world has no lobby); `InGame` → `SpawnPlayerMob` spawns the mob
  proto on the z-grid (prefers `mob_living_carbon_human` when emitted, else
  `dm_player_mob`) and `SetAttachedEntity` binds the session (adds
  `ActorComponent` server-side).
- **Limit**: no engine-side verification of an actual client connection —
  boot-smoke has no client. Attach logic is compiled + wired but exercised
  only at runtime by a real connect.

### 5. Probes (11 new, 182 total)

fidelityDifferential.test.ts: contents membership after `new` in loc,
`.loc` reads the container datum, loc-setter move semantics both ways,
`loc = null`, x/y/z read/write, positional turf contents, `.loc` → turf,
Enter/Entered on set, Exit/Exited on clear, for-in over contents, and
x-write crossing a turf boundary updating loc.

### Baystation fixes (folded in per orchestrator note)

- **CS0140 duplicate label**: repeated DM label names in one proc now get
  unique C# labels (`__dmLabel_x`, `__dmLabel_x_2`, …) via a per-method
  occurrence counter; labeled `break`/`continue` resolve to the innermost
  enclosing block with that DM name (label-scope stack).
- **CS1501 get_step_to arity**: BYOND's optional trailing args added —
  `GetStepTo(atom, trg, speed=0, min=0)`, `GetStepTowards(+speed)`,
  `GetStepRand(+speed)` (args accepted, ignored under the straight-line
  approximation).

## Verification performed

- `npm run build` — clean (tsc strict).
- `npm test` — ALL PASSED (runTests map assertions updated to format-6 shape;
  fixture now declares its turf types as a real corpus would;
  csharpEmitter.test.ts while/for body expectations updated for DMSetProperty).
- `npm run audit:semantics` — **182/182** (171 baseline + 11 new probes).
- `scripts/boot-smoke.sh` with `SS14_ENGINE_DIR=~/repos/RobustToolbox`
  (submodules initialized this session) — **PASS**: server reached
  `Ready`, 0 boot errors, spawn-bridge assertion fired. During development
  the real-engine build caught and fixed two real bugs: `DMTilePrototype`
  must be `partial` (RA0017), and a second `MapGridComponent+ComponentInit`
  subscription is a startup crash (see §3).
- Engine APIs verified by reading RobustToolbox @ 9cefa116:
  EntityDeserializer (format-6 proto-grouped entities, tilemap→tile-def names,
  chunk blob layout, postmapinit), ITileDefinition(Manager).Register,
  MapLoaderSystem.TryLoadMap, SharedTransformSystem (SetCoordinates/SetParent/
  AttachToGridOrMap), IPlayerManager (PlayerStatusChanged/JoinGame/
  SetAttachedEntity), MapGridComponent (16×16 default), TileRef/GetAllTiles.

## Known limits / unverified

- Real client attach (increment 4) is wired but not exercised — needs a live
  client connection.
- Engine-side x/y/z/movement bridges compile and are wired; live correctness
  (step→transform round trip) is not exercised by boot-smoke (no movement
  command); datum-side semantics are probe-covered.
- Turf datums are minted for loaded-map tiles only; `SetTile`-created tiles
  at runtime get no datum.
- `loc = null` on a positioned atom still resolves positionally (approx).
- get_step_* optional speed/min args are accepted but ignored
  (straight-line approximation).
- Map files are one map entity + N z-grids in a single file (multi-z corpora
  should be checked; format-6 allows it).
- Tile sprites are not emitted (RSI paths don't map to tile texture ResPaths);
  tiles render blank until sprite mapping lands.
