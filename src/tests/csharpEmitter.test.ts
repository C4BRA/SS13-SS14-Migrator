import { DMLexer, TokenType } from '../parser/dmLexer.js';
import { DMParser } from '../parser/dmParser.js';
import { DMIRGenerator } from '../ir/dmIRGenerator.js';
import { CSharpEmitter } from '../transpiler/csharpEmitter.js';

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

function transpileProc(dmCode: string): string {
  const parser = new DMParser(new DMLexer(dmCode).tokenize());
  const nodes = parser.parse();
  assert(parser.diagnostics.errors.length === 0, `No parse errors for: ${dmCode.trim().split('\n')[1] || dmCode}`);
  const ir = new DMIRGenerator().generateIR(nodes);
  return new CSharpEmitter().generateProcsCS(ir);
}

async function runCSharpEmitterTests() {
  console.log("=== Running C# Emitter Regression Tests ===");

  // Test 1: List indexing uses the runtime helper (DMValue index)
  const idx = transpileProc(`/obj/foo/proc/run()
    var/x = stuff[1]
`);
  assertContains(idx, `DMListGet(comp.GetVar("stuff"), DMValue.FromNumber(1))`, 'Index access emits DMListGet');

  // Test 2: Index assignment uses the runtime helper
  const idxSet = transpileProc(`/obj/foo/proc/run()
    stuff[1] = 5
`);
  assertContains(idxSet, `DMListSet(comp.GetVar("stuff"), DMValue.FromNumber(1), DMValue.FromNumber(5))`, 'Index assignment emits DMListSet');

  // Test 3: Method calls carry the method name and receiver
  const mc = transpileProc(`/obj/foo/proc/run()
    var/y = target.zero()
    var/w = target.add_one(5)
`);
  assertContains(mc, `await DMCallProc(comp.GetVar("target"), "zero")`, 'Zero-arg method call (no trailing comma)');
  assertContains(mc, `await DMCallProc(comp.GetVar("target"), "add_one", DMValue.FromNumber(5))`, 'Method call with args');

  // Test 4: src/usr/args postfix chains parse and emit
  const kw = transpileProc(`/obj/foo/proc/run()
    var/y = src.zero()
    var/z = usr.mob
`);
  assertContains(kw, `await DMCallProc(DMValue.FromDatum(comp), "zero")`, 'src.method() postfix chain');
  assertContains(kw, `(DMRuntimeHelpers.CurrentUsr).AsDatum()?.GetVar("mob") ?? DMValue.Null`, 'usr property access');

  // Test 5: Proc args are stored on the component (C#-keyword-safe)
  const args = transpileProc(`/obj/foo/proc/do_work(event, object, args)
    return event
`);
  assertContains(args, `comp.SetVar("event", args.Length > 0 ? args[0] : DMValue.Null);`, 'Arg named event set on component');
  assertContains(args, `comp.SetVar("object", args.Length > 1 ? args[1] : DMValue.Null);`, 'Arg named object set on component');
  assertContains(args, `comp.SetVar("args", args.Length > 2 ? args[2] : DMValue.Null);`, 'Arg named args set on component');
  assertContains(args, `comp.GetVar("event")`, 'Body reads arg through component var');

  // Test 6: DM keyword args are not dropped
  const kwArgs = transpileProc(`/obj/foo/proc/run(args, usr)
    return args
`);
  assertContains(kwArgs, `comp.SetVar("args", args.Length > 0 ? args[0] : DMValue.Null);`, 'DM keyword arg args preserved');
  assertContains(kwArgs, `comp.SetVar("usr", args.Length > 1 ? args[1] : DMValue.Null);`, 'DM keyword arg usr preserved');

  // Test 7: List literals {1, 2, 3}
  const list = transpileProc(`/obj/foo/proc/run()
    var/x = {1, 2, 3}
`);
  assertContains(list, `DMRuntimeHelpers.MakeList(DMValue.FromNumber(1), DMValue.FromNumber(2), DMValue.FromNumber(3))`, 'Brace list literal');

  // Test 8: Range literal 1..5
  const range = transpileProc(`/obj/foo/proc/run()
    for(x in 1..5)
        x = x
`);
  assertContains(range, `DMRuntimeHelpers.MakeRange(DMValue.FromNumber(1), DMValue.FromNumber(5))`, 'Range literal 1..5 in for-in');

  // Test 9: do/while
  const dowhile = transpileProc(`/obj/foo/proc/run()
    do
        x = x + 1
    while (x < 5)
`);
  assertContains(dowhile, `do\n`, 'do/while emits do block');
  assertContains(dowhile, `} while (`, 'do/while emits while clause');

  // Test 10: C-style for(var/i = 1, i <= 5, i++)
  const cfor = transpileProc(`/obj/foo/proc/run()
    for(var/i = 1, i <= 5, i++)
        x = x + i
`);
  assertContains(cfor, `comp.SetVar("i", DMValue.FromNumber(1));`, 'C-style for init');
  assertContains(cfor, `while (DMValue.LessOrEqual(`, 'C-style for condition');

  // Test 11: rand() with no args still emits valid C#
  const rand = transpileProc(`/obj/foo/proc/run()
    var/z = rand()
    var/r = rand(1, 6)
`);
  assertContains(rand, `DMRuntimeHelpers.Rand()`, 'rand() zero-arg');
  assertContains(rand, `DMRuntimeHelpers.Rand(DMValue.FromNumber(1), DMValue.FromNumber(6))`, 'rand(a, b)');

  // Test 12: Type-level var with expression value no longer breaks parsing
  const tlv = transpileProc(`/obj/foo
    var/list/stuff = list(1, 2, 3)
    proc/run()
        return stuff
`);
  assertContains(tlv, `return comp.GetVar("stuff");`, 'Type-level list value does not break proc parsing');

  // Test 13: User proc call with zero args
  const zc = transpileProc(`/obj/foo/proc/run()
    var/y = myProc()
`);
  assertContains(zc, `await comp.CallProc("myProc")`, 'Zero-arg user proc call (no trailing comma)');

  // Test 14: spawn expression emits an async lambda (valid Func<Task>)
  const sp = transpileProc(`/obj/foo/proc/run()
    spawn(2)
        x = 1
`);
  assertContains(sp, `async () => {`, 'spawn statement emits async lambda');

  // Test 15: Lexer — range tokens and BOM handling
  const rangeTokens = new DMLexer('1..5').tokenize();
  assert(rangeTokens[0].type === TokenType.Number && rangeTokens[0].value === '1', 'Lexer: 1..5 starts with Number 1');
  assert(rangeTokens[1].type === TokenType.Operator && rangeTokens[1].value === '..', 'Lexer: 1..5 emits .. operator');
  const bomTokens = new DMLexer('\uFEFF/obj/foo').tokenize();
  assert(bomTokens[0].type === TokenType.TypePath && bomTokens[0].value === '/obj/foo', 'Lexer: UTF-8 BOM stripped');

  // Test 16: Lexer — unterminated block comment produces a diagnostic
  const badComment = new DMLexer('/obj/foo\n/* comment never closed');
  badComment.tokenize();
  assert(badComment.diagnostics.errors.length === 1, 'Lexer: unterminated block comment reported');

  // Test 17: Lexer — new operator characters and ?. null-conditional
  const opToks = new DMLexer('a % b ~ c @ d $ e ?. f').tokenize();
  for (const [value, msg] of [['%', 'Lexer: % operator'], ['~', 'Lexer: ~ operator'], ['@', 'Lexer: @ operator'], ['$', 'Lexer: $ operator']]) {
    assert(opToks.some(t => t.type === TokenType.Operator && t.value === value), msg);
  }
  assert(opToks.some(t => t.type === TokenType.Operator && t.value === '?.'), 'Lexer: ?. null-conditional operator');

  // Test 18: Lexer — backslash line continuation is skipped
  const cont = new DMLexer('/obj/foo\n    var/x = 1 + \\\n        2\n').tokenize();
  assert(!cont.some(t => t.value === '\\'), 'Lexer: backslash continuation produces no token');

  // Test 19: Implicit return variable '.' parses and assigns
  const dot = transpileProc(`/obj/foo/proc/run()
    . = 5
    return
`);
  assertContains(dot, `comp.SetVar(".", DMValue.FromNumber(5));`, 'Implicit . assignment');
  assertContains(dot, `return comp.GetVar(".");`, 'Bare return returns implicit .');

  // Test 20: Parent call ..() parses
  const paren = transpileProc(`/obj/foo/proc/run()
    ..(5)
    return ..()
`);
  assertContains(paren, `await comp.CallProc("..", DMValue.FromNumber(5))`, 'Parent call with args');
  assertContains(paren, `await comp.CallProc("..")`, 'Parent call zero-arg');

  // Test 21: Modulo / bitwise ops parse
  const mod = transpileProc(`/obj/foo/proc/run()
    var/x = a % 2
    var/y = a & b
    var/z = ~a
`);
  assertContains(mod, `DMValue.Modulo(`, 'Modulo binary op');
  assertContains(mod, `comp.SetVar("y", DMValue.Null)`, 'Bitwise & parses (runtime stub)');

  // Test 22: 'to' range in for(var/i = 1 to 5) and in switch cases
  const to = transpileProc(`/obj/foo/proc/run()
    for(var/i = 1 to 5)
        x = i
    switch (y)
        if (1 to 5)
            x = 1
`);
  assertContains(to, `MakeRange(DMValue.FromNumber(1), DMValue.FromNumber(5))`, 'for(var/i = 1 to 5) emits MakeRange');
  assertContains(to, `MakeRange(`, 'switch case range 1 to 5');

  // Test 23: for (var/x as anything in list) type filter clause
  const asClause = transpileProc(`/obj/foo/proc/run()
    for (var/datum/x as anything in stuff)
        x = x
`);
  assertContains(asClause, `foreach (var __dmIter in DMListItems(comp.GetVar("stuff")))`, 'for-in with as filter clause');

  // Test 24: istype/locate keyword calls parse
  const istype = transpileProc(`/obj/foo/proc/run()
    if (istype(x, /turf))
        x = locate(x)
`);
  assertContains(istype, `DMIsType(comp.GetVar("x"), DMValue.FromString("/turf"))`, 'istype() keyword call');
  assertContains(istype, `DMLocate(comp.GetVar("x"))`, 'locate() keyword call');

  // Test 25: null-conditional ?. property access parses
  const ncl = transpileProc(`/obj/foo/proc/run()
    var/y = C.dna?.species
`);
  assertContains(ncl, `GetVar("species")`, '?. null-conditional property access');

  // Test 26: 'in' as expression operator
  const inOp = transpileProc(`/obj/foo/proc/run()
    if (5 in stuff)
        x = 1
`);
  assertContains(inOp, `DMValue.In(DMValue.FromNumber(5), comp.GetVar("stuff"))`, 'in expression operator');

  console.log("\n✅ ALL C# EMITTER REGRESSION TESTS PASSED!");
}

runCSharpEmitterTests().catch(err => {
  console.error("Test error:", err);
  process.exit(1);
});
