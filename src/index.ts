import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DMLexer } from './parser/dmLexer.js';
import { DMParser } from './parser/dmParser.js';
import { DMPreprocessor } from './preprocessor.js';
import { DMIRGenerator } from './ir/dmIRGenerator.js';
import { SymbolTable } from './ir/symbolTable.js';
import { RSIWriter } from './dmi/rsiWriter.js';
import { MapConverter } from './dmm/mapConverter.js';
import { YAMLGenerator } from './transpiler/yamlGenerator.js';
import { CSharpEmitter } from './transpiler/csharpEmitter.js';
import { SS14Template } from './project/ss14Template.js';
import { DiagnosticCollector } from './diagnostics.js';
import type { Diagnostic } from './diagnostics.js';
import { ConversionWorkerPool } from './parallel/workerPool.js';
import type { ParseFileResult, WarningsResult } from './parallel/workerProtocol.js';

export interface TranspilerOptions {
  inputDir: string;
  outputDir: string;
  buildSolution?: boolean;
  /** Worker threads for the per-file stages: 0/undefined = auto
   *  (os.availableParallelism(), capped), 1 = sequential, N = N workers. */
  jobs?: number;
}

/** Auto-mode cap: past ~16 workers the postMessage serialization cost eats the
 *  gains and even fat CI boxes rarely have more useful cores free. */
const MAX_AUTO_JOBS = 16;

function resolveJobs(jobs: number | undefined): number {
  if (jobs === undefined || jobs === 0) {
    return Math.max(1, Math.min(os.availableParallelism(), MAX_AUTO_JOBS));
  }
  return Math.max(1, Math.floor(jobs));
}

export class DM2SS14Transpiler {
  private rsiWriter = new RSIWriter();
  private mapConverter = new MapConverter();
  private yamlGenerator = new YAMLGenerator();
  private csharpEmitter = new CSharpEmitter();
  private templateGen = new SS14Template();

