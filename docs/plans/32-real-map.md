# Plan 32: real Paradise station map (NSS Cyberiad) — convert, boot, walk end-to-end

Wave item: take paradise's real primary station map through the full pipeline —
convert, `dotnet build`, server boot, headless client connect, walk, click —
at production scale (thousands of atoms, real turf/area/variant volume).

Map used: `_maps/map_files/stations/boxstation.dmm` — NSS Cyberiad, paradise's
primary station (255×255, 10,392 tile-key definitions, ~2.5 MB TGM).

## What changed (in scope)

### `src/dmm/mapConverter.ts` — scale + fidelity

- **Per-atom map attributes → variant prototypes.** Paradise DMM tiles carry
  braces attributes (`icon_state`, `dir`, `pixel_x`, `name`, `req_access_txt`, …)
  per placed atom. 18,184 attributed placed atoms now emit `__mv<N>` variant
  prototypes under `Resources/Prototypes/map_variants/<map-mirrored path>`
  (`parent:` + `DMRuntime{dmTypePath,initialVars}`) instead of silently dropping
  the attributes. 2,557 unique variants for boxstation.
- **Turf/area attrs are unmappable** (no entity to hang them on): each key is
  reported once per map as a warning, not per tile.
- **Perf (profiled, not guessed):**
  - `protoInitialVars` per-atom proto-var lookups were the dominant hotspot —
    naive per-entity union over ~36k atoms × proto-var merge cost 75 s of the
    91 s wall and ballooned RSS to 20 GB (retained intermediate objects).
    Fixed with a proto-initial-vars cache keyed by proto id + a `mapVariantFor`
    signature proto (`protoId|k=v;…`) so identical attr sets share one variant.
  - `flatStr` helper + chunked definition parse to stop SlicedString retention:
    the 2.5 MB DMM text was kept alive whole by thousands of small sliced
    references; flat-copy at the chunk boundary drops the backing buffer.

### `src/dmm/dmmParser.ts` — scope-adjacent (flagged)

- `DMMTileDefinition` gains `entryAttrs?: (Record<string,string>|undefined)[]`
  populated parallel to `typePaths` — braces attributes decode per entry so the
  converter can attribute them to the right atom in a stacked tile.

### `src/dmi/rsiWriter.ts` — duplicate stateId dedupe (W-I's ~287 errors)

- BYOND allows duplicate icon_state names in a DMI (first match wins on lookup);
  RSI meta rejects duplicate `stateId`s outright. `writeRSI` now hashes each
  state sheet (`sha1` over the decoded PNG slice), keeps the first state, and:
  - identical-content dup → counted in a summary warning (`N duplicate states
    deduped (identical images)`),
  - distinct-content dup → per-name warning, first kept (BYOND first-match).
- Result on the full paradise icon tree: **168 excess duplicate stateIds across
  32 RSI files → 0 remaining**; all distinct-content collisions reported.

### `src/tests/*` — appended plan-32 blocks (append-only)

- `rsiWriter.test.ts`: identical-image dedupe, distinct-content first-wins,
  warning split, kept PNG is the first state's sheet.
- `dmmParser.test.ts`: entryAttrs plumbing (turf/obj/area), absent-when-none,
  variant-proto reference + file emission, no `DMRuntime` component on map
  entities.

## Numbers

### Convert (paradise full corpus → boxstation real map)

| stage | before fix | after |
|---|---|---|
| dmm stage | 0.8 s (toy map) | 5.0 s |
| wall clock | 17.5 s (toy) | 22.8 s |
| RSS peak | 3.6 GB | 6.5 GB |

Arc of the optimization (dmm stage → wall → peak RSS):
naive per-entity attr union `75 s | 91.4 s | 20.4 GB` → +proto cache
`9.6 s | 27.3 s | 14.3 GB` → +variant protos `4.7 s | 21.6 s | 9.4 GB` →
+chunked parse/flatStr `5.0 s | 22.8 s | 6.5 GB`.

### Output

- `boxstation.yml`: **36,392 placed entities**, tilemap with 353 turf defs.
- `map_variants/…/boxstation.yml`: 2,557 `__mv` variant protos.
- `dotnet build` on the generated solution: **0 errors**.

### Server boot (real map)

- process start → `Ready`: **~147 s** (tile-def registration 353 defs at ~49 s;
  remaining ~98 s is map load + turf-datum mint + paradise `New()`/init chains).
- post-Ready RSS: **~5.3 GB** (36k entities + ~40 converted SS subsystems live).
- non-fatal noise, all logged: 8 missing tile sprites (beach/plasteel-stairs/
  gnesis/plastinum/plasma walls), 7× `beaker/large` spawn with `EntId=0`,
  `dm.out` file-not-found for paradise txt resources (`mode.txt`, `tips.txt`,
  `sillytips.txt`, `facts.txt`), 2 sprite-state warnings (moth markings,
  underwear `tank_fire`), recurring `Timer buckets has been reset` dm.out notes,
  `MainLoop: Cannot keep up!` under load.

### Boot + headless client connect + walk/click evidence

Server: `--config-file Resources/ConfigFiles/server_config.toml` (appended
`[game] auto_pause_empty = false`); client: `--headless --self-contained
--connect --connect-address 127.0.0.1` + `Resources/autocmds.txt`.

