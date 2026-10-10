// M2 slice compat defines — VERBATIM #define lines lifted from Paradise's
// code/__DEFINES/*. The trimmed corpus has no other way to see these
// constants; each line names its source file. Values are real, not
// paraphrased. Everything the door code needs that is NOT a constant
// (procs, complex macros) is left undefined on purpose — undefined names
// degrade to Null in the runtime, which is the dogfooding this item wants.

// code/__DEFINES/flags.dm
#define NONE 0
#define ALL ~0
#define PREVENT_CLICK_UNDER		(1<<8)
#define UPDATE_ICON_STATE	(1<<2)
#define UPDATE_OVERLAYS		(1<<3)
#define PASSGLASS		(1<<1)
#define PASSDOOR		(1<<7)

// code/__DEFINES/machines.dm
#define DOOR_OPENING 1
#define DOOR_CLOSING 2

// code/__DEFINES/layers.dm
#define OPEN_DOOR_LAYER 2.7
#define CLOSED_DOOR_LAYER 3.1

// code/__DEFINES/atmospherics_defines.dm
#define DOOR_HEAT_TRANSFER_COEFFICIENT		0.001
#define ZERO_HEAT_TRANSFER_COEFFICIENT		0.0

// code/__DEFINES/misc_defines.dm
#define CLICK_CD_MELEE 8
#define DOOR_CRUSH_DAMAGE 10
#define EXPLOSION_BLOCK_PROC -1

// code/__DEFINES/power_defines.dm
#define PW_CHANNEL_ENVIRONMENT	3

// code/__DEFINES/stat.dm
#define CONSCIOUS	0

// code/__DEFINES/combat_defines.dm
#define BRUTE		"brute"
#define BURN		"fire"
#define EXPLODE_HEAVY 2

// code/__DEFINES/genetics_defines.dm
#define MOB_SIZE_TINY 0

// code/__DEFINES/sound_defines.dm
#define SHORT_RANGE_SOUND_EXTRARANGE -9

// code/__DEFINES/time_defines.dm
#define SECONDS *10

// code/__DEFINES/wires_defines.dm
#define WIRE_IDSCAN "ID Scan"
#define WIRE_OPEN_DOOR "Door State"

// code/__DEFINES/construction_defines.dm
#define AICONTROLDISABLED_OFF 0 // Silicons can control the airlock normally.

// code/__DEFINES/hud.dm
#define DIAG_AIRLOCK_HUD 	"22" // Airlock shock overlay

// airlock.dm's own file-scope defines (they live inside paradise_airlock.dm
// already on master but are reproduced here verbatim for completeness of
// the extracted-file convention — harmless duplicates of the same value).
#define AIRLOCK_CLOSED	1
#define AIRLOCK_CLOSING	2
#define AIRLOCK_OPEN	3
#define AIRLOCK_OPENING	4
#define AIRLOCK_DENY	5
#define AIRLOCK_EMAG	6

#define AIRLOCK_SECURITY_NONE			0 //Normal airlock
#define AIRLOCK_SECURITY_METAL			1 //Medium security airlock
#define AIRLOCK_SECURITY_PLASTEEL_I_S	2
#define AIRLOCK_SECURITY_PLASTEEL_I		3
#define AIRLOCK_SECURITY_PLASTEEL_O_S	4
#define AIRLOCK_SECURITY_PLASTEEL_O		5
#define AIRLOCK_SECURITY_PLASTEEL		6 //Max security airlock

#define AIRLOCK_INTEGRITY_N			 300 // Normal airlock integrity
#define AIRLOCK_INTEGRITY_MULTIPLIER 1.5 // How much reinforced doors health increases
#define AIRLOCK_DAMAGE_DEFLECTION_N  21  // Normal airlock damage deflection
#define AIRLOCK_DAMAGE_DEFLECTION_R  30  // Reinforced airlock damage deflection

#define UI_GREEN 2
#define UI_ORANGE 1
#define UI_RED 0

// code/__DEFINES/dcs/dcs_helpers.dm — REAL signal-send macro. With no
// comp_lookup on the datum it evaluates to NONE (0), matching BYOND's
// "no signal consumers" result; _SendSignal is unreachable then.
#define SEND_SIGNAL(target, sigtype, arguments...) ( !target.comp_lookup || !target.comp_lookup[sigtype] ? NONE : target._SendSignal(sigtype, list(target, ##arguments)) )

// code/__DEFINES/tg_cooldowns.dm:74
#define COOLDOWN_DECLARE(cd_index) var/##cd_index = 0

// code/__DEFINES/_globals.dm — GLOBAL_LIST_EMPTY(X) -> GLOBAL_LIST_INIT(X,
// list()) -> GLOBAL_RAW(/list/##X); GLOBAL_MANAGED(X, ...). The transpiler
// needs the concrete result: a file-scope global list var.
#define GLOBAL_LIST_EMPTY(X) /global/var/list/##X = list()

// paradise proc-marker defines — they expand to linter hints only, so the
// empty expansion here is semantically identical.
#define SIGNAL_HANDLER
#define SHOULD_NOT_SLEEP(X)
#define SHOULD_CALL_PARENT(X)
#define PROTECTED_PROC(X)
