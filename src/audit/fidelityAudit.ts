// Fidelity audit: measures what is LOST in the DM -> C# conversion.
// This is a measurement-only harness: it reuses the production pipeline
// (preprocessor -> lexer -> parser -> IR -> emitter) but counts every
// construct that is dropped, stubbed, or mis-compiled instead of silently
// proceeding. Usage:
//   node dist/audit/fidelityAudit.js <repo-dir> [--json out.json] [--error-classes] [--build out-dir] [--build-max-procs N]

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
import { SymbolTable } from '../ir/symbolTable.js';
import { DMTypeDeclNode } from '../parser/dmParser.js';
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
  numLabeledBlock: number;
  // AST-level: expression losses
  numNew: number;
  numParentCall: number;
  numBinaryNull: number;   // & | ^ ~ >> (emit DMValue.Null)
  numBinaryOutput: number; // << (semantic mismatch -> console output)
  numAsCast: number;
  numUnaryTilde: number;
  numSpawnExpr: number;
  numWorldRef: number;
  numPathConstPropRead: number; // /path.foo (e.g. GLOB.x) -> absorbed into a dead string literal
  numBrokenPropRead: number;
  numUnknownBuiltin: number;
  numBareGlobalProcCalls: number; // target-less calls resolved via /proc globals (verified)
  numTypeResolvedBareCalls: number; // target-less calls resolved via the calling type's hierarchy
  numUnresolvedCalls: number; // target-less calls with no known target (silent Null at runtime)
  // Aggregates
  parseErrors: number;
  parseWarnings: number;
  totalLossSites: number;
  unknownBuiltins: Map<string, { count: number; samples: string[]; contexts: Map<string, number> }>;
  brokenProps: Map<string, number>;
  topFiles: Map<string, number>;
  // Parse diagnostics aggregated by message template (token texts stripped).
  errorClasses: Map<string, { errors: number; warnings: number; samples: string[]; tokens: Map<string, number> }>;
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
    numTry: 0, numLabeledBlock: 0,
    numNew: 0, numParentCall: 0, numBinaryNull: 0, numBinaryOutput: 0,
    numAsCast: 0, numUnaryTilde: 0, numSpawnExpr: 0,
    numWorldRef: 0, numPathConstPropRead: 0, numBrokenPropRead: 0, numUnknownBuiltin: 0,
    numBareGlobalProcCalls: 0, numTypeResolvedBareCalls: 0, numUnresolvedCalls: 0,
    parseErrors: 0, parseWarnings: 0, totalLossSites: 0,
    unknownBuiltins: new Map(), brokenProps: new Map(), topFiles: new Map(),
    errorClasses: new Map(),
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

// Aggregate parse diagnostics by message template so the error backlog is a
// prioritized list of *classes*, not 2,473 unrelated messages. Quoted token
// texts (e.g. `Unexpected token 'foo' in expression`) are stripped to the
// shared template `'<x>'`; file:line samples are kept for the first few hits.
function collectErrorClasses(
  counters: LossCounters,
  errors: readonly { message: string; line: number }[],
  warnings: readonly { message: string; line: number }[],
  relFile: string
): void {
  const add = (d: { message: string; line: number }, isWarning: boolean): void => {
    const key = d.message.replace(/'[^']*'/g, "'<x>'");
    let entry = counters.errorClasses.get(key);
    if (!entry) {
      entry = { errors: 0, warnings: 0, samples: [], tokens: new Map() };
      counters.errorClasses.set(key, entry);
    }
    if (isWarning) entry.warnings++;
    else entry.errors++;
    if (entry.samples.length < 3) entry.samples.push(`${relFile}:${d.line}`);
    // Histogram of the actual token values, so the class's dominant construct
    // is identifiable (e.g. "in 1 to width" -> token "to").
    for (const m of d.message.matchAll(/'([^']*)'/g)) {
      const tok = m[1];
      if (!tok) continue;
      entry.tokens.set(tok, (entry.tokens.get(tok) ?? 0) + 1);
    }
  };
  for (const e of errors) add(e, false);
  for (const w of warnings) add(w, true);
}

// AST-level counting: walk statement/expression trees and tally every
// construct the emitter drops or mis-compiles. Bare calls are bucketed with
// their enclosing type path; a post-pass (runAudit) resolves them against the
// corpus-wide SymbolTable, so procs declared in other files resolve too.
function countASTLevel(
  counters: LossCounters,
  typeDecls: DMTypeDeclNode[],
  relFile: string,
  symbols: SymbolTable
): void {
  const seen = new WeakSet<object>();
  let currentTypePath: string | null = null;

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
        currentTypePath = node.path;
        for (const proc of node.procs || []) {
          counters.procCount++;
          visit(proc);
        }
        for (const v of node.vars || []) visit(v);
        currentTypePath = null;
        return;

      case 'DMProcDecl':
        visit(node.args);
        visit(node.statements);
        return;

      // --- Dropped statements (emitter default -> "// Unknown statement:") ---
      case 'TryStatement': counters.numTry++; break;
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
          } else if (!MAPPED_BUILTINS.includes(node.name)) {
            const ctx = currentTypePath ?? '/';
            const entry = counters.unknownBuiltins.get(node.name) ?? { count: 0, samples: [], contexts: new Map<string, number>() };
            entry.count++;
            entry.contexts.set(ctx, (entry.contexts.get(ctx) ?? 0) + 1);
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

  for (const decl of typeDecls) {
    visit(decl);
  }
}

