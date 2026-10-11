// VERBATIM extract of Paradise code/controllers/subsystem/SSticker.dm —
// the ticker vars, fire() state machine, setup() round pipeline, and the
// character-creation/equip loops. Trimmed procs that only touch machinery
// outside the slice (tips, facts, biohazards, votes, map rotation, reboot)
// are left out; calls into them degrade to Null inside fire() exactly like
// every other out-of-slice call. Trimmed vars are marked [TRIMMED].

SUBSYSTEM_DEF(ticker)
	name = "Ticker"
	init_order = INIT_ORDER_TICKER

	priority = FIRE_PRIORITY_TICKER
	flags = SS_KEEP_TIMING
	runlevels = RUNLEVEL_LOBBY | RUNLEVEL_SETUP | RUNLEVEL_GAME
	offline_implications = "The game is no longer aware of when the round ends. Immediate server restart recommended."
	cpu_display = SS_CPUDISPLAY_LOW
	wait = 1 SECONDS

	/// Time the game should start, relative to world.time
	var/round_start_time = 0
	/// Time that the round started
	var/time_game_started = 0
	/// Current status of the game. See code\__DEFINES\game.dm
	var/current_state = GAME_STATE_STARTUP
	/// Do we want to force-start as soon as we can
	var/force_start = FALSE
	/// Do we want to force-end as soon as we can
	var/force_ending = FALSE
	/// Leave here at FALSE ! setup() will take care of it when needed for Secret mode -walter0o
	var/hide_mode = FALSE
	/// Our current game mode
	var/datum/game_mode/mode = null
	/// The current pick of lobby music played in the lobby
	var/login_music
	/// List of all minds in the game. Used for objective tracking
	var/list/datum/mind/minds = list()
	/// If set to nonzero, ALL players who latejoin or declare-ready join will have random appearances/genders
	var/random_players = FALSE
	/// Did we broadcast the tip of the round yet?
	var/tipped = FALSE
	/// What will be the tip of the round?
	var/selected_tip
	/// Did we broadcast the fact of the round yet?
	var/facted = FALSE
	/// What will be the fact of the round?
	var/selected_fact
	/// This is used for calculations for the statpanel
	var/pregame_timeleft
	/// If set to TRUE, the round will not restart on it's own
	var/delay_end = FALSE
	/// Holder for inital autotransfer vote timer
	var/next_autotransfer = 0
	/// Spam Prevention. Announce round end only once.
	var/round_end_announced = FALSE
	/// Is the ticker currently processing? If FALSE, roundstart is delayed
	var/ticker_going = TRUE
	/// Gamemode result (For things like cult or nukies which can end multiple ways)
	var/mode_result = "undefined"
	/// Server end state (Did we end properly or reboot or nuke or what)
	var/end_state = "undefined"
	/// Time the real reboot kicks in
	var/real_reboot_time = 0
	/// Datum used to generate the end of round scoreboard.
	var/datum/scoreboard/score = null
	// [TRIMMED] Bible_deity_name, cult_data, triai, cinematic,
	// flagged_antag_rollers, biohazard_pop_times,
	// biohazard_included_admin_spawns, cult_tried_summon — modes/features
	// outside the slice.

/datum/controller/subsystem/ticker/Initialize()
	login_music = pick(\
	'sound/music/thunderdome.ogg',\
	'sound/music/space.ogg',\
	'sound/music/title1.ogg',\
	'sound/music/title2.ogg',\
	'sound/music/title3.ogg',)

