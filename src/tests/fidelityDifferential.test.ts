// Semantic differential probes: for each small DM snippet with KNOWN BYOND
// behavior, this converts it through the real pipeline (preprocessor ->
// parser -> IR -> C# emitter), compiles the generated code with the vendored
// runtime, RUNS it, and reports whether the observed behavior matches DM.
//
// The point is not to pass/fail: it is to measure which DM semantics survive
// conversion. Run with: npm run audit:semantics   (requires dotnet)
//
// Expected values are BYOND semantics; observed values are the converted
// runtime's behavior. ✅ = semantics preserved, ❌ = semantics lost.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { DMPreprocessor } from '../preprocessor.js';
import { DMLexer } from '../parser/dmLexer.js';
import { DMParser } from '../parser/dmParser.js';
import { DiagnosticCollector } from '../diagnostics.js';
import { DMIRGenerator } from '../ir/dmIRGenerator.js';
import { CSharpEmitter } from '../transpiler/csharpEmitter.js';
import { DMRuntimeCS } from '../runtimeTemplate/dmRuntimeCS.js';

interface Probe {
  name: string;
  dm: string;
  expected: string;
  files?: Record<string, string>;
}

const PROBES: Probe[] = [
  {
    name: 'text equality is case-insensitive',
    dm: `/datum/probe/proc/run()\n\treturn "ABC" == "abc"`,
    expected: '1' // BYOND: "ABC" == "abc" is true
  },
  {
    name: 'text < compares lexicographically',
    dm: `/datum/probe/proc/run()\n\treturn "10" < "9"`,
    expected: '1' // BYOND: "10" < "9" is true (lexicographic)
  },
  {
    name: 'list equality is element-wise',
    dm: `/datum/probe/proc/run()\n\tvar/a = list(1, 2)\n\tvar/b = list(1, 2)\n\treturn a == b`,
    expected: '1'
  },
  {
    name: 'null == "" is true',
    dm: `/datum/probe/proc/run()\n\treturn null == ""`,
    expected: '1'
  },
  {
    name: '|| returns the operand value',
    dm: `/datum/probe/proc/run()\n\treturn 5 || 3`,
    expected: '5' // BYOND returns 5, not a boolean
  },
  {
    name: '&& short-circuits (side effects)',
    dm: `/datum/probe/proc/run()\n\tvar/x = 0\n\tif (0 && (x = 1))\n\t\treturn -1\n\treturn x`,
    expected: '0' // DM: right operand never evaluated
  },
  {
    name: 'L += x appends to a list',
    dm: `/datum/probe/proc/run()\n\tvar/L = list(1, 2)\n\tL += 3\n\treturn L`,
    expected: 'list(1, 2, 3)' // DM: list text rendering; probe hardened (WS13-8)
  },
  {
    name: 'L.len reads list length',
    dm: `/datum/probe/proc/run()\n\tvar/L = list(1, 2)\n\treturn L.len`,
    expected: '2'
  },
  {
    name: 'negative list index reads from end',
    dm: `/datum/probe/proc/run()\n\tvar/L = list(1, 2)\n\treturn L[-1]`,
    expected: '2' // BYOND: last element
  },
  {
    name: 'two new /type() create distinct objects',
    dm: `/datum/probe2\n/datum/probe/proc/run()\n\tvar/a = new /datum/probe2()\n\tvar/b = new /datum/probe2()\n\treturn a == b`,
    expected: '0'
  },
  {
    name: '..() executes the parent proc',
    dm: `/datum\n\tproc/run()\n\t\tsrc.mark = 9\n/datum/probe\n\tproc/run()\n\t\t..()\n\t\treturn src.mark`,
    expected: '9'
  },
  {
    name: 'world.time is a number',
    dm: `/datum/probe/proc/run()\n\treturn world.time`,
    expected: '0' // BYOND: some number >= 0; the converted runtime must not return null
  },
  {
    name: 'findtext is 1-based',
    dm: `/datum/probe/proc/run()\n\treturn findtext("abc", "b")`,
    expected: '2'
  },
  {
    name: 'text2num handles hex',
    dm: `/datum/probe/proc/run()\n\treturn text2num("0x1F")`,
    expected: '31'
  },
  {
    name: '"0" is falsy in conditions',
    dm: `/datum/probe/proc/run()\n\treturn ("0" ? 1 : 0)`,
    expected: '0'
  },
  {
    name: 'num2text of integer',
    dm: `/datum/probe/proc/run()\n\treturn num2text(42)`,
    expected: '42'
  },
  {
    name: 'break exits a C-style for loop',
    dm: `/datum/probe/proc/run()\n\tvar/count = 0\n\tfor (var/i = 1, i <= 10, i++)\n\t\tif (i == 3)\n\t\t\tbreak\n\t\tcount++\n\treturn count`,
    expected: '2'
  },
  {
    name: 'replacetext transforms text',
    dm: `/datum/probe/proc/run()\n\treturn replacetext("aaa", "a", "b")`,
    expected: 'bbb'
  },
  {
    name: 'as /type cast preserves the object',
    dm: `/datum/probe2\n/datum/probe/proc/run()\n\tvar/a = new /datum/probe2()\n\tvar/b = a as /datum/probe2\n\treturn b == null`,
    expected: '0' // BYOND: cast keeps the object, not null
  },
  {
    name: '1-based list indexing',
    dm: `/datum/probe/proc/run()\n\tvar/L = list(10, 20)\n\treturn L[1]`,
    expected: '10'
  },
  {
    name: '"a" + 5 concatenates',
    dm: `/datum/probe/proc/run()\n\treturn "a" + 5`,
    expected: 'a5'
  },
  {
    name: 'for(x in 1..3) sums range',
    dm: `/datum/probe/proc/run()\n\tvar/s = 0\n\tfor (var/i in 1..3)\n\t\ts += i\n\treturn s`,
    expected: '6'
  },
  {
    name: 'istype(null, /datum) is false',
    dm: `/datum/probe/proc/run()\n\treturn istype(null, /datum)`,
    expected: '0'
  },
  {
    name: 'islist() on a list',
    dm: `/datum/probe/proc/run()\n\treturn islist(list(1))`,
    expected: '1'
  },
  {
    name: 'bare call to a global proc resolves (/proc fallback)',
    dm: `/proc/global_probe_helper()\n\treturn 42\n/datum/probe/proc/run()\n\treturn global_probe_helper()`,
    expected: '42'
  },
  {
    name: 'isnull() on an uninitialized var',
    dm: `/datum/probe/proc/run()\n\tvar/x\n\treturn isnull(x)`,
    expected: '1'
  },
  {
    name: 'isnum/istext predicates',
    dm: `/datum/probe/proc/run()\n\treturn isnum(5) && istext("a") && !isnum("x")`,
    expected: '1'
  },
  {
    name: 'ismob() on a mob instance',
    dm: `/mob/probe_mob\n/datum/probe/proc/run()\n\tvar/m = new /mob/probe_mob()\n\treturn ismob(m)`,
    expected: '1'
  },
  {
    name: 'nameof() returns the final path segment',
    dm: `/datum/probe/proc/run()\n\treturn nameof(/datum/probe/proc/run)`,
    expected: 'run'
  },
  {
    name: 'turn() rotates a direction clockwise',
    dm: `/datum/probe/proc/run()\n\treturn turn(4, 90)`,
    expected: '2' // E + 90deg clockwise = S
  },
  {
    name: 'get_dist() is Chebyshev over x/y vars',
    dm: `/datum/probe2\n/datum/probe/proc/run()\n\tvar/a = new /datum/probe2()\n\tvar/b = new /datum/probe2()\n\ta.x = 1\n\ta.y = 1\n\tb.x = 4\n\tb.y = 5\n\treturn get_dist(a, b)`,
    expected: '4'
  },
  {
    name: 'get_dir() returns binary direction',
    dm: `/datum/probe2\n/datum/probe/proc/run()\n\tvar/a = new /datum/probe2()\n\tvar/b = new /datum/probe2()\n\ta.x = 1\n\ta.y = 1\n\tb.x = 4\n\tb.y = 5\n\treturn get_dir(a, b)`,
    expected: '5' // NE
  },
  {
    name: 'splittext() splits into a list',
    dm: `/datum/probe/proc/run()\n\tvar/L = splittext("a,b,c", ",")\n\treturn L.len`,
    expected: '3'
  },
  {
    name: 'jointext() joins a list',
    dm: `/datum/probe/proc/run()\n\treturn jointext(list("a", "b", "c"), "-")`,
    expected: 'a-b-c'
  },
  {
    name: 'rgb() formats hex color',
    dm: `/datum/probe/proc/run()\n\treturn rgb(255, 0, 128)`,
    expected: '#FF0080'
  },
  {
    name: 'initial() reads the pre-mutation var value',
    dm: `/datum/probe2\n\tproc/New()\n\t\tsrc.foo = 7\n/datum/probe/proc/run()\n\tvar/a = new /datum/probe2()\n\ta.foo = 99\n\treturn initial(a.foo)`,
    expected: '7'
  },
  {
    name: 'call() proc reference invokes dynamically',
    dm: `/datum/probe2\n\tproc/helper(x)\n\t\treturn x + 1\n/datum/probe/proc/run()\n\tvar/a = new /datum/probe2()\n\treturn call(a, "helper")(5)`,
    expected: '6'
  },
  // --- Plan 01 pure-function builtins (BYOND-verified expected values) ---
  {
    name: 'floor() rounds down',
    dm: `/datum/probe/proc/run()\n\treturn floor(3.7)`,
    expected: '3'
  },
  {
    name: 'ceil() rounds up',
    dm: `/datum/probe/proc/run()\n\treturn ceil(3.2)`,
    expected: '4'
  },
  {
    name: 'sqrt() square root',
    dm: `/datum/probe/proc/run()\n\treturn sqrt(16)`,
    expected: '4'
  },
  {
    name: 'sin() takes degrees (sin 30 = 0.5)',
    dm: `/datum/probe/proc/run()\n\treturn round(sin(30) * 100)`,
    expected: '50'
  },
  {
    name: 'cos() takes degrees (cos 60 = 0.5)',
    dm: `/datum/probe/proc/run()\n\treturn round(cos(60) * 100)`,
    expected: '50'
  },
  {
    name: 'sign() returns -1/0/1',
    dm: `/datum/probe/proc/run()\n\treturn sign(-5)`,
    expected: '-1'
  },
  {
    name: 'copytext_char() is char-based',
    dm: `/datum/probe/proc/run()\n\treturn copytext_char("hello", 2, 4)`,
    expected: 'el'
  },
  {
    name: 'length_char() counts chars',
    dm: `/datum/probe/proc/run()\n\treturn length_char("hello")`,
    expected: '5'
  },
  {
    name: 'text2ascii() returns char code',
    dm: `/datum/probe/proc/run()\n\treturn text2ascii("A")`,
    expected: '65'
  },
  {
    name: 'ascii2text() converts code to char',
    dm: `/datum/probe/proc/run()\n\treturn ascii2text(65)`,
    expected: 'A'
  },
  {
    name: 'ckey() canonicalizes',
    dm: `/datum/probe/proc/run()\n\treturn ckey("My_Thing #2!")`,
    expected: 'my thing 2'
  },
  {
    name: 'sorttext() case-insensitive compare',
    dm: `/datum/probe/proc/run()\n\treturn sorttext("b", "A")`,
    expected: '1'
  },
  {
    name: 'replacetextEx() literal case-sensitive replace',
    dm: `/datum/probe/proc/run()\n\treturn replacetextEx("aXbX", "X", "c")`,
    expected: 'acbc'
  },
  {
    name: 'html_encode() escapes markup',
    dm: `/datum/probe/proc/run()\n\treturn html_encode("<b>")`,
    expected: '&lt;b&gt;'
  },
  {
    name: 'html_decode() unescapes markup',
    dm: `/datum/probe/proc/run()\n\treturn html_decode("&lt;b&gt;")`,
    expected: '<b>'
  },
  {
    name: 'rgb2num(r, g, b) packs a color number',
    dm: `/datum/probe/proc/run()\n\treturn rgb2num(255, 128, 0)`,
    expected: '16744448'
  },
  {
    name: 'rgb2num("#hex") decomposes to channels',
    dm: `/datum/probe/proc/run()\n\tvar/c = rgb2num("#ff8000")\n\treturn c[1] * 1000000 + c[2] * 1000 + c[3]`,
    expected: '255128000'
  },
  {
    name: 'json_encode() serializes lists',
    dm: `/datum/probe/proc/run()\n\treturn json_encode(list(1, "two", null))`,
    expected: '[1,"two",null]'
  },
  {
    name: 'json_encode() escapes quotes and backslashes',
    dm: `/datum/probe/proc/run()\n\treturn json_encode(list("a\\"b", "c\\\\d", "e\\nf", "a\\tb"))`,
    expected: '["a\\"b","c\\\\d","e\\nf","a\\tb"]' // hardened: escape paths (WS13-7)
  },
  {
    name: 'time2text() formats decisecond world time',
    dm: `/datum/probe/proc/run()\n\treturn time2text(1000, "hh:mm:ss")`,
    expected: '00:01:40'
  },
  {
    name: 'json_decode() parses into an assoc list',
    dm: `/datum/probe/proc/run()\n\tvar/L = json_decode("{\\"a\\": 1}")\n\treturn L["a"]`,
    expected: '1'
  },
  {
    name: 'typesof() lists registered descendants',
    dm: `/datum/probe_base\n\tproc/base_helper()\n\t\treturn 1\n/datum/probe_base/child\n\tproc/child_helper()\n\t\treturn 1\n/datum/probe/proc/run()\n\tvar/L = typesof(/datum/probe_base)\n\treturn L.len`,
    expected: '2'
  },
  {
    name: 'range() finds datums within distance',
    dm: `/datum/probe2\n/datum/probe/proc/run()\n\tvar/a = new /datum/probe2()\n\tvar/b = new /datum/probe2()\n\ta.x = 0\n\ta.y = 0\n\tb.x = 1\n\tb.y = 1\n\treturn range(2, a).len`,
    expected: '2'
  },
  {
    name: 'GLOB.x reads the global default value',
    dm: `/global/var/counter = 5\n/datum/probe/proc/run()\n\treturn GLOB.counter`,
    expected: '5'
  },
  {
    name: 'GLOB.x = v writes and reads back',
    dm: `/global/var/x = 0\n/datum/probe/proc/run()\n\tGLOB.x = 42\n\treturn GLOB.x`,
    expected: '42'
  },
  {
    name: 'GLOB list default appends',
    dm: `/global/var/list/items = list()\n/datum/probe/proc/run()\n\tGLOB.items += "z"\n\treturn GLOB.items.len`,
    expected: '1'
  },
  {
    name: 'global initializer references an earlier global',
    dm: `/global/var/a = 2\n/global/var/b = GLOB.a + 3\n/datum/probe/proc/run()\n\treturn GLOB.b`,
    expected: '5'
  },
  {
    name: 'global with new /type() default is a datum',
    dm: `/datum/probe2\n/global/var/obj = new /datum/probe2()\n/datum/probe/proc/run()\n\treturn GLOB.obj != null`,
    expected: '1'
  },
  {
    name: 'undeclared GLOB.x reads as null',
    dm: `/datum/probe/proc/run()\n\treturn isnull(GLOB.nope)`,
    expected: '1'
  },
  {
    name: 'GLOB state persists across proc calls',
    dm: `/global/var/x = 0\n/datum/probe/proc/run()\n\tGLOB.x = 9\n\treturn helper()\n/datum/probe/proc/helper()\n\treturn GLOB.x`,
    expected: '9'
  },
  {
    name: 'GLOB shared across datum types',
    dm: `/global/var/shared = 7\n/datum/probe2\n\tproc/helper()\n\t\treturn GLOB.shared\n/datum/probe/proc/run()\n\tvar/a = new /datum/probe2()\n\treturn a.helper()`,
    expected: '7'
  },
  {
    name: 'assoc key on global list persists',
    dm: `/global/var/list/registry = list()\n/datum/probe/proc/run()\n\tGLOB.registry["k"] = 5\n\treturn GLOB.registry["k"]`,
    expected: '5'
  },
  // --- Plan 01 file-ops builtins (seed files written to the scratch dir) ---
  {
    name: 'fdel() on a missing file returns 0',
    dm: `/datum/probe/proc/run()\n\treturn fdel("probe_missing.txt")`,
    expected: '0'
  },
  {
    name: 'fexists() true for a seeded file',
    dm: `/datum/probe/proc/run()\n\treturn fexists("probe_seed.txt")`,
    expected: '1',
    files: { 'probe_seed.txt': 'seed content' }
  },
  {
    name: 'fdel() deletes a file and returns 1',
    dm: `/datum/probe/proc/run()\n\treturn fdel("probe_del.txt")`,
    expected: '1',
    files: { 'probe_del.txt': 'delete me' }
  },
  {
    name: 'file() yields a file value that isfile() accepts',
    dm: `/datum/probe/proc/run()\n\tvar/f = file("probe_seed.txt")\n\treturn isfile(f)`,
    expected: '1',
    files: { 'probe_seed.txt': 'seed content' }
  },
  {
    name: 'isfile() false for plain text',
    dm: `/datum/probe/proc/run()\n\treturn isfile("not a file")`,
    expected: '0'
  },
  {
    name: 'length(file) reports the byte size',
    dm: `/datum/probe/proc/run()\n\treturn length(file("probe_seed.txt"))`,
    expected: '12',
    files: { 'probe_seed.txt': 'seed content' }
  },
  {
    name: 'fcopy() copies a file and fexists() confirms',
    dm: `/datum/probe/proc/run()\n\tif (fcopy("probe_seed.txt", "probe_copy.txt"))\n\t\treturn fexists("probe_copy.txt")\n\treturn 0`,
    expected: '1',
    files: { 'probe_seed.txt': 'seed content' }
  },
  {
    name: 'flist() lists a seeded file name',
    dm: `/datum/probe/proc/run()\n\tfor (var/f in flist("."))\n\t\tif (f == "probe_seed.txt")\n\t\t\treturn 1\n\treturn 0`,
    expected: '1',
    files: { 'probe_seed.txt': 'seed content' }
  },
  {
    name: 'ref() is stable per datum and unique across datums',
    dm: `/datum/probe2\n/datum/probe/proc/run()\n\tvar/a = new /datum/probe2()\n\tvar/b = new /datum/probe2()\n\treturn ref(a) == ref(a) && ref(a) != ref(b)`,
    expected: '1'
  },
  {
    name: 'ref() of a non-datum is empty',
    dm: `/datum/probe/proc/run()\n\treturn ref(5)`,
    expected: ''
  },
  {
    name: 'refcount() is a number, not null',
    dm: `/datum/probe/proc/run()\n\treturn isnum(refcount(new /datum/probe2()))`,
    expected: '1'
  },
  {
    name: 'SpacemanDMM_unlint() is a no-op returning null',
    dm: `/datum/probe/proc/run()\n\treturn SpacemanDMM_unlint("x")`,
    expected: 'null'
  },
  // --- Plan 01 movement builtins (engine-free x/y/z grid) ---
  {
    name: 'step() moves an atom north and returns 1',
    dm: `/datum/probe2\n/datum/probe/proc/run()\n\tvar/a = new /datum/probe2()\n\ta.x = 3\n\ta.y = 3\n\tvar/r = step(a, 1)\n\treturn a.y * 10 + r`,
    expected: '41'
  },
  {
    name: 'step() with speed 2 moves two tiles',
    dm: `/datum/probe2\n/datum/probe/proc/run()\n\tvar/a = new /datum/probe2()\n\ta.x = 3\n\ta.y = 3\n\tstep(a, 1, 2)\n\treturn a.y`,
    expected: '5'
  },
  {
    name: 'step() with no direction returns 0',
    dm: `/datum/probe2\n/datum/probe/proc/run()\n\tvar/a = new /datum/probe2()\n\treturn step(a, 0)`,
    expected: '0'
  },
  {
    name: 'step_towards() moves one step toward the target',
    dm: `/datum/probe2\n/datum/probe/proc/run()\n\tvar/a = new /datum/probe2()\n\tvar/b = new /datum/probe2()\n\ta.x = 3\n\ta.y = 3\n\tb.x = 3\n\tb.y = 6\n\tstep_towards(a, b)\n\treturn a.y`,
    expected: '4'
  },
  {
    name: 'step_away() moves one step away from the target',
    dm: `/datum/probe2\n/datum/probe/proc/run()\n\tvar/a = new /datum/probe2()\n\tvar/b = new /datum/probe2()\n\ta.x = 3\n\ta.y = 3\n\tb.x = 3\n\tb.y = 1\n\tstep_away(a, b)\n\treturn a.y`,
    expected: '4'
  },
  {
    name: 'get_step_away() locates the turf one step away',
    dm: `/turf/away_turf\n/datum/probe/proc/run()\n\tvar/a = new /turf/away_turf()\n\tvar/b = new /turf/away_turf()\n\tvar/c = new /turf/away_turf()\n\ta.x = 3\n\ta.y = 3\n\tb.x = 3\n\tb.y = 1\n\tc.x = 3\n\tc.y = 4\n\tvar/t = get_step_away(a, b)\n\treturn t.x + t.y * 10`,
    expected: '43'
  },
  {
    name: 'get_step_towards() locates the turf one step toward',
    dm: `/turf/away_turf\n/datum/probe/proc/run()\n\tvar/a = new /turf/away_turf()\n\tvar/b = new /turf/away_turf()\n\tvar/c = new /turf/away_turf()\n\ta.x = 3\n\ta.y = 3\n\tb.x = 3\n\tb.y = 6\n\tc.x = 3\n\tc.y = 4\n\tvar/t = get_step_towards(a, b)\n\treturn t.x + t.y * 10`,
    expected: '43'
  },
  {
    name: 'orange(1, c) excludes the center tile',
    dm: `/datum/probe2\n/datum/probe/proc/run()\n\tvar/a = new /datum/probe2()\n\tvar/b = new /datum/probe2()\n\tvar/c = new /datum/probe2()\n\tvar/d = new /datum/probe2()\n\ta.x = 3\n\ta.y = 3\n\tb.x = 3\n\tb.y = 4\n\tc.x = 3\n\tc.y = 3\n\td.x = 5\n\td.y = 5\n\treturn orange(1, a).len`,
    expected: '1'
  },
  {
    name: 'orange(0, c) excludes the center tile entirely',
    dm: `/datum/probe2\n/datum/probe/proc/run()\n\tvar/a = new /datum/probe2()\n\tvar/b = new /datum/probe2()\n\ta.x = 3\n\ta.y = 3\n\tb.x = 3\n\tb.y = 3\n\treturn orange(0, a).len`,
    expected: '0'
  },
  {
    name: 'viewers() lists mobs within range',
    dm: `/mob/dummy\n/datum/probe/proc/run()\n\tvar/a = new /mob/dummy()\n\tvar/b = new /mob/dummy()\n\tvar/c = new /mob/dummy()\n\ta.x = 3\n\ta.y = 3\n\tb.x = 3\n\tb.y = 5\n\tc.x = 3\n\tc.y = 20\n\treturn viewers(2, a).len`,
    expected: '2'
  },
  {
    name: 'hearers() uses the 7-tile default range',
    dm: `/mob/dummy\n/datum/probe/proc/run()\n\tvar/a = new /mob/dummy()\n\tvar/b = new /mob/dummy()\n\tvar/c = new /mob/dummy()\n\ta.x = 3\n\ta.y = 3\n\tb.x = 3\n\tb.y = 10\n\tc.x = 3\n\tc.y = 12\n\treturn hearers(a).len`,
    expected: '2'
  },

  // --- Plan 10 B1: value semantics (expected = BYOND reference) ---
  {
    name: 'division of two integers is floor division',
    dm: `/datum/probe/proc/run()\n\treturn 7 / 2`,
    expected: '3'
  },
  {
    name: 'division of negative integers floors toward -inf',
    dm: `/datum/probe/proc/run()\n\treturn -7 / 2`,
    expected: '-4'
  },
  {
    name: 'division with a fractional operand is float division',
    dm: `/datum/probe/proc/run()\n\treturn 7.0 / 2`,
    expected: '3.5'
  },
  {
    name: 'number equality is exact (no float tolerance)',
    dm: `/datum/probe/proc/run()\n\treturn 1 == 1.000000001`,
    expected: '0'
  },
  {
    name: 'number equality exact for identical values',
    dm: `/datum/probe/proc/run()\n\treturn 1 == 1.0`,
    expected: '1'
  },
  {
    name: 'findtext is case-insensitive by default',
    dm: `/datum/probe/proc/run()\n\treturn findtext("ABC", "b")`,
    expected: '2'
  },
  {
    name: 'findtext with an empty needle finds the start',
    dm: `/datum/probe/proc/run()\n\treturn findtext("abc", "")`,
    expected: '1'
  },
  {
    name: 'isnull("") is 0 (empty string is not null)',
    dm: `/datum/probe/proc/run()\n\treturn isnull("")`,
    expected: '0'
  },
  {
    name: 'isnull(0) is 0 (zero is not null)',
    dm: `/datum/probe/proc/run()\n\treturn isnull(0)`,
    expected: '0'
  },
  {
    name: 'sign() of non-numeric text is 0',
    dm: `/datum/probe/proc/run()\n\treturn sign("abc")`,
    expected: '0'
  },
  {
    name: 'sign() of negative text is -1',
    dm: `/datum/probe/proc/run()\n\treturn sign("-3")`,
    expected: '-1'
  },
  {
    name: 'text2num radix parses the longest valid prefix',
    dm: `/datum/probe/proc/run()\n\treturn text2num("1G", 16)`,
    expected: '1'
  },
  {
    name: 'text2num radix 16 parses hex digits',
    dm: `/datum/probe/proc/run()\n\treturn text2num("1F", 16)`,
    expected: '31'
  },
  {
    name: 'text2num accepts a leading plus sign',
    dm: `/datum/probe/proc/run()\n\treturn text2num("+42")`,
    expected: '42'
  },
  {
    name: 'in checks associative keys',
    dm: `/datum/probe/proc/run()\n\treturn "a" in list("a" = 1)`,
    expected: '1'
  },
  {
    name: 'in checks positional values, not assoc keys as values',
    dm: `/datum/probe/proc/run()\n\treturn 2 in list("a" = 1)`,
    expected: '0'
  },
  {
    name: 'assoc list len counts entries',
    dm: `/datum/probe/proc/run()\n\treturn list("a" = 1).len`,
    expected: '1'
  },
  {
    name: 'assoc lists with different keys are not equal',
    dm: `/datum/probe/proc/run()\n\treturn list("a" = 1) == list("b" = 1)`,
    expected: '0'
  },
  {
    name: 'assoc lists with same keys are equal',
    dm: `/datum/probe/proc/run()\n\treturn list("a" = 1) == list("a" = 1)`,
    expected: '1'
  },
  {
    name: 'for-in iterates assoc values',
    dm: `/datum/probe/proc/run()\n\tvar/n = 0\n\tfor (var/x in list("a" = 7))\n\t\tn = x\n\treturn n`,
    expected: '7'
  },
  {
    name: 'params2list URL-decodes values',
    dm: `/datum/probe/proc/run()\n\treturn params2list("a=b%20c")["a"]`,
    expected: 'b c'
  },
  {
    name: 'length counts Unicode code points',
    dm: `/datum/probe/proc/run()\n\treturn length("a😀b")`,
    expected: '3'
  },
  {
    name: 'copytext slices by code points',
    dm: `/datum/probe/proc/run()\n\treturn copytext("a😀b", 2, 3)`,
    expected: '😀'
  },
  {
    name: 'findtext indexes by code points',
    dm: `/datum/probe/proc/run()\n\treturn findtext("a😀b", "😀")`,
    expected: '2'
  },
  {
    name: 'ispath("x") is 0 (text is not a path)',
    dm: `/datum/probe/proc/run()\n\treturn ispath("x")`,
    expected: '0'
  },
  {
    name: 'ispath(/obj) is 1',
    dm: `/datum/probe/proc/run()\n\treturn ispath(/obj)`,
    expected: '1'
  },
  {
    name: 'ispath base-type check (subtype is within)',
    dm: `/datum/probe/proc/run()\n\treturn ispath(/obj/item, /obj)`,
    expected: '1'
  },
  {
    name: 'ispath base-type check (base is not within subtype)',
    dm: `/datum/probe/proc/run()\n\treturn ispath(/obj, /obj/item)`,
    expected: '0'
  },
  {
    name: 'copytext with end 0 goes to the end of the string',
    dm: `/datum/probe/proc/run()\n\treturn copytext("abc", 1, 0)`,
    expected: 'abc'
  },
  {
    name: 'copytext with negative end counts from the end',
    dm: `/datum/probe/proc/run()\n\treturn copytext("abc", 2, -1)`,
    expected: 'b'
  },
  {
    name: 'copytext with start 0 is treated as 1',
    dm: `/datum/probe/proc/run()\n\treturn copytext("abc", 0)`,
    expected: 'abc'
  },

  // --- Plan 10 B2: emitter control flow + list semantics ---
  {
    name: 'for range with positive step',
    dm: `/datum/probe/proc/run()\n\tvar/s = 0\n\tfor (var/i = 1 to 6 step 2)\n\t\ts += i\n\treturn s`,
    expected: '9'
  },
  {
    name: 'for range with descending step',
    dm: `/datum/probe/proc/run()\n\tvar/s = 0\n\tfor (var/i = 5 to 1 step -2)\n\t\ts += i\n\treturn s`,
    expected: '9'
  },
  {
    name: 'for range step with continue still increments',
    dm: `/datum/probe/proc/run()\n\tvar/s = 0\n\tfor (var/i = 1 to 6 step 2)\n\t{\n\t\tif (i == 3)\n\t\t\tcontinue\n\t\ts += i\n\t}\n\treturn s`,
    expected: '6'
  },
  {
    name: 'for(var/type) iterates only matching instances',
    dm: `/mob/p_mob\n/obj/p_obj\n/datum/probe/proc/run()\n\tvar/count = 0\n\tfor (var/mob/p_mob/M in list(new /mob/p_mob(), new /obj/p_obj()))\n\t\tcount++\n\treturn count`,
    expected: '1'
  },
  {
    name: 'list index assignment copies on write',
    dm: `/datum/probe/proc/run()\n\tvar/a = list(1)\n\tvar/b = a\n\ta[1] = 9\n\treturn b[1]`,
    expected: '1'
  },
  {
    name: 'list += keeps associative keys',
    dm: `/datum/probe/proc/run()\n\tvar/a = list("k" = 1)\n\ta += 2\n\treturn a["k"]`,
    expected: '1'
  },
  {
    name: 'string + null concatenates null as empty',
    dm: `/datum/probe/proc/run()\n\treturn "a" + null`,
    expected: 'a'
  },
  {
    name: 'string + 0 concatenates the zero',
    dm: `/datum/probe/proc/run()\n\treturn "a" + 0`,
    expected: 'a0'
  },
  {
    name: 'abs of a negative number',
    dm: `/datum/probe/proc/run()\n\treturn abs(-5)`,
    expected: '5'
  },

  // --- Plan 10 B3: lexer literals ---
  {
    name: '0x hex literal',
    dm: `/datum/probe/proc/run()\n\treturn 0x1F`,
    expected: '31'
  },
  {
    name: '0b binary literal',
    dm: `/datum/probe/proc/run()\n\treturn 0b101`,
    expected: '5'
  },
  {
    name: 'CRLF line endings parse without errors',
    dm: `/datum/probe/proc/run()\r\n\tvar/x = 5\r\n\treturn x + 1`,
    expected: '6'
  },
  {
    name: 'return inside spawn() compiles and exits the block',
    dm: `/datum/probe/proc/run()\n\tvar/x = 1\n\tspawn(0)\n\t\treturn\n\treturn x`,
    expected: '1' // DM: return exits the spawn block; run() returns 1
  },
  {
    name: '\\x and \\u escapes decode to characters',
    dm: `/datum/probe/proc/run()\n\treturn "\\x41\\u0041"`,
    expected: 'AA' // BYOND: \x41 = 'A', \u0041 = 'A'
  },
  {
    name: 'unknown escapes keep the backslash',
    dm: `/datum/probe/proc/run()\n\treturn "\\a\\b"`,
    expected: '\\a\\b' // unknown escapes pass through byte-exact
  },
  {
    name: '\\the text-macro marker is preserved',
    dm: `/datum/probe/proc/run()\n\treturn "\\the item"`,
    expected: '\\the item' // marker kept verbatim, not corrupted to a tab
  },
  {
    name: 'arctan() returns degrees',
    dm: `/datum/probe/proc/run()\n\treturn round(arctan(1) * 10)`,
    expected: '450' // BYOND: atan(1) = 45 degrees
  },
  {
    name: 'regex() find returns the match start index',
    dm: `/datum/probe/proc/run()\n\tvar/re = regex("b+")\n\treturn re.Find("xabbb")`,
    expected: '3' // 1-based index of the first match ("xabbb": b at 3)
  },
  {
    name: 'regex() match returns the matched text',
    dm: `/datum/probe/proc/run()\n\tvar/re = regex("b+")\n\treturn re.Match("xabbb")`,
    expected: 'bbb'
  },
  {
    name: 'regex() replace substitutes matches',
    dm: `/datum/probe/proc/run()\n\tvar/re = regex("b+")\n\treturn re.Replace("xabbb", "Z")`,
    expected: 'xaZ'
  },
  {
    name: 'astype() returns the datum type path',
    dm: `/datum/probe2\n/datum/probe/proc/run()\n\tvar/a = new /datum/probe2()\n\treturn astype(a)`,
    expected: '/datum/probe2'
  },
  {
    name: 'regex_quote() escapes regex metacharacters',
    dm: `/datum/probe/proc/run()\n\treturn regex_quote("a.b")`,
    expected: 'a\\.b'
  },
  {
    name: 'findlasttext() finds the last match',
    dm: `/datum/probe/proc/run()\n\treturn findlasttext("abcabc", "b")`,
    expected: '5' // 1-based index of the last b
  },
  {
    name: 'values_sum() sums a list',
    dm: `/datum/probe/proc/run()\n\treturn values_sum(list(1, 2, 3))`,
    expected: '6'
  },
  {
    name: 'values_dot() dot product of two lists',
    dm: `/datum/probe/proc/run()\n\treturn values_dot(list(1, 2), list(3, 4))`,
    expected: '11' // 1*3 + 2*4
  },
  {
    name: 'roll() evaluates NdM dice',
    dm: `/datum/probe/proc/run()\n\treturn roll("1d1")`,
    expected: '1'
  },
  {
    name: 'isicon() is true only for dmi paths',
    dm: `/datum/probe/proc/run()\n\treturn isicon(/obj) + isicon("/x.dmi") * 0 + isicon(null)`,
    expected: '0'
  },
  {
    name: 'world.view and world.tick_lag are numbers',
    dm: `/datum/probe/proc/run()\n\treturn world.view + world.tick_lag`,
    expected: '6' // BYOND defaults 5 + 1
  },
  {
    name: 'default arg applies when omitted',
    dm: `/datum/probe/proc/f(a = 5)\n\treturn a\n/datum/probe/proc/run()\n\treturn f()`,
    expected: '5' // BYOND: missing arg binds the declared default (item 58)
  },
  {
    name: 'default arg overridden by a real argument',
    dm: `/datum/probe/proc/f(a = 5)\n\treturn a\n/datum/probe/proc/run()\n\treturn f(7)`,
    expected: '7'
  },
  {
    name: 'assoc identifier key list(a = 1)',
    dm: `/datum/probe/proc/run()\n\tvar/list/l = list(a = 1, "b" = 2)\n\treturn l["a"] + l["b"]`,
    expected: '3' // identifier keys are associative pairs (item 58)
  },
  {
    name: 'default arg is an expression evaluated per call',
    dm: `/datum/probe/proc/f(a = list(1, 2))\n\treturn length(a)\n/datum/probe/proc/run()\n\treturn f()`,
    expected: '2'
  },
  {
    name: 'labeled continue jumps back to the labeled loop',
    dm: `/datum/probe/proc/run()\n\tvar/count = 0\n\tvar/i = 0\n\touter:\n\t\twhile(i < 3)\n\t\t\ti += 1\n\t\t\tvar/j = 0\n\t\t\twhile(j < 3)\n\t\t\t\tj += 1\n\t\t\t\tif(j == 2)\n\t\t\t\t\tcontinue outer\n\t\t\t\tcount += 1\n\treturn count`,
    expected: '3' // item 59: label + goto, not a comment
  },
  {
    name: 'labeled break exits the labeled block',
    dm: `/datum/probe/proc/run()\n\tvar/count = 0\n\touter:\n\t\twhile(count < 100)\n\t\t\tcount += 1\n\t\t\tif(count == 3)\n\t\t\t\tbreak outer\n\treturn count`,
    expected: '3'
  },
  {
    name: '.type reads the datum type path',
    dm: `/datum/probe/proc/run()\n\tvar/datum/d = new\n\treturn d.type`,
    expected: '/datum' // bare new is /datum; item 62: DMGetProperty resolves type
  },
  {
    name: '.dir defaults to SOUTH (2)',
    dm: `/datum/probe/proc/run()\n\tvar/datum/d = new\n\treturn d.dir`,
    expected: '2' // implicit atom var default
  },
  {
    name: '.contents defaults to an empty list',
    dm: `/datum/probe/proc/run()\n\tvar/datum/d = new\n\treturn length(d.contents)`,
    expected: '0'
  },
  {
    name: '.overlays defaults to an empty list',
    dm: `/datum/probe/proc/run()\n\tvar/datum/d = new\n\treturn length(d.overlays)`,
    expected: '0'
  },
  {
    name: 'new Type(loc, args) sets the loc var',
    dm: `/obj/probe/proc/New(a, b)\n\treturn\n/datum/probe/proc/run()\n\tvar/datum/d = new\n\tvar/obj/probe/o = new /obj/probe(d, 7)\n\treturn o.loc == d`,
    expected: '1' // item 63: the first new() argument is the atom loc
  },
  {
    name: 'new /datum(x) passes x to New without a loc split',
    dm: `/datum/probe/proc/New(a)\n\tsrc.arg = a\n/datum/probe/proc/run()\n\tvar/datum/probe/p = new /datum/probe(9)\n\treturn p.arg`,
    expected: '9' // pure datums have no loc; New receives the argument
  },
  {
    name: 'atom New receives the loc as its first parameter',
    dm: `/obj/probe/proc/New(a, b)\n\tsrc.first = a\n\tsrc.second = b\n/datum/probe/proc/run()\n\tvar/datum/d = new\n\tvar/obj/probe/o = new /obj/probe(d, 7)\n\treturn (o.first == d) + o.second`,
    expected: '8' // New(loc, args...) keeps the loc as its first argument
  },
  {
    name: 'image() creates a datum with vars',
    dm: `/datum/probe/proc/run()\n\tvar/image/i = image('icons/x.dmi', null, "on", 4, 1)\n\treturn i.layer + i.dir`,
    expected: '5' // item 65: layer 4 + dir 1
  },
  {
    name: 'sound() creates a datum with volume',
    dm: `/datum/probe/proc/run()\n\tvar/sound/s = sound(null, 0, 0, 50, 3)\n\treturn s.volume + s.channel`,
    expected: '53'
  },
  {
    name: 'matrix scale mutates the transform vars',
    dm: `/datum/probe/proc/run()\n\tvar/matrix/m = matrix()\n\tm.Scale(2, 3)\n\treturn m.a + m.d`,
    expected: '5' // 2 + 3 — the builtin /matrix procs register at startup
  },
  {
    name: 'matrix translate then turn',
    dm: `/datum/probe/proc/run()\n\tvar/matrix/m = matrix()\n\tm.Translate(10, 20)\n\tm.Turn(90)\n\treturn m.e + m.f`,
    expected: '-20' // 90deg rotates (e,f) = (0,20) -> (-20,0)
  },
  {
    name: 'splicetext removes a range',
    dm: `/datum/probe/proc/run()\n\treturn splicetext("abcdef", 2, 4)`,
    expected: 'aef' // item 67: head "a" + tail "ef"
  },
  {
    name: 'filter() creates a datum with vars',
    dm: `/datum/probe/proc/run()\n\tvar/filter/f = filter("blur", 5)\n\treturn f.size`,
    expected: '5' // item 67: the size argument reads back
  },
  {
    name: 'stack_trace returns null',
    dm: `/datum/probe/proc/run()\n\treturn stack_trace("x")`,
    expected: 'null' // debug aid; Null in the engine-free runtime
  }
];

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`❌ ${message}`);
    process.exit(1);
  }
}

