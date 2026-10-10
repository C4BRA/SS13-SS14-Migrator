// M2 slice — VERBATIM proc extracts the door slice calls through.
// Sources: Paradise code/game/atoms.dm (update_icon family, set_density),
// code/modules/lighting/lighting_atom.dm (set_opacity family),
// code/_onclick/other_mobs.dm (attack_hand). Only the procs in the door
// call chain are extracted; surrounding file contents are omitted.

// ---- code/game/atoms.dm:545 ----
/atom/proc/update_icon(updates=ALL)
	SIGNAL_HANDLER
	SHOULD_CALL_PARENT(TRUE)

	if(updates & NONE)
		return // NONE is being sent on purpose, and thus no signal should be sent.

	updates &= ~SEND_SIGNAL(src, COMSIG_ATOM_UPDATE_ICON, updates)
	if(updates & UPDATE_ICON_STATE)
		update_icon_state()
		SEND_SIGNAL(src, COMSIG_ATOM_UPDATE_ICON_STATE)

	if(updates & UPDATE_OVERLAYS)
		var/list/new_overlays = update_overlays(updates)
		if(managed_overlays)
			cut_overlay(managed_overlays)
			managed_overlays = null
		if(length(new_overlays))
			if(length(new_overlays) == 1)
				managed_overlays = new_overlays[1]
			else
				managed_overlays = new_overlays
			add_overlay(new_overlays)

	SEND_SIGNAL(src, COMSIG_ATOM_UPDATED_ICON, updates)

// ---- code/game/atoms.dm:576 ----
/atom/proc/update_icon_state()
	PROTECTED_PROC(TRUE)
	return

// ---- code/game/atoms.dm:~596 ----
/atom/proc/update_overlays()
	PROTECTED_PROC(TRUE)
	. = list()
	SEND_SIGNAL(src, COMSIG_ATOM_UPDATE_OVERLAYS, .)

// ---- code/game/atoms.dm:1428 ----
/atom/proc/set_density(new_value)
	if(density == new_value)
		return
	. = density
	density = new_value

// ---- code/modules/lighting/lighting_atom.dm:57 ----
/atom/proc/set_opacity(new_opacity)
	if(new_opacity == opacity)
		return

	SEND_SIGNAL(src, COMSIG_ATOM_SET_OPACITY, new_opacity)
	. = opacity
	opacity = new_opacity

/atom/movable/set_opacity(new_opacity)
	. = ..()
	if(isnull(.) || !isturf(loc))
		return

	if(opacity)
		AddElement(/datum/element/light_blocking)
	else
		RemoveElement(/datum/element/light_blocking)

// ---- code/_onclick/other_mobs.dm:30 ----
/atom/proc/attack_hand(mob/user as mob, params)
	if(SEND_SIGNAL(src, COMSIG_ATOM_ATTACK_HAND, user) & COMPONENT_CANCEL_ATTACK_CHAIN)
		return TRUE
