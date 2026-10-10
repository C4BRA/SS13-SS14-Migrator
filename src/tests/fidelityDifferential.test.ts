// Semantic differential probes: each small DM program has a KNOWN BYOND
// result. It is converted through the real pipeline (preprocessor -> parser ->
// IR -> C# emitter), compiled against the engine-free runtime and RUN on the
// deterministic scheduler with a virtual clock.
//
// Expected values are BYOND behaviour, cross-checked against OpenDream's
// runtime (DreamValue, DMOpcodeHandlers, DreamProcNativeRoot) where the
// reference is ambiguous. `ERROR` means BYOND raises a runtime error.
// Probes must be valid DM (declared vars, existing types).
//
// All probes build into ONE project (one namespace each) and run in one
// process, resetting the runtime between probes.
//
// Run with: npm run audit:semantics   (requires dotnet)

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { DMPreprocessor } from '../preprocessor.js';
import { DMLexer } from '../parser/dmLexer.js';
import { DMParser } from '../parser/dmParser.js';
import { DiagnosticCollector } from '../diagnostics.js';
import { DMIRGenerator } from '../ir/dmIRGenerator.js';
import { SymbolTable } from '../ir/symbolTable.js';
import { CSharpEmitter } from '../transpiler/csharpEmitter.js';
import { DMRuntimeCS } from '../runtimeTemplate/dmRuntimeCS.js';

interface Probe {
  name: string;
  dm: string;
  expected: string;
  files?: Record<string, string>;
}

/** probe(name, expected, ...lines): lines are DM source (tabs for indentation). */
function probe(name: string, expected: string, ...lines: string[]): Probe {
  return { name, expected, dm: lines.join('\n') };
}

const RUN = '/datum/probe/proc/run()';

