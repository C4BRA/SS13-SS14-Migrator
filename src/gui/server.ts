import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { Worker } from 'worker_threads';
import AdmZip from 'adm-zip';
import { renderPage } from './page.js';

// W-J: the convert runs on a worker thread (see convertWorker.ts) so the page
// gets a live log stream even during the synchronous emit stages and a real
// cancel (worker.terminate), while this server stays responsive.

interface LogEvent { seq: number; level: 'log' | 'warn' | 'error'; line: string }

interface ConvertSummary {
  dmFiles?: number; dmiFiles?: number; dmmFiles?: number;
  types?: number; globals?: number; procs?: number;
  prototypeFiles?: number; csFiles?: number; rsiDirs?: number; mapFiles?: number;
  outputBytes?: number; unresolvedCalls?: number; warnings?: number; errors?: number;
  timings?: string; wallSeconds?: number;
}

const MAX_LOG_EVENTS = 5000;       // replay buffer for SSE clients
const MAX_FILE_PREVIEW = 256 * 1024; // output-browser file preview cap
const MAX_TREE_ENTRIES = 5000;

export class GUIServer {
  private port: number;
  private authToken: string;
  private convertInFlight = false;
  private server: http.Server | null = null;

  // In-flight conversion state (at most one — the 429 guard is unchanged).
  private worker: Worker | null = null;
  private cancelled = false;
  private logEvents: LogEvent[] = [];
  private logSeq = 0;
  private sseClients = new Set<http.ServerResponse>();
  private lastDone: Record<string, unknown> | null = null; // replayed to late SSE joins

  constructor(port: number = 3456) {
    this.port = port;
    this.authToken = crypto.randomBytes(32).toString('hex');
  }

