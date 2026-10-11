// M2-round harness (MARKED SHIM lines are corpus-only): world, atoms, the
// join hook that lets the converted engine hand a joining client to the
// REAL AttemptLateSpawn pipeline, plus evidence verbs (M2R-* markers).
//
// What is real here: SSticker/SSjobs datums + their fire()/setup()/
// AssignRank()/EquipRank() are the verbatim paradise files next to this
// one; the globals they write (SSticker, SSjobs, GLOB.*) are declared
// through the same GLOBAL_* macros paradise uses.

// ===== globals the slice touches (paradise declares these on GLOB) =====

/global/var/master_mode = "extended"
/global/var/secret_force_mode = "extended"
/global/var/enter_allowed = TRUE
/global/var/list/player_list = list()
/global/var/list/new_player_mobs = list()
/global/var/list/clients = list()
/global/var/list/ai_list = list()
/global/var/list/latejoin = list()
/global/var/list/landmarks_list = list()
/global/var/list/aroomwarp = list()
/global/var/list/ertdirector = list()
/global/var/list/syndicateofficer = list()
/global/var/list/dropped_item_list = list()
/global/var/list/current_pending_diseases = list()
/global/var/summon_guns_triggered = FALSE
/global/var/summon_magic_triggered = FALSE
/global/var/nologevent = FALSE
/global/var/disable_explosions = FALSE
/global/var/roundstart_ready_players = 0
/global/var/newplayer_start
/global/var/datum/configuration/configuration
/global/var/data_core
/global/var/datum/controller/master/Master
// The engine-side join hook hands the attached mob here so the real
// AttemptLateSpawn pipeline can reuse it as `character` (see below).
/global/var/mob/living/carbon/human/m2r_joiner_mob
/global/var/mob/new_player/m2r_joiner_lobby_mob

// ===== MARKED SHIM: atom New -> Initialize (paradise routes this through
// SSatoms.InitAtom, which is outside the slice) =====

/atom
	var/invisibility = 0
	var/anchored = FALSE
	var/density = FALSE
	var/sight = 0
	var/can_move = TRUE
	var/dir = 2

/atom/proc/Initialize(mapload)
	return INITIALIZE_HINT_NORMAL

/atom/New(loc)
	var/hint = Initialize(TRUE)
	if(hint == INITIALIZE_HINT_QDEL)
		qdel(src)
	return

/atom/proc/set_tag()
	return

/atom/movable/proc/forceMove(atom/destination)
	// [MARKED SHIM] paradise's doMove is a 200-line Enter/Exit/teleport
	// path; the slice needs the loc write only (runtime keeps entity
	// coordinates in sync on loc writes).
	loc = destination
	return TRUE

/atom/proc/get_turf()
	var/atom/A = src
	while(A)
		if(isturf(A))
			return A
		A = A.loc
	return null

/proc/get_area(atom/A)
	if(!A)
		return null
	var/atom/T = get_turf(A)
	return T ? T.loc : null

// ===== turf / area / mob for the demo map =====

/turf/floor
	icon = 'icons/m1.dmi'
	icon_state = "floor"

/turf/wall
	icon = 'icons/m1.dmi'
	icon_state = "wall"
	density = TRUE

/area/m2r
	icon = 'icons/m1.dmi'
	icon_state = "area"

/mob/living/carbon/human
	icon = 'icons/m1.dmi'
	icon_state = "human"
	var/job
	var/real_name
	var/datum/mind/mind
	var/dna
	var/lastarea
	var/buckled
	var/job_outfit
	var/ckey

// ===== join hook =====
// [MARKED SHIM] The converted engine calls /world/proc/on_player_join
// after a client attaches (see docs/plans/34-round-flow.md). We mint the
// lobby new_player, mark it ready, and leave it in GLOB.player_list —
// the ticker's REAL create_characters()/equip_characters() path then
// spawns it at its job landmark when the round starts. (Post-start
// joins would take the verbatim AttemptLateSpawn path in
// paradise_spawn.dm instead.)

/world/proc/on_player_join(mob/living/carbon/human/M, client)
	var/mob/new_player/NP = new /mob/new_player()
	NP.ckey = client && client.ckey ? client.ckey : "player"
	NP.real_name = M && M.name ? M.name : "Player"
	NP.client = client
	NP.ready = TRUE
	NP.client.prefs = new /datum/preferences()
	NP.client.prefs.active_character = new /datum/pref_character()
	NP.mind = new /datum/mind()
	NP.mind.key = NP.ckey
	m2r_joiner_mob = M
	m2r_joiner_lobby_mob = NP
	GLOB.player_list += NP
	world << "M2R-JOIN: new_player [NP.ckey] in lobby (state=[SSticker ? SSticker.current_state : "none"])"
	return NP