export const PROBES: Probe[] = [
  // ===== value semantics =====
  probe('text == is case-sensitive', '0', RUN, '\treturn "ABC" == "abc"'),
  probe('cmptext() is case-insensitive', '1', RUN, '\treturn cmptext("ABC", "abc")'),
  probe('text < compares lexicographically', '1', RUN, '\treturn "10" < "9"'),
  probe('lists compare by reference', '0', RUN, '\tvar/a = list(1, 2)', '\tvar/b = list(1, 2)', '\treturn a == b'),
  probe('~= compares list contents', '1', RUN, '\treturn list(1, 2) ~= list(1, 2)'),
  probe('null == "" is false', '0', RUN, '\treturn null == ""'),
  probe('null == 0 is false', '0', RUN, '\treturn null == 0'),
  probe('!null is true', '1', RUN, '\treturn !null'),
  probe('"0" is truthy', '1', RUN, '\treturn ("0" ? 1 : 0)'),
  probe('"" is falsy', '0', RUN, '\treturn ("" ? 1 : 0)'),
  probe('|| returns the deciding operand', '5', RUN, '\treturn 5 || 3'),
  probe('&& short-circuits', '0', RUN, '\tvar/x = 0', '\tif (0 && (x = 1))', '\t\treturn -1', '\treturn x'),
  probe('7 / 2 is 3.5 (no integer division)', '3.5', RUN, '\treturn 7 / 2'),
  probe('-7 / 2 is -3.5', '-3.5', RUN, '\treturn -7 / 2'),
  probe('numbers are 32-bit floats', '1', RUN, '\treturn 1 == 1.000000001'),
  probe('1/3 renders with 6 significant digits', '0.333333', RUN, '\treturn "[1/3]"'),
  probe('0.1 + 0.2 renders as 0.3', '0.3', RUN, '\treturn "[0.1 + 0.2]"'),
  probe('interpolation stringifies numbers', 'a5', RUN, '\treturn "a[5]"'),
  probe('interpolation of null is empty', 'ab', RUN, '\treturn "a[null]b"'),
  probe('text + number is a runtime error', 'ERROR', RUN, '\treturn "a" + 5'),
  probe('text + null is the text', 'a', RUN, '\treturn "a" + null'),
  probe('null + 3 is 3', '3', RUN, '\treturn null + 3'),
  probe('text - 1 is a runtime error', 'ERROR', RUN, '\treturn "a" - 1'),
  probe('division by zero is a runtime error', 'ERROR', RUN, '\tvar/z = 0', '\treturn 1 / z'),
  probe('% truncates toward zero', '-1', RUN, '\treturn -7 % 3'),
  probe('%% follows the divisor sign', '-2', RUN, '\treturn 7 %% -3'),
  probe('** is power', '1024', RUN, '\treturn 2 ** 10'),
  probe('~ is 24-bit', '16777215', RUN, '\treturn ~0'),
  probe('<< on numbers shifts', '8', RUN, '\treturn 1 << 3'),
  probe('0x hex literal', '31', RUN, '\treturn 0x1F'),
  probe('abs of a negative number', '5', RUN, '\treturn abs(-5)'),
  probe('isnull("") is 0', '0', RUN, '\treturn isnull("")'),
  probe('isnull(0) is 0', '0', RUN, '\treturn isnull(0)'),
  probe('isnum/istext predicates', '1', RUN, '\treturn isnum(5) && istext("a") && !isnum("x")'),
  probe('isnull() on an uninitialized local', '1', RUN, '\tvar/x', '\treturn isnull(x)'),

  // ===== lists =====
  probe('L += x appends', 'list(1, 2, 3)', RUN, '\tvar/L = list(1, 2)', '\tL += 3', '\treturn L'),
  probe('L += x mutates the shared list', '2', RUN, '\tvar/a = list(1)', '\tvar/b = a', '\ta += 2', '\treturn b.len'),
  probe('a = a + x copies', '1', RUN, '\tvar/a = list(1)', '\tvar/b = a', '\ta = a + 2', '\treturn b.len'),
  probe('index writes are visible through every reference', '9', RUN, '\tvar/a = list(1)', '\tvar/b = a', '\ta[1] = 9', '\treturn b[1]'),
  probe('L.len reads the length', '2', RUN, '\tvar/L = list(1, 2)', '\treturn L.len'),
  probe('L.len = n resizes', '5', RUN, '\tvar/L = list(1)', '\tL.len = 5', '\treturn length(L)'),
  probe('lists are 1-indexed', '10', RUN, '\tvar/L = list(10, 20)', '\treturn L[1]'),
  probe('negative list index is a runtime error', 'ERROR', RUN, '\tvar/L = list(1, 2)', '\treturn L[-1]'),
  probe('out-of-range index is a runtime error', 'ERROR', RUN, '\tvar/L = list(1, 2)', '\treturn L[3]'),
  probe('assoc list keys are its elements', 'a', RUN, '\tvar/L = list("a" = 1)', '\treturn L[1]'),
  probe('assoc list len counts entries', '1', RUN, '\treturn list("a" = 1).len'),
  probe('assoc lookup', '1', RUN, '\tvar/L = list("a" = 1)', '\treturn L["a"]'),
  probe('assoc keys are case-sensitive', 'null', RUN, '\tvar/L = list("a" = 1)', '\treturn L["A"]'),
  probe('datum assoc keys', '5', RUN, '\tvar/datum/d = new', '\tvar/L = list()', '\tL[d] = 5', '\treturn L[d]'),
  probe('in checks keys', '1', RUN, '\treturn "a" in list("a" = 1)'),
  probe('in does not check assoc values', '0', RUN, '\treturn 1 in list("a" = 1)'),
  probe('for-in over an assoc list yields keys', 'a', RUN, '\tvar/n', '\tfor (var/x in list("a" = 7))', '\t\tn = x', '\treturn n'),
  probe('for-in iterates a snapshot', '3', RUN, '\tvar/L = list(1, 2, 3)', '\tvar/n = 0', '\tfor (var/x in L)', '\t\tL += x', '\t\tn++', '\treturn n'),
  probe('L.Add appends every argument', '4', RUN, '\tvar/L = list(1)', '\tL.Add(2, 3, 4)', '\treturn L.len'),
  probe('L.Add of a list appends its elements', '3', RUN, '\tvar/L = list(1)', '\tL.Add(list(2, 3))', '\treturn L.len'),
  probe('L -= x removes the last occurrence', 'list(1, 2)', RUN, '\tvar/L = list(1, 2, 1)', '\tL -= 1', '\treturn L'),
  probe('L |= x skips duplicates', 'list(1, 2)', RUN, '\tvar/L = list(1, 2)', '\tL |= 2', '\tL |= 1', '\treturn L'),
  probe('L.Find', '2', RUN, '\treturn list(5, 6, 7).Find(6)'),
  probe('L.Cut', 'list(1, 4)', RUN, '\tvar/L = list(1, 2, 3, 4)', '\tL.Cut(2, 4)', '\treturn L'),
  probe('L.Insert', 'list(1, 9, 2)', RUN, '\tvar/L = list(1, 2)', '\tL.Insert(2, 9)', '\treturn L'),
  probe('L.Copy', 'list(2, 3)', RUN, '\tvar/L = list(1, 2, 3)', '\treturn L.Copy(2)'),
  probe('L.Join', '1-2-3', RUN, '\treturn list(1, 2, 3).Join("-")'),
  probe('list += keeps associative keys', '1', RUN, '\tvar/a = list("k" = 1)', '\ta += 2', '\treturn a["k"]'),
  probe('identifier assoc key list(a = 1)', '3', RUN, '\tvar/list/l = list(a = 1, "b" = 2)', '\treturn l["a"] + l["b"]'),
  probe('mixed list literal', 'list(1, "b" = 2)', RUN, '\treturn list(1, "b" = 2)'),

  // ===== procs and frames =====
  probe('locals never clobber src vars', 'src', '/datum/probe', '\tvar/name = "src"', RUN, '\tvar/name = "local"', '\treturn src.name'),
  probe('recursion keeps separate frames', '120', '/datum/probe/proc/fact(n)', '\tif (n <= 1)', '\t\treturn 1', '\tvar/r = n * fact(n - 1)', '\treturn r', RUN, '\treturn fact(5)'),
  probe('args is the argument list', '3', '/datum/probe/proc/f(a, b)', '\treturn args.len', RUN, '\treturn f(1, 2, 3)'),
  probe('named arguments bind by parameter name', '129', '/datum/probe/proc/f(a, b = 2, c = 3)', '\treturn a * 100 + b * 10 + c', RUN, '\treturn f(1, c = 9)'),
  probe('default arg applies when omitted', '5', '/datum/probe/proc/f(a = 5)', '\treturn a', RUN, '\treturn f()'),
  probe('default arg applies when null is passed', '5', '/datum/probe/proc/f(a = 5)', '\treturn a', RUN, '\treturn f(null)'),
  probe('default arg overridden by a real argument', '7', '/datum/probe/proc/f(a = 5)', '\treturn a', RUN, '\treturn f(7)'),
  probe('default arg expression evaluated per call', '2', '/datum/probe/proc/f(a = list(1, 2))', '\treturn length(a)', RUN, '\treturn f()'),
  probe('. is the implicit return value', '3', RUN, '\t. = 3', '\treturn'),
  probe('. is returned when the proc ends', '4', RUN, '\t. = 4'),
  probe('..() runs the parent type proc', '9', '/datum', '\tvar/mark', '\tproc/run()', '\t\tsrc.mark = 9', '/datum/probe', '\trun()', '\t\t..()', '\t\treturn src.mark'),
  probe('..() reaches an earlier definition on the same type', '11', '/datum/probe/proc/v()', '\treturn 1', '/datum/probe/v()', '\treturn ..() + 10', RUN, '\treturn v()'),
  probe('..() with no arguments passes the current argument values', '7', '/datum/pb/proc/f(x)', '\treturn x', '/datum/pb/c/f(x)', '\tx = 7', '\treturn ..()', RUN, '\tvar/datum/pb/c/o = new', '\treturn o.f(1)'),
  probe('bare call resolves a global proc', '42', '/proc/global_probe_helper()', '\treturn 42', RUN, '\treturn global_probe_helper()'),
  probe('global proc redefinition chains through ..()', '3', '/proc/gp()', '\treturn 1', '/proc/gp()', '\treturn ..() + 2', RUN, '\treturn gp()'),
  probe('usr is assignable and flows into callees', '1', '/datum/probe/proc/who()', '\treturn usr', RUN, '\tusr = src', '\treturn who() == src'),
  probe('call() proc reference', '6', '/datum/probe2', '\tproc/helper(x)', '\t\treturn x + 1', RUN, '\tvar/datum/probe2/a = new', '\treturn call(a, "helper")(5)'),
  probe('undefined proc on a datum is a runtime error', 'ERROR', '/datum/probe2', RUN, '\tvar/datum/probe2/a = new', '\treturn a:nope()'),
  probe('calling a proc on null is a runtime error', 'ERROR', '/datum/probe2/proc/f()', '\treturn 1', RUN, '\tvar/datum/probe2/a', '\treturn a.f()'),
  probe('?. on null is null', 'null', '/datum/probe2/proc/f()', '\treturn 1', RUN, '\tvar/datum/probe2/a', '\treturn a?.f()'),
  probe('try/catch catches runtime errors', 'caught', RUN, '\ttry', '\t\tvar/x = "a" - 1', '\tcatch(var/exception/e)', '\t\treturn "caught"', '\treturn "no"'),
  probe('proc static locals persist across calls', '2', '/datum/probe/proc/count()', '\tvar/static/n = 0', '\tn++', '\treturn n', RUN, '\tcount()', '\treturn count()'),
  probe('x++ evaluates to the old value', '15', RUN, '\tvar/x = 5', '\tvar/y = x++', '\treturn y + x + 4'),
  probe('++x evaluates to the new value', '12', RUN, '\tvar/x = 5', '\tvar/y = ++x', '\treturn y + x'),
  probe('break exits a C-style for', '2', RUN, '\tvar/count = 0', '\tfor (var/i = 1, i <= 10, i++)', '\t\tif (i == 3)', '\t\t\tbreak', '\t\tcount++', '\treturn count'),
  probe('for(x in 1 to 3) sums', '6', RUN, '\tvar/s = 0', '\tfor (var/i in 1 to 3)', '\t\ts += i', '\treturn s'),
  probe('for range with positive step', '9', RUN, '\tvar/s = 0', '\tfor (var/i = 1 to 6 step 2)', '\t\ts += i', '\treturn s'),
  probe('for range with descending step', '9', RUN, '\tvar/s = 0', '\tfor (var/i = 5 to 1 step -2)', '\t\ts += i', '\treturn s'),
  probe('for(var/type in L) visits only that type', '1', '/mob/p_mob', '/obj/p_obj', RUN, '\tvar/count = 0', '\tfor (var/mob/p_mob/M in list(new /mob/p_mob(), new /obj/p_obj()))', '\t\tcount++', '\treturn count'),
  probe('switch with ranges', 'mid', RUN, '\tswitch (5)', '\t\tif (1 to 3)', '\t\t\treturn "low"', '\t\tif (4 to 6)', '\t\t\treturn "mid"', '\treturn "none"'),
  probe('labeled continue', '3', RUN, '\tvar/count = 0', '\tvar/i = 0', '\touter:', '\t\twhile(i < 3)', '\t\t\ti += 1', '\t\t\tvar/j = 0', '\t\t\twhile(j < 3)', '\t\t\t\tj += 1', '\t\t\t\tif(j == 2)', '\t\t\t\t\tcontinue outer', '\t\t\t\tcount += 1', '\treturn count'),
  probe('labeled break', '3', RUN, '\tvar/count = 0', '\touter:', '\t\twhile(count < 100)', '\t\t\tcount += 1', '\t\t\tif(count == 3)', '\t\t\t\tbreak outer', '\treturn count'),
  probe('CRLF line endings parse', '6', `${RUN}\r`, '\tvar/x = 5\r', '\treturn x + 1\r'),

  // ===== type tree =====
  probe('type var defaults apply to new instances', '5', '/datum/pd', '\tvar/x = 5', RUN, '\tvar/datum/pd/p = new', '\treturn p.x'),
  probe('subtype overrides a default', '7', '/datum/pd', '\tvar/x = 5', '/datum/pd/sub', '\tx = 7', RUN, '\tvar/datum/pd/p = new /datum/pd/sub', '\treturn p.x'),
  probe('constant-folded default', '12', '/datum/pd', '\tvar/x = (1 << 2) | 8', RUN, '\tvar/datum/pd/p = new', '\treturn p.x'),
  probe('list initializers are per instance', '0', '/datum/pd', '\tvar/list/L = list()', RUN, '\tvar/datum/pd/a = new', '\tvar/datum/pd/b = new', '\ta.L += 1', '\treturn b.L.len'),
  probe('initial() reads the compile-time default', '7', '/datum/probe2', '\tvar/foo = 7', RUN, '\tvar/datum/probe2/a = new', '\ta.foo = 99', '\treturn initial(a.foo)'),
  probe('parent_type reparents a type', '1', '/datum/pa', '\tvar/x = 1', '/datum/zz', '\tparent_type = /datum/pa', RUN, '\tvar/datum/zz/z = new', '\treturn z.x + istype(z, /datum/pa) - 1'),
  probe('implicit new uses the declared type', '5', '/datum/pd', '\tvar/x = 5', RUN, '\tvar/datum/pd/p = new', '\treturn p.x'),
  probe('new with a type held in a variable', '5', '/datum/pd', '\tvar/x = 5', RUN, '\tvar/t = /datum/pd', '\tvar/datum/pd/p = new t', '\treturn p.x'),
  probe('New() receives the arguments', '9', '/datum/pn', '\tvar/arg', '\tNew(a)', '\t\targ = a', RUN, '\tvar/datum/pn/p = new(9)', '\treturn p.arg'),
  probe('two new objects are distinct', '0', '/datum/probe2', RUN, '\tvar/a = new /datum/probe2()', '\tvar/b = new /datum/probe2()', '\treturn a == b'),
  probe('.type reads the type path', '/datum/probe2', '/datum/probe2', RUN, '\tvar/datum/probe2/d = new', '\treturn d.type'),
  probe('typesof() lists the type and its subtypes', '2', '/datum/probe_base', '/datum/probe_base/child', RUN, '\tvar/L = typesof(/datum/probe_base)', '\treturn L.len'),
  probe('istype() follows the tree', '1', '/obj/item', '/obj/item/tool', RUN, '\tvar/obj/item/tool/t = new', '\treturn istype(t, /obj/item) && !istype(t, /mob)'),
  probe('ismob() on a mob instance', '1', '/mob/probe_mob', RUN, '\tvar/m = new /mob/probe_mob()', '\treturn ismob(m)'),
  probe('istype(null, /datum) is false', '0', RUN, '\treturn istype(null, /datum)'),
  probe('ispath("x") is 0', '0', RUN, '\treturn ispath("x")'),
  probe('ispath(/obj) is 1', '1', RUN, '\treturn ispath(/obj)'),
  probe('ispath subtype check', '1', '/obj/item', RUN, '\treturn ispath(/obj/item, /obj)'),
  probe('ispath base is not within a subtype', '0', '/obj/item', RUN, '\treturn ispath(/obj, /obj/item)'),
  probe('atom builtin defaults', '5', RUN, '\tvar/obj/o = new', '\treturn o.dir + o.layer + length(o.contents)'),
  probe('loc and contents stay in sync', '1', RUN, '\tvar/obj/box = new', '\tvar/obj/item = new(box)', '\treturn item.loc == box && (item in box.contents)'),
  probe('moving out updates the old contents', '0', RUN, '\tvar/obj/box = new', '\tvar/obj/item = new(box)', '\titem.loc = null', '\treturn length(box.contents)'),
  probe('deleted references read as null', '1', RUN, '\tvar/datum/d = new', '\tvar/datum/e = d', '\tdel d', '\treturn isnull(e)'),
  probe('operator overloads', '3', '/datum/vec', '\tvar/v = 1', '\tproc/operator+(datum/vec/other)', '\t\tvar/datum/vec/r = new', '\t\tr.v = v + other.v', '\t\treturn r', RUN, '\tvar/datum/vec/a = new', '\tvar/datum/vec/b = new', '\tb.v = 2', '\tvar/datum/vec/c = a + b', '\treturn c.v'),
  probe('as /type keeps the object', '0', '/datum/probe2', RUN, '\tvar/a = new /datum/probe2()', '\tvar/b = a as /datum/probe2', '\treturn b == null'),

  // ===== scheduler =====
  probe('sleep and spawn interleave by world.time', 'abc', '/datum/probe', '\tvar/list/log', RUN, '\tlog = list()', '\tspawn(5)', '\t\tlog += "b"', '\tlog += "a"', '\tsleep(10)', '\tlog += "c"', '\treturn jointext(log, "")'),
  probe('spawn runs with a copy of the locals', '1', '/datum/probe', '\tvar/list/log', RUN, '\tlog = list()', '\tvar/x = 1', '\tspawn(1)', '\t\tlog += "[x]"', '\tx = 2', '\tsleep(2)', '\treturn jointext(log, "")'),
  probe('world.time advances across sleep', '5', RUN, '\tvar/t = world.time', '\tsleep(5)', '\treturn world.time - t'),
  probe('world.time starts at 0', '0', RUN, '\treturn world.time'),
  probe('a sleeping callee suspends the caller', 'xy', '/datum/probe', '\tvar/list/log', '/datum/probe/proc/slow()', '\tsleep(5)', '\tlog += "x"', RUN, '\tlog = list()', '\tslow()', '\tlog += "y"', '\treturn jointext(log, "")'),
  probe('set waitfor = 0 returns at the first sleep', 'rs', '/datum/probe', '\tvar/list/log', '/datum/probe/proc/slow()', '\tset waitfor = 0', '\tsleep(10)', '\tlog += "s"', RUN, '\tlog = list()', '\tslow()', '\tlog += "r"', '\tsleep(20)', '\treturn jointext(log, "")'),
  probe('return inside spawn exits the block', '1', RUN, '\tvar/x = 1', '\tspawn(0)', '\t\treturn', '\treturn x'),

  // ===== globals =====
  probe('global var default', '5', '/var/global/counter = 5', RUN, '\treturn counter'),
  probe('global. prefix', '5', '/var/global/counter = 5', RUN, '\treturn global.counter'),
  probe('global write persists across procs', '9', '/var/global/gx = 0', '/datum/probe/proc/helper()', '\treturn gx', RUN, '\tgx = 9', '\treturn helper()'),
  probe('global initializer references an earlier global', '5', '/var/global/ga = 2', '/var/global/gb = ga + 3', RUN, '\treturn gb'),
  probe('global list += appends', '1', '/var/global/list/items = list()', RUN, '\titems += "z"', '\treturn items.len'),
  probe('global initialized with new', '1', '/datum/probe2', '/var/global/datum/probe2/gobj = new /datum/probe2()', RUN, '\treturn gobj != null'),

  // ===== builtins =====
  probe('findtext is 1-based', '2', RUN, '\treturn findtext("abc", "b")'),
  probe('findtext is case-insensitive', '2', RUN, '\treturn findtext("ABC", "b")'),
  probe('findtext with an empty needle is 0', '0', RUN, '\treturn findtext("abc", "")'),
  probe('text2num handles hex', '31', RUN, '\treturn text2num("0x1F")'),
  probe('text2num radix 16', '31', RUN, '\treturn text2num("1F", 16)'),
  probe('num2text of an integer', '42', RUN, '\treturn num2text(42)'),
  probe('replacetext', 'bbb', RUN, '\treturn replacetext("aaa", "a", "b")'),
  probe('replacetextEx is case-sensitive', 'acbc', RUN, '\treturn replacetextEx("aXbX", "X", "c")'),
  probe('nameof() returns the final path segment', 'run', RUN, '\treturn nameof(/datum/probe/proc/run)'),
  probe('turn() is counter-clockwise', '1', RUN, '\treturn turn(4, 90)'),
  probe('splittext()', '3', RUN, '\tvar/list/L = splittext("a,b,c", ",")', '\treturn L.len'),
  probe('jointext()', 'a-b-c', RUN, '\treturn jointext(list("a", "b", "c"), "-")'),
  probe('rgb() is lowercase hex', '#ff0080', RUN, '\treturn rgb(255, 0, 128)'),
  probe('floor()', '3', RUN, '\treturn floor(3.7)'),
  probe('ceil()', '4', RUN, '\treturn ceil(3.2)'),
  probe('sqrt()', '4', RUN, '\treturn sqrt(16)'),
  probe('sin() takes degrees', '50', RUN, '\treturn round(sin(30) * 100)'),
  probe('cos() takes degrees', '50', RUN, '\treturn round(cos(60) * 100)'),
  probe('sign()', '-1', RUN, '\treturn sign(-5)'),
  probe('sign() of text is 0', '0', RUN, '\treturn sign("-3")'),
  probe('copytext_char()', 'el', RUN, '\treturn copytext_char("hello", 2, 4)'),
  probe('length_char()', '5', RUN, '\treturn length_char("hello")'),
  probe('text2ascii()', '65', RUN, '\treturn text2ascii("A")'),
  probe('ascii2text()', 'A', RUN, '\treturn ascii2text(65)'),
  probe('ckey() keeps [a-z0-9@]', 'mything2', RUN, '\treturn ckey("My_Thing #2!")'),
  probe('sorttext() returns 1 for ascending order', '-1', RUN, '\treturn sorttext("b", "A")'),
  probe('html_encode()', '&lt;b&gt;', RUN, '\treturn html_encode("<b>")'),
  probe('html_decode()', '<b>', RUN, '\treturn html_decode("&lt;b&gt;")'),
  probe('rgb2num(r, g, b)', '16744448', RUN, '\treturn rgb2num(255, 128, 0)'),
  probe('rgb2num("#hex") channels', '255,128,0', RUN, '\tvar/list/c = rgb2num("#ff8000")', '\treturn "[c[1]],[c[2]],[c[3]]"'),
  probe('large numbers render with 6 significant digits', '2.55128e+08', RUN, '\treturn "[255128000]"'),
  probe('json_encode()', '[1,"two",null]', RUN, '\treturn json_encode(list(1, "two", null))'),
  probe('json_encode() escapes', '["a\\"b","c\\\\d","e\\nf","a\\tb"]', RUN, '\treturn json_encode(list("a\\"b", "c\\\\d", "e\\nf", "a\\tb"))'),
  probe('json_decode()', '1', RUN, '\tvar/list/L = json_decode("{\\"a\\": 1}")', '\treturn L["a"]'),
  probe('params2list URL-decodes', 'b c', RUN, '\tvar/list/L = params2list("a=b%20c")', '\treturn L["a"]'),
  probe('time2text()', '00:01:40', RUN, '\treturn time2text(1000, "hh:mm:ss")'),
  probe('length counts code points', '3', RUN, '\treturn length("a😀b")'),
  probe('copytext by code points', '😀', RUN, '\treturn copytext("a😀b", 2, 3)'),
  probe('copytext with end 0', 'abc', RUN, '\treturn copytext("abc", 1, 0)'),
  probe('copytext with negative end', 'b', RUN, '\treturn copytext("abc", 2, -1)'),
  probe('copytext with start 0', 'abc', RUN, '\treturn copytext("abc", 0)'),
  probe('\\x and \\u escapes', 'AA', RUN, '\treturn "\\x41\\u0041"'),
  probe('arctan() returns degrees', '450', RUN, '\treturn round(arctan(1) * 10)'),
  probe('regex Find', '3', RUN, '\tvar/regex/re = regex("b+")', '\treturn re.Find("xabbb")'),
  probe('regex Replace', 'xaZ', RUN, '\tvar/regex/re = regex("b+")', '\treturn re.Replace("xabbb", "Z")'),
  probe('regex_quote()', 'a\\.b', RUN, '\treturn regex_quote("a.b")'),
  probe('findlasttext()', '5', RUN, '\treturn findlasttext("abcabc", "b")'),
  probe('values_sum()', '6', RUN, '\treturn values_sum(list(1, 2, 3))'),
  probe('roll("1d1")', '1', RUN, '\treturn roll("1d1")'),
  probe('world.view + world.tick_lag', '6', RUN, '\treturn world.view + world.tick_lag'),
  probe('ref() is stable and unique', '1', '/datum/probe2', RUN, '\tvar/a = new /datum/probe2()', '\tvar/b = new /datum/probe2()', '\treturn ref(a) == ref(a) && ref(a) != ref(b)'),
  probe('image() vars', '5', RUN, "\tvar/image/i = image('icons/x.dmi', null, \"on\", 4, 1)", '\treturn i.layer + i.dir'),
  probe('sound() vars', '53', RUN, '\tvar/sound/s = sound(null, 0, 0, 50, 3)', '\treturn s.volume + s.channel'),
  probe('matrix Scale (x\' = a*x + b*y + c)', '5', RUN, '\tvar/matrix/m = matrix()', '\tm.Scale(2, 3)', '\treturn m.a + m.e'),
  probe('matrix Translate', '30', RUN, '\tvar/matrix/m = matrix()', '\tm.Translate(10, 20)', '\treturn m.c + m.f'),
  probe('splicetext()', 'aef', RUN, '\treturn splicetext("abcdef", 2, 4)'),

  // ===== files (seeded in the probe working directory) =====
  { ...probe('fdel() on a missing file returns 0', '0', RUN, '\treturn fdel("probe_missing.txt")') },
  { ...probe('fexists() for a seeded file', '1', RUN, '\treturn fexists("probe_seed.txt")'), files: { 'probe_seed.txt': 'seed content' } },
  { ...probe('fdel() deletes a file', '1', RUN, '\treturn fdel("probe_del.txt")'), files: { 'probe_del.txt': 'delete me' } },
  { ...probe('file() values are files', '1', RUN, '\tvar/f = file("probe_seed.txt")', '\treturn isfile(f)'), files: { 'probe_seed.txt': 'seed content' } },
  { ...probe('length(file) is the byte size', '12', RUN, '\treturn length(file("probe_seed.txt"))'), files: { 'probe_seed.txt': 'seed content' } },
];

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`❌ ${message}`);
    process.exit(1);
  }
}

