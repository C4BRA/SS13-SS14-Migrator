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

  // Test 11: Backslash line continuations are joined before directive handling
  const t11 = preprocess('#define FLAG_A \\\n    1\nvar/a = FLAG_A\n');
  assertContains(t11.out, 'var/a = 1', 'Object-like define with backslash continuation');

  // Test 12: Function-like macro expansion with argument substitution
  const t12 = preprocess('#define DOUBLE(x) (2 * x)\nvar/a = DOUBLE(5)\n');
  assertContains(t12.out, 'var/a = (2 * 5)', 'Function-like macro argument substitution');

  // Test 13: Token pasting (##) and stringification (#)
  const t13 = preprocess('#define GLOBAL_LIST_INIT(X, V) /global/var/list/##X = V\nGLOBAL_LIST_INIT(organ, list(1, 2))\n#define GREET(x) "hello " + #x\nvar/b = GREET(world)\n');
  assertContains(t13.out, '/global/var/list/organ = list(1, 2)', '## token pasting');
  assertContains(t13.out, '"hello " + "world"', '# stringification');

  // Test 14: Variadic macro (...)
  const t14 = preprocess('#define LIST(...) list(...)\nvar/c = LIST(1, 2, 3)\n');
  assertContains(t14.out, 'var/c = list(1, 2, 3)', 'Variadic macro with ...');

  // Test 15: Recursive macro expansion is depth-guarded
  const t15 = preprocess('#define LOOP(x) LOOP(x)\nvar/d = LOOP(1)\n');
  assert(!t15.out.includes('LOOP(LOOP(LOOP(LOOP(LOOP'), 'Recursive macro expansion bounded by depth guard');

  // Test 16: Nested macro in argument
  const t16 = preprocess('#define INNER 7\n#define OUTER(x) [x]\nvar/e = OUTER(INNER)\n');
  assertContains(t16.out, 'var/e = [7]', 'Nested macro expanded inside function-like argument');

  // Test 17: Function-like macro used without parentheses is left as-is
  const t17 = preprocess('#define FOO(x) x\nvar/f = FOO\n');
  assertContains(t17.out, 'var/f = FOO', 'Function-like macro without call parens untouched');

  // Test 18: #include with backslash path separators resolves on all platforms
  const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pp_test_'));
  fs.mkdirSync(path.join(tmpDir2, 'dir'));
  fs.writeFileSync(path.join(tmpDir2, 'dir', 'core.dm'), '#define CORE 7\n');
  fs.writeFileSync(path.join(tmpDir2, 'main2.dm'), '#include "dir\\core.dm"\nvar/x = CORE\n');
  const t18 = preprocess(fs.readFileSync(path.join(tmpDir2, 'main2.dm'), 'utf-8'), path.join(tmpDir2, 'main2.dm'));
  assertContains(t18.out, 'var/x = 7', 'Backslash #include path resolved');

  // Test 19: Seed defines make cross-file macros visible
  const seeds = new Map([['GLOBAL_CONST', '42']]);
  const coll13 = new DiagnosticCollector();
  const pp13 = new DMPreprocessor(coll13, seeds);
  const t19 = pp13.process('var/y = GLOBAL_CONST\n', '/tmp/pp_test13.dm');
  assertContains(t19, 'var/y = 42', 'Seeded global defines expand in every file');

  // Test 20: Seeded function-like macros expand across files
  const fnSeeds = new Map([['GLOBAL_VAR_INIT', { params: ['X', 'V'], variadic: false, body: '/global/var/##X = V' }]]);
  const coll20 = new DiagnosticCollector();
  const pp20 = new DMPreprocessor(coll20, undefined, fnSeeds);
  const t20 = pp20.process('GLOBAL_VAR_INIT(counter, 0)\n', '/tmp/pp_test20.dm');
  assertContains(t20, '/global/var/counter = 0', 'Seeded function-like macro expands');

  fs.rmSync(tmpDir2, { recursive: true, force: true });
  console.log("\n✅ ALL PREPROCESSOR TESTS PASSED!");
}

runPreprocessorTests().catch(err => {
  console.error("Test error:", err);
  process.exit(1);
});