/datum/controller/subsystem/ticker/fire()
	switch(current_state)
		if(GAME_STATE_STARTUP)
			// This is ran as soon as the MC starts firing, and should only run ONCE, unless startup fails
			pregame_timeleft = GLOB.configuration.general.lobby_time SECONDS
			round_start_time = world.time + pregame_timeleft
			to_chat(world, "<B>[SPAN_DARKMBLUE("Welcome to the pre-game lobby!")]</B>")
			to_chat(world, "Please, setup your character and select ready. Game will start in [GLOB.configuration.general.lobby_time] seconds")
			current_state = GAME_STATE_PREGAME
			fire() // TG says this is a good idea
			for(var/mob/new_player/N in GLOB.player_list)
				if(N.client)
					N.new_player_panel_proc() // to enable the observe option
		if(GAME_STATE_PREGAME)
			if(!SSticker.ticker_going) // This has to be referenced like this, and I dont know why. If you dont put SSticker. it will break
				return

			// This is so we dont have sleeps in controllers, because that is a bad, bad thing
			pregame_timeleft = max(0, round_start_time - world.time)

			if(pregame_timeleft <= 1 MINUTES && !tipped)
				send_tip_of_the_round()
				tipped = TRUE

			if(pregame_timeleft <= 120 SECONDS && !facted)
				send_fact_of_the_round()
				facted = TRUE

			if(pregame_timeleft <= 0 || force_start)
				current_state = GAME_STATE_SETTING_UP
				Master.SetRunLevel(RUNLEVEL_SETUP)
		if(GAME_STATE_SETTING_UP)
			if(!setup()) // Setup failed
				current_state = GAME_STATE_STARTUP
				Master.SetRunLevel(RUNLEVEL_LOBBY)
		if(GAME_STATE_PLAYING)
			delay_end = FALSE // reset this in case round start was delayed
			mode.process()

			for(var/biohazard in biohazard_pop_times)
				if(world.time - biohazard_pop_times[biohazard] > BIOHAZARD_POP_INTERVAL)
					sample_biohazard_population(biohazard)

			if(world.time > next_autotransfer)
				SSvote.start_vote(new /datum/vote/crew_transfer)
				next_autotransfer = world.time + GLOB.configuration.vote.autotransfer_interval_time

			var/game_finished = SSshuttle.emergency.mode >= SHUTTLE_ENDGAME || mode.station_was_nuked
			if(GLOB.configuration.gamemode.disable_certain_round_early_end)
				mode.check_finished() // some modes contain var-changing code in here, so call even if we don't uses result
			else
				game_finished |= mode.check_finished()
			if(game_finished || force_ending)
				current_state = GAME_STATE_FINISHED
		if(GAME_STATE_FINISHED)
			current_state = GAME_STATE_FINISHED
			Master.SetRunLevel(RUNLEVEL_POSTGAME) // This shouldnt process more than once, but you never know
			auto_toggle_ooc(TRUE) // Turn it on
			declare_completion()
			addtimer(CALLBACK(src, PROC_REF(call_reboot)), 5 SECONDS)
			// [TRIMMED] map-rotation / map-vote block: SSmaprotate, SSvote,
			// /datum/map are outside the slice.

