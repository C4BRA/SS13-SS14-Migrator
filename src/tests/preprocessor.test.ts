import { DMPreprocessor } from '../preprocessor.js';
import { DiagnosticCollector } from '../diagnostics.js';
import { DMLexer } from '../parser/dmLexer.js';
import { DMParser } from '../parser/dmParser.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ TEST FAILED: ${message}`);
    process.exit(1);
  } else {
    console.log(`✅ ${message}`);
  }
}

function assertContains(haystack: string, needle: string, message: string) {
  if (!haystack.includes(needle)) {
    console.error(`❌ TEST FAILED: ${message}`);
    console.error(`  Expected to contain: "${needle}"`);
    console.error(`  Actual: "${haystack}"`);
    process.exit(1);
  } else {
    console.log(`✅ ${message}`);
  }
}

function preprocess(code: string, filePath: string = '/tmp/pre_test.dm', collector: DiagnosticCollector = new DiagnosticCollector()) {
  const pp = new DMPreprocessor(collector);
  return { out: pp.process(code, filePath), collector };
}

async function runPreprocessorTests() {
  console.log("=== Running DM Preprocessor Tests ===");

  // Test 1: Object-like #define substitution
  const t1 = preprocess('#define DAMAGE 10\nvar/dmg = DAMAGE\n');
  assertContains(t1.out, 'var/dmg = 10', '#define object-like substitution');

  // Test 2: Macro not substituted inside string literals or icon paths
  const t2 = preprocess('#define PICK x\nvar/a = "PICK"\nvar/b = \'PICK.dmi\'\n');
  assertContains(t2.out, '"PICK"', 'No substitution inside string literals');
  assertContains(t2.out, "'PICK.dmi'", 'No substitution inside icon paths');

  // Test 3: #ifdef / #ifndef / #else / #endif
  const t3 = preprocess('#define FEATURE_X\n#ifdef FEATURE_X\nvar/a = 1\n#else\nvar/a = 2\n#endif\n#ifndef FEATURE_Y\nvar/b = 3\n#endif\n');
  assertContains(t3.out, 'var/a = 1', '#ifdef true branch kept');
  assert(!t3.out.includes('var/a = 2'), '#else branch dropped');
  assertContains(t3.out, 'var/b = 3', '#ifndef on undefined macro keeps branch');

  // Test 4: #if defined() with logical operators
  const t4 = preprocess('#define A\n#define B\n#if defined(A) && !defined(C)\nvar/x = 1\n#endif\n#if defined(A) || defined(C)\nvar/y = 2\n#endif\n');
  assertContains(t4.out, 'var/x = 1', '#if defined(A) && !defined(C)');
  assertContains(t4.out, 'var/y = 2', '#if defined(A) || defined(C)');

  // Test 5: #undef
  const t5 = preprocess('#define X 5\nvar/a = X\n#undef X\nvar/b = X\n');
  assertContains(t5.out, 'var/a = 5', '#define before #undef');
  assertContains(t5.out, 'var/b = X', '#undef removes macro');

  // Test 6: #include resolution with cycle guard
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp_test_'));
  const incFile = path.join(tmpDir, 'defs.dm');
  const mainFile = path.join(tmpDir, 'main.dm');
  fs.writeFileSync(incFile, '#define INCLUDED 42\nvar/fromInclude = INCLUDED\n');
  fs.writeFileSync(mainFile, '#include "defs.dm"\nvar/mainVal = INCLUDED\n');
  const t6 = preprocess('#include "defs.dm"\nvar/mainVal = INCLUDED\n', mainFile);
  assertContains(t6.out, 'var/fromInclude = 42', '#include inlines included file');
  assertContains(t6.out, 'var/mainVal = 42', 'Macros from #include visible to includer');

  // Cycle guard: c.dm includes a.dm includes b.dm includes a.dm (cycle)
  const aFile = path.join(tmpDir, 'a.dm');
  const bFile = path.join(tmpDir, 'b.dm');
  const cFile = path.join(tmpDir, 'c.dm');
  fs.writeFileSync(aFile, '#include "b.dm"\nvar/a1 = 1\n');
  fs.writeFileSync(bFile, '#include "a.dm"\nvar/b1 = 2\n');
  fs.writeFileSync(cFile, '#include "a.dm"\nvar/c1 = 3\n');
  const coll = new DiagnosticCollector();
  const t6b = preprocess(fs.readFileSync(cFile, 'utf-8'), cFile, coll);
  assert(coll.errors.length === 1 && coll.errors[0].message.includes('Recursive'), 'Cycle guard reports recursive include');
  assertContains(t6b.out, 'var/b1 = 2', 'Included file content kept despite cycle');
  assertContains(t6b.out, 'var/a1 = 1', 'Outer file continues after cycle');

  // Test 7: Missing include produces error
  const coll7 = new DiagnosticCollector();
  preprocess('#include "nope.dm"\nvar/a = 1\n', '/tmp/pp_main7.dm', coll7);
  assert(coll7.errors.length === 1 && coll7.errors[0].message.includes('not found'), 'Missing include reported as error');

  // Test 8: Unknown directive / #warn diagnostics
  const coll8 = new DiagnosticCollector();
  preprocess('#warn watch out\n#frobnicate x\nvar/a = 1\n', '/tmp/pp_main8.dm', coll8);
  assert(coll8.warnings.length === 2, `Unknown directive + #warn produce warnings (got ${coll8.warnings.length})`);

  // Test 9: Nested conditionals
  const t9 = preprocess('#define A\n#if defined(A)\n#ifdef B\nvar/nope = 1\n#else\nvar/yes = 1\n#endif\n#endif\n');
  assertContains(t9.out, 'var/yes = 1', 'Nested conditional with inner #else');

  // Test 10: End-to-end: preprocessed source parses cleanly
  const t10 = preprocess('#define MAX_HP 100\n/mob/person\n    var/hp = MAX_HP\n    proc/hurt()\n        hp -= 10\n        if (hp <= 0)\n            del src\n');
  const parser = new DMParser(new DMLexer(t10.out).tokenize());
  const ast = parser.parse();
  assert(parser.diagnostics.errors.length === 0, 'Preprocessed output parses without errors');
  const mob = ast.find((n: any) => n.path === '/mob/person');
  assert(mob !== undefined, 'Preprocessed type declaration parsed');
  assert(mob!.vars[0].name === 'hp' && mob!.vars[0].initialValue === '100', 'Macro expanded to numeric initializer');

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log("\n✅ ALL PREPROCESSOR TESTS PASSED!");
}

runPreprocessorTests().catch(err => {
  console.error("Test error:", err);
  process.exit(1);
});