interface CodebaseResult {
  name: string;
  dir: string;
  files: number;
  counters: LossCounters;
}

export function runAudit(dir: string, name: string): CodebaseResult {
  const files = walk(dir, '.dm');
  const counters = emptyCounters();
  console.log(`[${name}] Scanning ${files.length} .dm files ...`);

  const collected = DMPreprocessor.collectDefinesFromFiles(files);
  console.log(`[${name}] Collected ${collected.object.size} object-like, ${collected.function.size} function-like defines.`);

  const symbols = new SymbolTable();

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
    const typeDecls = parser.parse();
    symbols.addTypeDecls(typeDecls);
    countASTLevel(counters, typeDecls, relFile, symbols);
    // read globalVars afterwards so /global/var/ declarations are included.
    counters.numGlobalVars += parser.globalVars.length;

    counters.parseErrors += collector.errors.length;
    counters.parseWarnings += collector.warnings.length;
    collectErrorClasses(counters, collector.errors, collector.warnings, relFile);

    const fileLoss =
      counters.numGlobalVars + 0; // placeholder: real per-file loss tracked separately
    void fileLoss;

    done++;
    if (done % 500 === 0 || done === files.length) {
      console.log(`[${name}] ${done}/${files.length} files ...`);
    }
  }

  // Plan 02 — resolve bare calls against the corpus-wide symbol table. A name
  // declared as a global proc (/proc/foo) resolves from every context via the
  // runtime registry's /proc fallback; a type-local proc only resolves when the
  // call site's enclosing type is within its hierarchy. Everything left in
  // `unknownBuiltins` after this pass is genuinely unresolved (silent Null at
  // runtime) — the actionable backlog.
  for (const [name, info] of counters.unknownBuiltins) {
    if (symbols.hasGlobalProc(name)) {
      counters.numBareGlobalProcCalls += info.count;
      counters.unknownBuiltins.delete(name);
      continue;
    }
    let resolved = 0;
    let unresolved = 0;
    for (const [ctx, cnt] of info.contexts) {
      if (symbols.resolveBareProc(ctx === '/' ? null : ctx, name)) resolved += cnt;
      else unresolved += cnt;
    }
    counters.numTypeResolvedBareCalls += resolved;
    if (unresolved === 0) {
      counters.unknownBuiltins.delete(name);
    } else {
      info.count = unresolved;
    }
  }
  counters.numUnresolvedCalls = [...counters.unknownBuiltins.values()].reduce((a, v) => a + v.count, 0);
  counters.numUnknownBuiltin = counters.numUnresolvedCalls;
  counters.totalLossSites =
    counters.numElif + counters.numIfNumeric + counters.numIfError +
    counters.numPragmaOnce + counters.numDefineStringTruncation +
    counters.numGoto + counters.numSetModifiers + counters.numSwitchBraceForm +
    counters.numWeightedPick + counters.numMultiVarFor + counters.numForStepClause +
    counters.numForAsFilter + counters.numVerbDecls + counters.numClientDecls +
    counters.numWorldDecls + counters.numClassicGlobalVars +
    counters.numTry + counters.numLabeledBlock +
    counters.numNew + counters.numParentCall + counters.numBinaryNull +
    counters.numBinaryOutput + counters.numAsCast +
    counters.numUnaryTilde + counters.numSpawnExpr + counters.numWorldRef +
    counters.numPathConstPropRead + counters.numBrokenPropRead +
    counters.numUnknownBuiltin;

  return { name, dir, files: files.length, counters };
}

