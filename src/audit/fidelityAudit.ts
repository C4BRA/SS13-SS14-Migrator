// Fidelity audit: measures what is LOST in the DM -> C# conversion.
// This is a measurement-only harness: it reuses the production pipeline
// (preprocessor -> lexer -> parser -> IR -> emitter) but counts every
// construct that is dropped, stubbed, or mis-compiled instead of silently
// proceeding. Usage:
//   node dist/audit/fidelityAudit.js <repo-dir> [--json out.json] [--build out-dir] [--build-max-procs N]

import * as fs from 'fs';
import * as path from 'path';
import { DMPreprocessor, FunctionMacro } from '../preprocessor.js';
import { DMLexer } from '../parser/dmLexer.js';
import { DMParser } from '../parser/dmParser.js';
import { DiagnosticCollector } from '../diagnostics.js';
import { DMIRGenerator } from '../ir/dmIRGenerator.js';
import { CSharpEmitter } from '../transpiler/csharpEmitter.js';
import { SS14Template } from '../project/ss14Template.js';
import { DMRuntimeCS } from '../runtimeTemplate/dmRuntimeCS.js';
import { MAPPED_BUILTINS } from '../transpiler/builtinMappings.js';
import { execSync, spawn } from 'child_process';

interface LossCounters {
  // Source-level (raw regex heuristics)
  numElif: number;
  numIfNumeric: number;
  numIfError: number;
  numPragmaOnce: number;
  numDefineStringTruncation: number;
  numGoto: number;
  numSetModifiers: number;
  numSwitchBraceForm: number;
  numWeightedPick: number;
  numMultiVarFor: number;
  numForStepClause: number;
  numForAsFilter: number;
  numVerbDecls: number;
  numClientDecls: number;
  numWorldDecls: number;
  // Parse-level
  numGlobalVars: number;
  numClassicGlobalVars: number; // var/global/x = ... (misparsed onto /datum, dropped)
  numGlobAccess: number; // GLOB.foo reads (accessor var never initialized at runtime)
  // AST-level: dropped statements
  numTry: number;
  numBreak: number;
  numContinue: number;
  numLabeledBlock: number;
  // AST-level: expression losses
  numNew: number;
  numParentCall: number;
  numBinaryNull: number;   // & | ^ ~ >> (emit DMValue.Null)
  numBinaryOutput: number; // << (semantic mismatch -> console output)
  numCompileBreak: number; // != ~! ** (generated C# fails to compile)
  numAsCast: number;
  numUnaryTilde: number;
  numSpawnExpr: number;
  numWorldRef: number;
  numPathConstPropRead: number; // /path.foo (e.g. GLOB.x) -> absorbed into a dead string literal
  numBrokenPropRead: number;
  numUnknownBuiltin: number;
  numBareGlobalProcCalls: number; // target-less calls to user procs defined in the codebase (CallProc on wrong path)
  // Aggregates
  parseErrors: number;
  parseWarnings: number;
  totalLossSites: number;
  unknownBuiltins: Map<string, { count: number; samples: string[] }>;
  brokenProps: Map<string, number>;
  topFiles: Map<string, number>;
  procCount: number;
  typeCount: number;
}

const BROKEN_PROP_NAMES = ['len', 'type', 'loc', 'dir', 'x', 'y', 'z', 'overlays', 'contents'];

function emptyCounters(): LossCounters {
  return {
    numElif: 0, numIfNumeric: 0, numIfError: 0, numPragmaOnce: 0,
    numDefineStringTruncation: 0, numGoto: 0, numSetModifiers: 0,
    numSwitchBraceForm: 0, numWeightedPick: 0, numMultiVarFor: 0,
    numForStepClause: 0, numForAsFilter: 0, numVerbDecls: 0,
    numClientDecls: 0,     numWorldDecls: 0,
    numGlobalVars: 0, numClassicGlobalVars: 0, numGlobAccess: 0,
    numTry: 0, numBreak: 0, numContinue: 0, numLabeledBlock: 0,
    numNew: 0, numParentCall: 0, numBinaryNull: 0, numBinaryOutput: 0,
    numCompileBreak: 0, numAsCast: 0, numUnaryTilde: 0, numSpawnExpr: 0,
    numWorldRef: 0, numPathConstPropRead: 0, numBrokenPropRead: 0, numUnknownBuiltin: 0,
    numBareGlobalProcCalls: 0,
    parseErrors: 0, parseWarnings: 0, totalLossSites: 0,
    unknownBuiltins: new Map(), brokenProps: new Map(), topFiles: new Map(),
    procCount: 0, typeCount: 0
  };
}

