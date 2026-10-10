# W-J (item 30): GUI polish — live log, fidelity card, jobs, cancel, output browser

The convert UI (`node dist/cli.js gui`, `src/gui/`) got its iteration pass.
Everything stays inside `src/gui/` — `src/index.ts` and the pipeline are
untouched; the transpiler still only talks via `console.*` and return/throw,
and the GUI learns about progress by listening, not by new API surface.

## Architecture change: convert runs on a worker thread

`src/gui/convertWorker.ts` is new: it receives `{inputDir, outputDir, jobs}`
via `workerData`, wraps `console.log/warn/error` into `postMessage({type:'log'})`,
runs `transpile()`, and posts `{type:'result'}`.

Why a worker instead of the old in-process call:

- **Live log during synchronous stages.** The YAML/C# emit stage is a long
  synchronous run; in-process it starved the event loop, so nothing could be
  streamed mid-stage. In the worker it just posts messages — the HTTP server
  stays responsive and SSE delivery is smooth the whole way through.
- **Real cancellation.** `worker.terminate()` is an actual abort, mid-stage,
  mid-file. An in-process convert has no stop path short of
  `process.exit`.

Trade-off noted: logs arrive as discrete lines with `log|warn|error` level —
formatting identical to the CLI's own output since the same strings are
forwarded and re-printed on the server console.

## Endpoints (all behind the existing session-token posture)

| Endpoint | Notes |
|---|---|
| `GET /api/events` | SSE: `{t:'start'}` on run begin (`{replay:true}` marker on connect), `{t:'log'}` per line, `{t:'done'}` at finish. Token via `?token=` (EventSource can't set headers). Replay buffer 5000 lines; mid-flight joiners catch up, late joiners get history + `done`. |
| `POST /api/cancel` | 409 when idle; otherwise sets the cancelled flag + terminates the worker. The pending `/api/convert` resolves `{cancelled:true}` from the worker `exit` event — one code path finishes every outcome. |
| `GET /api/tree` | `root`+`path`; entries `{name,dir,size}` dirs-first, 5000-entry cap. |
| `GET /api/file` | `root`+`path`; first 256 KB text, `truncated`/`binary` flags. |
| `POST /api/convert` | unchanged + `jobs` form field (0/auto..64, else 400). |

Browser confinement (`confine()`): root must pass `validateOutputPath`
(existing $HOME realpath rule) and be an existing dir; `path` is
realpath-resolved and must stay under the root's real path — `..` and symlink
escapes get 403. Generated trees ship a `RobustToolbox` symlink into the
engine checkout: it shows in listings but refuses to open, and the summary
walker uses `lstatSync` so engine bytes are never counted as emitted output.

## Page (`src/gui/page.ts`)

Moved out of `server.ts` into its own template module; same GitHub-dark skin,
wider shell (920px) for the browser pane. Client JS stays ES5-style with no
template-literal escapes — one escaping bug (`\/` cooking inside the TS
literal, `SyntaxError: Invalid regular expression flags`) was caught by the
first live drive.

- **Live log tail**: SSE-driven; stage tracker reads the pipeline's own
  `[N/5]` markers into a progress bar + elapsed timer. No more fake stages.
- **Fidelity summary card**: tiles for input files (`.dm/.dmi/.dmm` counted
  from the zip), DM types, globals, procs emitted (`ProcRegistry.Register(`
  lines in emitted `.cs`), emitted file counts (prototype YAML, `.cs`, `.rsi`
  dirs, maps), unresolved call names, parse warnings/errors, wall time,
  output bytes, stage timings. All numbers parsed from real log lines or
  walked off disk — absent metrics render as no tile, never invented.
- **Jobs picker**: Auto (core count) / 1 / 4 / 8 → `--jobs` equivalent.
- **Cancel**: visible only mid-flight; cancel → terminate → `[CANCELLED]` in
  the log; partial output is left on disk (not silently deleted).
- **Output browser**: root field (defaults to the output dir after a
  convert, editable to any dir under `$HOME`), breadcrumb, `..` row, dirs +
  file sizes, text preview for any file (binaries flagged).

## Verification

- `npm run build` clean, `npm test` all green (new W-J block covers
  tree/file/SSE auth, confinement escapes, cancel-409), `audit:semantics`
  unchanged at 280/280.
- Real E2E over CDP on `localhost:3456` (Chromium, `DOM.setFileInputFiles`):
  - `tests/m1-demo` zipped → convert at jobs=4: live lines streamed
    (`Parsing 1 .dm files across 4 worker threads`), summary = 16 types /
    11 procs / 17 .cs / 1 rsi / 1 map / 0 unresolved / 344.8 KB, browser
    drilled `Content.Server/DM/ConvertedDMProcs_1.cs` and
    `Resources/Prototypes/converted_entities.yml` in-page.
  - 5000-file synthetic corpus at jobs=1: cancelled mid-stage-2, worker
    terminated, `[CANCELLED]` shown, Convert re-enabled — no second job
    state leak (429 guard unchanged).

## Known limits

- Output dir for a cancelled run keeps whatever stage-1 bootstrap wrote —
  reported, not auto-cleaned (partial trees can be useful and deleting is
  the destructive default).
- Log buffer caps at 5000 lines per run in the client DOM too; corpus-scale
  warning floods truncate oldest lines.
- `dm2ss14 serve`/`:7780` in older task notes is stale — the entry point is
  `node dist/cli.js gui` on `:3456` (`cli.ts` is outside this item's scope).
- The RobustToolbox symlink inside the output tree can't be browsed (by
  design, confinement); file preview caps at 256 KB.
