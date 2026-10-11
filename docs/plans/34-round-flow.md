# 34 — Round-flow slice: gameticker -> join -> job spawn (W-N)

Wave item: prove a real round boundary on converted paradise — `world/New`
→ gamemode ticker init → lobby → player join → job/role assignment →
spawn at a job landmark with role-appropriate equipment → round starts.

## Slice scope

Chosen: the paradise `SSticker` pre-game path plus `SSjobs` equip side of
spawn-in. Surveyed what survives conversion:

- `/datum/controller/gameticker` (`SSticker`) — `SUBSYSTEM_DEF` singleton;
  `fire()` walks `GAME_STATE_STARTUP(0)` → `PREGAME(1)` → `SETTING_UP(2)` →
  `PLAYING(3)` → `FINISHED(4)`; `setup()` → `can_start` eligibility loop →
  `SSjobs.job_selector.assign_all_roles()` → `create_characters()` →
  `equip_characters()` → `current_state = PLAYING`,
  `Master.SetRunLevel(RUNLEVEL_GAME)`.
- `EquipRank` — landmark match (`/obj/effect/landmark/start` with
  `sloc.name == rank`) → `H.forceMove(T)` → `job.equip(H)` →
  `equipOutfit_impl` → `H.job_outfit = O`.
- `SSjobs` — `SetupOccupations` builds `occupations` + `name_occupations`
  dicts over `subtypesof(/datum/job)`; `GetJob(rank)` reads the dict.

Corpus (`tests/m2-round/`) follows the m2-slice convention: verbatim
paradise `.dm` where it converts (`paradise_ticker.dm`, `paradise_jobs.dm`,
`paradise_gamemode.dm`, `paradise_spawn.dm`, defines), plus `m2r.dm` —
harness globals, `[MARKED SHIM]` procs for join/job-selection/prefs, and
`m2r_state`/`m2r_who`/`m2r_probe`/`m2r_jobs` verbs that print `M2R-*`
evidence lines.

Degradation: the slice works WITH subsystems firing (W-N
`RegisterSubsystemsAsync` calls `Initialize` post-construction) and does
not depend on W-K's instantiation work — the harness's `on_player_join`
shim + prefs stubs carry the path when the full MC is absent.

## Transpiler/runtime fixes (W-N regions)

- **Bare global names** (`csharpEmitter.ts`): unshadowed declared
  `/global/var` names resolve through `GlobalVars.Get/Set` in reads, writes
  and list index write-back — `NEW_SS_GLOBAL`'s `SSticker = src` and
  `GLOB.player_list += NP` in corpus code bind the real globals.
- **`on_player_join` hook** (`dmRuntimeCS.ts`): client InGame invokes the
  corpus `/world` proc so paradise-style join plumbing runs.
- **`RegisterSubsystemsAsync` initialize** (`dmRuntimeCS.ts`): BYOND's MC
  calls `subsystem.Initialize()` after construction — fired via
  `CanCallProc`/`CallProc` post-DMNew (verified jobs=2).
- **`var/list/x = list()` var inits seeded** (`csharpEmitter.ts`): scalar
  seeding skipped expression inits; an unseeded list var reads null and
  `x[k]=v` silently stored null — broke `SSjobs.name_occupations`
  (`GetJob` → Null → `job.equip` skipped → no outfit). Now empty-list
  inits seed `MakeList()`. Non-empty `list(...)` literals stay unseeded.
- **Builtins** (`dmRuntimeCS.ts`): `subtypesof`, `shuffle`, `pickweight`,
  `english_list`, `sortList`.

## Evidence (scripts/m2-round.sh, 5/5)

```
M2R-WORLD: world/New complete
M2R-JOIN: new_player localhostjoegenero in lobby (state=0)
M2R-RUNLEVEL: 2                      (RUNLEVEL_SETUP)
M2R-DBG: assign_all_roles list=1
M2R-DBG: player localhostjoegenero ready=1
M2R-DBG: create_character ckey=localhostjoegenero role=Assistant
M2R-DBG: equipOutfit_impl /datum/outfit/job/assistant onto ...
M2R-RUNLEVEL: 4                      (RUNLEVEL_GAME)
M2R-STATE: ticker_state=3 runlevel=4 jobs=2 minds=1
M2R-WHO: ... job=Assistant role=Assistant outfit=/datum/outfit/job/assistant
M2R-WHERE: x=5 y=7 z=1               (Assistant start landmark)
M2R-PROBE: getjob=... names=2 outfitvar=/datum/outfit/job/assistant
M2R-JOB: Chef positions=1 / Assistant positions=0
```

Gate stages: R1 world/New+Ready · R2 join→lobby→SETUP · R3 role
assignment · R4 landmark spawn+equip+PLAYING · R5 jobs dict/GetJob.

## Verification

- `npm run build` clean, `npm test` green, `npm run audit:semantics`
  **313/313** (298 baseline + 15 W-N probes: global binding/shadowing,
  NEW_SS_GLOBAL, subtypesof, shuffle/pickweight/english_list/sortList,
  list-init seeding).
- `scripts/m2-round.sh` PASS 5/5 (log evidence above).
- `scripts/m1-gate.sh` PASS (unchanged demo still works).
- `scripts/boot-smoke.sh` PASS.

## Known limits

- **keybinds `type: Function`** crashes the client — emitted by the W-G
  ss14Template region; `scripts/m2-round.sh` seds it to `State` post-build
  (workaround lives here until that region lands a fix).
- **XAMLIL resource flattening**: building Robust.Client through the
  generated `RobustToolbox/` symlink flattens embedded resource names →
  "Unable to find type" on every xaml. The gate rebuilds Robust.Client via
  the resolved real engine path and verifies namespaced `Populate:` entries
  before copying the dll. Note for whoever owns engine-adapter scripts.
- **`{attached}`** autocmd can bind a landmark datum instead of the mob —
  the gate uses `dmverbon "/mob/living/carbon/human" verb` (DatumForPath
  resolves first-live-datum-of-type).
- `mode` announces "invalid" (declared `name="extended"` collides with the
  basename default rule) — cosmetic, documented approximation.
- Sim still pauses with zero players (engine semantics); the ticker only
  fires once the client goes InGame — the gate pads autocmds accordingly.
- W-K items: `SSatoms/New` chain ordering and full subsystem
  instantiation semantics are theirs — this slice's harness shims stand
  in for the MC paths the corpus needs (prefs/ready, mind transfer,
  assign_all_roles).
