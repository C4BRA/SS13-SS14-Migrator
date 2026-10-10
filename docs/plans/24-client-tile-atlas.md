# W-C — Client tile atlas: dmTile registration on the client

Item: W-C (client tile atlas). Converted `dmTile` prototypes were registered
only server-side, so the client's tilemap resolved every converted tile id to
the atlas' error cell — floors/walls drew nothing (previously documented as
"client-side tiles draw nothing", docs/plans/20,21). This item makes the
client register the identical defs and build its texture atlas with them.

## The actual mechanism at pin 9cefa116 (engine study)

`ClydeTileDefinitionManager` (client impl of `ITileDefinitionManager`) builds
its tile texture atlas inside `_genTextureAtlas()`, which runs **only** from
`Initialize()` — `IPostInjectInit.PostInject()` merely grabs the sawmill
(`ClydeTileDefinitionManager.cs:63-73,264`). Nothing in the engine calls
`Initialize()` for content: that call is content's own job. Stock SS14 does it
in `Content.Shared EntryPoint.PostInit` → `InitTileDefinitions()` (register
Space first — "hard coding hack" — then sort the rest ordinal "so that tile
IDs match up", then `_tileDefinitionManager.Initialize()`).

Entry-point discovery at this pin: `BaseModLoader.InitMod` scans
`mod.GameAssembly.GetTypes()` for `GameShared` subclasses
(`BaseModLoader.cs:38-52`), and `GameController.LoadModules` loads **every**
`/Assemblies/Content.*.dll` as its own mod
(`GameController.cs:334-356` → `ModLoader.TryLoadModulesFrom`). So a
`GameShared` class emitted into `Content.Shared` gets `PreInit/Init/PostInit`
on **both** client and server — the same mechanism upstream uses. On the
client, `BroadcastRunLevel(PostInit)` fires after
`_prototypeManager.LoadDefaultPrototypes()` and before connect
(`GameController.cs:188-254`), which is exactly the right lifecycle point:
defs are deserialized, atlas has not been needed yet.

Ordering/id-parity constraints (why this had to be shared code, not a client
copy):

- `Tile.TypeId` is a raw `ushort`/`int` serialized into grid states —
  client and server must assign **identical** ids.
- `PrototypeManager.EnumeratePrototypes` returns `FrozenDictionary.Values` —
  hash order, and .NET string hashing is seeded per process → enumeration
  order would differ between the two processes.
- `Tile.IsEmpty` is `TypeId == 0` and tilemap `0:` entries mean space →
  `dm_space` must be pinned to id 0.
- Sprite validation must run identically on both sides or the effective def
  sets diverge.
- `Register` throws on duplicate names and `Initialize` must run once per
  process — both call sites guard with one idempotent registrar.

## What changed

- **`src/project/ss14Template.ts`** (owned): emits
  `Content.Shared/DM/DMTileDefs.cs` containing:
  - `DMTilePrototype` (moved out of `Content.Server` — one type now
    materializes client-side so dmTile protos deserialize there);
  - `DMTileDefsEntryPoint : GameShared` — `PostInit()` calls
    `DMTileDefs.EnsureRegistered()`;
  - `DMTileDefs.EnsureRegistered()` — static, idempotent: enumerates dmTile
    protos, sorts `dm_space`-first then `string.Compare(Ordinal)`, runs
    `ValidateTileSprite`, `Register`s each, then calls
    `ITileDefinitionManager.Initialize()` (server impl: no-op; client impl:
    builds the atlas and wires proto-reload listeners) and logs
    `Registered {N} converted tile definitions` (m1-gate greps this line —
    preserved, now with `%d` `{0}` formatting that also matches the old
    regex).
  - generated `Content.Shared.csproj` now imports `Shared.props`,
    `Robust.Properties.targets` (wires the serialization source generator —
    **required**, without it partial DataField types get no
    `ISerializationGenerated` impl and `SerializationManager.Initialize`
    crashes at boot with a `DataDefinition<T>` constraint violation), and
    `Robust.EntitySystemSubscriptionsGenerator.targets` (same imports the
    Server/Client csprojs carry).
- **`src/transpiler/csharpEmitter.ts`** (`// W-C client tiles` marker
  regions only):
  - `DMTilePrototype` class and `ValidateTileSprite` removed from the emitted
    server system (replaced by marker comments; the shared file now holds
    them);
  - `RegisterTileDefs()` now delegates to `DMTileDefs.EnsureRegistered()` —
    kept so `StartWorld`'s map load can never run ahead of registration
    regardless of which entry point fires first;
  - `_tilesRegistered` field removed.
- **Generated `Content.Client/EntryPoint.cs`**: `RegisterIgnore("dmTile")`
  removed — the client now loads the dmTile kind (it lives in shared code,
  so the client's PrototypeManager knows it).
- **`src/tests/runTests.ts`** (append-only): the stale
  `RegisterIgnore("dmTile")` assertion flipped to assert its absence; 9 new
  probes over the emitted shared file + server delegation.

## Verification

- `npm run build` clean; `npm test` green — all existing assertions plus the
  10 new W-C ones; includes the real-engine compile of the generated
  solution (exit 0).
- `npm run audit:semantics` — **238/238** probes preserved.
- Fixture convert → `dotnet build Content.sln` → **0 errors** → server boots
  → `Server Version 285.0.0.0 -> Ready`, `Registered 2 converted tile
  definitions` (fixture has dm_space + dm_turf).
- `scripts/client-smoke.sh` — **PASS** (headless client connects, receives
  Full GameState, B-1 attach fires).
- `tests/m1-demo` convert → build 0 errors → headless client log:
  ```
  [DEBG] clyde: Tile atlas took 00:00:00.0045953 to build
  [INFO] dm: Registered 5 converted tile definitions
  [INFO] state: Received Full GameState: to=1, sz=1745
  [DEBG] client: Runlevel changed to: InGame
  ```
  — the atlas build fires client-side immediately after registration, the
  client then connects and plays.
- **Windowed evidence**: same run windowed (llvmpipe mitigations:
  `ALSOFT_DRIVERS=null LP_NUM_THREADS=2`, Eye `drawLight:false` on the mob
  protos for fullbright QA) — screenshot shows the m1-demo room's floor and
  wall tiles rendered (grey floor field, dark wall ring, obj + mob sprites)
  where the same view previously drew nothing.
- Paradise corpus (repo root): **28,425 types** converted incl. **353 dmTile
  protos** → `dotnet build Content.sln -m:1` → **0 errors** (shared engine
  obj/ churn required the usual serial retries — pre-existing flake).

## Notable trap found

Moving the prototype class into `Content.Shared` initially crashed the
server at boot: `GenericArguments[0], 'Content.Shared.DM.DMTilePrototype',
on 'DataDefinition<T>' violates the constraint` — the generated shared
csproj lacked `MSBuild/Robust.Properties.targets`, so the Robust
serialization generator never ran there and no `ISerializationGenerated`
impl was emitted for the `partial` proto class. Fixed by importing it (and
`Robust.EntitySystemSubscriptionsGenerator.targets`) — same imports the
generated Server/Client projects already had.

## Known limits

- Tiles render their own sprite crops; turf edge-sprite smoothing is not
  wired (same as before — `EdgeSprites` data exists but nothing assigns it).
- `reloadtiletextures` / proto-reload on the client now rebuilds the atlas
  via the engine's own reload hook (subscribed in `Initialize`) — dmTile
  re-registration on hot reload isn't a scenario the pipeline produces.
- The windowed screenshot needed `drawLight:false` on the mob Eye (engine
  has no lights in converted worlds — unrelated, documented in
  docs/plans/21).
- The headless `_genTextureAtlas` path builds the ImageSharp sheet and the
  DummyTexture upload — exercised and logged; GL upload is untested here by
  nature.
