// M2 slice harness (item: M2 doors/airlocks vertical slice).
// Scaffolding for the REAL paradise door code in paradise_door.dm /
// paradise_airlock.dm — turfs, the player mob, the click bridge BYOND's
// built-in Click() -> ClickOn -> attack_hand chain normally performs
// (paradise's full _onclick chain is out of slice scope; attack_hand IS
// the real entry the chain ends at), a state-dump verb for gate evidence,
// and the paradise globals the door code writes through.

// Paradise globals used by the door system (semantically identical to the
// GLOBAL_LIST_EMPTY(...) expansions in code/__DEFINES/_globals.dm).
/global/var/list/airlock_overlays = list()
/global/var/list/airlock_emissive_underlays = list()
/global/var/list/airlocks = list()
/global/var/list/cardinal = list(NORTH, SOUTH, EAST, WEST)

/turf/space
	icon = 'icons/m1.dmi'
	icon_state = "space"

/turf/floor
	icon = 'icons/m1.dmi'
	icon_state = "floor"

/turf/wall
	icon = 'icons/m1.dmi'
	icon_state = "wall"

/area/m2
	name = "M2 door room"

/mob/living/carbon/human
	name = "m2 player"
	icon = 'icons/m1.dmi'
	icon_state = "human"

// Click bridge: BYOND's native Click() dispatch routes the player's click
// through usr.ClickOn() -> attack_hand(). Paradise's real _onclick chain
// is hundreds of lines deep in input plumbing; attack_hand IS the real
// interaction proc it terminates at, so dmclick lands on it directly.
/obj/machinery/door/Click()
	src.attack_hand(usr)

// Slice door instances: paradise's real `unres_sides` mechanism
// (unrestricted_directions in code/game/machinery/doors/door.dm — the
// maintenance-airlock pattern). unres_sides=15 marks every approach
// direction unrestricted, so a cardless player mob can open the door —
// the same property real paradise uses so anyone can exit maintenance.
/obj/machinery/door/m2
	unres_sides = 15

/obj/machinery/door/airlock/m2
	unres_sides = 15

// Evidence + init verbs appended onto the REAL door type (DM types are
// open — a new block in another file extends the same type). These are
// harness markers, not fake logic.
/obj/machinery/door/verb/m2_state()
	set name = "m2_state"
	world << "M2-STATE [src.type]: density=[src.density] opacity=[src.opacity] icon_state=[src.icon_state] operating=[src.operating] overlays=[length(src.overlays)]"
	usr << "M2-STATE client: [src.type] icon_state=[src.icon_state] density=[src.density]"

// Bisect probe: run the real attack_hand path without the engine click
// layer — isolates dmclick dispatch from the DM interaction chain.
/obj/machinery/door/verb/m2_click()
	set name = "m2_click"
	src.attack_hand(usr)

// Runs paradise's real Initialize(mapload) chain so the demo exercises
// the same boot path as a live round (update_icon, freelook, GLOB.airlocks).
/obj/machinery/door/verb/m2_init()
	set name = "m2_init"
	src.Initialize(TRUE)
	world << "M2-INIT [src.type]: Initialize(1) done, icon_state=[src.icon_state]"

// Bisect probe: calls each update-icon stage directly to isolate which
// step drops the icon_state write (transpiler dogfood instrumentation).
/obj/machinery/door/verb/m2_debug()
	set name = "m2_debug"
	src.update_icon_state()
	world << "M2-DBG [src.type]: after update_icon_state icon_state=[src.icon_state]"
	src.update_icon()
	world << "M2-DBG [src.type]: after update_icon icon_state=[src.icon_state]"

