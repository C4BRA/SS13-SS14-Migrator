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
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const preprocessor_js_1 = require("../preprocessor.js");
const dmLexer_js_1 = require("../parser/dmLexer.js");
const dmParser_js_1 = require("../parser/dmParser.js");
const diagnostics_js_1 = require("../diagnostics.js");
const usage = 'Usage: npm run audit:repo -- <directory> [out.json]';
function walk(dir, ext) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            out.push(...walk(full, ext));
        }
        else if (entry.isFile() && entry.name.toLowerCase().endsWith(ext)) {
            out.push(full);
        }
    }
    return out;
}
function main() {
    const dir = process.argv[2];
    if (!dir) {
        console.error(usage);
        process.exit(1);
    }
    const outFile = process.argv[3];
    if (!fs.existsSync(dir)) {
        console.error(`Directory not found: ${dir}`);
        process.exit(1);
    }
    const files = walk(dir, '.dm');
    console.log(`Scanning ${files.length} .dm files in ${dir} ...`);
    // Two-pass like the production pipeline: collect all #defines globally,
    // then preprocess + lex + parse each file with the shared macro dictionary.
    const collected = preprocessor_js_1.DMPreprocessor.collectDefinesFromFiles(files);
    console.log(`Collected ${collected.object.size} object-like, ${collected.function.size} function-like defines.`);
    let clean = 0;
    let failing = 0;
    let totalErrors = 0;
    let totalWarnings = 0;
    let globalVars = 0;
    const firstErrorCauses = new Map();
    const failingSamples = [];
    for (const file of files) {
        let code;
        try {
            code = fs.readFileSync(file, 'utf-8');
        }
        catch {
            continue;
        }
        const collector = new diagnostics_js_1.DiagnosticCollector();
        collector.file = path.basename(file);
        const pp = new preprocessor_js_1.DMPreprocessor(collector, collected.object, collected.function);
        const pre = pp.process(code, file);
        const tokens = new dmLexer_js_1.DMLexer(pre).tokenize();
        const parser = new dmParser_js_1.DMParser(tokens, collector);
        const decls = parser.parse();
        globalVars += parser.globalVars.length;
        const errors = collector.errors;
        totalErrors += errors.length;
        totalWarnings += collector.warnings.length;
        if (errors.length === 0 && decls.length >= 0) {
            clean++;
        }
        else {
            failing++;
            const first = errors[0]?.message ?? '(lexer/parser crash)';
            firstErrorCauses.set(first, (firstErrorCauses.get(first) ?? 0) + 1);
            if (failingSamples.length < 5) {
                failingSamples.push(`${path.relative(dir, file)} :: ${first}`);
            }
        }
    }
    const causes = [...firstErrorCauses.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([message, count]) => ({ message, count }));
    const result = {
        dir,
        scannedAt: new Date().toISOString(),
        filesScanned: files.length,
        cleanFiles: clean,
        failingFiles: failing,
        totalErrors,
        totalWarnings,
        globalVars,
        firstErrorCauses: causes
    };
    const pct = (files.length > 0 ? (clean / files.length) * 100 : 0).toFixed(2);
    console.log(`\n=== REPO AUDIT: ${dir} ===`);
    console.log(`Files scanned:        ${files.length}`);
    console.log(`Files with zero diag: ${clean} (${pct}%)`);
    console.log(`Files with errors:    ${failing}`);
    console.log(`Total errors:         ${totalErrors}`);
    console.log(`Total warnings:       ${totalWarnings}`);
    console.log(`/global/var/ parsed:  ${globalVars}`);
    console.log(`\nTop first-error causes:`);
    for (const c of causes.slice(0, 15)) {
        console.log(`  ${String(c.count).padStart(6)}  ${c.message}`);
    }
    console.log(`\nFailing samples:`);
    for (const s of failingSamples) {
        console.log(`  ${s}`);
    }
    if (outFile) {
        fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
        console.log(`\nBaseline written to ${outFile}`);
    }
}
main();
