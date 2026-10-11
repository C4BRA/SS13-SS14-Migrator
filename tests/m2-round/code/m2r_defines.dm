// M2-round compat defines — VERBATIM #define lines lifted from Paradise's
// code/__DEFINES/*. Same convention as tests/m2-slice: constants are real,
// anything that is not a constant is left undefined so it degrades to Null.

// code/__DEFINES/game_defines.dm
#define GAME_STATE_STARTUP		0
#define GAME_STATE_PREGAME		1
#define GAME_STATE_SETTING_UP	2
#define GAME_STATE_PLAYING		3
#define GAME_STATE_FINISHED		4

// code/__DEFINES/subsystems.dm
#define RUNLEVEL_LOBBY		(1<<0)
#define RUNLEVEL_SETUP		(1<<1)
#define RUNLEVEL_GAME		(1<<2)
#define RUNLEVEL_POSTGAME	(1<<3)

// code/__DEFINES/time.dm (deciseconds)
#define SECONDS *10
#define MINUTES *600

// code/__DEFINES/MC.dm — subsystem boilerplate (token-paste macros; the
// transpiler's preprocessor expands SS##X -> SS<name>, #X -> "name").
#define GLOBAL_REAL(X, Typepath) var/global##Typepath/##X
#define NEW_SS_GLOBAL(varname) if(varname != src){if(istype(varname)){Recover();qdel(varname);}varname = src;}
#define SUBSYSTEM_DEF(X) GLOBAL_REAL(SS##X, /datum/controller/subsystem/##X);\
/datum/controller/subsystem/##X/New(){\
	NEW_SS_GLOBAL(SS##X);\
	PreInit();\
	ss_id=#X;\
}\
/datum/controller/subsystem/##X

// code/__DEFINES/_globals.dm
#define GLOBAL_VAR_INIT(X, InitValue) var/global/##X = InitValue
#define GLOBAL_LIST_INIT(X, InitValue) var/global/##X = InitValue
#define GLOBAL_LIST_EMPTY(X) var/global/##X = list()

// code/__DEFINES/initialization.dm
#define INITIALIZATION_INSSATOMS 0
#define INITIALIZATION_INNEW_MAPLOAD 1
#define INITIALIZATION_INNEW_REGULAR 2
#define INITIALIZE_HINT_NORMAL 0
#define INITIALIZE_HINT_LATELOAD 1
#define INITIALIZE_HINT_QDEL 2

// code/__DEFINES/job_defines.dm (subset used by slice jobs)
#define JOBCAT_SUPPORT			(1<<2)
#define JOBCAT_SERVICE			(1<<4)
#define JOB_ASSISTANT			(1<<13)
#define JOB_CHEF				(1<<14)
#define DEP_FLAG_SERVICE		(1<<4)
#define DEP_FLAG_COMMAND		(1<<0)
#define DEP_FLAG_SUPPLY			(1<<1)
#define DEP_FLAG_ENGINEERING	(1<<3)
#define DEP_FLAG_MEDICAL		(1<<5)
#define DEP_FLAG_SCIENCE		(1<<6)
#define DEP_FLAG_SECURITY		(1<<7)
#define DEP_FLAG_LEGAL			(1<<8)
#define CREW_PAY_ASSISTANT		100
#define NONE_DIFFICULTY			1
#define EASY_DIFFICULTY			2
#define PREFTOGGLE_2_RANDOMSLOT	(1<<20)
#define RETURN_TO_LOBBY			0
#define EXP_TYPE_CREW			"crew"
#define ITEM_SLOT_EYES			5
#define MISC_LOG				"misc"
#define COMMAND_MEMBER_STARTING_BALANCE	1000
#define CREW_MEMBER_STARTING_BALANCE	250
#define ACCOUNT_SECURITY_ID		1

// code/__DEFINES/traits.dm — trait names as opaque keys (paradise's trait
// datum machinery is outside the slice; HAS_TRAIT shim => always absent).
#define TRAIT_TEMPERATE_PARTIER		"temperate_partier"
#define TRAIT_WORK_HARD_PARTY_HARDER	"work_hard_party_harder"
#define TRAIT_NEARSIGHT				"nearsight"
#define TRAIT_CURRENTLY_Z_MOVING		"zmove"

// code/__DEFINES/misc
#define NONE			0
#define INDESTRUCTIBLE	(1<<6)
#define LAVA_PROOF		(1<<5)
#define FIRE_PROOF		(1<<4)
#define UNACIDABLE		(1<<3)
#define ACID_PROOF		(1<<2)
#define MOB_LAYER		4
#define TRUE			1
#define FALSE			0
#define ROUNDSTART_LOGOUT_REPORT_TIME	0
#define COMSIG_TICKER_ROUND_STARTING	"ticker_round_starting"
#define COMSIG_GLOB_JOB_AFTER_SPAWN	"job_after_spawn"
#define SHUTTLE_ENDGAME				4
#define MAPROTATION_MODE_HYBRID_FPTP_NO_DUPLICATES	2
#define MAPROTATION_MODE_FULL_RANDOM				1

// ---- MARKED SHIMS ----
// Paradise resolves these through machinery outside the slice (trait datums,
// signals, TGUI spans, timers, logging). Defined so the verbatim branches
// they guard stay on their common path.
#define HAS_TRAIT(A, T) (FALSE)
#define SHOULD_CALL_PARENT(X)
#define SEND_SIGNAL(A, B, C)
#define SEND_GLOBAL_SIGNAL(A, B)
#define SPAN_DARKMBLUE(X) "[X]"
#define SPAN_GREEN(X) "[X]"
#define SPAN_NOTICE(X) "[X]"
#define SPAN_WARNING(X) "[X]"
#define SPAN_DANGER(X) "[X]"
#define SPAN_BOLDNOTICE(X) "[X]"
#define SPAN_INTERFACE(X) "[X]"
#define html_encode(X) "[X]"
#define wiki_link(A, B) "[B]"
#define PROC_REF(X) "proc_ref"
#define TYPE_PROC_REF(T, X) "type_proc_ref"
#define CALLBACK(A, B) B
#define INVOKE_ASYNC(A, B)
#define addtimer(A, B)
#define start_watch() 0
#define stop_watch(W) 0
#define log_debug(X)
#define stack_trace(X)
#define to_chat(A, B) A << "[B]"
#define chat_box_green(X) X
#define chat_box_notice(X) X
#define popleft(L) null
#define english_list(L) "[L]"
#define pickweight(L) pick(L)
#define sortList(L) L
#define ROUND_UP(X) round(X)
#define UNLINT(X) X
