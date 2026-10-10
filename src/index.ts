import * as fs from 'fs';
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

export interface TranspilerOptions {
  inputDir: string;
  outputDir: string;
  buildSolution?: boolean;
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
    const allASTNodes: any[] = [];
    const diagnostics = new DiagnosticCollector();
    const globals: any[] = [];

    // BYOND compiles the .dme environment as ONE translation unit: files are
    // pulled in by #include in listed order and #defines persist through the
    // rest of the unit. When a .dme is present we do the same — a single
    // preprocessor pass over the environment file, with file-boundary
    // markers so diagnostics stay attributed. Without a .dme we fall back to
    // the legacy every-.dm-in-sorted-order walk with pre-seeded defines.
    const dmeFile = this.findDmeFile(options.inputDir);
    const segments: { file: string; text: string }[] = [];

    if (dmeFile) {
      console.log(`      Environment: ${path.relative(options.inputDir, dmeFile) || path.basename(dmeFile)} (single .dme-ordered pass)`);
      const unitCollector = new DiagnosticCollector();
      unitCollector.file = path.relative(options.inputDir, dmeFile);
      const preprocessor = new DMPreprocessor(unitCollector);
      preprocessor.emitFileMarkers = true;
      const fileStack: string[] = [];
      preprocessor.onIncludeBoundary = (kind, f) => {
        if (kind === 'start') {
          fileStack.push(unitCollector.file ?? '');
          unitCollector.file = path.relative(options.inputDir, f);
        } else {
          unitCollector.file = fileStack.pop() ?? unitCollector.file;
        }
      };
      const processed = preprocessor.processFile(dmeFile);
      diagnostics.merge(unitCollector);
      segments.push(...DMPreprocessor.splitFileMarkers(processed, path.resolve(dmeFile)));
    } else {
      const dmFiles = this.findFiles(options.inputDir, '.dm');
      // Pre-pass: collect object-like AND function-like #defines across the
      // whole input tree so macros defined in one file (e.g. __DEFINES/*.dm)
      // are visible in all files, matching how BYOND compiles a codebase as a
      // single unit.
      const collected = DMPreprocessor.collectDefinesFromFiles(dmFiles);
      if (collected.object.size + collected.function.size > 0) {
        console.log(`      Seeded ${collected.object.size} object-like and ${collected.function.size} function-like global #defines from ${dmFiles.length} source files.`);
      }
      for (const dmFile of dmFiles) {
        const code = fs.readFileSync(dmFile, 'utf-8');
        const collector = new DiagnosticCollector();
        collector.file = path.relative(options.inputDir, dmFile);
        const preprocessor = new DMPreprocessor(collector, collected.object, collected.function);
        segments.push({ file: dmFile, text: preprocessor.process(code, dmFile) });
        diagnostics.merge(collector);
      }
    }

    for (const seg of segments) {
      const collector = new DiagnosticCollector();
      collector.file = path.relative(options.inputDir, seg.file);
      const lexer = new DMLexer(seg.text);
      const tokens = lexer.tokenize();
      collector.merge(lexer.diagnostics);
      const parser = new DMParser(tokens, collector);
      const nodes = parser.parse();
      globals.push(...parser.globalVars);
      diagnostics.merge(collector);
      allASTNodes.push(...nodes);
    }

    // Generate DM-IR
    const irGen = new DMIRGenerator();
    const irMap = irGen.generateIR(allASTNodes);
    console.log(`      Resolved ${irMap.size} DM types.`);
    if (globals.length > 0) {
      console.log(`      Collected ${globals.length} /global/var/ declarations.`);
    }
    // Corpus-wide symbol table for emit-time call-target resolution (item 64).
    // Built BEFORE the AST array is released below.
    const symbols = new SymbolTable();
    symbols.addTypeDecls(allASTNodes);
    // The parsed ASTs are only needed for IR generation — release them before
    // emission so the YAML + C# outputs (which are large at corpus scale)
    // fit in the heap alongside the IR (item 66 full-corpus boot).
    allASTNodes.length = 0;
    let unresolvedCallNames = 0;
    const emitterWarn = console.warn.bind(console);
    console.warn = (msg: string) => {
      if (String(msg).includes('[dm2ss14] symbol:')) unresolvedCallNames++;
      emitterWarn(msg);
    };

    // 3. Emit SS14 Entity YAML Prototypes and C# Systems
    console.log(`[3/5] Emitting SS14 YAML Prototypes and C# ECS Systems...`);
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

    // 4. Convert DMI icons to RSI
    console.log(`[4/5] Converting DMI icon assets to RSI...`);
    const dmiFiles = this.findFiles(options.inputDir, '.dmi');
    const rsiBaseDir = path.join(options.outputDir, 'Resources', 'Textures');

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

    // 5. Convert DMM maps to SS14 Grid YAML maps
    console.log(`[5/5] Converting DMM maps to SS14 Grid Maps...`);
    const dmmFiles = this.findFiles(options.inputDir, '.dmm');
    const mapsDir = path.join(options.outputDir, 'Resources', 'Maps');

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

  /**
   * Locates the DM environment (.dme) to compile. Top-level .dme files are
   * preferred; among candidates the one with the most #include lines wins
   * (a codebase may ship several environments — test harnesses, alternate
   * map packs — and the main one includes the most files). Returns null
   * when no .dme exists.
   */
  private findDmeFile(inputDir: string): string | null {
    if (!fs.existsSync(inputDir)) return null;
    const stat = fs.statSync(inputDir);
    if (stat.isFile()) return inputDir.endsWith('.dme') ? inputDir : null;

    const candidates = this.findFiles(inputDir, '.dme');
    if (candidates.length === 0) return null;
    const topLevel = candidates.filter(f => path.resolve(path.dirname(f)) === path.resolve(inputDir));
    const pool = topLevel.length > 0 ? topLevel : candidates;

    let best: string | null = null;
    let bestIncludes = -1;
    for (const f of pool) {
      let includes = 0;
      try {
        const text = fs.readFileSync(f, 'utf-8');
        includes = (text.match(/^\s*#include\b/gm) || []).length;
      } catch { /* unreadable — skip */ }
      if (includes > bestIncludes) {
        bestIncludes = includes;
        best = f;
      }
    }
    if (pool.length > 1) {
      console.warn(`[dm2ss14] warning: ${pool.length} .dme environments found; using ${path.basename(best!)} (${bestIncludes} includes)`);
    }
    return best;
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
