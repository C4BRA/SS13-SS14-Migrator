// VERBATIM extract of Paradise code/game/objects/effects/landmarks.dm +
// code/modules/mob/new_player/new_player.dm — spawn landmarks, the
// latejoin spawner that fills GLOB.latejoin, and the real AttemptLateSpawn
// join pipeline. The atom Initialize chain goes through a MARKED SHIM
// (paradise routes /atom/New -> attempt_init -> SSatoms.InitAtom; SSatoms
// is out of the slice, so the shim calls Initialize() directly and honors
// the QDEL hint).

// ===== VERBATIM: landmarks.dm =====

/obj/effect/landmark
	name = "landmark"
	icon = 'icons/effects/spawner_icons.dmi'
	icon_state = "questionmark"
	anchored = TRUE
	invisibility = 101

/obj/effect/landmark/Initialize(mapload)
	. = ..()
	set_tag()
	invisibility = 101
	GLOB.landmarks_list += src

/// There should only be one of these, in the lobby art area
/obj/effect/landmark/newplayer_start
	name = "start"

/obj/effect/landmark/newplayer_start/Initialize(mapload)
	GLOB.newplayer_start = loc
	..()

/obj/effect/landmark/spawner
	var/spawner_list

/obj/effect/landmark/spawner/Initialize(mapload)
	. = ..()
	if(spawner_list)
		spawner_list += loc
		return INITIALIZE_HINT_QDEL

/obj/effect/landmark/spawner/late/crew
	name = "Late Join Crew"

/obj/effect/landmark/spawner/late/crew/Initialize(mapload)
	spawner_list = GLOB.latejoin
	return ..()

/obj/effect/landmark/start
	name = "start"
	icon_state = "Assistant"

/obj/effect/landmark/start/assistant
	name = "Assistant"

/obj/effect/landmark/start/chef
	name = "Chef"
	icon_state = "Chef"

// ===== VERBATIM: new_player.dm (subset) =====

/mob/new_player
	var/ready = FALSE
	var/chose_respawn = FALSE
	var/spawning = FALSE // referenced by the lobby UI; unused here
	var/toggled_antag = 0
	density = FALSE
	invisibility = 101
	sight = SEE_SELF // [HARNESS] paradise composes this from SEE flags; const ok
	can_move = FALSE

/mob/new_player/proc/new_player_panel_proc()
	return

/mob/new_player/proc/IsJobAvailable(rank)
	var/datum/job/thisjob = SSjobs.GetJob(rank)
	if(!thisjob)
		to_chat(src, alert("[rank] is unavailable. Please try another."))
		return 0
	if(!SSjobs.is_position_available(rank))
		to_chat(src, alert("[rank] is not available. Please try another."))
		return 0
	return thisjob