function walk(dir: string, ext: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full, ext));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(ext)) {
      out.push(full);
    }
  }
  return out;
}

// Source-level heuristics: count constructs that the parser/preprocessor
// silently mishandle (no AST node is produced for them).
function countSourceLevel(counters: LossCounters, code: string): void {
  const lines = code.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();

    if (t.startsWith('#elif')) counters.numElif++;
    else if (t.startsWith('#if')) {
      const body = t.replace(/^#if/, '');
      // Numeric/relational conditionals (defined() and bare names are fine)
      if (/[0-9]|>=|<=|!=|==|>|<|\+|\-|\*|\/|\|\||&&/.test(body.replace(/defined\s*\([^)]*\)/g, ''))) {
        counters.numIfNumeric++;
      }
    } else if (t.startsWith('#error')) counters.numIfError++;
    else if (/^#pragma\s+once/.test(t)) counters.numPragmaOnce++;
    else if (/^#define/.test(t)) {
      const q = t.indexOf('"');
      const c = t.indexOf('//');
      if (q >= 0 && c > q) counters.numDefineStringTruncation++;
    }

    if (/\bgoto\b/.test(t)) counters.numGoto++;
    if (/^\s*set\s+\w/.test(line)) counters.numSetModifiers++;
    if (/\bswitch\s*\([^)]*\)\s*\{/.test(t)) counters.numSwitchBraceForm++;
    if (/\bpick\s*\([^)]*;/.test(t)) counters.numWeightedPick++;
    if (/^\s*for\s*\(\s*var\/[^)]*,\s*\w+\s+in/i.test(t)) counters.numMultiVarFor++;
    if (/\bfor\s*\([^)]*\bto\b[^)]*\bstep\b/i.test(t)) counters.numForStepClause++;
    if (/\bfor\s*\([^)]*\bas\s+\w+\s+in\b/i.test(t)) counters.numForAsFilter++;
    if (/^\s*\/.*\/verb\//.test(t)) counters.numVerbDecls++;
    if (/^\s*\/client\b/.test(t)) counters.numClientDecls++;
    if (/^\s*\/world\b/.test(t)) counters.numWorldDecls++;
    if (/^\s*var\/global\/|^\s*\w+\/var\/global\//.test(t)) counters.numClassicGlobalVars++;
    if (/\bGLOB\.[A-Za-z_]/.test(t)) counters.numGlobAccess++;
  }
}

// AST-level counting: walk statement/expression trees and tally every
// construct the emitter drops or mis-compiles. `allProcNames` is shared
// across files so target-less calls to user procs defined elsewhere in the
// codebase are not misclassified as unknown builtins.
function countASTLevel(counters: LossCounters, parser: DMParser, relFile: string, allProcNames: Set<string>): void {
  const procNames = allProcNames;
  const seen = new WeakSet<object>();

  const visit = (node: any): void => {
    if (node === null || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }

    switch (node.type) {
      case 'DMTypeDecl':
        counters.typeCount++;
        for (const proc of node.procs || []) {
          counters.procCount++;
          procNames.add(proc.name);
          visit(proc);
        }
        for (const v of node.vars || []) visit(v);
        return;

      case 'DMProcDecl':
        visit(node.args);
        visit(node.statements);
        return;

      // --- Dropped statements (emitter default -> "// Unknown statement:") ---
      case 'TryStatement': counters.numTry++; break;
      case 'BreakStatement': counters.numBreak++; break;
      case 'ContinueStatement': counters.numContinue++; break;
      case 'LabeledBlockStatement': counters.numLabeledBlock++; break;

      // --- Expression losses ---
      case 'new':
        counters.numNew++;
        for (const a of node.arguments || []) visit(a);
        return;

      case 'call': {
        if (!node.target) {
          if (node.name === '..') {
            counters.numParentCall++;
          } else if (node.name === 'spawn') {
            counters.numSpawnExpr++;
          } else if (!MAPPED_BUILTINS.includes(node.name) && !procNames.has(node.name)) {
            counters.numUnknownBuiltin++;
            const entry = counters.unknownBuiltins.get(node.name) ?? { count: 0, samples: [] };
            entry.count++;
            if (entry.samples.length < 3) entry.samples.push(relFile);
            counters.unknownBuiltins.set(node.name, entry);
          }
        }
        visit(node.target);
        for (const a of node.arguments || []) visit(a);
        return;
      }

      case 'binary': {
        switch (node.operator) {
          case '&': case '|': case '^': case '~': case '>>':
            counters.numBinaryNull++;
            break;
          case '<<':
            counters.numBinaryOutput++;
            break;
          case '!=': case '~!': case '**':
            counters.numCompileBreak++;
            break;
          case 'as':
            counters.numAsCast++;
            break;
        }
        visit(node.left);
        visit(node.right);
        return;
      }

      case 'unary':
        if (node.operator === '~') counters.numUnaryTilde++;
        visit(node.operand);
        return;

      case 'variable':
        if (node.name === 'world') counters.numWorldRef++;
        return;

      case 'literal':
        if (node.literalType === 'string' && typeof node.value === 'string' && node.value.startsWith('/') && node.value.includes('.')) {
          // /path/constant.foo — a property read on a type-path constant
          // (e.g. GLOB.configuration.thing) that the lexer absorbed into a
          // string literal; dead data in the output.
          counters.numPathConstPropRead++;
        }
        return;

      case 'property':
        if (BROKEN_PROP_NAMES.includes(node.property)) {
          counters.numBrokenPropRead++;
          counters.brokenProps.set(node.property, (counters.brokenProps.get(node.property) ?? 0) + 1);
        }
        visit(node.target);
        return;
    }

    // Recurse into everything else (statements with bodies, literals, etc.)
    for (const key of Object.keys(node)) {
      visit(node[key]);
    }
  };

  for (const decl of parser.parse()) {
    visit(decl);
  }
  void 0;
}

interface CodebaseResult {
  name: string;
  dir: string;
  files: number;
  counters: LossCounters;
}

function runAudit(dir: string, name: string): CodebaseResult {
  const files = walk(dir, '.dm');
  const counters = emptyCounters();
  console.log(`[${name}] Scanning ${files.length} .dm files ...`);

  const collected = DMPreprocessor.collectDefinesFromFiles(files);
  console.log(`[${name}] Collected ${collected.object.size} object-like, ${collected.function.size} function-like defines.`);

  const allProcNames = new Set<string>();

  let done = 0;
  for (const file of files) {
    let code: string;
    try {
      code = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    const relFile = path.relative(dir, file);
    countSourceLevel(counters, code);

    const collector = new DiagnosticCollector();
    collector.file = relFile;
    const pp = new DMPreprocessor(collector, collected.object, collected.function);
    const pre = pp.process(code, file);
    const lexer = new DMLexer(pre);
    const tokens = lexer.tokenize();
    collector.merge(lexer.diagnostics);
    const parser = new DMParser(tokens, collector);
    counters.numGlobalVars += parser.globalVars.length;
    countASTLevel(counters, parser, relFile, allProcNames);

    counters.parseErrors += collector.errors.length;
    counters.parseWarnings += collector.warnings.length;

    const fileLoss =
      counters.numGlobalVars + 0; // placeholder: real per-file loss tracked separately
    void fileLoss;

    done++;
    if (done % 500 === 0 || done === files.length) {
      console.log(`[${name}] ${done}/${files.length} files ...`);
    }
  }

  // Reclassify target-less calls to procs defined in the codebase: these are
  // not "unknown builtins", but they still route through comp.CallProc which
  // looks up the component's own type path (global /proc/... definitions are
  // registered under "/proc" and are never found -> Null at runtime).
  const reclassified = new Map<string, number>();
  for (const [name, info] of counters.unknownBuiltins) {
    if (allProcNames.has(name)) {
      counters.numBareGlobalProcCalls += info.count;
      reclassified.set(name, info.count);
    }
  }
  for (const name of reclassified.keys()) {
    counters.unknownBuiltins.delete(name);
  }
  counters.numUnknownBuiltin = [...counters.unknownBuiltins.values()].reduce((a, v) => a + v.count, 0);
  counters.totalLossSites =
    counters.numElif + counters.numIfNumeric + counters.numIfError +
    counters.numPragmaOnce + counters.numDefineStringTruncation +
    counters.numGoto + counters.numSetModifiers + counters.numSwitchBraceForm +
    counters.numWeightedPick + counters.numMultiVarFor + counters.numForStepClause +
    counters.numForAsFilter + counters.numVerbDecls + counters.numClientDecls +
    counters.numWorldDecls + counters.numGlobalVars + counters.numClassicGlobalVars + counters.numGlobAccess +
    counters.numTry + counters.numBreak + counters.numContinue + counters.numLabeledBlock +
    counters.numNew + counters.numParentCall + counters.numBinaryNull +
    counters.numBinaryOutput + counters.numCompileBreak + counters.numAsCast +
    counters.numUnaryTilde + counters.numSpawnExpr + counters.numWorldRef +
    counters.numPathConstPropRead + counters.numBrokenPropRead +
    counters.numUnknownBuiltin + counters.numBareGlobalProcCalls;

  return { name, dir, files: files.length, counters };
}

function printResult(r: CodebaseResult): void {
  const c = r.counters;
  const line = (label: string, value: number, note = ''): void => {
    console.log(`  ${label.padEnd(34)} ${String(value).padStart(8)}  ${note}`);
  };
  console.log(`\n=== FIDELITY AUDIT: ${r.name} (${r.files} files) ===`);
  console.log(`Parse diagnostics: ${c.parseErrors} errors, ${c.parseWarnings} warnings`);
  console.log(`  Types / procs parsed: ${c.typeCount} types, ${c.procCount} procs`);  line('/global/var/ dropped', c.numGlobalVars, 'parsed, never emitted');
  line('var/global/ (classic)', c.numClassicGlobalVars, 'lands on /datum, dropped');
  line('GLOB.x accessor reads', c.numGlobAccess, 'var never initialized -> Null');
  console.log('-- Preprocessor loss --');
  line('#elif (mis-handled)', c.numElif);
  line('#if numeric/relational', c.numIfNumeric, 'comparisons ignored');
  line('#error (ignored)', c.numIfError);
  line('#pragma once (no-op)', c.numPragmaOnce);
  line('#define with // in string', c.numDefineStringTruncation, 'truncated');
  console.log('-- Parser-level loss --');
  line('goto', c.numGoto, 'silently misparsed');
  line('set modifiers (verbs)', c.numSetModifiers, 'dropped');
  line('switch { } brace form', c.numSwitchBraceForm, 'misparsed');
  line('weighted pick(a;"x")', c.numWeightedPick, 'weights dropped');
  line('multi-var for(a, b in ...)', c.numMultiVarFor);
  line('for ... step n', c.numForStepClause);
  line('for ... as type in ...', c.numForAsFilter);
  line('verb declarations', c.numVerbDecls, 'folded into procs');
  line('client declarations', c.numClientDecls);
  line('world declarations', c.numWorldDecls);
  console.log('-- Emitter loss (statement drops) --');
  line('try/catch', c.numTry, '-> // Unknown statement');
  line('break', c.numBreak, '-> // Unknown statement');
  line('continue', c.numContinue, '-> // Unknown statement');
  line('labeled blocks', c.numLabeledBlock, '-> // Unknown statement');
  console.log('-- Emitter loss (expression) --');
  line('new /type(...)', c.numNew, 'returns caller as placeholder');
  line('..() parent calls', c.numParentCall, '-> CallProc("..") -> Null');
  line('bitwise & | ^ ~ >>', c.numBinaryNull, '-> DMValue.Null');
  line('<< (shift/output)', c.numBinaryOutput, '-> console Output');
  line('COMPILE-BREAK != ~! **', c.numCompileBreak, '-> generated C# does not build');
  line('as casts', c.numAsCast, '-> DMValue.Null');
  line('unary ~', c.numUnaryTilde, '-> DMValue.Null');
  line('spawn() as expression', c.numSpawnExpr, 'empty body');
  line('world references', c.numWorldRef, '-> Null');
  line('path-const reads /path.x', c.numPathConstPropRead, 'GLOB.x style, dead literal');
  line('builtin prop reads', c.numBrokenPropRead, 'len/type/loc/x/y/z/dir...');
  line('unknown builtin calls', c.numUnknownBuiltin, '-> CallProc -> Null');
  line('bare calls to global procs', c.numBareGlobalProcCalls, 'resolved at runtime via /proc fallback');
  console.log(`TOTAL LOSS SITES (approx): ${c.totalLossSites}`);

  if (c.unknownBuiltins.size > 0) {
    const top = [...c.unknownBuiltins.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 25);
    console.log('\nTop unknown builtin calls (-> Null at runtime):');
    for (const [name, info] of top) {
      console.log(`  ${String(info.count).padStart(7)}  ${name}   (e.g. ${info.samples[0]})`);
    }
  }
  if (c.brokenProps.size > 0) {
    const top = [...c.brokenProps.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    console.log('\nBroken builtin property reads:');
    for (const [name, count] of top) {
      console.log(`  ${String(count).padStart(7)}  .${name}`);
    }
  }
}

async function runBuildProof(r: CodebaseResult, outDir: string, maxProcs: number): Promise<void> {
  console.log(`\n[${r.name}] Building representative proc sample (max ${maxProcs} procs) ...`);
  if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const files = walk(r.dir, '.dm');
  const collected = DMPreprocessor.collectDefinesFromFiles(files);
  const allNodes: any[] = [];
  const collector = new DiagnosticCollector();
  let count = 0;
  for (const file of files) {
    let code: string;
    try {
      code = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    const pp = new DMPreprocessor(new DiagnosticCollector(), collected.object, collected.function);
    const pre = pp.process(code, file);
    const parser = new DMParser(new DMLexer(pre).tokenize(), collector);
    allNodes.push(...parser.parse());
    count++;
  }
  console.log(`[${r.name}] Parsed ${count} files for build sample.`);

  const irGen = new DMIRGenerator();
  const irMap = irGen.generateIR(allNodes);

  // Sample up to maxProcs procs evenly across types
  const sampled = new Map<string, Map<string, any>>();
  let totalProcs = 0;
  for (const [p, t] of irMap.entries()) totalProcs += t.procs.size;
  const perType = Math.max(1, Math.ceil(maxProcs / Math.max(1, irMap.size)));
  for (const [p, t] of irMap.entries()) {
    const procs = new Map<string, any>();
    let n = 0;
    for (const [name, proc] of t.procs.entries()) {
      procs.set(name, proc);
      if (++n >= perType) break;
    }
    sampled.set(p, procs);
  }
  const sampleIr = new Map<string, any>();
  for (const [p, t] of irMap.entries()) {
    sampleIr.set(p, { ...t, procs: sampled.get(p)! });
  }
  const sampledCount = [...sampleIr.values()].reduce((a, t) => a + t.procs.size, 0);
  console.log(`[${r.name}] Emitting ${sampledCount} sampled procs from ${irMap.size} types (of ${totalProcs} total).`);

  const emitter = new CSharpEmitter();
  const serverDMDir = path.join(outDir, 'Content.Server', 'DM');
  fs.mkdirSync(serverDMDir, { recursive: true });
  fs.writeFileSync(path.join(serverDMDir, 'ConvertedDMProcs.cs'), emitter.generateProcsCS(sampleIr), 'utf-8');
  fs.writeFileSync(path.join(serverDMDir, 'ConvertedDMSystem.cs'), emitter.generateSystemCS(), 'utf-8');

  const template = new SS14Template();
  template.generateSS14Solution(outDir);
  for (const f of DMRuntimeCS.getRuntimeCSFiles()) {
    const target = path.join(outDir, 'SS13.DM.Runtime', f.filename);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.content, 'utf-8');
  }

  console.log(`[${r.name}] Running dotnet build ...`);
  const engineDir = process.env.SS14_ENGINE_DIR || path.join(outDir, '..', 'RobustToolbox');
  // Live-streamed build: buffered execSync output makes a healthy 12-15 min
  // build look identical to a hang. Spawn with piped output that echoes as it
  // arrives, and SIGKILL (single-process MSBuild via -m:1) if it exceeds the
  // 30-minute budget so a genuinely stuck build cannot block forever.
  const cmd = `dotnet build Content.sln --nologo -v q -m:1 -nodeReuse:false --disable-build-servers -p:EngineDir="${engineDir}"`;
  const child = spawn(cmd, { cwd: outDir, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => { process.stdout.write(d); output += d.toString(); });
  child.stderr.on('data', (d) => { process.stderr.write(d); output += d.toString(); });
  const timer = setTimeout(() => {
    console.log(`[${r.name}] dotnet build exceeded ${30} min — killing (SIGKILL; this is a timeout, NOT a compile failure)`);
    child.kill('SIGKILL');
  }, 30 * 60 * 1000);
  const buildFailed: boolean = await new Promise((resolve) => {
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code !== 0);
    });
  });
  if (!buildFailed) {
    console.log(`[${r.name}] BUILD SUCCESS`);
    return;
  }
  const errLines = output.split('\n').filter((l: string) => l.includes('error CS'));
  const byCode = new Map<string, number>();
  for (const l of errLines) {
    const m = l.match(/error (CS\d+)/);
    if (m) byCode.set(m[1], (byCode.get(m[1]) ?? 0) + 1);
  }
  const sorted = [...byCode.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`[${r.name}] BUILD FAILED with ${errLines.length} C# errors`);
  for (const [code, n] of sorted.slice(0, 15)) {
    console.log(`  ${String(n).padStart(7)}  ${code}`);
  }
  const samples = errLines.slice(0, 5).map((l: string) => l.trim());
  for (const s of samples) console.log(`    e.g. ${s}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dir = args[0];
  if (!dir) {
    console.error('Usage: node dist/audit/fidelityAudit.js <repo-dir> [--json out.json] [--build out-dir] [--build-max-procs N]');
    process.exit(1);
  }
  let jsonOut: string | undefined;
  let buildDir: string | undefined;
  let maxProcs = 1500;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--json') jsonOut = args[++i];
    else if (args[i] === '--build') buildDir = args[++i];
    else if (args[i] === '--build-max-procs') maxProcs = parseInt(args[++i], 10) || 1500;
  }
  if (!fs.existsSync(dir)) {
    console.error(`Directory not found: ${dir}`);
    process.exit(1);
  }

  const name = path.basename(dir);
  const result = runAudit(dir, name);
  printResult(result);

  if (jsonOut) {
    const serializable = {
      ...result,
      counters: {
        ...result.counters,
        unknownBuiltins: Object.fromEntries(result.counters.unknownBuiltins),
        brokenProps: Object.fromEntries(result.counters.brokenProps),
        topFiles: Object.fromEntries(result.counters.topFiles)
      }
    };
    fs.writeFileSync(jsonOut, JSON.stringify(serializable, null, 2));
    console.log(`\nJSON written to ${jsonOut}`);
  }

  if (buildDir) {
    await runBuildProof(result, buildDir, maxProcs);
  }
}

main().catch(err => {
  console.error('Audit error:', err);
  process.exit(1);
});
