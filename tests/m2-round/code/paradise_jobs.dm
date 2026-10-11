// VERBATIM extract of Paradise code/controllers/subsystem/SSjobs.dm +
// code/datums/job/job.dm + code/datums/job/depts/service_jobs.dm —
// the jobs subsystem, the /datum/job type, and two real jobs. Procs that
// only serve machinery outside the slice (EXP tracking, skeleton crew,
// databases, custom user items, ID cards) are trimmed; their call sites
// stay verbatim and degrade to Null.

SUBSYSTEM_DEF(jobs)
	name = "Jobs"
	init_order = INIT_ORDER_JOBS // 12
	wait = 5 MINUTES // Dont ever make this a super low value since EXP updates are calculated from this value
	runlevels = RUNLEVEL_GAME
	offline_implications = "Job playtime hours will no longer be logged. No immediate action is needed."
	cpu_display = SS_CPUDISPLAY_LOW

	//List of all jobs
	var/list/occupations = list()
	var/list/name_occupations = list()	//Dict of all jobs, keys are titles
	var/list/type_occupations = list()	//Dict of all jobs, keys are types
	var/list/prioritized_jobs = list() // List of jobs set to priority by HoP/Captain
	var/list/id_change_records = list() // List of all job transfer records
	var/probability_of_antag_role_restriction = 100 // Dict probability of a job rolling an antagonist role
	var/id_change_counter = 1

	/// Is the crew count below the skeleton crew threshold?
	var/skeleton_crew = FALSE
	/// Holds a reference to the skeleton timer until it's finished or killed.
	var/skeleton_revoke_timer
	///list of station departments and their associated roles and economy payments
	var/list/station_departments = list()
	/// Do we spawn everyone at shuttle due to late arivals?
	var/late_arrivals_spawning = FALSE
	/// Do we spawn people drunkenly due to the party last night?
	var/drunken_spawning = FALSE
	/// Job selector, used for roundstart and late join job assignment
	var/datum/job_selector/job_selector

/datum/controller/subsystem/jobs/Initialize()
	if(!length(occupations))
		SetupOccupations()
	for(var/department_type in subtypesof(/datum/station_department))
		station_departments += new department_type()
	LoadJobs(FALSE)

// Only fires every 5 minutes
/datum/controller/subsystem/jobs/fire()
	if(GLOB.configuration.jobs.allow_skeleton_crew_access)
		check_skeleton_crew()
	if(!SSdbcore.IsConnected() || !GLOB.configuration.jobs.enable_exp_tracking)
		return
	batch_update_player_exp(announce = FALSE) // Set this to true if you ever want to inform players about their EXP gains

/datum/controller/subsystem/jobs/proc/SetupOccupations(list/faction = list("Station"))
	occupations = list()
	var/list/all_jobs = subtypesof(/datum/job)
	if(!length(all_jobs))
		to_chat(world, SPAN_WARNING("Error setting up jobs, no job datums found."))
		return 0

	for(var/J in all_jobs)
		var/datum/job/job = new J()
		if(!job)
			continue
		occupations += job
		name_occupations[job.title] = job
		type_occupations[J] = job
	return 1

/datum/controller/subsystem/jobs/proc/GetJob(rank)
	if(!length(occupations))
		SetupOccupations()
	return name_occupations[rank]

/datum/controller/subsystem/jobs/proc/GetJobType(jobtype)
	if(!length(occupations))
		SetupOccupations()
	return type_occupations[jobtype]

/datum/controller/subsystem/jobs/proc/ResetOccupations()
	for(var/mob/new_player/player in GLOB.player_list)
		if((player) && (player.mind))
			player.mind.assigned_role = null
			player.mind.special_role = null
	occupations.Cut()
	SetupOccupations()
	return

/datum/controller/subsystem/jobs/proc/is_position_available(rank)
	var/datum/job/job = GetJob(rank)
	if(!job)
		return FALSE
	if((job.total_positions == -1) || (job.spawn_positions == -1))
		return TRUE
	return job.current_positions < job.spawn_positions