/mob/new_player/proc/AttemptLateSpawn(rank)
	if(src != usr)
		return 0
	if(!SSticker || SSticker.current_state != GAME_STATE_PLAYING)
		to_chat(usr, SPAN_WARNING("The round is either not ready, or has already finished..."))
		return 0
	if(!GLOB.enter_allowed)
		to_chat(usr, SPAN_NOTICE("There is an administrative lock on entering the game!"))
		return 0
	if(!IsJobAvailable(rank))
		to_chat(src, alert("[rank] is not available. Please try another."))
		return 0
	var/datum/job/thisjob = SSjobs.GetJob(rank)
	if(thisjob.barred_by_disability(client))
		to_chat(src, alert("[rank] is not available due to your character's disability. Please try another."))
		return 0
	if(thisjob.barred_by_quirk(client))
		to_chat(src, alert("[rank] is not available due to your character's quirk. Please try another."))
		return 0
	if(thisjob.barred_by_missing_limbs(client))
		to_chat(src, alert("[rank] is not available due to your character having amputated limbs without a prosthetic replacement. Please try another."))
		return 0

	SSjobs.job_selector.latejoin_assign(src, thisjob)

	var/mob/living/character = create_character()	//creates the human and transfers vars and mind
	character = SSjobs.AssignRank(character, rank, TRUE)					//equips the human
	if(chose_respawn)
		SSblackbox.record_feedback("tally", "player_respawn", 1, "[thisjob]")
		log_and_message_admins("[character.ckey] has respawned as [character.real_name], \a [character.dna?.species ? character.dna.species : "Undefined species"] [rank].")
	// AIs don't need a spawnpoint, they must spawn at an empty core
	if(character.mind.assigned_role == "AI")
		var/mob/living/silicon/ai/ai_character = character.AIize() // AIize the character, but don't move them yet

		// IsJobAvailable for AI checks that there is an empty core available in this list
		ai_character.moveToEmptyCore()
		AnnounceCyborg(ai_character, rank, "has been downloaded to the empty core in \the [get_area(ai_character)]")

		SSticker.mode.latespawn(ai_character)
		qdel(src)
		return

	//Find our spawning point.
	var/join_message

	if(IsAdminJob(rank))
		if(IsERTSpawnJob(rank))
			character.loc = pick(GLOB.ertdirector)
		else if(IsSyndicateCommand(rank))
			character.loc = pick(GLOB.syndicateofficer)
		else
			character.forceMove(pick(GLOB.aroomwarp))
		join_message = "has arrived"
	else
		character.forceMove(pick(GLOB.latejoin))
		join_message = "has arrived on the station"

	character.lastarea = get_area(loc)
	// Moving wheelchair if they have one
	if(character.buckled && istype(character.buckled, /obj/structure/chair/wheelchair))
		character.buckled.forceMove(character.loc)
		character.buckled.dir = character.dir

	character = SSjobs.EquipRank(character, rank, 1)					//equips the human
	SSticker.equip_cuis(character) // Gives them their CUIs

	if(!IsAdminJob(rank))
		SSticker.mode.latespawn(character)
	else
		log_dynamic("Admin joined. Budget remains unchanged.", TRUE)

	if(character.mind.assigned_role == "Cyborg")
		AnnounceCyborg(character, rank, join_message)
	else
		SSticker.minds += character.mind//Cyborgs and AIs handle this in the transform proc.	//TODO!!!!! ~Carn
		if(!IsAdminJob(rank))
			GLOB.data_core.manifest_inject(character)
			AnnounceArrival(character, rank, join_message)

			if(length(GLOB.current_pending_diseases) && character.ForceContractDisease(GLOB.current_pending_diseases[1]["disease"], TRUE, TRUE))
				var/datum/event/disease_outbreak/outbreak = GLOB.current_pending_diseases[1]["event"]
				outbreak.force_disease_time = 0
				popleft(GLOB.current_pending_diseases)
			if(GLOB.summon_guns_triggered)
				give_guns(character)
			if(GLOB.summon_magic_triggered)
				give_magic(character)

	if(!thisjob.is_position_available() && (thisjob in SSjobs.prioritized_jobs))
		SSjobs.prioritized_jobs -= thisjob
	qdel(src)

/mob/new_player/proc/AnnounceArrival(mob/living/carbon/human/character, rank, join_message)
	if(SSticker.current_state == GAME_STATE_PLAYING)
		to_chat(world, SPAN_NOTICE("[character.real_name] [join_message] as [rank]."))
	return

// ===== harness types (MARKED) =====
// create_character on real paradise goes through client prefs + dna +
// species; the slice mints the human mob directly and hands it a mind
// datum, which is all the job/EquipRank code path reads.

/datum/mind
	var/key
	var/name = "mind"
	var/assigned_role
	var/special_role
	var/role_alt_title
	var/list/job_objectives = list()

// [TRIMMED] create_character lives in m2r.dm — paradise's real version
// builds a human from client prefs + dna + species; the slice's harness
// version reuses the already-attached mob (marked there).