function emitProbe(dmCode: string, ns: string): string {
  const collector = new DiagnosticCollector();
  const pre = new DMPreprocessor(collector).process(dmCode, 'probe.dm');
  const parser = new DMParser(new DMLexer(pre).tokenize(), collector);
  const nodes = parser.parse();
  assert(collector.errors.length === 0, `Probe failed to parse: ${collector.errors[0]?.message ?? 'unknown'}`);
  const symbols = new SymbolTable();
  symbols.addTypeDecls(nodes);
  const ir = new DMIRGenerator().generateIR(nodes);
  return new CSharpEmitter({ namespace: ns }).generateProcsCS(ir, parser.globalVars, symbols);
}

function driver(count: number): string {
  const cases = Array.from({ length: count }, (_, i) =>
    `            Console.WriteLine("PROBE_RESULT_${i}:" + Escape(Run(Probe${i}.ConvertedDMProcs.Boot)));`).join('\n');
  return `using System;
using System.Threading.Tasks;
using SS13.DM.Runtime;

static class ProbeDriver
{
    static string Escape(string s) => s.Replace("\\\\", "\\\\\\\\").Replace("\\n", "\\\\n");

    static string Run(Func<Task> boot)
    {
        DMRuntimeHelpers.ResetRuntime();
        DMTickScheduler.ErrorSink = (_, _) => { };
        DMRuntimeHelpers.OutputSink = (_, _) => { };
        Task<DMValue>? task = null;
        try
        {
            task = DMTickScheduler.Run(async () =>
            {
                await boot();
                var probe = new DMRuntime(DMTypes.GetOrThrow("/datum/probe"));
                await probe.RunInitializers();
                return await probe.CallProc("run");
            });
            DMTickScheduler.RunUntilIdle();
        }
        catch (Exception e)
        {
            return "ERROR: " + e.Message;
        }
        if (!task.IsCompleted) return "(did not finish)";
        if (task.IsFaulted) return "ERROR: " + (task.Exception!.InnerException ?? task.Exception).Message;
        return task.Result.Repr();
    }

    static void Main()
    {
${cases}
    }
}
`;
}

