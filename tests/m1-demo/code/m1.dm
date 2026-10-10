// M1 demo world (item 74): one map, a player mob, one clickable object.
// Turfs render via dmTile protos + .tile.png sprites; the button exercises
// the dmclick -> Click() -> 'usr <<'/'world <<' output path; the mob's
// step_* verbs exercise the x/y/z -> engine-transform move path.

/turf/space
	icon = 'icons/m1.dmi'
	icon_state = "space"

/turf/floor
	icon = 'icons/m1.dmi'
	icon_state = "floor"

/turf/wall
	icon = 'icons/m1.dmi'
	icon_state = "wall"

/area/m1
	name = "M1 demo room"

/obj/m1_button
	name = "demo button"
	icon = 'icons/m1.dmi'
	icon_state = "button"
	var/press_count = 0

// Click() is what dmclick invokes (src = clicked atom, usr = calling mob).
/obj/m1_button/proc/Click()
	src.press_count = src.press_count + 1
	usr << "M1-CLICK client: you pressed [src.name]"
	world << "M1-CLICK: [usr.name] pressed the button ([src.press_count]x)"

// Verb alternative on the same object (context-menu stand-in, dmverbon path).
/obj/m1_button/verb/poke()
	usr << "M1-POKE client: you poked [src.name]"
	world << "M1-POKE: [usr.name] poked the button"

/mob/living/carbon/human
	name = "m1 player"
	icon = 'icons/m1.dmi'
	icon_state = "human"

// Movement verbs: y/x var writes route through DMSetProperty ->
// SetAtomPosition -> EntityMoveBridge -> transform SetCoordinates.
/mob/living/carbon/human/verb/step_north()
	src.y = src.y + 1
	world << "M1-MOVE: mob moved to [src.x],[src.y],[src.z]"

/mob/living/carbon/human/verb/step_east()
	src.x = src.x + 1
	world << "M1-MOVE: mob moved to [src.x],[src.y],[src.z]"

/world/New()
	..()
	world << "M1-WORLD: world/New complete"
