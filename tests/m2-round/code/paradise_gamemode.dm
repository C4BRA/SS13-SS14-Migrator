// VERBATIM extract of Paradise code/game/gamemodes/game_mode.dm +
// extended/extended.dm + gamemode_configuration pick/get_runnable_modes —
// the base game-mode datum and the default "extended" mode. Procs that
// only matter to antag/station machinery are trimmed.

// ===== VERBATIM: game_mode.dm (subset) =====

/datum/game_mode
	var/name = "invalid"
	var/config_tag = "invalid"
	var/votable = TRUE
	// vars for basic things
	var/required_players = 0
	var/required_enemies = 1
	var/recommended_enemies = 1
	/// Was the roundstart nuke objective set? (prevents duplicate nukie teams)
	var/pre_nuke_objectives = FALSE
	var/antag_flag = BE_ANTAG
	var/station_was_nuked = 0 //see nuclearbomb.dm and malfunction.dm
	var/explosion_in_progress = 0 //if the station is currently undergoing a nuke
	var/nuke_off_station = 0 //if the nuke was moved off station
	var/list/allowed_jobs = list() //Job types that may be antags.
	var/list/protected_jobs = list() //Job types that cannot be antags
	var/list/protected_species = list() //species that are not allowed to be antags
	var/list/auto_declare_mode_begin
	var/list/auto_declare_mode_antagonists
	var/list/auto_declare_mode_misc
	var/list/reroll_friendly_antags = list()
	var/completed_target_objectives = FALSE

/datum/game_mode/proc/announce()
	to_chat(world, "<B>The current game mode is - [name]!</B>")
	if(automatic_announcement)
		to_chat(world, automatic_announcement)

/datum/game_mode/proc/pre_setup()
	// everyone and their mother knows this
	return TRUE

/datum/game_mode/proc/post_setup()
	// called after setup is complete
	return TRUE

/datum/game_mode/proc/process()
	return

/datum/game_mode/proc/can_start()
	var/playerC = 0
	for(var/mob/new_player/player in GLOB.player_list)
		if((player.client) && (player.ready))
			playerC++
	if(playerC >= required_players)
		return TRUE
	return FALSE

/datum/game_mode/proc/check_finished()
	return FALSE

// [HARNESS FIELD] paradise reads this off extended's type vars; the trimmed
// corpus declares it on the base type so announce() compiles.
/datum/game_mode
	var/automatic_announcement = null

// ===== VERBATIM: extended/extended.dm =====

/datum/game_mode/extended
	name = "extended"
	config_tag = "extended"
	required_players = 0
	latejoin_antag_compatible = TRUE
	automatic_announcement = "Just have fun and enjoy the game!"

/datum/game_mode/extended/pre_setup()
	return 1

/datum/game_mode/extended/post_setup()
	..()
	return 1

// [HARNESS FIELD] extended declares this in paradise; keep on subtype.
/datum/game_mode/extended
	var/latejoin_antag_compatible = FALSE

// ===== VERBATIM: gamemode_configuration pick/get_runnable_modes =====

/datum/configuration_section/gamemode_configuration/proc/pick_mode(mode_name)
	for(var/T in subtypesof(/datum/game_mode))
		var/datum/game_mode/M = T
		// If the tag exists, and its the same as the mode
		if(initial(M.config_tag) && (initial(M.config_tag) == mode_name))
			return new T()

	// Default to extended if it didnt work
	stack_trace("Could not pick a gamemode. Defaulting to extended. (Attempted mode: [mode_name])")
	return new /datum/game_mode/extended()

/datum/configuration_section/gamemode_configuration/proc/get_runnable_modes()
	var/list/datum/game_mode/runnable_modes = list()
	for(var/T in subtypesof(/datum/game_mode))
		var/datum/game_mode/M = new T()

		if(!(M.config_tag in gamemodes))
			qdel(M)
			continue

		if(probabilities[M.config_tag] <= 0)
			qdel(M)
			continue

		if(M.can_start())
			runnable_modes[M] = probabilities[M.config_tag]

	return runnable_modes

// ===== harness datums (MARKED) =====
// paradise builds configuration from config text files; the slice seeds the
// small section tree the ticker touches.

/datum/configuration_section
	var/name = "config_section"

/datum/configuration_section/gamemode_configuration
	name = "gamemode"
	var/list/gamemodes = list("extended")
	var/list/probabilities = list("extended" = 100)
	var/disable_certain_round_early_end = FALSE

/datum/configuration_section/general_configuration
	name = "general"
	var/lobby_time = 5

/datum/configuration_section/vote_configuration
	name = "vote"
	var/enable_map_voting = FALSE
	var/autotransfer_interval_time = 0

/datum/configuration_section/jobs_configuration
	name = "jobs"
	var/allow_skeleton_crew_access = FALSE
	var/enable_exp_tracking = FALSE
	var/assistant_maint_access = FALSE

/datum/configuration
	var/datum/configuration_section/gamemode_configuration/gamemode
	var/datum/configuration_section/general_configuration/general
	var/datum/configuration_section/vote_configuration/vote
	var/datum/configuration_section/jobs_configuration/jobs

/datum/configuration/New()
	// [MARKED SHIM] explicit type paths: `x = new()` (type inferred from
	// the declared var) is not yet resolved by the transpiler — emits
	// DMNew(comp, "") and returns a typeless datum. Paradise always uses
	// explicit paths here anyway; kept explicit for the slice.
	gamemode = new /datum/configuration_section/gamemode_configuration()
	general = new /datum/configuration_section/general_configuration()
	vote = new /datum/configuration_section/vote_configuration()
	jobs = new /datum/configuration_section/jobs_configuration()