/mob/new_player
	var/ckey
	var/real_name
	var/client
	var/ready = FALSE
	var/datum/mind/mind
	var/dna

/mob/new_player/proc/create_character()
	// [MARKED SHIM] paradise builds a fresh human from client prefs; the
	// slice hands back the already-attached mob after giving it a mind so
	// the real AssignRank/EquipRank path runs on the player's entity.
	var/mob/living/carbon/human/character = m2r_joiner_mob
	world << "M2R-DBG: create_character ckey=[ckey] role=[mind ? mind.assigned_role : "none"]"
	if(!character.mind)
		character.mind = mind ? mind : new /datum/mind()
	else if(mind)
		character.mind = mind
	character.mind.key = ckey
	GLOB.player_list += character
	character.real_name = real_name
	character.name = real_name
	character.ckey = ckey
	return character

// ===== client prefs stub (MARKED SHIM) =====
// paradise's ticker can_start() gate checks client.prefs.active_character
// eligibility; real prefs come from SQL. Stub answers 'eligible'.

/datum/preferences
	var/datum/pref_character/active_character
	var/list/be_special = list()

/datum/pref_character
	var/alternate_option = 0

/datum/pref_character/proc/check_any_job()
	return TRUE

// ===== datum/controller/master (MARKED SHIM) =====
// paradise's MC is a 3k-line scheduler; the slice needs SetRunLevel
// observability only.

/datum/controller/master
	var/current_runlevel = RUNLEVEL_LOBBY

/datum/controller/master/proc/SetRunLevel(new_runlevel)
	current_runlevel = new_runlevel
	world << "M2R-RUNLEVEL: [current_runlevel]"
	return TRUE

/datum/controller/master/New()
	if(Master != src)
		Master = src
	return

// ===== datum/job_selector (MARKED SHIM) =====
// paradise's job_selector does preference matching + antag rolling; the
// slice assigns the requested rank directly.

/datum/job_selector
	var/list/assigned = list()

/datum/job_selector/proc/latejoin_assign(mob/new_player/player, datum/job/job)
	assigned[job.title] = player
	return TRUE

/datum/job_selector/proc/assign_all_roles()
	world << "M2R-DBG: assign_all_roles list=[GLOB.player_list ? GLOB.player_list.len : 0]"
	for(var/mob/new_player/player in GLOB.player_list)
		world << "M2R-DBG: player [player.ckey] ready=[player.ready] mind=[player.mind]"
		if(player.ready && player.mind)
			player.mind.assigned_role = "Assistant"
			assigned["Assistant"] = player
	return TRUE

/datum/job_selector/proc/apply_roles_to_players()
	return TRUE

// ===== world boot =====

/world/New()
	..()
	configuration = new /datum/configuration()
	Master = new /datum/controller/master()
	world << "M2R-WORLD: world/New complete"

// ===== evidence verbs =====
// dmverbon <path> <verb> in the gate script reads state off the live
// datums after each stage and prints M2R-* markers into dm.out.

/mob/living/carbon/human/verb/m2r_state()
	set name = "m2r_state"
	set category = "Debug"
	world << "M2R-STATE: ticker_state=[SSticker ? SSticker.current_state : "null"] runlevel=[Master ? Master.current_runlevel : "null"] jobs=[SSjobs && SSjobs.occupations ? SSjobs.occupations.len : 0] minds=[SSticker && SSticker.minds ? SSticker.minds.len : 0]"
	world << "M2R-MODE: [SSticker && SSticker.mode ? SSticker.mode.name : "null"]"

/mob/living/carbon/human/verb/m2r_who()
	set name = "m2r_who"
	set category = "Debug"
	world << "M2R-WHO: ckey=[ckey] real_name=[real_name] job=[job] role=[mind ? mind.assigned_role : "none"] outfit=[job_outfit ? job_outfit : "none"]"
	world << "M2R-WHERE: x=[x] y=[y] z=[z] loc=[loc]"

/mob/living/carbon/human/verb/m2r_probe()
	set name = "m2r_probe"
	set category = "Debug"
	world << "M2R-PROBE: getjob=[SSjobs.GetJob("Assistant")] names=[SSjobs.name_occupations ? SSjobs.name_occupations.len : "null"] outfitvar=[job_outfit] mind=[mind]"

/mob/living/carbon/human/verb/m2r_jobs()
	set name = "m2r_jobs"
	set category = "Debug"
	for(var/datum/job/J in SSjobs.occupations)
		world << "M2R-JOB: [J.title] positions=[J.total_positions]"