/datum/controller/subsystem/ticker/proc/setup()
	var/random_cult = pick(typesof(/datum/cult_info))
	cult_data = new random_cult()
	score = new()

	// Create and announce mode
	if(GLOB.master_mode == "secret")
		hide_mode = TRUE

	var/list/datum/game_mode/runnable_modes
	var/is_admin_forced = FALSE

	if(GLOB.master_mode == "random" || GLOB.master_mode == "secret")
		runnable_modes = GLOB.configuration.gamemode.get_runnable_modes()
		if(!length(runnable_modes))
			to_chat(world, "<B>Unable to choose playable game mode.</B> Reverting to pre-game lobby.")
			force_start = FALSE
			current_state = GAME_STATE_PREGAME
			Master.SetRunLevel(RUNLEVEL_LOBBY)
			return FALSE
		if(GLOB.secret_force_mode != "secret")
			mode = GLOB.configuration.gamemode.pick_mode(GLOB.secret_force_mode)
			is_admin_forced = TRUE

		SSjobs.ResetOccupations()
		if(!mode)
			mode = pickweight(runnable_modes)
		if(mode)
			var/mtype = mode.type
			mode = new mtype
	else
		mode = GLOB.configuration.gamemode.pick_mode(GLOB.master_mode)

	if(!mode.can_start() && !is_admin_forced)
		to_chat(world, "<B>Unable to start [mode.name].</B> Not enough players, [mode.required_players] players needed. Reverting to pre-game lobby.")
		mode = null
		current_state = GAME_STATE_PREGAME
		force_start = FALSE
		SSjobs.ResetOccupations()
		Master.SetRunLevel(RUNLEVEL_LOBBY)
		return FALSE

	// Randomise characters now. This avoids rare cases where a human is set as a changeling then they randomise to an IPC
	for(var/mob/new_player/player in GLOB.player_list)
		if(player.client.prefs.toggles2 & PREFTOGGLE_2_RANDOMSLOT)
			player.client.prefs.load_random_character_slot(player.client)

	// Lets check if people who ready should or shouldnt be
	for(var/mob/new_player/P in GLOB.player_list)
		// Not logged in
		if(!P.client)
			continue
		// Not ready
		if(!P.ready)
			continue
		// Not set to return if nothing available
		if(P.client.prefs.active_character.alternate_option != RETURN_TO_LOBBY)
			continue

		var/has_antags = (length(P.client.prefs.be_special) > 0)
		if(!P.client.prefs.active_character.check_any_job())
			to_chat(P, SPAN_DANGER("You have no jobs enabled, along with return to lobby if job is unavailable. This makes you ineligible for any round start role, please update your job preferences."))
			if(has_antags)
				// We add these to a list so we can deal with them as a batch later
				flagged_antag_rollers |= P.ckey

			P.ready = FALSE

	//Configure mode and assign player to special mode stuff

	var/can_continue = FALSE
	can_continue = mode.pre_setup() //Setup special modes. This also does the antag fishing checks.

	if(!can_continue)
		QDEL_NULL(mode)
		to_chat(world, "<B>Error setting up [GLOB.master_mode].</B> Reverting to pre-game lobby.")
		current_state = GAME_STATE_PREGAME
		force_start = FALSE
		SSjobs.ResetOccupations()
		Master.SetRunLevel(RUNLEVEL_LOBBY)
		return FALSE

	// Enable highpop slots just before we distribute jobs.
	var/playercount = length(GLOB.clients)
	var/highpop_trigger = 80

	if(playercount >= highpop_trigger)
		log_debug("Playercount: [playercount] versus trigger: [highpop_trigger] - loading highpop job config")
		SSjobs.LoadJobs(TRUE)
	else
		log_debug("Playercount: [playercount] versus trigger: [highpop_trigger] - keeping standard job config")

	// [MARKED SHIM] `x = new()` (no-path new) emits DMNew(comp, "") —
	// unresolved; explicit type path (paradise semantics unchanged).
	SSjobs.job_selector = new /datum/job_selector()
	SSjobs.job_selector.assign_all_roles()
	SSjobs.job_selector.apply_roles_to_players()

	if(hide_mode)
		var/list/modes = list()
		for(var/datum/game_mode/M in runnable_modes)
			modes += M.name
		modes = sortList(modes)
		to_chat(world, "<B>The current game mode is - Secret!</B>")
		to_chat(world, "<B>Possibilities:</B> [english_list(modes)]")
	else
		mode.announce()

	// Behold, a rough way of figuring out what takes 10 years
	var/watch = start_watch()

	// Count ready players before we spawn them for hijack objective requirements
	GLOB.roundstart_ready_players = 0
	for(var/mob/new_player/player in GLOB.new_player_mobs)
		if(player.ready && player.client)
			GLOB.roundstart_ready_players++

	create_characters() // Create player characters and transfer clients
	log_debug("Creating characters took [stop_watch(watch)]s")

	// Gather everyones minds
	for(var/mob/living/player in GLOB.player_list)
		if(player.mind)
			minds += player.mind

	watch = start_watch()
	equip_characters() // Apply outfits and loadouts to the characters
	log_debug("Equipping characters took [stop_watch(watch)]s")

	watch = start_watch()
	GLOB.data_core.manifest() // Create the manifest
	log_debug("Manifest creation took [stop_watch(watch)]s")
	SEND_SIGNAL(src, COMSIG_TICKER_ROUND_STARTING, world.time)

	// Update the MC and state to game playing
	current_state = GAME_STATE_PLAYING
	Master.SetRunLevel(RUNLEVEL_GAME)

	// [TRIMMED] AI-core generation, news feeds, syndicate code phrases —
	// all call machinery outside the slice.

	return TRUE

/datum/controller/subsystem/ticker/proc/create_characters()
	for(var/mob/new_player/player in GLOB.player_list)
		if(player.ready && player.mind)
			if(player.mind.assigned_role == "AI")
				player.close_spawn_windows()
				var/mob/living/silicon/ai/ai_character = player.AIize()
				ai_character.moveToAILandmark()
			else if(!player.mind.assigned_role)
				continue
			else
				player.create_character()
				qdel(player)

/datum/controller/subsystem/ticker/proc/equip_characters()
	for(var/mob/living/carbon/human/player in GLOB.player_list)
		if(player && player.mind && player.mind.assigned_role && player.mind.assigned_role != player.mind.special_role)
			SSjobs.AssignRank(player, player.mind.assigned_role, FALSE)
			SSjobs.EquipRank(player, player.mind.assigned_role, FALSE)
			equip_cuis(player)

/datum/controller/subsystem/ticker/proc/equip_cuis(mob/living/carbon/human/H)
	if(!H.client)
		return // If they are spawning without a client (somehow), they *cant* have a CUI list
	for(var/datum/custom_user_item/cui in H.client.cui_entries)
		// Skip items with invalid character names
		if((cui.characer_name != H.real_name) && !cui.all_characters_allowed)
			continue
		// [TRIMMED] CUI equip body — custom user items are outside the slice.
		break
