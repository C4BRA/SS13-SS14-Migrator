"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.DM2SS14Transpiler = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const dmLexer_js_1 = require("./parser/dmLexer.js");
const dmParser_js_1 = require("./parser/dmParser.js");
const preprocessor_js_1 = require("./preprocessor.js");
const dmIRGenerator_js_1 = require("./ir/dmIRGenerator.js");
const symbolTable_js_1 = require("./ir/symbolTable.js");
const rsiWriter_js_1 = require("./dmi/rsiWriter.js");
const mapConverter_js_1 = require("./dmm/mapConverter.js");
const yamlGenerator_js_1 = require("./transpiler/yamlGenerator.js");
const csharpEmitter_js_1 = require("./transpiler/csharpEmitter.js");
const ss14Template_js_1 = require("./project/ss14Template.js");
const diagnostics_js_1 = require("./diagnostics.js");
class DM2SS14Transpiler {
    rsiWriter = new rsiWriter_js_1.RSIWriter();
    mapConverter = new mapConverter_js_1.MapConverter();
    yamlGenerator = new yamlGenerator_js_1.YAMLGenerator();
    csharpEmitter = new csharpEmitter_js_1.CSharpEmitter();
    templateGen = new ss14Template_js_1.SS14Template();
    async transpile(options) {
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
        const allASTNodes = [];
        const diagnostics = new diagnostics_js_1.DiagnosticCollector();
        // Pre-pass: collect object-like AND function-like #defines across the
        // whole input tree so macros defined in one file (e.g. __DEFINES/*.dm)
        // are visible in all files, matching how BYOND compiles a codebase as a
        // single unit.
        const collected = preprocessor_js_1.DMPreprocessor.collectDefinesFromFiles(dmFiles);
        if (collected.object.size + collected.function.size > 0) {
            console.log(`      Seeded ${collected.object.size} object-like and ${collected.function.size} function-like global #defines from ${dmFiles.length} source files.`);
        }
        const globals = [];
        for (const dmFile of dmFiles) {
            const code = fs.readFileSync(dmFile, 'utf-8');
            const collector = new diagnostics_js_1.DiagnosticCollector();
            collector.file = path.relative(options.inputDir, dmFile);
            const preprocessor = new preprocessor_js_1.DMPreprocessor(collector, collected.object, collected.function);
            const processed = preprocessor.process(code, dmFile);
            const lexer = new dmLexer_js_1.DMLexer(processed);
            const tokens = lexer.tokenize();
            collector.merge(lexer.diagnostics);
            const parser = new dmParser_js_1.DMParser(tokens, collector);
            const nodes = parser.parse();
            globals.push(...parser.globalVars);
            diagnostics.merge(collector);
            allASTNodes.push(...nodes);
        }
        // Generate DM-IR
        const irGen = new dmIRGenerator_js_1.DMIRGenerator();
        const irMap = irGen.generateIR(allASTNodes);
        console.log(`      Resolved ${irMap.size} DM types.`);
        if (globals.length > 0) {
            console.log(`      Collected ${globals.length} /global/var/ declarations.`);
        }
        // The parsed ASTs are only needed for IR generation — release them before
        // emission so the YAML + C# outputs (which are large at corpus scale)
        // fit in the heap alongside the IR (item 66 full-corpus boot).
        allASTNodes.length = 0;
        // Corpus-wide symbol table for emit-time call-target resolution (item 64).
        const symbols = new symbolTable_js_1.SymbolTable();
        for (const node of allASTNodes)
            symbols.addTypeDecls([node]);
        let unresolvedCallNames = 0;
        const emitterWarn = console.warn.bind(console);
        console.warn = (msg) => {
            if (String(msg).includes('[dm2ss14] symbol:'))
                unresolvedCallNames++;
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
        }
        else {
            console.log(`      Symbol pass: all bare/method call targets resolved against declared procs.`);
        }
        // 4. Convert DMI icons to RSI
        console.log(`[4/5] Converting DMI icon assets to RSI...`);
        const dmiFiles = this.findFiles(options.inputDir, '.dmi');
        const rsiBaseDir = path.join(options.outputDir, 'Resources', 'Textures');
        for (const dmiFile of dmiFiles) {
            const relPath = path.relative(options.inputDir, dmiFile);
            const rsiPath = path.join(rsiBaseDir, relPath.replace(/\.dmi$/, '.rsi'));
            const dmiCollector = new diagnostics_js_1.DiagnosticCollector();
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
            const dmmCollector = new diagnostics_js_1.DiagnosticCollector();
            dmmCollector.file = relPath;
            for (const warning of mapData.warnings) {
                dmmCollector.warning(warning);
            }
            diagnostics.merge(dmmCollector);
        }
        this.reportDiagnostics(diagnostics);
        console.log(`[dm2ss14] Transpilation complete! Output saved to: ${options.outputDir}`);
    }
    reportDiagnostics(diagnostics) {
        const fmt = (d) => `${d.file ? d.file + ':' : ''}${d.line}:${d.column} ${d.message}`;
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
    findFiles(dir, ext) {
        const results = [];
        if (!fs.existsSync(dir))
            return results;
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
            }
            catch {
                continue; // e.g. broken symlinks
            }
            if (stat.isDirectory()) {
                results.push(...this.findFiles(filePath, ext));
            }
            else if (file.endsWith(ext)) {
                results.push(filePath);
            }
        }
        return results;
    }
}
exports.DM2SS14Transpiler = DM2SS14Transpiler;
