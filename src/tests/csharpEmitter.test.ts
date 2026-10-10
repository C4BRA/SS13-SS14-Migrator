import { DMLexer, TokenType } from '../parser/dmLexer.js';
import { DMParser } from '../parser/dmParser.js';
import { DMIRGenerator } from '../ir/dmIRGenerator.js';
import { SymbolTable } from '../ir/symbolTable.js';
import { CSharpEmitter } from '../transpiler/csharpEmitter.js';

// Emission-shape regression tests. Behaviour is verified end-to-end by the
// semantic probes (fidelityDifferential.test.ts); these pin the lowering
// guarantees that make that behaviour possible.

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ TEST FAILED: ${message}`);
    process.exit(1);
  } else {
    console.log(`✅ ${message}`);
  }
}

function assertContains(haystack: string, needle: string | RegExp, message: string) {
  const ok = typeof needle === 'string' ? haystack.includes(needle) : needle.test(haystack);
  if (!ok) {
    console.error(`❌ TEST FAILED: ${message}`);
    console.error(`  Expected to contain: ${needle}`);
    console.error(`  Actual:\n${haystack.slice(haystack.indexOf('public static async Task<DMValue> P_'))}`);
    process.exit(1);
  } else {
    console.log(`✅ ${message}`);
  }
}

function transpile(dmCode: string): string {
  const parser = new DMParser(new DMLexer(dmCode).tokenize());
  const nodes = parser.parse();
  assert(parser.diagnostics.errors.length === 0, `No parse errors for: ${dmCode.trim().split('\n')[1] || dmCode}`);
  const symbols = new SymbolTable();
  symbols.addTypeDecls(nodes);
  const ir = new DMIRGenerator().generateIR(nodes);
  return new CSharpEmitter().generateProcsCS(ir, parser.globalVars, symbols);
}

/** Proc body text only (registrations and runtime scaffolding stripped). */
function body(cs: string): string {
  const start = cs.indexOf('public static async Task<DMValue> P_');
  const end = cs.indexOf('public static class ConvertedDMInits');
  return cs.slice(start, end);
}

async function runCSharpEmitterTests() {
  console.log("=== Running C# Emitter Regression Tests ===");

  // Locals and args are C# locals, never datum vars.
  const locals = transpile(`/obj/foo
    var/stuff
/obj/foo/proc/run(event, object)
    var/x = stuff[1]
    return event
`);
  assertContains(body(locals), /DMValue l_event_\d+ = args\.Length > 0 \? args\[0\] : DMValue\.Null;/, 'arg bound to a C# local (keyword-safe name)');
  assertContains(body(locals), /DMValue l_object_\d+ = args\.Length > 1 \? args\[1\] : DMValue\.Null;/, 'second arg bound by position');
  assertContains(body(locals), /DMValue l_x_\d+ = DMListGet\(comp\.GetVar\("stuff"\), DMValue\.FromNumber\(1d\)\);/, 'local declared as C# local; src var read via comp');
  assertContains(body(locals), /return l_event_\d+;/, 'arg read as a local');
  assert(!/comp\.SetVar\("(x|event|object)"/.test(locals), 'no local or arg is ever stored on the datum');

  // Default arguments apply when omitted or null.
  const defaults = transpile(`/obj/foo/proc/f(flag = 3)
    return flag
`);
  assertContains(body(defaults), /if \(l_flag_\d+\.IsNull\) l_flag_\d+ = DMValue\.FromNumber\(3d\);/, 'default arg applied on null');

  // . is a local; bare return returns it.
  const dot = transpile(`/obj/foo/proc/run()
    . = 5
    return
`);
  assertContains(body(dot), '__dot = DMValue.FromNumber(5d);', '. assignment writes the frame local');
  assertContains(body(dot), 'return __dot;', 'bare return returns .');

  // Method calls and src calls.
  const mc = transpile(`/obj/foo
    var/target
/obj/foo/proc/run()
    var/y = target.zero()
    var/w = target.add_one(5)
    var/z = src.zero()
    var/u = usr.mob
`);
  assertContains(mc, 'await DMCallProc(comp.GetVar("target"), "zero")', 'zero-arg method call');
  assertContains(mc, 'await DMCallProc(comp.GetVar("target"), "add_one", DMValue.FromNumber(5d))', 'method call with args');
  assertContains(mc, 'await comp.CallProc("zero")', 'src.method() dispatches on comp');
  assertContains(mc, 'DMRuntimeHelpers.DMGetProperty(DMRuntimeHelpers.CurrentUsr, "mob")', 'usr property access');

  // ..() names its owner and definition index; with no args it forwards the current arg values.
  const paren = transpile(`/obj/foo/proc/run(a)
    ..(5)
    return ..()