/datum/controller/subsystem/jobs/proc/AssignRank(mob/living/carbon/human/H, rank, joined_late = FALSE)
	if(!H)
		return null
	var/datum/job/job = GetJob(rank)

	H.job = rank

	var/alt_title = null

	if(H.mind)
		H.mind.assigned_role = rank
		alt_title = H.mind.role_alt_title

		CreateMoneyAccount(H, rank, job)

	var/list/L = list()
	L.Add("<b>Your role on the station is: [alt_title ? alt_title : rank].")
	L.Add("You answer directly to [job.supervisors]. Special circumstances may change this.")
	L.Add("For more information on how the station works, see [wiki_link("Standard_Operating_Procedure", "Standard Operating Procedure (SOP)")].")
	if(job.job_department_flags & DEP_FLAG_SERVICE)
		L.Add("As a member of Service, make sure to read up on your [wiki_link("Standard_Operating_Procedure_(Service)", "Department SOP")].")
	if(job.job_department_flags & DEP_FLAG_SUPPLY)
		L.Add("As a member of Supply, make sure to read up on your [wiki_link("Standard_Operating_Procedure_(Supply)", "Department SOP")].")
	if(job.job_department_flags == DEP_FLAG_COMMAND) // Check if theyre only command, like captain/hop/bs/ntrep, to not spam their chatbox
		L.Add("As an important member of Command, read up on your [wiki_link("Standard_Operating_Procedure_(Command)", "Department SOP")].")
	if(job.job_department_flags & DEP_FLAG_LEGAL)
		L.Add("Your job requires complete knowledge of [wiki_link("Space Law", "Space Law")] and [wiki_link("Legal_Standard_Operating_Procedure", "Legal Standard Operating Procedure")].")
	if(job.job_department_flags & DEP_FLAG_ENGINEERING)
		L.Add("As a member of Engineering, make sure to read up on your [wiki_link("Standard_Operating_Procedure_(Engineering)", "Department SOP")].")
	if(job.job_department_flags & DEP_FLAG_MEDICAL)
		L.Add("As a member of Medbay, make sure to read up on your [wiki_link("Standard_Operating_Procedure_(Medical)", "Department SOP")].")
	if(job.job_department_flags & DEP_FLAG_SCIENCE)
		L.Add("As a member of Science, make sure to read up on your [wiki_link("Standard_Operating_Procedure_(Science)", "Department SOP")].")
	if(job.job_department_flags & DEP_FLAG_SECURITY)
		L.Add("As a member of Security, you are to know [wiki_link("Space Law", "Space Law")] and [wiki_link("Legal_Standard_Operating_Procedure", "Legal Standard Operating Procedure")], as well as your [wiki_link("Standard_Operating_Procedure_(Security)", "Department SOP")].")
	if(job.req_admin_notify)
		L.Add("You are playing a job that is important for the game progression. If you have to disconnect, please go to cryo and inform command. If you are unable to do so, please notify the admins via adminhelp.")
	L.Add("<br>If you need help, check the [wiki_link("Main_Page", "wiki")] or use Mentorhelp(F1)!</b>")
	if(job.important_information)
		L.Add("</b><span class='userdanger' style='width: 80%'>[job.important_information]</span>")

	to_chat(H, chat_box_green(L.Join("<br>")))

	// If the job has objectives, announce those too
	if(length(H.mind.job_objectives))
		var/list/objectives_message = list()
		var/counter = 1
		for(var/datum/job_objective/objective as anything in H.mind.job_objectives)
			objectives_message.Add("<b>Objective #[counter]: [objective.objective_name]</b>")
			objectives_message.Add("[objective.description]<br>")
			counter++
		to_chat(H, chat_box_notice(objectives_message.Join("<br>")))

	return H