  public async transpile(options: TranspilerOptions): Promise<void> {
    console.log(`[dm2ss14] Starting SS13 to SS14 transpilation...`);
    console.log(`  Input Directory: ${options.inputDir}`);
    console.log(`  Output Directory: ${options.outputDir}`);

    if (!fs.existsSync(options.inputDir)) {
      throw new Error(`Input directory '${options.inputDir}' does not exist.`);
    }

    // 1. Generate base SS14 solution structure
    console.log(`[1/5] Bootstrapping SS14 C# solution layout...`);
    this.templateGen.generateSS14Solution(options.outputDir);

    // 2. Discover and parse DM source files
    console.log(`[2/5] Parsing DM source code and building AST/DM-IR...`);
    const stageStart = Date.now();
    const stageTimes: Record<string, number> = {};
    const dmFiles = this.findFiles(options.inputDir, '.dm');
    const allASTNodes: any[] = [];
    const diagnostics = new DiagnosticCollector();

    // Pre-pass: collect object-like AND function-like #defines across the
    // whole input tree so macros defined in one file (e.g. __DEFINES/*.dm)
    // are visible in all files, matching how BYOND compiles a codebase as a
    // single unit. Order-dependent: always on the main thread, unchanged.
    const collected = DMPreprocessor.collectDefinesFromFiles(dmFiles);
    if (collected.object.size + collected.function.size > 0) {
      console.log(`      Seeded ${collected.object.size} object-like and ${collected.function.size} function-like global #defines from ${dmFiles.length} source files.`);
    }

    const jobs = resolveJobs(options.jobs);
    // Shared pool for the per-file stages (parse, DMI, DMM). Created lazily at
    // the first stage that has files so an empty stage doesn't spawn workers
    // for nothing; workers get the #define seeds once via workerData.
    let pool: ConversionWorkerPool | null = null;
    const ensurePool = (fileCount: number): ConversionWorkerPool | null => {
      if (jobs <= 1 || fileCount === 0) return null;
      if (!pool) {
        pool = new ConversionWorkerPool(Math.min(jobs, fileCount), {
          objectDefines: collected.object,
          functionDefines: collected.function,
        });
      }
      return pool;
    };

    // Rebuild one file's collector from a worker result and merge it — identical
    // to what diagnostics.merge(fileCollector) does in the sequential loops.
    const mergeFileDiagnostics = (file: string, errors: Diagnostic[], warnings: Diagnostic[]): void => {
      const collector = new DiagnosticCollector();
      collector.file = file;
      for (const e of errors) collector.error(e.message, e.line, e.column);
      for (const w of warnings) collector.warning(w.message, w.line, w.column);
      diagnostics.merge(collector);
    };
    const mergeWarnings = (file: string, warnings: string[]): void => {
      const collector = new DiagnosticCollector();
      collector.file = file;
      for (const w of warnings) collector.warning(w);
      diagnostics.merge(collector);
    };

    const globals: any[] = [];

    try {
      const parsePool = ensurePool(dmFiles.length);
      if (parsePool) {
        console.log(`      Parsing ${dmFiles.length} .dm files across ${jobs} worker threads.`);
        // Fan out per-file preprocess+lex+parse; Promise.all keeps the results
        // in dmFiles order so AST/diagnostics merges are byte-identical to the
        // sequential loop regardless of completion order.
        const results = await Promise.all(dmFiles.map((dmFile) =>
          parsePool.exec<ParseFileResult>({
            kind: 'parse',
            filePath: dmFile,
            relPath: path.relative(options.inputDir, dmFile),
          })));
        for (let i = 0; i < results.length; i++) {
          const res = results[i];
          mergeFileDiagnostics(path.relative(options.inputDir, dmFiles[i]), res.errors, res.warnings);
          globals.push(...res.globalVars);
          allASTNodes.push(...res.nodes);
        }
      } else {
        for (const dmFile of dmFiles) {
          const code = fs.readFileSync(dmFile, 'utf-8');
          const collector = new DiagnosticCollector();
          collector.file = path.relative(options.inputDir, dmFile);
          const preprocessor = new DMPreprocessor(collector, collected.object, collected.function);
          const processed = preprocessor.process(code, dmFile);
          const lexer = new DMLexer(processed);
          const tokens = lexer.tokenize();
          collector.merge(lexer.diagnostics);
          const parser = new DMParser(tokens, collector);
          const nodes = parser.parse();
          globals.push(...parser.globalVars);
          diagnostics.merge(collector);
          allASTNodes.push(...nodes);
        }
      }

      // Generate DM-IR
      const irGen = new DMIRGenerator();
      const irMap = irGen.generateIR(allASTNodes);
      stageTimes['defines+parse+IR'] = Date.now() - stageStart;
      console.log(`      Resolved ${irMap.size} DM types.`);
      if (globals.length > 0) {
        console.log(`      Collected ${globals.length} /global/var/ declarations.`);
      }
      // The parsed ASTs are only needed for IR generation — release them before
      // emission so the YAML + C# outputs (which are large at corpus scale)
      // fit in the heap alongside the IR (item 66 full-corpus boot).
      allASTNodes.length = 0;

      // Corpus-wide symbol table for emit-time call-target resolution (item 64).
      const symbols = new SymbolTable();
      for (const node of allASTNodes) symbols.addTypeDecls([node]);
      let unresolvedCallNames = 0;
      const emitterWarn = console.warn.bind(console);
      console.warn = (msg: string) => {
        if (String(msg).includes('[dm2ss14] symbol:')) unresolvedCallNames++;
        emitterWarn(msg);
      };

      // 3. Emit SS14 Entity YAML Prototypes and C# Systems
      console.log(`[3/5] Emitting SS14 YAML Prototypes and C# ECS Systems...`);
      const emitStart = Date.now();
      const protoDir = path.join(options.outputDir, 'Resources', 'Prototypes');
      this.yamlGenerator.generateYAMLPrototypes(irMap, protoDir);
      console.log(`      YAML prototypes emitted (${irMap.size} types).`);

      const serverDMDir = path.join(options.outputDir, 'Content.Server', 'DM');
      console.log(`      Emitting C# ECS systems...`);
      // Streaming emission: the proc bodies are written to the file as they
      // are generated instead of accumulating one giant string (45k+ types at
      // corpus scale would exceed the node heap — item 66).
      this.csharpEmitter.emitCSharpSystemsFile(irMap, serverDMDir, globals, symbols);
      console.warn = emitterWarn;
      if (unresolvedCallNames > 0) {
        console.log(`      Symbol pass: ${unresolvedCallNames} unresolved call names (runtime fallback — see warnings above).`);
      } else {
        console.log(`      Symbol pass: all bare/method call targets resolved against declared procs.`);
      }

      stageTimes['emit'] = Date.now() - emitStart;

      // 4. Convert DMI icons to RSI
      console.log(`[4/5] Converting DMI icon assets to RSI...`);
      const dmiStart = Date.now();
      const dmiFiles = this.findFiles(options.inputDir, '.dmi');
      const rsiBaseDir = path.join(options.outputDir, 'Resources', 'Textures');

      const dmiPool = ensurePool(dmiFiles.length);
      if (dmiPool) {
        const results = await Promise.all(dmiFiles.map((dmiFile) => {
          const relPath = path.relative(options.inputDir, dmiFile);
          return dmiPool.exec<WarningsResult>({
            kind: 'dmi',
            dmiPath: dmiFile,
            rsiPath: path.join(rsiBaseDir, relPath.replace(/\.dmi$/, '.rsi')),
          }).then(res => ({ relPath, res }));
        }));
        for (const { relPath, res } of results) {
          mergeWarnings(relPath, res.warnings);
        }
      } else {
        for (const dmiFile of dmiFiles) {
          const relPath = path.relative(options.inputDir, dmiFile);
          const rsiPath = path.join(rsiBaseDir, relPath.replace(/\.dmi$/, '.rsi'));

          const dmiCollector = new DiagnosticCollector();
          dmiCollector.file = relPath;
          const meta = this.rsiWriter.convertDMIToRSI(dmiFile, rsiPath);
          for (const warning of meta.warnings) {
            dmiCollector.warning(warning);
          }
          diagnostics.merge(dmiCollector);
        }
      }

      stageTimes['dmi'] = Date.now() - dmiStart;

      // 5. Convert DMM maps to SS14 Grid YAML maps
      console.log(`[5/5] Converting DMM maps to SS14 Grid Maps...`);
      const dmmStart = Date.now();
      const dmmFiles = this.findFiles(options.inputDir, '.dmm');
      const mapsDir = path.join(options.outputDir, 'Resources', 'Maps');

      const dmmPool = ensurePool(dmmFiles.length);
      if (dmmPool) {
        const results = await Promise.all(dmmFiles.map((dmmFile) => {
          const relPath = path.relative(options.inputDir, dmmFile);
          return dmmPool.exec<WarningsResult>({
            kind: 'dmm',
            dmmPath: dmmFile,
            yamlPath: path.join(mapsDir, relPath.replace(/\.dmm$/, '.yml')),
          }).then(res => ({ relPath, res }));
        }));
        for (const { relPath, res } of results) {
          mergeWarnings(relPath, res.warnings);
        }
      } else {
        for (const dmmFile of dmmFiles) {
          const relPath = path.relative(options.inputDir, dmmFile);
          const yamlMapPath = path.join(mapsDir, relPath.replace(/\.dmm$/, '.yml'));
          const mapData = this.mapConverter.convertDMMToSS14Map(dmmFile, yamlMapPath);
          const dmmCollector = new DiagnosticCollector();
          dmmCollector.file = relPath;
          for (const warning of mapData.warnings) {
            dmmCollector.warning(warning);
          }
          diagnostics.merge(dmmCollector);
        }
      }
      stageTimes['dmm'] = Date.now() - dmmStart;
    } finally {
      // Idle workers would otherwise keep the event loop (and the GUI server
      // path) alive past a failed conversion.
      if (pool) await pool.close();
    }

    const secs = (ms: number) => (ms / 1000).toFixed(1) + 's';
    console.log(`      Timings: defines+parse+IR ${secs(stageTimes['defines+parse+IR'])} | emit ${secs(stageTimes['emit'])} | dmi ${secs(stageTimes['dmi'])} | dmm ${secs(stageTimes['dmm'])}`);
    this.reportDiagnostics(diagnostics);
    console.log(`[dm2ss14] Transpilation complete! Output saved to: ${options.outputDir}`);
  }