  public stop(): void {
    if (this.worker) {
      this.worker.terminate().catch(() => undefined);
      this.worker = null;
    }
    for (const res of this.sseClients) {
      try { res.end(); } catch { /* already gone */ }
    }
    this.sseClients.clear();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  public start(): void {
    const server = http.createServer(async (req, res) => {
      const url = req.url || '/';
      const pathname = url.split('?')[0];

      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderPage({
          authToken: this.authToken,
          defaultOutputPath: path.join(process.env.HOME || '', 'Downloads', 'SS14-Converted-Server'),
          cores: os.availableParallelism()
        }));
        return;
      }

      // Live log stream for the page (SSE). Read-only: the session token
      // arrives as ?token= because EventSource cannot set headers.
      if (req.method === 'GET' && pathname === '/api/events') {
        if (!this.isAuthorizedRead(req)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Forbidden' }));
          return;
        }
        this.handleEvents(res);
        return;
      }

      // Output-browser endpoints (read-only, token + $HOME-confined).
      if (req.method === 'GET' && pathname === '/api/tree') {
        if (!this.isAuthorizedRead(req)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Forbidden' }));
          return;
        }
        this.handleTree(url, res);
        return;
      }
      if (req.method === 'GET' && pathname === '/api/file') {
        if (!this.isAuthorizedRead(req)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Forbidden' }));
          return;
        }
        this.handleFile(url, res);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/cancel') {
        if (!this.isAuthorized(req)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Forbidden: invalid Host/Origin or missing session token.' }));
          return;
        }
        if (!this.convertInFlight || !this.worker) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No conversion in progress.' }));
          return;
        }
        this.cancelled = true;
        // The pending /api/convert response resolves as {cancelled:true} from
        // the worker 'exit' handler — terminate() is the real abort path.
        this.worker.terminate().catch(() => undefined);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ cancelled: true }));
        return;
      }

      if (req.method === 'POST' && pathname === '/api/convert') {
        if (!this.isAuthorized(req)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Forbidden: invalid Host/Origin or missing session token.' }));
          return;
        }
        if (this.convertInFlight) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'A conversion is already in progress. Wait for it to finish.' }));
          return;
        }
        this.convertInFlight = true;
        try {
          await this.handleConvertRequest(req, res);
        } finally {
          this.convertInFlight = false;
          this.worker = null;
        }
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    });

    this.server = server;
    // A port conflict (or any listen error) must fail gracefully instead of
    // crashing the process with an unhandled 'error' event (WS12-7).
    server.on('error', (err: Error) => {
      console.error(`Failed to start GUI server on port ${this.port}: ${err.message}`);
      process.exit(1);
    });
    server.listen(this.port, '127.0.0.1', () => {
      console.log(`\n==================================================`);
      console.log(`\u{1F680} dm2ss14 macOS Desktop App launched!`);
      console.log(`\u{1F449} Open http://localhost:${this.port} in your browser`);
      console.log(`Session token (required for /api/convert): ${this.authToken}`);
      console.log(`==================================================\n`);
    });
  }

  // CSRF / DNS-rebinding protection: the server only ever binds loopback, and
  // a conversion must come from a same-origin page carrying the session token
  // (a hostile website can fire a cross-site POST at localhost:3456, but it
  // cannot read the token to pass the X-Auth-Token check).
  private isAuthorized(req: http.IncomingMessage): boolean {
    if (!this.hostAllowed(req)) return false;

    const origin = req.headers.origin;
    if (origin) {
      const originOk =
        origin === `http://localhost:${this.port}` || origin === `http://127.0.0.1:${this.port}`;
      if (!originOk) return false;
    }

    return this.tokenOk(req);
  }

  // Read-only GET endpoints (SSE, output browser): same loopback Host rule +
  // the session token, which may arrive via ?token= since EventSource cannot
  // set headers.
  private isAuthorizedRead(req: http.IncomingMessage): boolean {
    return this.hostAllowed(req) && this.tokenOk(req);
  }

  private hostAllowed(req: http.IncomingMessage): boolean {
    const host = req.headers.host || '';
    return (
      host === `localhost:${this.port}` || host === `127.0.0.1:${this.port}` ||
      host === 'localhost' || host === '127.0.0.1'
    );
  }

  private tokenOk(req: http.IncomingMessage): boolean {
    const token = req.headers['x-auth-token'];
    const tokenStr = Array.isArray(token) ? token[0] : token;
    if (tokenStr === this.authToken) return true;
    const q = (req.url || '').split('?')[1];
    if (!q) return false;
    const params = new URLSearchParams(q);
    return params.get('token') === this.authToken;
  }

  // Restrict output paths to the user's home directory so a crafted
  // outputPath field cannot make the server write outside the sandbox.
  // `~/x` is expanded; symlinks inside $HOME that point outside are rejected
  // via realpath of the deepest existing ancestor (WS12-1, WS12-9).
  public static validateOutputPath(outputDirPath: string): string | null {
    if (!outputDirPath) return null;
    if (outputDirPath.includes('\0')) return null;
    const homeRoot = path.resolve(process.env.HOME || '/tmp');
    let expanded = outputDirPath;
    if (expanded === '~') expanded = homeRoot;
    else if (expanded.startsWith('~/')) expanded = path.join(homeRoot, expanded.slice(2));
    const resolved = path.resolve(expanded);
    const realHome = (() => {
      try {
        return fs.realpathSync(homeRoot);
      } catch {
        return homeRoot;
      }
    })();
    // Deepest existing ancestor's REAL path (symlinks resolved).
    let probe = resolved;
    let realAncestor: string | null = null;
    for (;;) {
      try {
        realAncestor = fs.realpathSync(probe);
        break;
      } catch {
        const parent = path.dirname(probe);
        if (parent === probe) break;
        probe = parent;
      }
    }
    if (realAncestor === null) return null;
    if (realAncestor !== realHome && !realAncestor.startsWith(realHome + path.sep)) return null;
    return resolved;
  }

  // ---- Live log / SSE -----------------------------------------------------

  private pushLog(level: LogEvent['level'], line: string): void {
    const ev: LogEvent = { seq: this.logSeq++, level, line };
    this.logEvents.push(ev);
    if (this.logEvents.length > MAX_LOG_EVENTS) this.logEvents.shift();
    // Preserve the server-side log the CLI/headless flows already rely on.
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
    this.broadcast({ t: 'log', level, line });
  }

  private broadcast(payload: unknown): void {
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of this.sseClients) {
      try {
        res.write(data);
      } catch {
        this.sseClients.delete(res);
      }
    }
  }

  private handleEvents(res: http.ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    res.write(': connected\n\n');
    // Replay the buffer so a page that connects mid-convert catches up, then
    // a terminal event if the last run already finished. A 'start' marker
    // first lets the client tell replayed history from live lines.
    res.write(`data: ${JSON.stringify({ t: 'start', replay: true })}\n\n`);
    if (this.convertInFlight) {
      // Lets a page that (re)loaded mid-run resume its busy UI before the
      // buffered lines pour in; 'done' is not sent while a run is live.
      res.write(`data: ${JSON.stringify({ t: 'running' })}\n\n`);
    }
    for (const ev of this.logEvents) {
      res.write(`data: ${JSON.stringify({ t: 'log', level: ev.level, line: ev.line })}\n\n`);
    }
    if (this.lastDone) {
      res.write(`data: ${JSON.stringify({ t: 'done', ...this.lastDone })}\n\n`);
    }
    this.sseClients.add(res);
    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* gone */ }
    }, 15000);
    res.on('close', () => {
      clearInterval(heartbeat);
      this.sseClients.delete(res);
    });
  }

  // ---- Output browser -----------------------------------------------------

  private readQuery(url: string): URLSearchParams {
    const q = url.split('?')[1] || '';
    return new URLSearchParams(q);
  }

  private json(res: http.ServerResponse, code: number, payload: unknown): void {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  }

  // Resolve `rel` inside `root` with symlink confinement: both must already
  // exist (browsing is for real output dirs) and the real path must stay
  // under the real root — same hardening posture as validateOutputPath.
  private confine(root: string, rel: string): { real: string; relPosix: string } | null {
    const validated = GUIServer.validateOutputPath(root);
    if (validated === null) return null;
    let realRoot: string;
    try {
      const st = fs.statSync(validated);
      if (!st.isDirectory()) return null;
      realRoot = fs.realpathSync(validated);
    } catch {
      return null;
    }
    const abs = path.resolve(realRoot, rel || '.');
    let real: string;
    try {
      real = fs.realpathSync(abs);
    } catch {
      return null;
    }
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
    const relPosix = path.relative(realRoot, real).split(path.sep).join('/');
    return { real, relPosix };
  }

  private handleTree(url: string, res: http.ServerResponse): void {
    const q = this.readQuery(url);
    const root = q.get('root') || '';
    const rel = q.get('path') || '';
    if (!root) {
      this.json(res, 400, { error: 'Missing root parameter.' });
      return;
    }
    const c = this.confine(root, rel);
    if (!c) {
      this.json(res, 403, { error: 'Path must exist and stay inside the browsed directory.' });
      return;
    }
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(c.real, { withFileTypes: true });
    } catch {
      this.json(res, 400, { error: 'Not a directory.' });
      return;
    }
    const entries: { name: string; dir: boolean; size: number }[] = [];
    for (const d of dirents) {
      let isDir = d.isDirectory();
      let size = 0;
      if (d.isSymbolicLink()) {
        try {
          const st = fs.statSync(path.join(c.real, d.name));
          isDir = st.isDirectory();
          size = st.size;
        } catch { continue; } // broken symlink
      } else if (!isDir) {
        try { size = fs.statSync(path.join(c.real, d.name)).size; } catch { size = 0; }
      }
      entries.push({ name: d.name, dir: isDir, size });
    }
    entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    const truncated = entries.length > MAX_TREE_ENTRIES;
    this.json(res, 200, {
      root,
      path: c.relPosix,
      entries: truncated ? entries.slice(0, MAX_TREE_ENTRIES) : entries,
      truncated
    });
  }

  private handleFile(url: string, res: http.ServerResponse): void {
    const q = this.readQuery(url);
    const root = q.get('root') || '';
    const rel = q.get('path') || '';
    if (!root || !rel) {
      this.json(res, 400, { error: 'Missing root or path parameter.' });
      return;
    }
    const c = this.confine(root, rel);
    if (!c) {
      this.json(res, 403, { error: 'Path must exist and stay inside the browsed directory.' });
      return;
    }
    let st: fs.Stats;
    try {
      st = fs.statSync(c.real);
    } catch {
      this.json(res, 404, { error: 'File not found.' });
      return;
    }
    if (!st.isFile()) {
      this.json(res, 400, { error: 'Not a file.' });
      return;
    }
    let fd: number;
    try {
      fd = fs.openSync(c.real, 'r');
    } catch {
      this.json(res, 403, { error: 'Cannot read file.' });
      return;
    }
    try {
      const cap = Math.min(st.size, MAX_FILE_PREVIEW);
      const buf = Buffer.alloc(cap);
      const read = fs.readSync(fd, buf, 0, cap, 0);
      const head = buf.subarray(0, Math.min(read, 8192));
      const binary = head.includes(0);
      this.json(res, 200, {
        name: path.basename(c.real),
        path: c.relPosix,
        size: st.size,
        truncated: st.size > MAX_FILE_PREVIEW,
        binary,
        text: binary ? '' : buf.subarray(0, read).toString('utf-8')
      });
    } finally {
      fs.closeSync(fd);
    }
  }

  // ---- Conversion ---------------------------------------------------------

  private static readonly MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB
  private static readonly MAX_ZIP_ENTRIES = 50000;
  private static readonly MAX_ZIP_UNCOMPRESSED = 4 * 1024 * 1024 * 1024; // 4 GiB
  private static readonly MAX_JOBS = 64;

  private async handleConvertRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let oversized = false;
    // The in-flight 429 guard must stay held until the conversion finishes:
    // resolve only when the 'end' handler completes (WS12-2 — previously the
    // promise resolved before the request body was even consumed, so two
    // concurrent conversions raced on the same output directory).
    await new Promise<void>(resolve => {
      req.on('data', chunk => {
        totalBytes += chunk.length;
        if (totalBytes > GUIServer.MAX_UPLOAD_BYTES) oversized = true;
        if (!oversized) chunks.push(chunk);
      });
      req.on('error', () => resolve());
      req.on('end', async () => {
        try {
          await this.processConvertBody(req, res, chunks, totalBytes, oversized);
        } finally {
          resolve();
        }
      });
    });
  }

  private async processConvertBody(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    chunks: Buffer[],
    totalBytes: number,
    oversized: boolean
  ): Promise<void> {
    let tempInputDir: string | null = null;
    try {
      if (oversized) {
        this.json(res, 413, { error: 'Upload exceeds the 2 GiB size limit.' });
        return;
      }
      const body = Buffer.concat(chunks);
      const contentType = req.headers['content-type'] || '';

      let zipBuffer: Buffer | null = null;
      let outputDirPath = path.join(process.env.HOME || '/tmp', 'Downloads', 'SS14-Converted-Server');
      let jobs: number | undefined;

      if (contentType.includes('multipart/form-data')) {
        const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
        if (boundaryMatch) {
          const boundary = boundaryMatch[1] || boundaryMatch[2];
          const parts = this.parseMultipart(body, boundary);

          const filePart = parts.find(p => p.filename);
          const outputPart = parts.find(p => p.name === 'outputPath');
          const jobsPart = parts.find(p => p.name === 'jobs');

          if (filePart) zipBuffer = filePart.data;
          if (outputPart) {
            const candidate = GUIServer.validateOutputPath(outputPart.data.toString('utf-8').trim() || outputDirPath);
            if (!candidate) {
              this.json(res, 400, { error: 'Invalid outputPath: must resolve inside your home directory.' });
              return;
            }
            outputDirPath = candidate;
          }
          if (jobsPart) {
            const raw = jobsPart.data.toString('utf-8').trim();
            if (raw === '' || raw === 'auto' || raw === '0') {
              jobs = undefined; // auto
            } else {
              const parsed = Number(raw);
              if (!Number.isInteger(parsed) || parsed < 0 || parsed > GUIServer.MAX_JOBS) {
                this.json(res, 400, { error: `Invalid jobs: expected an integer 0-${GUIServer.MAX_JOBS} (0 = auto).` });
                return;
              }
              jobs = parsed;
            }
          }
        }
      }

      if (!zipBuffer) {
        this.json(res, 400, { error: 'No zip file provided.' });
        return;
      }

      // Validate the archive before extracting: guard against zip bombs and
      // pathological archives (excessive entry counts / uncompressed sizes).
      // Note: entry.header.size is attacker-controlled metadata (WS12-4) —
      // the post-extraction size check below is the authoritative bound.
      const zip = new AdmZip(zipBuffer);
      const entries = zip.getEntries();
      let totalUncompressed = 0;
      for (const entry of entries) {
        totalUncompressed += entry.header.size;
        if (entries.length > GUIServer.MAX_ZIP_ENTRIES || totalUncompressed > GUIServer.MAX_ZIP_UNCOMPRESSED) {
          this.json(res, 400, { error: 'Archive rejected: too many entries or total size exceeds limits.' });
          return;
        }
      }

      // Input file counts for the fidelity summary — from the archive's own
      // entry list so they are independent of the transpiler's log lines.
      const inputCounts = { dm: 0, dmi: 0, dmm: 0 };
      for (const entry of entries) {
        if (entry.isDirectory) continue;
        const lower = entry.entryName.toLowerCase();
        if (lower.endsWith('.dm')) inputCounts.dm++;
        else if (lower.endsWith('.dmi')) inputCounts.dmi++;
        else if (lower.endsWith('.dmm')) inputCounts.dmm++;
      }

      // Unpredictable temp dir under os.tmpdir(): a predictable cwd-relative
      // name could be pre-planted as a symlink (WS12-5).
      tempInputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm2ss14-'));

      zip.extractAllTo(tempInputDir, true);

      // Authoritative zip-bomb bound: re-measure actual extracted bytes
      // (the declared header sizes may lie — WS12-4).
      let extractedBytes = 0;
      const stack = [tempInputDir];
      while (stack.length > 0) {
        const dir = stack.pop()!;
        for (const f of fs.readdirSync(dir)) {
          const p = path.join(dir, f);
          const st = fs.statSync(p);
          if (st.isDirectory()) stack.push(p);
          else extractedBytes += st.size;
          if (extractedBytes > GUIServer.MAX_ZIP_UNCOMPRESSED) {
            this.json(res, 400, { error: 'Archive rejected: extracted size exceeds limits.' });
            return;
          }
        }
      }

      // Fresh run state, then the first line of this run's log. The 'start'
      // marker tells already-connected SSE clients to drop the previous
      // run's replayed lines before this run's lines arrive.
      this.cancelled = false;
      this.lastDone = null;
      this.logEvents = [];
      this.broadcast({ t: 'start' });
      this.pushLog('log', `[dm2ss14] Queued: ${inputCounts.dm} .dm / ${inputCounts.dmi} .dmi / ${inputCounts.dmm} .dmm input file(s).`);
      await this.runConvertWorker(tempInputDir, outputDirPath, jobs, inputCounts, res);
    } catch {
      // Do not leak server-side paths/error internals to the client (WS12-3).
      if (!res.writableEnded) this.json(res, 500, { error: 'Transpilation failed.' });
    } finally {
      if (tempInputDir && fs.existsSync(tempInputDir)) {
        fs.rmSync(tempInputDir, { recursive: true, force: true });
      }
    }
  }

  // Run transpile() on a worker thread; resolve the HTTP response when it
  // posts its result, errors, or exits (cancel -> terminated).
  private runConvertWorker(
    inputDir: string,
    outputDir: string,
    jobs: number | undefined,
    inputCounts: { dm: number; dmi: number; dmm: number },
    res: http.ServerResponse
  ): Promise<void> {
    const startedAt = Date.now();
    const worker = new Worker(path.join(__dirname, 'convertWorker.js'), {
      workerData: { inputDir, outputDir, jobs }
    });
    this.worker = worker;

    return new Promise<void>(resolve => {
      let settled = false;
      const finish = (payload: Record<string, unknown>) => {
        if (settled) return;
        settled = true;
        this.lastDone = payload;
        this.broadcast({ t: 'done', ...payload });
        if (!res.writableEnded) {
          this.json(res, (payload.success || payload.cancelled) ? 200 : 500, payload);
        }
        resolve();
      };

      worker.on('message', (msg: any) => {
        if (msg && msg.type === 'log') {
          this.pushLog(msg.level === 'warn' || msg.level === 'error' ? msg.level : 'log', String(msg.line));
          return;
        }
        if (msg && msg.type === 'result') {
          if (msg.ok) {
            const summary = this.buildSummary(outputDir, inputCounts, startedAt);
            finish({ success: true, outputDir, summary, message: 'Transpilation completed successfully!' });
          } else {
            finish({ success: false, cancelled: this.cancelled, error: this.cancelled ? 'Conversion cancelled.' : 'Transpilation failed: ' + String(msg.error) });
          }
        }
      });
      worker.on('error', () => {
        finish({ success: false, cancelled: this.cancelled, error: this.cancelled ? 'Conversion cancelled.' : 'Conversion worker crashed.' });
      });
      worker.on('exit', code => {
        // terminate() (cancel) or an unhandled crash both land here when no
        // result message was delivered first.
        finish(this.cancelled
          ? { success: false, cancelled: true, error: 'Conversion cancelled.' }
          : { success: false, error: `Conversion worker exited unexpectedly (code ${code}).` });
      });
    });
  }

  // Fidelity summary card data: metrics parsed from the transpiler's own log
  // lines plus real counts walked from the emitted output tree — nothing is
  // invented: a metric that is not observed is simply absent from the card.
  private buildSummary(
    outputDir: string,
    inputCounts: { dm: number; dmi: number; dmm: number },
    startedAt: number
  ): ConvertSummary {
    const s: ConvertSummary = {
      dmFiles: inputCounts.dm,
      dmiFiles: inputCounts.dmi,
      dmmFiles: inputCounts.dmm,
      warnings: 0,
      errors: 0,
      wallSeconds: Math.round((Date.now() - startedAt) / 100) / 10
    };
    for (const ev of this.logEvents) {
      const line = ev.line;
      let m = line.match(/Resolved (\d+) DM types/);
      if (m) { s.types = Number(m[1]); continue; }
      m = line.match(/Collected (\d+) \/global\/var/);
      if (m) { s.globals = Number(m[1]); continue; }
      m = line.match(/Symbol pass: (\d+) unresolved call names/);
      if (m) { s.unresolvedCalls = Number(m[1]); continue; }
      if (line.includes('all bare/method call targets resolved')) { s.unresolvedCalls = 0; continue; }
      if (line.startsWith('[dm2ss14] warning:')) { s.warnings!++; continue; }
      if (line.startsWith('[dm2ss14] error:')) { s.errors!++; continue; }
      m = line.match(/Timings:\s*(.*)/);
      if (m) { s.timings = m[1].trim(); continue; }
    }

    // Emitted-artifact counts from the output tree itself.
    let bytes = 0;
    const stack = [outputDir];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      let list: string[];
      try { list = fs.readdirSync(dir); } catch { continue; }
      for (const name of list) {
        const p = path.join(dir, name);
        let st: fs.Stats;
        try { st = fs.lstatSync(p); } catch { continue; }
        // Generated trees contain a RobustToolbox *symlink* into the engine
        // checkout — don't follow it or the card reports the engine's size,
        // not the emitted output's.
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) {
          if (name.endsWith('.rsi')) s.rsiDirs = (s.rsiDirs || 0) + 1;
          stack.push(p);
          continue;
        }
        bytes += st.size;
        const rel = path.relative(outputDir, p);
        if (name.endsWith('.cs')) {
          s.csFiles = (s.csFiles || 0) + 1;
          // Registered procs: one ProcRegistry.Register(...) line per emitted
          // DM proc — counting them gives the real "procs emitted" number.
          try {
            const text = fs.readFileSync(p, 'utf-8');
            s.procs = (s.procs || 0) + text.split('ProcRegistry.Register(').length - 1;
          } catch { /* unreadable file — count stays honest */ }
        } else if (name.endsWith('.yml') || name.endsWith('.yaml')) {
          const under = rel.split(path.sep).slice(0, 2).join('/');
          if (under === path.join('Resources', 'Prototypes').split(path.sep).join('/')) {
            s.prototypeFiles = (s.prototypeFiles || 0) + 1;
          } else if (under === path.join('Resources', 'Maps').split(path.sep).join('/')) {
            s.mapFiles = (s.mapFiles || 0) + 1;
          }
        }
      }
    }
    s.outputBytes = bytes;
    return s;
  }

  private parseMultipart(body: Buffer, boundary: string): { name?: string; filename?: string; data: Buffer }[] {
    const parts: { name?: string; filename?: string; data: Buffer }[] = [];
    const boundaryBuf = Buffer.from('--' + boundary);

    let start = body.indexOf(boundaryBuf) + boundaryBuf.length;

    while (start < body.length) {
      const nextBoundary = body.indexOf(boundaryBuf, start);
      if (nextBoundary === -1) break;

      const partBuffer = body.subarray(start, nextBoundary);
      const headerEnd = partBuffer.indexOf('\r\n\r\n');
      if (headerEnd !== -1) {
        const headerStr = partBuffer.subarray(0, headerEnd).toString('utf-8');
        const data = partBuffer.subarray(headerEnd + 4, partBuffer.length - 2);

        const nameMatch = headerStr.match(/name="([^"]+)"/);
        const filenameMatch = headerStr.match(/filename="([^"]+)"/);

        parts.push({
          name: nameMatch ? nameMatch[1] : undefined,
          filename: filenameMatch ? filenameMatch[1] : undefined,
          data
        });
      }

      start = nextBoundary + boundaryBuf.length;
    }

    return parts;
  }
}