/datum/controller/subsystem/jobs/proc/EquipRank(mob/living/carbon/human/H, rank, joined_late = 0) // Equip and put them in an area
	if(!H)
		return null

	var/datum/job/job = GetJob(rank)

	H.job = rank

	if(!joined_late && !late_arrivals_spawning)
		var/turf/T = null
		var/obj/S = null
		var/list/landmarks = GLOB.landmarks_list
		if((drunken_spawning && !HAS_TRAIT(H, TRAIT_TEMPERATE_PARTIER)) || HAS_TRAIT(H, TRAIT_WORK_HARD_PARTY_HARDER))
			landmarks = shuffle(landmarks) //Shuffle it so it's random

		for(var/obj/effect/landmark/start/sloc in landmarks)
			if(sloc.name != rank && !(drunken_spawning && !HAS_TRAIT(H, TRAIT_TEMPERATE_PARTIER)))
				if(!(sloc.name in list("Assistant", "Chef", "Bartender", "Clown", "Mime", "Coroner")) || !HAS_TRAIT(H, TRAIT_WORK_HARD_PARTY_HARDER))
					continue
			if(locate(/mob/living) in sloc.loc)
				continue
			if(drunken_spawning && sloc.name == "AI")
				continue
			S = sloc
			break
		if(!S)
			S = locate("start*[rank]") // use old stype
		if(!S) // still no spawn, fall back to the arrivals shuttle
			for(var/turf/TS in get_area_turfs(/area/shuttle/arrival))
				if(!TS.density)
					var/clear = 1
					for(var/obj/O in TS)
						if(O.density)
							clear = 0
							break
					if(clear)
						T = TS
						continue

		if(isturf(S))
			T = S
		else if(istype(S, /obj/effect/landmark/start) && isturf(S.loc))
			T = S.loc

		if(T)
			H.forceMove(T)
			// Moving wheelchair if they have one
			if(H.buckled && istype(H.buckled, /obj/structure/chair/wheelchair))
				H.buckled.forceMove(H.loc)
				H.buckled.dir = H.dir

	if(job)
		var/new_mob = job.equip(H)
		if(ismob(new_mob))
			H = new_mob

	if(job && H)
		job.after_spawn(H)

		//Gives glasses to the vision impaired
		if(HAS_TRAIT(H, TRAIT_NEARSIGHT))
			var/equipped = H.equip_to_slot_or_del(new /obj/item/clothing/glasses/regular(H), ITEM_SLOT_EYES)
			if(!equipped)
				GLOB.dropped_item_list += new /obj/item/clothing/glasses/regular(H)

		if(!job.allow_bureaucratic_error)
			return

		if(job.department_head)
			if(job.department_head[1] == "Captain") //I feel like this should be a var on job datum but eh
				return

			// Send a message to the person in the job's department_head through PDA
			var/datum/job/J = job
			var/head_title = J.department_head[1]

			// [TRIMMED] PDA-lookup body — /obj/item/pda is outside the slice.
			var/no_bureaucratic_error = TRUE
			if(!no_bureaucratic_error)
				return

			var/sent_name = head_title

			to_chat(H, SPAN_NOTICE("Your department head, [sent_name], has been notified of your arrival."))
	return H

// ===== VERBATIM: code/datums/job/job.dm (subset — vars + equip path) =====

/datum/job

	//The name of the job
	var/title = "NOPE"

	/// Job access. A list of constants from access_defines.dm.
	var/list/access = list()

	///Job Bitflag, used for Database entries - DO NOT JUST EDIT THESE
	var/flag = 0
	///Department(s) Bitflag, used for Databse entries - DO NOT JUST EDIT THESE
	var/department_flag = 0
	///list of the names of departments heads (as strings)
	var/department_head = list()
	///List of the department(s) this job is a part of
	var/job_departments = list()
	///Can this role access its department money account?
	var/department_account_access = FALSE
	/// Does this job get a bank account?
	var/has_bank_account = TRUE
	//How many players can be this job
	var/total_positions = 0

	//How many players can spawn in as this job
	var/spawn_positions = 0

	//How many players have this job
	var/current_positions = 0

	//Supervisors, who this person answers to directly
	var/supervisors = ""

	/// Text which is shown to someone in BIG BOLG RED when they spawn. Use for critically important stuff that could make/break a round
	var/important_information = null

	//Sellection screen color
	var/selection_color = "#ffffff"

	//List of alternate titles, if any
	var/list/alt_titles

	//If this is set to 1, a text is printed to the player when jobs are assigned, telling him that he should let admins know that he has to disconnect.
	var/req_admin_notify

	/// Flags for identifying by department, because we need other shit that isnt for the database
	var/job_department_flags

	//If you have use_age_restriction_for_jobs config option enabled and the database set up, this option will add a requirement for players to be at least minimal_player_age days old. (meaning they first signed in at least that many days before.)
	var/minimal_player_age = 0

	// Assoc list of EXP_TYPE_ defines and the amount of time needed in those departments
	var/list/exp_map = list()

	/// Cannot pick this job if the character has these disabilities
	var/list/blacklisted_disabilities = list()
	/// If this job could have any amputated limbs
	var/missing_limbs_allowed = TRUE

	/// What outfit does this job's players start in? Must be a /datum/outfit
	var/outfit = null

	/// Can people be hired to this position despite not actually being there in
	/// a manner which makes sense (e.g. HoP line). If they can, allow
	/// bureaucratic errors (job announcements in the wrong place, etc)
	var/allow_bureaucratic_error = FALSE

	/// Difficulty of the job. Used for a few things, mainly what
	/// /datum/job/equip chooses to display when giving the "you are X" text.
	var/difficulty = NONE_DIFFICULTY

