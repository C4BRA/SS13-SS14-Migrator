// M2 slice — VERBATIM extract of Paradise code/game/jobs/access.dm lines 1-45
// (the generic access-check procs; job-specific access tables below line 45
// are not needed by the door slice and are omitted). Source:
// ParadiseSS13/Paradise master @ Oct-2026.

//returns 1 if this mob has sufficient access to use this object
/obj/proc/allowed(mob/M)
	//check if we don't require any access at all
	var/attempted_access = SEND_SIGNAL(M, COMSIG_MOB_TRIED_ACCESS, src)
	if(attempted_access & ACCESS_DISALLOWED)
		return FALSE
	if(check_access())
		return 1

	if(!M)
		return 0

	var/acc = M.get_access() //see mob.dm

	if(acc == IGNORE_ACCESS || M.can_admin_interact())
		return 1 //Mob ignores access

	else
		return check_access_list(acc)

/obj/proc/check_access(obj/item/I)
	var/list/L
	if(I)
		L = I.GetAccess()
	else
		L = list()
	return check_access_list(L)

/obj/proc/check_access_list(list/L)
	if(!L)
		return 0
	if(!istype(L, /list))
		return 0
	return has_access(req_access, req_one_access, L)

/proc/has_access(list/req_access, list/req_one_access, list/accesses)
	for(var/req in req_access)
		if(!(req in accesses)) //doesn't have this access
			return 0
	if(length(req_one_access))
		for(var/req in req_one_access)
			if(req in accesses) //has an access from the single access list
				return 1
		return 0
	return 1
