# Plan 15 — B-8 Speed: worker-thread parallel parse + DMI/DMM conversion (item 76)

Status: **executed 2026-10-10** · scope `src/index.ts`, `src/cli.ts`,
`src/parallel/*` (new), `src/tests/*` · PLAN.md item 76.

## Problem

The fidelity audit measured the DM parse stage as dominant on corpus runs.
Paradise (3,842 `.dm`, 1,386 `.dmi`, 199 `.dmm`) took ~62s wall on one thread.
All three per-file stages are embarrassingly parallel: files are independent —
the only order-dependent piece is the shared two-pass `#define` collection
(`DMPreprocessor.collectDefinesFromFiles`), which seeds a *read-only* global
macro dictionary (the preprocessor is copy-on-write, so per-file `#define`/
`#undef` never mutates the seeds).

## Approach

- **`src/parallel/workerProtocol.ts`** — task/result wire types
  (`parse` | `dmi` | `dmm`), plus the `workerData` init payload (the two seed
  `#define` maps, structured-cloned once per worker).
- **`src/parallel/parseWorker.ts`** — worker entry. Runs the *same* per-file
  body as the sequential loops: `DMPreprocessor(collector, seeds)` → `DMLexer`
  → `DMParser` for `parse`; `RSIWriter.convertDMIToRSI` / `MapConverter
  .convertDMMToSS14Map` (which write their own outputs) for `dmi`/`dmm`.
  Results return per-file diagnostics; task exceptions propagate as errors.
- **`src/parallel/workerPool.ts`** — fixed-size `ConversionWorkerPool` over
  `node:worker_threads` (builtin, no new deps). One task in flight per worker;
  results keyed by sequence number; worker death rejects its task and drains
  the queue if the pool is empty; `close()` always terminates.
- **`src/index.ts`** — `TranspilerOptions.jobs` (0/undefined = auto =
  `os.availableParallelism()` capped at 16, 1 = sequential). One lazily-created
  pool is shared across the parse, DMI, and DMM stages. Results merge strictly
  in file-index order (`Promise.all` preserves `dmFiles` order), so AST
  concatenation, `/global/var/` collection, and diagnostics aggregation are
  identical to sequential. IR generation, YAML/C# emission stay serial. Added a
  one-line per-stage timing summary to the conversion log.
- **`src/cli.ts`** — `--jobs N` / `-j N` (also `-jN`, `--jobs=N`); invalid
  values exit with usage error. GUI path unchanged (`jobs` optional).

Measured stage timings now print in the run log:
`Timings: defines+parse+IR … | emit … | dmi … | dmm …`.

## Verification

- `npm run build` clean (tsc strict), `npm test` all green,
  `npm run audit:semantics` **171/171** probes under dotnet 10.
- New `src/tests/parallelDeterminism.test.ts` (wired into `runTests.ts`):
  fixture with shared object/function `#define`s + a per-file `#undef`/`#define`
  override, an orphan-key `.dmm` (forces warnings), and a `.dmi`; converts with
  `jobs:1` vs `jobs:4` and asserts identical warning/error streams (order +
  content), identical emitted file set, byte-identical file contents, and the
  per-file override honored through workers.

## Numbers — paradise, 8-core VM, median of 3 runs

Command: `node dist/cli.js convert --input ~/ss13-corpora/paradise --output …`

| mode | wall | defines+parse+IR | emit (serial) | dmi | dmm |
|---|---|---|---|---|---|
| `-j1` (sequential) | **62.46s** | ~12.0s | ~9s | ~36.3s | ~4.7s |
| auto (8 workers) | **22.19s** | ~4.7s | ~8s | ~5.9s | ~1.2s |

- **Wall-clock: 62.46s → 22.19s = 2.8× faster.**
- DMI stage was the largest single stage sequentially (36.3s → 5.9s, ~6×);
  parse+IR 12.0s → 4.7s (~2.6×); DMM 4.7s → 1.2s (~4×).
- Serial emit (~7–9s) is now the dominant stage — bounded by streaming C#
  emission; not parallelized (shared `symbols`/`console.warn` counters,
  ordered single-file output).
- Output correctness at corpus scale: `diff -r` on the two 1.2GB output trees
  = **0 differences** (`-j1` vs auto, `-j1` vs `-j1` rerun).
- Worker death/task failure propagates the original error; pool `finally`-
  closes so the GUI path can't leak threads on a failed conversion.

## Known limits / non-goals

- Emit stage stays serial (~8s floor on paradise). Parallelizing emission means
  splitting the streaming file writer + symbol pass — bigger scope, left for a
  follow-up if profiling justifies it.
- Each worker holds a clone of the ~8.5k-entry seed maps and ASTs transit
  `postMessage` — peak RSS rose ~1.7GB → ~2.9GB on paradise (still well under
  the 4GB default heap that item 66 established as the constraint).
- `jobs` beyond the file count or core count degrades gracefully (pool sized
  `min(jobs, fileCount)`; tasks queue on idle workers).