`);
  assertContains(paren, 'await comp.CallParentProc("/obj/foo", 0, "run", DMValue.FromNumber(5d))', 'parent call with explicit args');
  assertContains(paren, /await comp\.CallParentProc\("\/obj\/foo", 0, "run", DMOps\.ParentArgs\(args, l_a_\d+\)\)/, 'parent call forwards current arg values');

  // A proc defined twice on one type registers two definitions; the second's ..() reaches the first.
  const twice = transpile(`/obj/foo/proc/v()
    return 1
/obj/foo/v()
    return ..() + 1
`);
  assert((twice.match(/ProcRegistry\.Register\("\/obj\/foo", "v"/g) || []).length === 2, 'both definitions registered in order');
  assertContains(twice, 'CallParentProc("/obj/foo", 1, "v"', 'second definition calls ..() with index 1');

  // Type defaults: constants at registration, everything else per instance.
  const defs = transpile(`/obj/foo
    var/n = 5 * 2
    var/list/L = list(1, 2)
    icon = 'icons/x.dmi'
    name = "thing"
`);
  assertContains(defs, 'DMTypes.DefineVar("/obj/foo", "n", DMValue.Multiply(DMValue.FromNumber(5d), DMValue.FromNumber(2d)));', 'constant expression folded at registration');
  assertContains(defs, 'DMTypes.DefineVar("/obj/foo", "icon", DMValue.FromFile("icons/x.dmi"));', 'file literal default');
  assertContains(defs, 'DMTypes.DefineVar("/obj/foo", "name", DMValue.FromString("thing"));', 'string default');
  assertContains(defs, /DMTypes\.DefineVarInit\("\/obj\/foo", "L", ConvertedDMInits\.I_ObjFoo_L_\d+\);/, 'list initializer runs per instance');

  // Compound assignment on lists mutates in place; plain + copies.
  const comp = transpile(`/obj/foo/proc/run()
    var/L = list()
    L += 1
    L -= 1
    L |= 2
    L = L + 3
`);
  assertContains(body(comp), /l_L_\d+ = DMOps\.AddAssign\(l_L_\d+, DMValue\.FromNumber\(1d\)\);/, '+= lowers to in-place AddAssign');
  assertContains(body(comp), /DMOps\.RemoveAssign\(/, '-= lowers to RemoveAssign');
  assertContains(body(comp), /DMOps\.CombineAssign\(/, '|= lowers to CombineAssign');
  assertContains(body(comp), /l_L_\d+ = DMValue\.Add\(l_L_\d+, DMValue\.FromNumber\(3d\)\);/, 'a = a + x copies via Add');

  // Postfix increment evaluates to the old value.
  const post = transpile(`/obj/foo/proc/run()
    var/x = 1
    var/y = x++
`);
  assertContains(body(post), /DMOps\.Post\(l_x_\d+, \(l_x_\d+ = DMValue\.Add\(l_x_\d+, DMValue\.FromNumber\(1d\)\)\)\)/, 'x++ yields the old value');

  // Interpolation stringifies each part (no + concatenation).
  const interp = transpile(`/obj/foo/proc/run()
    var/a = "hello [usr] world"
`);
  assertContains(interp, 'DMText.Interp(DMValue.FromString("hello "), DMRuntimeHelpers.CurrentUsr, DMValue.FromString(" world"))', 'interpolation lowers to DMText.Interp');

  // spawn captures copies of the locals and never runs on the thread pool.
  const sp = transpile(`/obj/foo/proc/run()
    var/x = 1
    spawn(2)
        x = 2
`);
  assertContains(body(sp), /var c_x_\d+ = l_x_\d+;/, 'spawn snapshots each local');
  assertContains(body(sp), 'DMTickScheduler.Spawn(DMValue.FromNumber(2d), async () =>', 'spawn schedules on the DM scheduler');
  assertContains(body(sp), /c_x_\d+ = DMValue\.FromNumber\(2d\)/, 'spawn body writes its copy');
  assert(!sp.includes('Task.Run'), 'no thread-pool work');

  // Named arguments bind by parameter name at the callee.
  const named = transpile(`/obj/foo/proc/f(a, b)
    return a
/obj/foo/proc/run()
    return f(1, b = 2)