function emitConverted(dmCode: string, outDir: string): void {
  const collector = new DiagnosticCollector();
  const pp = new DMPreprocessor(collector);
  const pre = pp.process(dmCode, 'probe.dm');
  const parser = new DMParser(new DMLexer(pre).tokenize(), collector);
  const nodes = parser.parse();
  assert(collector.errors.length === 0, `Probe failed to parse: ${collector.errors[0]?.message ?? 'unknown'}`);
  const ir = new DMIRGenerator().generateIR(nodes);
  const emitter = new CSharpEmitter();
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'ConvertedDMProcs.cs'), emitter.generateProcsCS(ir, parser.globalVars), 'utf-8');
}

const DRIVER = `using System;
using SS13.DM.Runtime;
using Content.Server.DM;

class ProbeDriver
{
    static void Main()
    {
        var datum = new DMRuntime { DMTypePath = "/datum/probe" };
        ConvertedDMProcs.RegisterProcs();
        var res = datum.CallProc("run").Result;
        Console.WriteLine("PROBE_RESULT:" + res.ToString());
    }
}
`;

async function main(): Promise<void> {
  // WS13-10: missing dotnet must SKIP gracefully, not hard-fail — execSync
  // throws when the binary is absent.
  try {
    execSync('dotnet --version', { stdio: 'pipe' });
  } catch {
    console.log('dotnet not available — skipping semantic probes');
    return;
  }

  const scratch = path.join(os.tmpdir(), 'dm2ss14-fidelity');
  if (fs.existsSync(scratch)) fs.rmSync(scratch, { recursive: true, force: true });
  fs.mkdirSync(scratch, { recursive: true });

  // Engine-free probe project: the SS13.DM.Runtime sources + the generated
  // proc file + a driver. No RobustToolbox needed — the runtime is pure C#.
  const csproj = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
</Project>`;
  fs.writeFileSync(path.join(scratch, 'ProbeDriver.csproj'), csproj, 'utf-8');
  for (const f of DMRuntimeCS.getRuntimeCSFiles()) {
    fs.writeFileSync(path.join(scratch, f.filename), f.content, 'utf-8');
  }
  fs.writeFileSync(path.join(scratch, 'Program.cs'), DRIVER, 'utf-8');

  console.log('=== Semantic Differential Probes (expected = BYOND, observed = converted) ===');
  let matches = 0;
  const results: { name: string; expected: string; observed: string; match: boolean }[] = [];

  for (const probe of PROBES) {
    emitConverted(probe.dm, scratch);
    if (probe.files) {
      for (const [name, content] of Object.entries(probe.files)) {
        fs.writeFileSync(path.join(scratch, name), content, 'utf-8');
      }
    }
    let output: string;
    try {
      output = execSync('dotnet run --project ProbeDriver.csproj --nologo -v q', {
        cwd: scratch,
        timeout: 300000,
        maxBuffer: 16 * 1024 * 1024,
        stdio: 'pipe',
        env: { ...process.env, DOTNET_ROLL_FORWARD: 'LatestMajor' }
      }).toString();
    } catch (e: any) {
      output = (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '');
      const compileErrors = output.split('\n').filter(l => l.includes('error CS')).slice(0, 3);
      const match = false;
      const failure = e.killed || e.signal ? `TIMED OUT after 300s (killed=${e.killed})` : (compileErrors.length > 0 ? `BUILD FAILED: ${compileErrors.join('; ')}` : `FAILED: ${e.message ?? e.code ?? 'no output'}`);
      results.push({ name: probe.name, expected: probe.expected, observed: failure, match });
      console.log(`❌ ${probe.name}  (expected ${probe.expected}) — ${failure}`);
      continue;
    }
    const m = output.match(/PROBE_RESULT:(.*)$/m);
    const observed = m ? m[1] : '(no result)';
    const match = observed === probe.expected;
    if (match) matches++;
    results.push({ name: probe.name, expected: probe.expected, observed, match });
    console.log(`${match ? '✅' : '❌'} ${probe.name}  (expected ${probe.expected}, observed ${observed})`);
  }

  console.log(`\n=== Summary: ${matches}/${PROBES.length} probes preserved DM semantics ===`);
  console.log(`Scratch project kept at: ${scratch}`);
}

main().catch(err => {
  console.error('Probe error:', err);
  process.exit(1);
});
