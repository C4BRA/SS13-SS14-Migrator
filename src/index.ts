import * as fs from 'fs';
import * as path from 'path';
import { DMLexer } from './parser/dmLexer.js';
import { DMParser } from './parser/dmParser.js';
import { DMPreprocessor } from './preprocessor.js';
import { DMIRGenerator } from './ir/dmIRGenerator.js';
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
    const dmFiles = this.findFiles(options.inputDir, '.dm');
    const allASTNodes: any[] = [];
    const diagnostics = new DiagnosticCollector();

    // Pre-pass: collect object-like AND function-like #defines across the
    // whole input tree so macros defined in one file (e.g. __DEFINES/*.dm)
    // are visible in all files, matching how BYOND compiles a codebase as a
    // single unit.
    const collected = DMPreprocessor.collectDefinesFromFiles(dmFiles);
    if (collected.object.size + collected.function.size > 0) {
      console.log(`      Seeded ${collected.object.size} object-like and ${collected.function.size} function-like global #defines from ${dmFiles.length} source files.`);
    }

    const globals: any[] = [];

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

    // Generate DM-IR
    const irGen = new DMIRGenerator();
    const irMap = irGen.generateIR(allASTNodes);
    console.log(`      Resolved ${irMap.size} DM types.`);
    if (globals.length > 0) {
      console.log(`      Collected ${globals.length} /global/var/ declarations.`);
    }

    // 3. Emit SS14 Entity YAML Prototypes and C# Systems
    console.log(`[3/5] Emitting SS14 YAML Prototypes and C# ECS Systems...`);
    const protoDir = path.join(options.outputDir, 'Resources', 'Prototypes');
    this.yamlGenerator.generateYAMLPrototypes(irMap, protoDir);

    const serverDMDir = path.join(options.outputDir, 'Content.Server', 'DM');
    this.csharpEmitter.emitCSharpSystems(irMap, serverDMDir, globals);

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

  private findFiles(dir: string, ext: string): string[] {
    const results: string[] = [];
    if (!fs.existsSync(dir)) return results;

    const list = fs.readdirSync(dir);
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
