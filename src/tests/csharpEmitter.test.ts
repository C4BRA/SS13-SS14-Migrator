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
  return new CSharpEmitter().generateProcsCS(ir, parser.globalVars);
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
  assertContains(kw, `DMRuntimeHelpers.DMGetProperty(DMRuntimeHelpers.CurrentUsr, "mob")`, 'usr property access');

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
  assertContains(cfor, `while (true)`, 'C-style for wrapper');
  assertContains(cfor, `if (!(DMValue.LessOrEqual(`, 'C-style for condition tested at top');

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
  assertContains(paren, `await comp.CallParentProc("run", DMValue.FromNumber(5))`, 'Parent call with args');
  assertContains(paren, `await comp.CallParentProc("run")`, 'Parent call zero-arg');

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
  assertContains(asClause, `foreach (var __dmIter1 in DMListItems(comp.GetVar("stuff")))`, 'for-in with as filter clause');

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
  assertContains(ncl, `DMGetProperty(comp.GetVar("C"), "dna")`, '?. null-conditional property access');

  // Test 26: 'in' as expression operator
  const inOp = transpileProc(`/obj/foo/proc/run()
    if (5 in stuff)
        x = 1
`);
  assertContains(inOp, `DMValue.In(DMValue.FromNumber(5), comp.GetVar("stuff"))`, 'in expression operator');

  // Test 27: GLOB.x reads resolve through the GlobalVars registry
  const globRead = transpileProc(`/global/var/counter = 5
/datum/probe/proc/run()
    return GLOB.counter
`);
  assertContains(globRead, `(await GlobalVars.Get("counter"))`, 'GLOB.x read emits GlobalVars.Get');
  assertContains(globRead, `public static class GlobalVars`, 'GlobalVars registry class emitted');
  assertContains(globRead, `Vars["counter"] = DMValue.FromNumber(5);`, 'Global default value materialized');

  // Test 28: GLOB.x writes resolve through the GlobalVars registry
  const globWrite = transpileProc(`/global/var/counter = 0
/datum/probe/proc/run()
    GLOB.counter = 42
    return GLOB.counter
`);
  assertContains(globWrite, `(await GlobalVars.Set("counter", DMValue.FromNumber(42)))`, 'GLOB.x = v emits GlobalVars.Set');

  // Test 29: Global initializers with new/compound expressions
  const globInit = transpileProc(`/global/var/obj = new /datum/probe2()
/datum/probe/proc/run()
    return GLOB.obj
`);
  assertContains(globInit, `Vars["obj"] = (await DMNew(null, "/datum/probe2"));`, 'Global init with new uses null datum');

  // Test 30: Global referencing another global in its initializer
  const globRef = transpileProc(`/global/var/a = 2
/global/var/b = GLOB.a + 3
/datum/probe/proc/run()
    return GLOB.b
`);
  assertContains(globRef, `Vars["b"] = DMValue.Add((await GlobalVars.Get("a")), DMValue.FromNumber(3));`, 'Global init reads earlier global');

  // Test 31: Plan 01 pure-function builtins emit runtime helper calls
  const pure = transpileProc(`/datum/probe/proc/run()
    var/a = floor(3.7)
    var/b = ceil(3.2)
    var/c = sqrt(16)
    var/d = sin(30)
    var/e = cos(60)
    var/f = sign(-5)
    var/g = copytext_char("hello", 2, 4)
    var/h = length_char("hello")
    var/i = text2ascii("A")
    var/j = ckey("My_Thing #2!")
    var/k = sorttext("b", "A")
    var/l = replacetextEx("aXbX", "X", "c")
    var/m = html_encode("<b>")
    var/n = rgb2num(255, 128, 0)
    var/o = json_encode(list(1, "two"))
    var/p = time2text(1000, "hh:mm:ss")
    var/q = list2params(list(1, 2))
    var/r = arglist(list(1, 2))
`);
  assertContains(pure, `DMRuntimeHelpers.Floor(DMValue.FromNumber(3.7))`, 'floor mapping');
  assertContains(pure, `DMRuntimeHelpers.Ceil(DMValue.FromNumber(3.2))`, 'ceil mapping');
  assertContains(pure, `DMRuntimeHelpers.Sqrt(DMValue.FromNumber(16))`, 'sqrt mapping');
  assertContains(pure, `DMRuntimeHelpers.Sin(DMValue.FromNumber(30))`, 'sin mapping');
  assertContains(pure, `DMRuntimeHelpers.Cos(DMValue.FromNumber(60))`, 'cos mapping');
  assertContains(pure, `DMRuntimeHelpers.Sign(DMValue.Negate(DMValue.FromNumber(5)))`, 'sign mapping');
  assertContains(pure, `DMRuntimeHelpers.CopyTextChar(DMValue.FromString("hello"), DMValue.FromNumber(2), DMValue.FromNumber(4))`, 'copytext_char mapping');
  assertContains(pure, `DMRuntimeHelpers.LengthChar(DMValue.FromString("hello"))`, 'length_char mapping');
  assertContains(pure, `DMRuntimeHelpers.Text2Ascii(DMValue.FromString("A"))`, 'text2ascii mapping');
  assertContains(pure, `DMRuntimeHelpers.CKey(DMValue.FromString("My_Thing #2!"))`, 'ckey mapping');
  assertContains(pure, `DMRuntimeHelpers.SortText(DMValue.FromString("b"), DMValue.FromString("A"))`, 'sorttext mapping');
  assertContains(pure, `DMRuntimeHelpers.ReplaceTextEx(DMValue.FromString("aXbX"), DMValue.FromString("X"), DMValue.FromString("c"))`, 'replacetextEx mapping');
  assertContains(pure, `DMRuntimeHelpers.HtmlEncode(DMValue.FromString("<b>"))`, 'html_encode mapping');
  assertContains(pure, `DMRuntimeHelpers.RGB2Num(DMValue.FromNumber(255), DMValue.FromNumber(128), DMValue.FromNumber(0))`, 'rgb2num mapping');
  assertContains(pure, `DMRuntimeHelpers.JsonEncode(`, 'json_encode mapping');
  assertContains(pure, `DMRuntimeHelpers.Time2Text(DMValue.FromNumber(1000), DMValue.FromString("hh:mm:ss"))`, 'time2text mapping');
  assertContains(pure, `DMRuntimeHelpers.List2Params(`, 'list2params mapping');
  assertContains(pure, `DMRuntimeHelpers.DMArgList(`, 'arglist mapping');

  // Test 32: Plan 01 file-ops builtins emit runtime helper calls
  const files = transpileProc(`/datum/probe/proc/run()
    var/a = file("data/save.sav")
    var/b = isfile(a)
    var/c = fdel(a)
    var/d = fcopy("src.txt", "dst.txt")
    var/e = fcopy_rsc("icon.dmi", "copy.dmi")
    var/f = flist("data")
    var/g = ref(src)
    var/h = refcount(src)
    var/i = SpacemanDMM_unlint("x")
`);
  assertContains(files, `DMRuntimeHelpers.File(DMValue.FromString("data/save.sav"))`, 'file mapping');
  assertContains(files, `DMRuntimeHelpers.IsFile(`, 'isfile mapping');
  assertContains(files, `DMRuntimeHelpers.FileDel(`, 'fdel mapping');
  assertContains(files, `DMRuntimeHelpers.FileCopy(DMValue.FromString("src.txt"), DMValue.FromString("dst.txt"))`, 'fcopy mapping');
  assertContains(files, `DMRuntimeHelpers.FileCopyRsc(`, 'fcopy_rsc mapping');
  assertContains(files, `DMRuntimeHelpers.FList(DMValue.FromString("data"))`, 'flist mapping');
  assertContains(files, `DMRuntimeHelpers.Ref(`, 'ref mapping');
  assertContains(files, `DMRuntimeHelpers.RefCount(`, 'refcount mapping');
  assertContains(files, `DMRuntimeHelpers.SpacemanUnlint(`, 'SpacemanDMM_unlint mapping');

  // Test 33: Plan 01 movement builtins emit runtime helper calls
  const move = transpileProc(`/datum/probe/proc/run()
    var/a = step(src, 1)
    var/b = step_towards(src, src)
    var/c = step_away(src, src)
    var/d = get_step_away(src, src)
    var/e = get_step_towards(src, src)
    var/f = orange(2, src)
    var/g = viewers(2, src)
    var/h = hearers(src)
`);
  assertContains(move, `DMRuntimeHelpers.Step(`, 'step mapping');
  assertContains(move, `DMRuntimeHelpers.StepTowards(`, 'step_towards mapping');
  assertContains(move, `DMRuntimeHelpers.StepAway(`, 'step_away mapping');
  assertContains(move, `DMRuntimeHelpers.GetStepAway(`, 'get_step_away mapping');
  assertContains(move, `DMRuntimeHelpers.GetStepTowards(`, 'get_step_towards mapping');
  assertContains(move, `DMRuntimeHelpers.Orange(DMValue.FromNumber(2), `, 'orange mapping');
  assertContains(move, `DMRuntimeHelpers.Viewers(DMValue.FromNumber(2), `, 'viewers mapping');
  assertContains(move, `DMRuntimeHelpers.Hearers(DMValue.FromDatum(comp))`, 'hearers mapping');

  // Test 34: Plan 09 B1 — DM precedence: ?: binds looser than == (x == b ? c : d)
  const prec = transpileProc(`/obj/foo/proc/run()
    var/x = a == b ? c : d
    var/y = m || n && o
    var/z = p + q << 2
`);
  assertContains(prec, `DMValue.Equals(comp.GetVar("a"), comp.GetVar("b")).IsTrue() ? comp.GetVar("c") : comp.GetVar("d")`, 'ternary binds looser than ==');
  assertContains(prec, `(comp.GetVar("m")) is var __dm_t1 && !__dm_t1.IsTrue()`, '|| binds looser than &&');
  assertContains(prec, `DMValue.Output(DMValue.Add(comp.GetVar("p"), comp.GetVar("q")), DMValue.FromNumber(2))`, 'shift binds looser than +');

  // Test 35: Plan 09 B1 — a/b is division by a variable (not a type-path literal)
  const div = transpileProc(`/obj/foo/proc/run()
    var/x = a/b
    var/y = a/b/c
`);
  assertContains(div, `DMValue.Divide(comp.GetVar("a"), comp.GetVar("b"))`, 'a/b divides by variable b');
  assertContains(div, `DMValue.Divide(DMValue.Divide(comp.GetVar("a"), comp.GetVar("b")), comp.GetVar("c"))`, 'a/b/c chains divisions');

  // Test 36: Plan 09 B1 — single-line bodies (if/while/for) are not dropped
  const oneLine = transpileProc(`/obj/foo/proc/run()
    if (x) return 5
    if (y) return 6 else return 7
    while (x) x = x + 1
    for(z in list) z = z + 1
`);
  assertContains(oneLine, `if (comp.GetVar("x").IsTrue())\n            {\n                return DMValue.FromNumber(5);`, 'single-line if body');
  assertContains(oneLine, `else\n            {\n                return DMValue.FromNumber(7);`, 'single-line else body');
  assertContains(oneLine, `while (comp.GetVar("x").IsTrue())\n            {\n                {\n                    comp.SetVar("x", DMValue.Add(comp.GetVar("x"), DMValue.FromNumber(1)));`, 'single-line while body');
  assertContains(oneLine, `comp.SetVar("z", DMValue.Add(comp.GetVar("z"), DMValue.FromNumber(1)));`, 'single-line for-in body');

  // Test 37: Plan 09 B1 — associative list literals list("a" = 1)
  const assoc = transpileProc(`/obj/foo/proc/run()
    var/l = list("a" = 1, "b" = 2)
`);
  assertContains(assoc, `DMRuntimeHelpers.MakeListAssoc(DMValue.FromString("a"), DMValue.FromNumber(1), DMValue.FromString("b"), DMValue.FromNumber(2))`, 'assoc list literal');

  // Test 38: Plan 09 B1 — leading-slash-less declarations (mob/verb/say)
  const decl = transpileProc(`/mob/verb/say(msg)
    return msg
`);
  assertContains(decl, `ProcRegistry.Register("/mob", "say", Proc_Mob_Say);`, 'mob/verb/say registers under /mob');

  // Test 39: Plan 09 B1 — in-clause proc args are not phantom parameters
  const inClause = transpileProc(`/obj/foo/proc/find_thing(atom/target as mob in oview(1), flag = 0)
    return target
`);
  assertContains(inClause, `comp.SetVar("target", args.Length > 0 ? args[0] : DMValue.Null);`, 'in-clause arg is a real parameter');
  assertContains(inClause, `comp.SetVar("flag", args.Length > 1 ? args[1] : DMValue.Null);`, 'second arg still positional');
  assert(!inClause.includes('args.Length > 2'), 'no phantom parameter from in-clause');

  // Test 40: Plan 09 B1 — string interpolation [expr] transpiles to concatenation
  const interp = transpileProc(`/obj/foo/proc/run()
    var/a = "hello [usr] world"
    var/b = "a [5 + 1] c"
`);
  assertContains(interp, `DMRuntimeHelpers.CurrentUsr`, 'interpolated usr reads the variable');
  assertContains(interp, `DMValue.Add(DMValue.Add(DMValue.Add(DMValue.FromString(""), DMValue.FromString("hello ")), DMRuntimeHelpers.CurrentUsr), DMValue.FromString(" world"))`, 'interpolation concatenates parts');

  // Test 41: Plan 09 B2 — switch emits a terminating break (no infinite
  // loop) and single-evaluates the switch value; continue in a case with no
  // enclosing loop exits the switch.
  const sw = transpileProc(`/obj/foo/proc/run()
    switch (x)
      if (1)
        doThing()
      if (2)
        continue
      else
        doOther()
`);
  assertContains(sw, `while (true)\n            {\n                if (DMValue.In(comp.GetVar("x"), DMValue.FromNumber(1)).IsTrue())`, 'switch wrapper + first case');
  assertContains(sw, `else if (DMValue.In(comp.GetVar("x"), DMValue.FromNumber(2)).IsTrue())\n                {\n                    break;\n                }`, 'continue in case (no loop) exits the switch');
  assertContains(sw, `                }\n                break;\n            }\n            return comp.GetVar(".");`, 'terminating break after the case chain');
  assert((sw.match(/DMValue\.In\(comp\.GetVar\("x"\),/g) || []).length === 2, 'switch value single-evaluated (reused in each case cond)');

  // Test 42: Plan 09 B2 — continue in a C-style for still runs the increment
  const cforCont = transpileProc(`/obj/foo/proc/run()
    for (var/i = 0, i < 5, i++)
      if (i == 2)
        continue
      dothings()
`);
  assertContains(cforCont, `while (true)\n                {\n                    if (!(DMValue.LessThan(comp.GetVar("i"), DMValue.FromNumber(5))).IsTrue()) break;`, 'C-for condition tested at loop top');
  assertContains(cforCont, `goto __dmForCont0;`, 'continue in C-for jumps to the increment label');
  assertContains(cforCont, `__dmForCont0:\n                    comp.SetVar("i", comp.SetVar("i", DMValue.Add(comp.GetVar("i"), DMValue.FromNumber(1))));`, 'increment behind the continue label');
  assert(!cforCont.includes('continue;'), 'no plain continue emitted inside the C-for');

  // Test 43: Plan 09 B2 — continue inside a switch inside a C-for targets
  // the for (runs the increment), not the switch wrapper
  const swfor = transpileProc(`/obj/foo/proc/run()
    for (var/i = 0, i < 5, i++)
      switch (i)
        if (1)
          continue
      dodone()
`);
  assertContains(swfor, `goto __dmForCont0;`, 'continue in switch-in-for jumps to the for increment');
  assert(!swfor.includes('continue;'), 'no plain continue emitted inside the switch-in-for');

  // Test 44: Plan 09 B2 — pathToClassName collisions get a numeric suffix
  const col = transpileProc(`/obj/item/foo/proc/a()
    return
/obj/ItemFoo/proc/b()
    return
`);
  assertContains(col, 'ObjItemFoo_2', 'second colliding class name gets a suffix');
  assert((col.match(/public static async Task<DMValue> Proc_ObjItemFoo_\w+\(DMRuntime/g) || []).length === 2, 'both colliding paths emit distinct static methods');
  assertContains(col, 'Proc_ObjItemFoo_2_B(', 'suffixed method for the second path (/obj/ItemFoo)');
  assertContains(col, 'Proc_ObjItemFoo_A(', 'unsuffixed method for /obj/item/foo');

  console.log("\n✅ ALL C# EMITTER REGRESSION TESTS PASSED!");
}

runCSharpEmitterTests().catch(err => {
  console.error("Test error:", err);
  process.exit(1);
});