Verified log evidence (each step cross-checked in server/client logs):

- client connects; `Player "localhost@JoeGenero_N" attached to mob "<uid>"
  (proto "mob_living_carbon_human")` — fresh mob per connect, uids 36393+.
- `dmverbs` enumerates **1445 converted verbs** on the mob.
- `dmclick 66,147,1` (a placed airlock tile, uid 9795) and
  `dmclick /obj/machinery/door/airlock` both dispatch into converted paradise
  `Click()` — logged as `dmverb 'Click' threw: Division by zero` from inside
  the paradise click chain (dispatch + usr/mob binding proven; the fault is
  paradise-side semantics — see cross-scope findings).
- `dmloc` prints mob coords from the live datum (`x=1, y=1, z=1` = spawn).

## Known limits / honest gaps

- **Movement chain silently no-ops on the real map** *(refined by the windowed
  pass below: teleports relocate but NRE mid-move; step-based moves veto)*.
  `Move`, `abstract_move` — called via `dmverbon` on the mob with turf-coord
  destinations — all execute without error but leave coords unchanged.
  Narrowed: targeting resolves the right mob datum (HasProc passes, no "no
  datum"), turf datums are minted with x/y/z (DatumAt resolves), vars like
  `buckled`/`active_movement` parse to real Null. The veto sits inside
  paradise's converted `doMove`/`Move` chain or the Enter/Exit veto path —
  generated-C#/runtime scope (csharpEmitter/dmRuntimeCS), not this item.
  Note the demo map's `step_north` (engine `step()` builtin) **does** move the
  mob (m1-gate E4: 3 distinct coords) — the attach/move bridges work; the
  failure is in paradise-specific proc semantics.
- **`{attached}` autocmd token resolves the CLIENT-side uid**, not the server
  mob uid — on a 36k-entity map uid 3 is a placed whiteship docking port, so
  `{attached}`-targeting autocmds hit the wrong atom. Toy-map coincidence made
  it look correct in m1-gate. Worked around by path-targeting
  (`dmverbon /mob/living/carbon/human …`). Fix belongs in client autocmd
  plumbing (out of scope).
- **`keybinds.yml` emits `type: Function`** (ss14Template, W-G's input block) —
  not in the engine `KeyBindingType` enum → headless client `ArgumentException`
  at `InputManager.LoadKeyFile`. This currently **breaks `m1-gate.sh` on
  master's HEAD** (introduced by 737bd57, after the last gate PASS). Verified
  gate goes 5/5 PASS again with a throwaway `sed Function→State` — the only
  blocker. Flagged for the W-G/template owner; not committed (out of scope).
- **`[DM-PUMP] Division by zero`** recurs ~3× during idle ticks — a converted
  paradise subsystem fires into an unguarded division (runtime semantics,
  out of scope).
- **Area datums are never minted** (unmappable) — area-level overrides
  (`req_access` etc.) on map tiles are warned and dropped.

## Windowed pass (follow-up, persistent testing agent)

A windowed RobustToolbox client on llvmpipe/VNC confirmed the headless
findings visually and added two sharper results:

- **Full Cyberiad renders** — departments, corridors, airlocks, machinery,
  docks at ~10 px/tile; ambient light applied. Mob sprite visible; the
  viewport eye follows the attached mob (teleport to space → lone human on
  starfield — unambiguous attach evidence).
- **`doMove`/`forceMove` DO relocate the mob** (1,1,1 → 66,147,1 → back), but
  `doMove` throws `NullReferenceException` mid-move — the loc write + attach
  bridge succeed, the fault lands in the post-move notification path.
  `step_*`/`Move`/`walk` still silently no-op — consistent with a turf
  `Enter` veto cancelling steps (forceMove bypasses Enter checks by design).
- **`StartWorld()` loads the first *sorted* `/Maps/**/*.yml` that loads.**
  With all generated station maps restored, `EventStructures/
  splashscreen_empty.yml` sorts before `stations/boxstation.yml` and gets
  served instead — boxstation only loaded in the headless run because it was
  the sole file present. Needs a deterministic/configured map pick
  (ConvertedDMSystem / emit scope). Workaround: a sort-first `aaa_` copy.
- **Sprite-state coverage gaps** are visible: e.g. `state '"2-8"' does not
  exist in RSI power_cond_white.rsi` → checkerboard placeholder bands on
  cables/pipes/signage. Structure renders; some icon states are missing from
  the converted RSIs (dmi coverage item, logged).
- Stale `type: Function` binds also linger in `bin/*/Resources/keybinds.yml`
  copies — same flagged emitter bug, other mount points.

## Verification

- `npm run build` clean; `npm test` green (all plan-32 blocks included);
  `npm run audit:semantics` **303/303**.
- `scripts/boot-smoke.sh` PASS; `scripts/m1-gate.sh` PASS 5/5 *with the
  keybinds Function→State workaround applied to generated output* (raw master
  HEAD fails at client startup as described above).
- Real-map: convert 22.8 s, 36,392 entities, dotnet build 0 errors, boot→Ready
  ~147 s, headless client attach + 1445 verbs + Click() dispatch evidenced.
