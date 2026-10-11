# W-M (item 33): UI strategy spike — text-UI bridge over the console channel

Question: can BYOND's interface model (`.dmf` skins, `browse()` browser
controls, `input()`/`alert()` modal prompts, `Topic()` href routing, verb
panels) be emulated enough to be *playable*, or must converted games port to
SS14-native UI?

**Answer from the spike: the BYOND message loop is a routing problem, not a
rendering problem — and it routes fine over the existing `dm*` console
channel. The recommendation for M2+ is a two-track UI: keep the BYOND loop
(Topic/verbs/prompts) on a chat/console-style presentation, and port the
*windows* (tgui-class UIs) to SS14-native `BoundUserInterface`. Emulating the
.dmf/browser layer itself is the expensive path and buys the least.**

## 1. Survey — what the corpora actually use

Grep counts (case-sensitive, `**/*.dm`; `input..in`/`as..in` counted with
`input\b.*?\bin\b` line patterns; `verb/` = `/verb/` path segments;

| Mechanism | Paradise | tgstation | Notes |
|---|---|---|---|
| `input(...)` total | 349 | 256 | modal prompts, all kinds |
| `input ... in list` | ~171 | ~139 | pick-from-list (the "menu" idiom) |
| `input ... as T in` | 9 | 21 | typed pick (mostly `as num`) |
| `alert(...)` | 292 | 27 | 3-button confirm |
| `<< browse` / `browse(...)` | ~146 | ~51 | browser-control pages |
| `/Topic(` overrides | 93 | 50 | server-side href endpoints |
| `href=` emitted strings | ~1100 | ~412 | links inside browse/say payloads |
| `/verb/` definitions | 187 | 40 | verb-panel entries |
| `Click(` overrides | ~141 | ~178 | map clicks (already bridged: `dmclick`) |
| `winset(`/`winget`/`winclone` | 48 | 70 | skin mutation — thin tail |
| `output(` to controls | 13 | 14 | grid/info control writes |
| `.dmf` skin files | 1 | 1 | ~19 window/elem lines, boot boilerplate only |
| tgui machinery (`tgui`, `SStgui`, `ui_interact`, `ui_act`, `ui_data`) | ~1609 | ~2123 | 340 Paradise `.dm` files touch it |

Reading of the numbers:

- **The verb panel and `Click()` are the primary interaction surface** —
  `Click()` overrides alone outnumber `/verb/` defs 2-4x in tg, and verbs +
  clicks already work (`dmverb`/`dmclick`, M1 gate). Most day-to-day SS13
  play is click + verb + chat.
- **Topic()/browse() is the legacy admin/info panel path** — 93/50 Topic
  procs and 1100+/400+ emitted hrefs are real but *sparse* relative to
  tgui. Everything pre-tgui (admin panels, VV, papers, computers on
  Paradise-era code) flows through here.
- **`input()`/`alert()` are everywhere and cheap to serve** — they suspend
  the calling proc for a scalar answer; ~350/250 call sites, but the
  *protocol* is tiny: question in, answer out.
- **winset/winget is a thin tail** — 48/70 call sites, mostly HUD/map-popup
  tricks (`code/_onclick/hud/map_popups.dm`), not core play.
- **tgui is the dominant "real window" surface by an order of magnitude**
  (1600–2100 hits, hundreds of files) — and it is itself just Topic-shaped:
  `ui_data()` → JSON → React UI → `ui_act(action, params)` → server. It is
  emphatically *not* a .dmf-skin problem.

Conclusion the survey forces: a "BYOND UI emulation" that tried to render
.dmf skins + browser controls would be solving the *least-used* surface
(1 boilerplate skin file, ~50 Topic procs) while tgui — the majority
window surface — would still need its own solution anyway.

## 2. What the spike built (and proved)

New runtime region `DMUiRuntime` (dmRuntimeCS.ts, `// W-M ui` markers) +
emitters in csharpEmitter (`// W-M ui` markers), wired over the same
console channel that already carries `dmverb`/`dmclick`/`usr <<` text:

| BYOND element | Spike implementation |
|---|---|
| `usr << browse(html,"window=w")` | `DMBrowseDoc` marker intercepted in `DMValue.Output` → `RenderBrowse`: HTML stripped to text lines, `<a href>` links extracted, numbered, registered per-usr, printed to the session console (`== w ==` header + `links (dmlink <n>)`). |
| link click | `dmlink <n>` → `RouteHref`: parses `?k=v;k2=v2` into an assoc `href_list`, resolves `src=` via the ref() table → fires `verb=` through `CallVerbAsUsr` or `Topic(href, href_list)` on src → usr → `/world` fallback. `byond://`/external URLs are honest no-ops. |
| verb/stat panel | `dmpanel` — enumerates the mob's verbs (the `dmverbs` infra) and registers `?src=<ref>;verb=<name>` links — **the exact href shape BYOND panels generate**, so panel clicks and page clicks share one router. |
| `input()`/`input() as T`/`input() in L` | `InputAsync(args, asType, pickList)` → `DMUiPrompt` (options filtered by `as`, defaults honored) → pushed to the session console as `== INPUT #id:` + numbered options; proc suspends until `dmanswer <id> <n|text>` or `(cancel)`. |
| `alert()` | same machinery, `Kind="alert"`, buttons as options (default folds into button1 per BYOND arg order). |
| `dmlinks` | lists the pending link table. |
| engine-free (probes/headless) | `PromptHook == null` → deterministic default (default-matching option → default → first option). Probes stay green without a session. Orphaned prompts on a session-less usr auto-default + log, so no proc can deadlock. |

Emission: `input(...) in L` / `as T` intercepted in the binary-op path
(parser binds `input(...) as num in L` as nested binops — the emitter walks
the `in`/`as` pair to find the input call); `input()/alert()/browse()`
intercepted before the STUBBED_BUILTINS fallback.

### Evidence (converted m1-demo + ui.dm fixture, headless client autocmds)

Real captured transcript — every arrow is a different hop in the BYOND loop:

```
> dmpanel
verbs (dmlink <n>):
  [1] step_east [2] step_north [3] uiask [4] uipanel
> dmlinks
  [3] uiask    (?src=REF[0x1];verb=uiask)      <- BYOND panel href shape
> dmlink 3                                      <- click a panel link
== INPUT #1: UI prompt — Choose a number
   [1] 1 [2] 2 [3] 3
   dmanswer 1 <n|text>   ('(cancel)' aborts)
> dmanswer 1 3
UI-INPUT: pick=3                                <- suspended proc resumed
== ALERT #2: UI alert — Really?
> dmanswer 2 Yes
UI-ALERT: ok=Yes
> dmverb uipanel                                <- usr << browse(html,opts)
== uipanel ==
Panel
topic-hit
verb-hit
links (dmlink <n>):
  [5] topic-hit    (?src=REF[0x2];x=7)          <- relay datum ref
  [6] verb-hit     (?src=REF[0x2];verb=vpoke)
> dmlink 5                                      <- Topic() round-trip
UI-TOPIC client: href x=7
UI-TOPIC: x=7 hits=1                            <- href_list["x"] read inside Topic
> dmlink 6                                      <- ?verb= on a non-mob datum
UI-VERB client: vpoke fired via ?verb= link
UI-VERB: m1 player vpoke fired
> dmlink 1                                      <- verb panel click -> move
M1-MOVE: mob moved to 2,1,1
> dmloc
x=2, y=1, z=1
```

Server log confirms `Player ... attached to mob "4"` and `dm.out` copies of
the `UI-*`/`M1-MOVE` world broadcasts — i.e. `world <<` and `usr <<` both
land on their correct channels.

## 3. What this proves / doesn't prove

**Proven:** the entire BYOND *server-side UI protocol* is alive: prompts
suspend/resume with correct DM semantics (defaults, `as` filters, cancel →
null), href → Topic()/verb resolution works across datum types, the verb
panel is the same router in disguise. The mechanism is *faithful*, only the
presentation is text. For a playable loop (admin tools, papers, VV, machine
panels, combat verbs, object examine/click) this suffices — BYOND itself
delivers these semantics over chat-adjacent panes for half of its UI.

**Not proven (out of spike scope):** rich rendering (colors, tables,
images-in-chat — the console channel is text-only); `output()` to
grid/info controls (13–14 sites, unwired); `winset` skin mutation (48–70
sites, still Null stubs); and *client-side polish* — today the presentation
is the toolshed/console log the engine already ships to sessions.

## 4. The alternative, honestly costed

**Emulate the .dmf/browser layer.** A real skin interpreter would need: the
.dmf window tree parser, a control model (browser/output/input/map/
info/label/button...), `winset`/`winget`/`winclone` property mutation,
per-window pane routing, and a BYOND-compatible HTML renderer for browser
controls (the HTML corpus is 2004-era: nested tables, `<font>`, inline
styles). Effort estimate: **3–5× this spike for a crippled subset** —
measured against this spike's one-session cost, call it 3–5 sessions to a
non-playable demo, and it *still does not address tgui* (which is the
majority of real windows: ~1600–2100 references vs ~50 Topic procs). Every
hour spent here is an hour spent reimplementing the least-used surface.

**tgui emulation.** tgui's DM side is `ui_interact`/`ui_data`/`ui_act` +
`SStgui` lifecycle; its client side is a real React app over JSON state.
Emulating it = shipping a React runtime + the tg-packaged interfaces +
the SS topic channel — strictly more work than option A, though it covers
the largest surface.

**SS14-native BoundUserInterface (recommended north star).** The pin's BUI
machinery already does exactly what tgui does: server-held UI state →
serialized to client → `BoundUserInterface` renders → `*Message` back to
server. A converted machine's `ui_interact`/`ui_data`/`ui_act` maps
mechanically onto `BoundUIState`/`ui_act` messages — same shape, typed and
engine-supported, including range/PVS checks the BYOND model lacks. This is
where converted *windows* should land; the spike's text bridge covers the
*protocol* underneath meanwhile.

## 5. Recommendation for M2+

1. **Keep the text-UI bridge as the protocol floor** (this spike): Topic(),
   verbs-as-links, prompts. It is faithful, cheap, and already playable.
   Near-term upgrades that stay inside the same model: a `dmlink`-clickable
   chat affordance on the client (client-side command composer — the links
   are already numbered), `output()` routed to a named "control" buffer
   rendered like browse, and real `byond://` external-link surfacing.
2. **For windows, write a `ui_interact`/`ui_act` → BoundUserInterface
   adapter** rather than emulating either BYOND layer: tgui-class UIs get
   real engine windows; the DM call sites barely notice (they already call
   `ui_interact()` and answer `ui_act()` — a translated BUI subclass can
   invoke the converted procs verbatim).
3. **Leave `.dmf`/`winset` un-emulated** — 48–70 call sites, mostly HUD
   popups and boot boilerplate; port the handful that matter by hand or
   stub-map them to the nearest BUI control.
4. **Negative finding worth keeping:** do NOT invest in a browser-control
   HTML renderer or a skin interpreter — the survey says they'd serve ~5%
   of the window surface at the highest cost.

### Metrics (honest)

- Survey: Paradise 349 input / 292 alert / ~146 browse / 93 Topic / 187
  verbs / 48 winset / ~1609 tgui refs; tgstation 256 / 27 / ~51 / 50 /
  40 / 70 / ~2123.
- Probes: 298 → **309** (+11 W-M engine-free semantics), all green.
- `npm test` green incl. 11 new W-M emit assertions; boot-smoke PASS.
- Live evidence: one converted fixture, one client — verb-through-link,
  Topic() round-trip, input/alert suspend-resume all logged.
- Known limits: text-only presentation; `output()`/`winset`/`winget` unwired
  (thin tail, deliberate); `dmpanel` lists mob verbs only (BYOND panels
  also list src-verbs-in-view); link table is per-usr FIFO-64 (pages push
  new links, oldest fall off); pending prompts cap at 32/usr then
  auto-default oldest; browse()'s `window=` is a label, not a pane model.