/datum/job/proc/equip(mob/living/carbon/human/H, visualsOnly = FALSE, announce = TRUE, datum/outfit/outfit_override = null, assign_special_role = FALSE, skip_pda = FALSE)
	if(!H)
		return 0

	if(outfit_override)
		equipOutfit(H, outfit_override)
	else
		equipOutfit(H, outfit)
	return H

/datum/job/proc/after_spawn(mob/living/carbon/human/H)
	SHOULD_CALL_PARENT(TRUE)
	SEND_GLOBAL_SIGNAL(COMSIG_GLOB_JOB_AFTER_SPAWN, H)

/datum/job/proc/equipOutfit(mob/living/carbon/human/H, datum/outfit/outfit_override, visualsOnly = FALSE)
	if(visualsOnly)
		var/datum/outfit/O = outfit_override || outfit
		if(O)
			H.equipOrCollect(O.belt, ITEM_SLOT_BELT)
			H.equipOrCollect(O.l_ear, ITEM_SLOT_EAR_LEFT)
			H.equipOrCollect(O.r_ear, ITEM_SLOT_EAR_RIGHT)
			H.equipOrCollect(O.gloves, ITEM_SLOT_GLOVES)
			H.equipOrCollect(O.shoes, ITEM_SLOT_SHOES)
			H.equipOrCollect(O.head, ITEM_SLOT_HEAD)
			H.equipOrCollect(O.mask, ITEM_SLOT_MASK)
			H.equipOrCollect(O.neck, ITEM_SLOT_NECK)
			H.equipOrCollect(O.back, ITEM_SLOT_BACK)
			H.equipOrCollect(O.uniform, ITEM_SLOT_UNIFORM)
			H.equipOrCollect(O.suit, ITEM_SLOT_SUIT)
	else
		var/datum/outfit/O = outfit_override || outfit
		if(O)
			equipOutfit_impl(H, O)

/datum/job/proc/equipOutfit_impl(mob/living/carbon/human/H, datum/outfit/O)
	// [MARKED SHIM] paradise's equipOutfit walks the outfit datum's item
	// lists and equips each piece; the slice records the outfit used on
	// the mob so role-appropriate equipment is observable without the
	// item/clothing tree.
	world << "M2R-DBG: equipOutfit_impl [O] onto [H]"
	H.job_outfit = O

/datum/job/proc/get_access()
	return access.Copy()

/datum/job/proc/is_position_available()
	return (total_positions == -1) || (spawn_positions == -1) || (current_positions < spawn_positions)

// ===== VERBATIM: code/datums/job/depts/service_jobs.dm — two real jobs =====

/datum/job/assistant
	title = "Assistant"
	flag = JOB_ASSISTANT
	department_flag = JOBCAT_SUPPORT
	total_positions = -1
	spawn_positions = -1
	supervisors = "the head of personnel"
	department_head = list("Head of Personnel")
	selection_color = "#dddddd"
	access = list()			//See /datum/job/assistant/get_access()
	alt_titles = list(
		"Off-Duty",
		"Retired",
		"Intern",
	)
	outfit = /datum/outfit/job/assistant
	difficulty = NONE_DIFFICULTY
	description = "Assistants have the responsibility to learn the game.\n\n\
					Difficulties: Learning the controls. Radio headsets"

/datum/job/assistant/get_access()
	if(GLOB.configuration.jobs.assistant_maint_access)
		return list(ACCESS_MAINT_TUNNELS)
	else
		return list()

/datum/job/chef
	title = "Chef"
	flag = JOB_CHEF
	department_flag = JOBCAT_SERVICE
	total_positions = 1
	spawn_positions = 1
	supervisors = "the head of personnel"
	department_head = list("Head of Personnel")
	selection_color = "#dddddd"
	access = list()
	outfit = /datum/outfit/job/chef
	difficulty = EASY_DIFFICULTY
	description = "As a Chef, you are tasked with keeping the crew fed. Cook food in the kitchen and sell it to the crew."

// Minimal outfit datums so outfit paths resolve (paradise: datums/outfits.dm).
/datum/outfit
	var/name = "NOPE"

/datum/outfit/job
	name = "job"

/datum/outfit/job/assistant
	name = "Assistant"

/datum/outfit/job/chef
	name = "Chef"
