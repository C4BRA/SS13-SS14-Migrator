import { parentPort, workerData } from 'worker_threads';
import { DM2SS14Transpiler } from '../index.js';

// Conversion worker thread (W-J): runs one transpile() off the HTTP server's
// event loop. Two wins over calling transpile() in-process:
//  - console output is forwarded to the parent as it is produced, so the GUI
//    can stream a live log even while the synchronous emit stages are running
//    (they would otherwise starve SSE delivery);
//  - the job can be genuinely cancelled via worker.terminate() — an in-process
//    convert has no abort path mid-stage.
interface ConvertRequest {
  inputDir: string;
  outputDir: string;
  jobs?: number;
}

const post = (msg: unknown): void => {
  parentPort?.postMessage(msg);
};

// Everything the pipeline reports goes through console.* — forward each line
// to the parent. Nothing is written to the worker's own stdout so the server
// log stays the single place the lines appear (the parent re-prints them).
for (const level of ['log', 'warn', 'error'] as const) {
  console[level] = (...args: unknown[]) => {
    const text = args.map(a => (typeof a === 'string' ? a : String(a))).join(' ');
    for (const line of text.split('\n')) {
      post({ type: 'log', level, line });
    }
  };
}

(async () => {
  const req = workerData as ConvertRequest;
  try {
    await new DM2SS14Transpiler().transpile({
      inputDir: req.inputDir,
      outputDir: req.outputDir,
      jobs: req.jobs
    });
    post({ type: 'result', ok: true });
  } catch (err: any) {
    // Keep the error message only — same "don't leak internals" posture as the
    // HTTP handler; the parent still strips paths before answering the page.
    post({ type: 'result', ok: false, error: String(err?.message || err) });
  }
})();