`);
  assertContains(named, 'DMOps.NamedArgs(new DMValue[] { DMValue.FromNumber(1d) }, ("b", DMValue.FromNumber(2d)))', 'named args packed for the callee');

  // waitfor = 0 is a registration attribute.
  const wf = transpile(`/obj/foo/proc/bg()
    set waitfor = 0
    sleep(1)
`);
  assertContains(wf, /ProcRegistry\.Register\("\/obj\/foo", "bg", P_ObjFoo_Bg, null, false\);/, 'set waitfor = 0 registers WaitFor=false');
  assertContains(body(wf), 'await DMTickScheduler.Sleep(DMValue.FromNumber(1d));', 'sleep awaits the scheduler');

  // Proc statics live in the global store, initialized at boot.
  const st = transpile(`/obj/foo/proc/count()
    var/static/n = 0
    n++
    return n
`);
  assertContains(st, 'Vars["/obj/foo/proc/count/n"] = DMValue.FromNumber(0d);', 'proc static initialized with the globals');
  assertContains(body(st), 'GlobalVars.Get("/obj/foo/proc/count/n")', 'proc static read from the global store');

  // Globals: bare names resolve local > src var > global; global. prefix.
  const glob = transpile(`/var/global/counter = 5
/datum/probe
    var/mine = 1
/datum/probe/proc/run()
    return counter + mine + global.counter
`);
  assertContains(glob, 'Vars["counter"] = DMValue.FromNumber(5d);', 'global default materialized');
  assertContains(body(glob), 'DMValue.Add(DMValue.Add(GlobalVars.Get("counter"), comp.GetVar("mine")), GlobalVars.Get("counter"))', 'global vs src var resolution');

  // Implicit new uses the declared type; new with a type expression.
  const nw = transpile(`/obj/item
/obj/foo/proc/run()
    var/obj/item/I = new(src)
    var/t = /obj/item
    var/x = new t(src)
`);
  assertContains(body(nw), 'await DMNew(null, "/obj/item", DMValue.FromDatum(comp))', 'implicit new creates the declared type');
  assertContains(body(nw), /await DMNewValue\(l_t_\d+, DMValue\.FromDatum\(comp\)\)/, 'new with a runtime type value');

  // Operators.
  const ops = transpile(`/obj/foo
    var/a
    var/b
/obj/foo/proc/run()
    var/x = a == b ? 1 : 2
    var/y = a in b
    var/z = a ~= b
    var/w = a << 2
`);
  assertContains(body(ops), '(DMValue.Equals(comp.GetVar("a"), comp.GetVar("b")).IsTrue() ? DMValue.FromNumber(1d) : DMValue.FromNumber(2d))', 'ternary binds looser than ==');
  assertContains(body(ops), 'DMValue.InList(comp.GetVar("a"), comp.GetVar("b"))', 'in lowers to InList');
  assertContains(body(ops), 'DMValue.Equivalent(', '~= lowers to Equivalent');
  assertContains(body(ops), 'DMOps.ShiftOrOutput(', '<< decides shift vs output at runtime');

  // a/b is division by a variable (not a type-path literal).
  const div = transpile(`/obj/foo
    var/a
    var/b
    var/c
/obj/foo/proc/run()
    var/x = a/b/c
`);
  assertContains(body(div), 'DMValue.Divide(DMValue.Divide(comp.GetVar("a"), comp.GetVar("b")), comp.GetVar("c"))', 'a/b/c chains divisions');

  // Switch: single-evaluated value, == per case, ranges.
  const sw = transpile(`/obj/foo/proc/run(x)
    switch (x)
      if (1, 2)
        return 1
      if (3 to 5)
        return 2
      else
        return 3
`);
  assertContains(body(sw), /if \(__dm_t\d+\.Equals\(DMValue\.FromNumber\(1d\)\) \|\| __dm_t\d+\.Equals\(DMValue\.FromNumber\(2d\)\)\)/, 'switch case compares with ==');
  assertContains(body(sw), /DMValue\.InRange\(__dm_t\d+, DMValue\.FromNumber\(3d\), DMValue\.FromNumber\(5d\)\)/, 'switch range case');

  // C-style for: continue runs the increment.
  const cfor = transpile(`/obj/foo/proc/run()
    for (var/i = 0, i < 5, i++)
      if (i == 2)
        continue
      world << i
`);
  assertContains(body(cfor), /goto __dmForCont\d+;/, 'continue jumps to the increment label');
  assert(!body(cfor).includes('continue;'), 'no plain continue inside the C-for');

  // for (var/T/x in L) filters by type and binds a fresh local.
  const forin = transpile(`/mob/foo