async function main(): Promise<void> {
  try {
    execSync('dotnet --version', { stdio: 'pipe' });
  } catch {
    console.log('dotnet not available — skipping semantic probes');
    return;
  }

  const scratch = path.join(os.tmpdir(), 'dm2ss14-fidelity');
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.mkdirSync(scratch, { recursive: true });
  fs.writeFileSync(path.join(scratch, 'ProbeDriver.csproj'), `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <NoWarn>CS0162;CS0164;CS0168;CS0219;CS1998;CS8321;CS8600;CS8602;CS8603;CS8604;CS8618;CS8625</NoWarn>
  </PropertyGroup>
</Project>`, 'utf-8');
  for (const f of DMRuntimeCS.getRuntimeCSFiles()) fs.writeFileSync(path.join(scratch, f.filename), f.content, 'utf-8');

  PROBES.forEach((p, i) => {
    fs.writeFileSync(path.join(scratch, `Probe${i}.cs`), emitProbe(p.dm, `Probe${i}`), 'utf-8');
    for (const [name, content] of Object.entries(p.files ?? {})) fs.writeFileSync(path.join(scratch, name), content, 'utf-8');
  });
  fs.writeFileSync(path.join(scratch, 'Program.cs'), driver(PROBES.length), 'utf-8');

  console.log(`=== Semantic Differential Probes: ${PROBES.length} (expected = BYOND, observed = converted) ===`);
  let output: string;
  try {
    output = execSync('dotnet run --project ProbeDriver.csproj --nologo -v q', {
      cwd: scratch, timeout: 600000, maxBuffer: 64 * 1024 * 1024, stdio: 'pipe',
      env: { ...process.env, DOTNET_ROLL_FORWARD: 'LatestMajor' }
    }).toString();
  } catch (e: any) {
    output = (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '');
    const errors = output.split('\n').filter(l => l.includes('error CS'));
    if (errors.length > 0) {
      console.log(`❌ probe build failed (${errors.length} errors):`);
      for (const l of [...new Set(errors)].slice(0, 25)) console.log('   ' + l.replace(scratch + '/', ''));
      process.exitCode = 1;
      return;
    }
  }

  let matches = 0;
  PROBES.forEach((p, i) => {
    const m = output.match(new RegExp(`^PROBE_RESULT_${i}:(.*)$`, 'm'));
    const observed = m ? m[1].replace(/\\(\\|n)/g, (_, c) => (c === 'n' ? '\n' : '\\')) : '(no result)';
    const match = p.expected === 'ERROR' ? observed.startsWith('ERROR') : observed === p.expected;
    if (match) matches++;
    console.log(`${match ? '✅' : '❌'} ${p.name}  (expected ${p.expected}, observed ${observed})`);
  });
  console.log(`\n=== Summary: ${matches}/${PROBES.length} probes preserved DM semantics ===`);
  console.log(`Scratch project kept at: ${scratch}`);
  if (matches !== PROBES.length) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(err => {
    console.error('Probe error:', err);
    process.exit(1);
  });
}