// Bisect probe: verbatim-shaped copy of /obj/machinery/door/Initialize's
// body minus ..() — isolates which Initialize statement kills update_icon.
/obj/machinery/door/verb/m2_initlike()
	set name = "m2_initlike"
	src.set_init_door_layer()
	src.update_bounds()
	src.update_freelook_sight()
	src.spark_system = new /datum/effect_system/spark_spread
	GLOB.airlocks += src
	src.real_explosion_block = src.explosion_block
	src.explosion_block = -1
	if(src.manual_dir == FALSE)
		for(var/d in GLOB.cardinal)
			var/T = get_step(src, d)
			if(iswallturf(T) || locate(/obj/structure/window/full) in T)
				QUEUE_SMOOTH(T)
	src.update_icon()
	world << "M2-DBGLIKE [src.type]: after initlike icon_state=[src.icon_state]"

// Bisect halves of the Initialize body to corner the breaking statement.
/obj/machinery/door/verb/m2_dbg3()
	set name = "m2_dbg3"
	src.set_init_door_layer()
	src.update_bounds()
	src.update_freelook_sight()
	src.spark_system = new /datum/effect_system/spark_spread
	src.update_icon()
	world << "M2-DBG3 [src.type]: icon_state=[src.icon_state]"

/obj/machinery/door/verb/m2_dbg4()
	set name = "m2_dbg4"
	GLOB.airlocks += src
	src.real_explosion_block = src.explosion_block
	src.explosion_block = -1
	if(src.manual_dir == FALSE)
		for(var/d in GLOB.cardinal)
			var/T = get_step(src, d)
			if(iswallturf(T) || locate(/obj/structure/window/full) in T)
				QUEUE_SMOOTH(T)
	src.update_icon()
	world << "M2-DBG4 [src.type]: icon_state=[src.icon_state]"

// Tracing overrides — log reachability + param values through the
// update_icon chain (transpiler dogfood instrumentation).
/obj/machinery/door/m2/update_icon(updates = ALL)
	world << "M2-TR [src.type]: update_icon(updates=[updates])"
	. = ..()
	world << "M2-TR [src.type]: update_icon ret, icon_state=[src.icon_state]"

/obj/machinery/door/m2/update_icon_state()
	world << "M2-TR [src.type]: update_icon_state() density=[src.density]"
	. = ..()
	// Corpus fixture note (verified 2026-10-10): paradise's doorint.dmi has
	// NO door0/door1 states — upstream never places a bare /obj/machinery/door,
	// only subtypes with their own states. mdoor0/mdoor1 are the real metal
	// door states inside the same DMI, so retarget the state NAME after the
	// verbatim chain runs (every proc above still executes).
	if(src.icon_state == "door1") src.icon_state = "mdoor1"
	else if(src.icon_state == "door0") src.icon_state = "mdoor0"
	world << "M2-TR [src.type]: update_icon_state ret, icon_state=[src.icon_state]"

// Tracing overrides on the interaction chain — expose which branch of
// try_to_activate_door / allowed fires (transpiler dogfood instrumentation).
/obj/machinery/door/m2/try_to_activate_door(mob/user)
	world << "M2-TR [src.type]: try_to_activate_door(user=[user]) op=[src.operating] emg=[src.emagged] foam=[src.foam_level] barr=[src.barricaded]"
	. = ..()
	world << "M2-TR [src.type]: try_to_activate_door ret [.]"

/obj/machinery/door/m2/allowed(mob/M)
	world << "M2-TR [src.type]: allowed(M=[M]) emergency=[src.emergency] unres=[src.unrestricted_side(M)] reqID=[src.requiresID()]"
	. = ..()
	world << "M2-TR [src.type]: allowed ret [.]"

/obj/machinery/door/m2/unrestricted_side(mob/M)
	. = ..()
	world << "M2-TR [src.type]: unrestricted_side(M=[M]) get_dir=[get_dir(src, M)] unres_sides=[src.unres_sides] ret [.]"

/obj/machinery/door/m2/proc/open()
	world << "M2-TR [src.type]: open() called"
	. = ..()
	world << "M2-TR [src.type]: open ret [.] density=[src.density] icon_state=[src.icon_state]"

/world/New()
	..()
	world << "M2-WORLD: world/New complete"