  private reportDiagnostics(diagnostics: DiagnosticCollector): void {
    const fmt = (d: Diagnostic): string =>
      `${d.file ? d.file + ':' : ''}${d.line}:${d.column} ${d.message}`;

    for (const w of diagnostics.warnings) {
      console.warn(`[dm2ss14] warning: ${fmt(w)}`);
    }
    for (const e of diagnostics.errors) {
      console.error(`[dm2ss14] error: ${fmt(e)}`);
    }

    if (diagnostics.hasErrors()) {
      throw new Error(`DM parsing failed with ${diagnostics.errors.length} error(s)`);
    }
  }

  private findFiles(dir: string, ext: string): string[] {
    const results: string[] = [];
    if (!fs.existsSync(dir)) return results;

    const list = fs.readdirSync(dir);
    // Deterministic walk: collectDefinesFromFiles' #define/#undef sequence
    // depends on file order (fs.readdirSync order is platform/FS dependent),
    // which made macro expansions flaky (a corpus file intermittently got an
    // unterminated /* */ from a differently-collected define — perf audit).
    list.sort();
    for (const file of list) {
      const filePath = path.join(dir, file);
      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue; // e.g. broken symlinks
      }
      if (stat.isDirectory()) {
        results.push(...this.findFiles(filePath, ext));
      } else if (file.endsWith(ext)) {
        results.push(filePath);
      }
    }
    return results;
  }
}