function printResult(r: CodebaseResult): void {
  const c = r.counters;
  const line = (label: string, value: number, note = ''): void => {
    console.log(`  ${label.padEnd(34)} ${String(value).padStart(8)}  ${note}`);
  };
  console.log(`\n=== FIDELITY AUDIT: ${r.name} (${r.files} files) ===`);
  console.log(`Parse diagnostics: ${c.parseErrors} errors, ${c.parseWarnings} warnings`);
  console.log(`  Types / procs parsed: ${c.typeCount} types, ${c.procCount} procs`);  line('/global/var/ decls', c.numGlobalVars, 'emitted into GlobalVars registry');
  line('var/global/ (classic)', c.numClassicGlobalVars, 'emitted into GlobalVars registry');
  line('GLOB.x accessor reads', c.numGlobAccess, 'resolved via GlobalVars.Get');
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
  line('labeled blocks', c.numLabeledBlock, '-> // Unknown statement');
  console.log('-- Emitter loss (expression) --');
  line('new /type(...)', c.numNew, 'returns caller as placeholder');
  line('..() parent calls', c.numParentCall, '-> CallProc("..") -> Null');
  line('bitwise & | ^ ~ >>', c.numBinaryNull, '-> DMValue.Null');
  line('<< (shift/output)', c.numBinaryOutput, '-> console Output');
  line('as casts', c.numAsCast, '-> DMValue.Null');
  line('unary ~', c.numUnaryTilde, '-> DMValue.Null');
  line('spawn() as expression', c.numSpawnExpr, 'empty body');
  line('world references', c.numWorldRef, '-> Null');
  line('path-const reads /path.x', c.numPathConstPropRead, 'GLOB.x style, dead literal');
  line('builtin prop reads', c.numBrokenPropRead, 'len/type/loc/x/y/z/dir...');
  line('unknown builtin calls', c.numUnknownBuiltin, '-> CallProc -> Null');
  line('unresolved bare calls', c.numUnresolvedCalls, '-> Null at runtime (actionable backlog)');
  line('bare calls -> /proc globals', c.numBareGlobalProcCalls, 'resolved via /proc registry (verified)');
  line('bare calls -> type procs', c.numTypeResolvedBareCalls, 'resolved via calling type hierarchy');
  console.log(`TOTAL LOSS SITES (approx): ${c.totalLossSites}`);

  if (c.unknownBuiltins.size > 0) {
    const top = [...c.unknownBuiltins.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 25);
    console.log('\nTop unresolved bare calls (-> Null at runtime):');
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

// Prioritized parse-error backlog: top classes by total diagnostics, each with
// sample locations for the first few hits. `onlyErrors` keeps warnings out of
// the ranking (they are low-priority noise like ignored #pragma).
function printErrorClasses(r: CodebaseResult, topN = 25): void {
  const classes = [...r.counters.errorClasses.entries()].sort((a, b) => {
    const ta = a[1].errors + a[1].warnings;
    const tb = b[1].errors + b[1].warnings;
    return tb - ta;
  });
  const total = classes.reduce((a, [, v]) => a + v.errors + v.warnings, 0);
  console.log(`\nTop ${Math.min(topN, classes.length)} parse diagnostic classes (${total} total):`);
  if (classes.length === 0) {
    console.log('  (no parse diagnostics)');
    return;
  }
  let rank = 0;
  for (const [cls, v] of classes) {
    if (rank++ >= topN) break;
    const count = v.errors + v.warnings;
    const pct = (100 * count / Math.max(1, total)).toFixed(1);
    const warn = v.warnings > 0 ? ` (${v.warnings} warnings)` : '';
    console.log(`  ${String(count).padStart(6)} ${String(pct).padStart(5)}%  ${cls}${warn}`);
    for (const s of v.samples) console.log(`           e.g. ${s}`);
    if (v.tokens.size > 0) {
      const topTokens = [...v.tokens.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
      const tokensStr = topTokens.map(([t, n]) => `'${t}' x${n}`).join(', ');
      console.log(`           tokens: ${tokensStr}`);
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
  const allGlobals: any[] = [];
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
    allGlobals.push(...parser.globalVars);
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
  fs.writeFileSync(path.join(serverDMDir, 'ConvertedDMProcs.cs'), emitter.generateProcsCS(sampleIr, allGlobals), 'utf-8');
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
  let showErrorClasses = false;
  let maxProcs = 1500;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--json') jsonOut = args[++i];
    else if (args[i] === '--error-classes') showErrorClasses = true;
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
  if (showErrorClasses) printErrorClasses(result);

  if (jsonOut) {
    const serializable = {
      ...result,
      counters: {
        ...result.counters,
        unknownBuiltins: Object.fromEntries(result.counters.unknownBuiltins),
        brokenProps: Object.fromEntries(result.counters.brokenProps),
        topFiles: Object.fromEntries(result.counters.topFiles),
        errorClasses: Object.fromEntries(result.counters.errorClasses)
      }
    };
    fs.writeFileSync(jsonOut, JSON.stringify(serializable, null, 2));
    console.log(`\nJSON written to ${jsonOut}`);
  }

  if (buildDir) {
    await runBuildProof(result, buildDir, maxProcs);
  }
}

const isDirectRun = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('fidelityAudit.js');
if (isDirectRun) {
  main().catch(err => {
    console.error('Audit error:', err);
    process.exit(1);
  });
}