/obj/foo
    var/stuff
/obj/foo/proc/run()
    for (var/mob/foo/M in stuff)
        world << M
`);
  assertContains(body(forin), /foreach \(var __dmIter\d+ in DMListItems\(comp\.GetVar\("stuff"\)\)\)/, 'for-in iterates a snapshot');
  assertContains(body(forin), 'if (!DMIsType(', 'for-in filters by the declared type');

  // Builtins map to runtime helpers; user procs shadow same-named builtins.
  const pure = transpile(`/proc/stack_trace(msg)
    return 1
/datum/probe/proc/run()
    var/a = floor(3.7)
    var/b = rgb2num(255, 128, 0)
    var/c = istype(src, /turf)
    var/d = stack_trace("x")
`);
  assertContains(pure, 'DMRuntimeHelpers.Floor(DMValue.FromNumber(3.7d))', 'floor mapping');
  assertContains(pure, 'DMRuntimeHelpers.RGB2Num(DMValue.FromNumber(255d), DMValue.FromNumber(128d), DMValue.FromNumber(0d))', 'rgb2num mapping');
  assertContains(pure, 'DMIsType(DMValue.FromDatum(comp), DMValue.FromPath("/turf"))', 'istype with a path');
  assertContains(pure, 'await DMCallGlobal("stack_trace", DMValue.FromString("x"))', 'user-defined stack_trace shadows the builtin table');

  // Leading-slash-less declarations (mob/verb/say).
  const decl = transpile(`/mob/verb/say(msg)
    return msg
`);
  assertContains(decl, 'ProcRegistry.Register("/mob", "say", P_Mob_Say, new[] { "msg" }, true);', 'mob/verb/say registers under /mob');

  // in-clause proc args are not phantom parameters.
  const inClause = transpile(`/obj/foo/proc/find_thing(atom/target as mob in oview(1), flag = 0)
    return target
`);
  assertContains(body(inClause), /DMValue l_target_\d+ = args\.Length > 0/, 'in-clause arg is a real parameter');
  assertContains(body(inClause), /if \(l_flag_\d+\.IsNull\) l_flag_\d+ = DMValue\.FromNumber\(0d\);/, 'second arg keeps its default');
  assert(!inClause.includes('args.Length > 2'), 'no phantom parameter from in-clause');

  // Class-name collisions get a numeric suffix.
  const col = transpile(`/obj/item/a.b/proc/a()
    return
/obj/item/ab/proc/b()
    return
`);
  assertContains(col, 'P_ObjItemAb_A(', 'first colliding path keeps the base name');
  assertContains(col, 'P_ObjItemAb_2_B(', 'second colliding path gets a suffix');

  // Lexer regressions.
  const rangeTokens = new DMLexer('1..5').tokenize();
  assert(rangeTokens[0].type === TokenType.Number && rangeTokens[0].value === '1', 'Lexer: 1..5 starts with Number 1');
  assert(rangeTokens[1].type === TokenType.Operator && rangeTokens[1].value === '..', 'Lexer: 1..5 emits .. operator');
  const bomTokens = new DMLexer('\uFEFF/obj/foo').tokenize();
  assert(bomTokens[0].type === TokenType.TypePath && bomTokens[0].value === '/obj/foo', 'Lexer: UTF-8 BOM stripped');
  const badComment = new DMLexer('/obj/foo\n/* comment never closed');
  badComment.tokenize();
  assert(badComment.diagnostics.errors.length === 1, 'Lexer: unterminated block comment reported');
  const opToks = new DMLexer('a % b ~ c @ d $ e ?. f').tokenize();
  for (const [value, msg] of [['%', 'Lexer: % operator'], ['~', 'Lexer: ~ operator'], ['@', 'Lexer: @ operator'], ['$', 'Lexer: $ operator']]) {
    assert(opToks.some(t => t.type === TokenType.Operator && t.value === value), msg);
  }
  assert(opToks.some(t => t.type === TokenType.Operator && t.value === '?.'), 'Lexer: ?. null-conditional operator');
  const cont = new DMLexer('/obj/foo\n    var/x = 1 + \\\n        2\n').tokenize();
  assert(!cont.some(t => t.value === '\\'), 'Lexer: backslash continuation produces no token');

  console.log("\n✅ ALL C# EMITTER REGRESSION TESTS PASSED!");
}

runCSharpEmitterTests().catch(err => {
  console.error("Test error:", err);
  process.exit(1);
});
