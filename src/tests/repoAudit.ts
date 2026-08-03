import * as fs from 'fs';
import * as path from 'path';
import { DMPreprocessor } from '../preprocessor.js';
import { DMLexer } from '../parser/dmLexer.js';
import { DMParser } from '../parser/dmParser.js';
import { DiagnosticCollector } from '../diagnostics.js';

interface AuditResult {
  dir: string;
  scannedAt: string;
  filesScanned: number;
  cleanFiles: number;
  failingFiles: number;
  totalErrors: number;
  totalWarnings: number;
  globalVars: number;
  firstErrorCauses: { message: string; count: number }[];
}

const usage = 'Usage: npm run audit:repo -- <directory> [out.json]';

function walk(dir: string, ext: string): string[] {
  const out: string[] = [];
  // Sorted walk: the #define/#undef sequence in collectDefinesFromFiles is
  // order-dependent (fs.readdirSync order is platform/FS dependent), which
  // made macro expansions flaky — deterministic order (item 68, B-0).
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full, ext));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(ext)) {
      out.push(full);
    }
  }
  return out;
}

function main(): void {
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
  const collected = DMPreprocessor.collectDefinesFromFiles(files);
  console.log(
    `Collected ${collected.object.size} object-like, ${collected.function.size} function-like defines.`
  );

  let clean = 0;
  let failing = 0;
  let totalErrors = 0;
  let totalWarnings = 0;
  let globalVars = 0;
  const firstErrorCauses = new Map<string, number>();
  const failingSamples: string[] = [];

  for (const file of files) {
    let code: string;
    try {
      code = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }

    const collector = new DiagnosticCollector();
    collector.file = path.basename(file);
    const pp = new DMPreprocessor(collector, collected.object, collected.function);
    const pre = pp.process(code, file);

    // The lexer's diagnostics (unterminated strings/block comments,
    // inconsistent indentation) live on lexer.diagnostics and MUST be merged
    // — dropping them made the audit report false-clean "0 files" while the
    // production pipeline still failed (item 68, B-0).
    const lexer = new DMLexer(pre);
    const tokens = lexer.tokenize();
    collector.merge(lexer.diagnostics);
    const parser = new DMParser(tokens, collector);
    const decls = parser.parse();
    globalVars += parser.globalVars.length;

    const errors = collector.errors;
    totalErrors += errors.length;
    totalWarnings += collector.warnings.length;
    if (errors.length === 0 && decls.length >= 0) {
      clean++;
    } else {
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

  const result: AuditResult = {
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
