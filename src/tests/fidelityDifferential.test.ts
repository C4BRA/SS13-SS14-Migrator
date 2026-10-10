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
  },

  // --- Plan 16 B-2: world/tick/time layer (item 70) ---
  {
    name: 'sleep(n) waits n deciseconds on the world clock',
    dm: `/datum/probe/proc/run()\n\tvar/t0 = world.time\n\tsleep(3)\n\treturn world.time - t0`,
    expected: '3' // DM: world.time = server ticks × tick_lag (0.3s game time)
  },
  {
    name: 'world.time stays on the tick grid',
    dm: `/datum/probe/proc/run()\n\tsleep(1)\n\treturn world.time`,
    expected: '1' // tick_lag 1: wake fires on the first tick boundary, time=1
  },
  {
    name: 'spawn body runs after its delay',
    dm: `/datum/probe/proc/run()\n\tvar/x = 0\n\tspawn(2)\n\t\tx = 1\n\tsleep(4)\n\treturn x`,
    expected: '1' // spawn(2) fires ~0.2s in; sleep(4) outlasts it
  },
  {
    name: 'same-tick spawns run in call order (FIFO)',
    dm: `/datum/probe/proc/run()\n\tvar/x = 0\n\tspawn(1)\n\t\tx += 2\n\tspawn(1)\n\t\tx *= 10\n\tsleep(3)\n\treturn x`,
    expected: '20' // BYOND wakes same-tick procs in sleep order: +2 then *10
  },
  {
    name: 'spawn(0) runs before a sleep(1) finishes',
    dm: `/datum/probe/proc/run()\n\tvar/x = 0\n\tspawn(0)\n\t\tx = 1\n\tsleep(1)\n\treturn x`,
    expected: '1' // DM: spawn(0) queues at the end of the current scheduler pass
  },
  {
    name: 'sleep is deciseconds not ticks (tick_lag conversion)',
    dm: `/datum/probe/proc/run()\n\tworld.tick_lag = 0.5\n\tsleep(1)\n\treturn world.time`,
    expected: '1' // sleep(1) = 1ds = 2 ticks at lag 0.5; world.time = 2×0.5 = 1
  },
  {
    name: 'world.fps and world.tick_lag are linked',
    dm: `/datum/probe/proc/run()\n\tworld.tick_lag = 0.5\n\treturn world.fps`,
    expected: '20' // BYOND: fps = 10/tick_lag
  },
  {
    name: 'world.realtime is ds since the BYOND era',
    dm: `/datum/probe/proc/run()\n\treturn isnum(world.realtime) && world.realtime > 1000000`,
    expected: '1' // BYOND era: deciseconds since 2000-01-01 00:00:00 GMT
  },
  {
    name: 'world.Tick() fires once per world tick',
    dm: `/global/var/ticks = 0\n/world/proc/Tick()\n\tGLOB.ticks += 1\n/datum/probe/proc/run()\n\tsleep(3)\n\treturn GLOB.ticks`,
    expected: '2' // BYOND 515+: world.Tick() runs at the END of each tick — a
    // proc woken at tick 3's boundary reads ticks=2 (tick 3's Tick has not
    // fired yet); verified ordering: wakes happen before the same tick's Tick()
  },
  // ==== Item 69 (B-1): containment / loc / position probes ====
  {
    name: 'new /obj inside a container lands in its contents',
    dm: `/obj/box\n/obj/item/thing\n/datum/probe/proc/run()\n\tvar/obj/box/b = new /obj/box\n\tvar/obj/item/thing/i = new /obj/item/thing(b)\n\treturn b.contents.len`,
    expected: '1' // BYOND: contents membership derives from loc
  },
  {
    name: 'x.loc reads back the container datum',
    dm: `/obj/box\n/obj/item/thing\n/datum/probe/proc/run()\n\tvar/obj/box/b = new /obj/box\n\tvar/obj/item/thing/i = new /obj/item/thing(b)\n\treturn i.loc == b`,
    expected: '1'
  },
  {
    name: 'loc setter moves between containers',
    dm: `/obj/box\n/obj/box/second\n/obj/item/thing\n/datum/probe/proc/run()\n\tvar/obj/box/a = new /obj/box\n\tvar/obj/box/second/b = new /obj/box/second\n\tvar/obj/item/thing/i = new /obj/item/thing(a)\n\ti.loc = b\n\treturn a.contents.len * 10 + b.contents.len`,
    expected: '1' // a loses the item (0*10) and b gains it (+1)
  },
  {
    name: 'loc = null empties the old container',
    dm: `/obj/box\n/obj/item/thing\n/datum/probe/proc/run()\n\tvar/obj/box/b = new /obj/box\n\tvar/obj/item/thing/i = new /obj/item/thing(b)\n\ti.loc = null\n\treturn b.contents.len`,
    expected: '0'
  },
  {
    name: 'x/y/z vars read and write as numbers',
    dm: `/obj/probe2\n/datum/probe/proc/run()\n\tvar/obj/probe2/o = new /obj/probe2\n\to.x = 4\n\to.y = 6\n\to.z = 2\n\treturn o.x + o.y * 10 + o.z * 100`,
    expected: '264'
  },
  {
    name: 'turf contents finds a positioned atom',
    dm: `/turf/floor_t\n/obj/item/thing\n/datum/probe/proc/run()\n\tvar/turf/floor_t/t = new /turf/floor_t\n\tt.x = 5\n\tt.y = 5\n\tt.z = 1\n\tvar/obj/item/thing/i = new /obj/item/thing\n\ti.x = 5\n\ti.y = 5\n\ti.z = 1\n\treturn t.contents.len`,
    expected: '1' // no explicit loc — positional turf membership (item 69)
  },
  {
    name: 'atom .loc resolves to the turf at its position',
    dm: `/turf/floor_t\n/obj/item/thing\n/datum/probe/proc/run()\n\tvar/turf/floor_t/t = new /turf/floor_t\n\tt.x = 5\n\tt.y = 5\n\tt.z = 1\n\tvar/obj/item/thing/i = new /obj/item/thing\n\ti.x = 5\n\ti.y = 5\n\ti.z = 1\n\treturn i.loc == t`,
    expected: '1'
  },
  {
    name: 'Enter/Entered hooks fire on loc set',
    dm: `/obj/box\n\tvar/entered_count = 0\n\tproc/Entered(m)\n\t\tentered_count++\n/obj/item/thing\n/datum/probe/proc/run()\n\tvar/obj/box/b = new /obj/box\n\tvar/obj/item/thing/i = new /obj/item/thing\n\ti.loc = b\n\treturn b.entered_count`,
    expected: '1'
  },
  {
    name: 'Exit/Exited hooks fire on loc clear',
    dm: `/obj/box\n\tvar/exited_count = 0\n\tproc/Exited(m)\n\t\texited_count++\n/obj/item/thing\n/datum/probe/proc/run()\n\tvar/obj/box/b = new /obj/box\n\tvar/obj/item/thing/i = new /obj/item/thing(b)\n\ti.loc = null\n\treturn b.exited_count`,
    expected: '1'
  },
  {
    name: 'iterating an atom iterates its contents',
    dm: `/obj/box\n/obj/item/thing\n/datum/probe/proc/run()\n\tvar/obj/box/b = new /obj/box\n\tvar/obj/item/thing/i = new /obj/item/thing(b)\n\tvar/count = 0\n\tfor (var/o in b)\n\t\tcount++\n\treturn count`,
    expected: '1'
  },
  {
    name: 'x write crossing a turf boundary updates loc',
    dm: `/turf/floor_t\n/obj/item/thing\n/datum/probe/proc/run()\n\tvar/turf/floor_t/t1 = new /turf/floor_t\n\tt1.x = 5\n\tt1.y = 5\n\tt1.z = 1\n\tvar/turf/floor_t/t2 = new /turf/floor_t\n\tt2.x = 6\n\tt2.y = 5\n\tt2.z = 1\n\tvar/obj/item/thing/i = new /obj/item/thing\n\ti.x = 5\n\ti.y = 5\n\ti.z = 1\n\ti.loc = t1\n\ti.x = 6\n\treturn i.loc == t2`,
    expected: '1'
  },

  // --- Tier-4 builtins (docs/plans/17-remaining-builtins.md) ---
  {
    name: 'file2text() reads a seeded file',
    dm: `/datum/probe/proc/run()\n\treturn file2text("probe_f2t.txt")`,
    expected: 'file body',
    files: { 'probe_f2t.txt': 'file body' }
  },
  {
    name: 'file2text() of a missing file is null',
    dm: `/datum/probe/proc/run()\n\treturn file2text("probe_f2t_missing.txt")`,
    expected: 'null'
  },
  {
    name: 'text2file() writes then file2text() reads back',
    dm: `/datum/probe/proc/run()\n\ttext2file("hi", "probe_t2f.txt")\n\treturn file2text("probe_t2f.txt")`,
    expected: 'hi'
  },
  {
    name: 'md5() returns lowercase hex',
    dm: `/datum/probe/proc/run()\n\treturn md5("abc")`,
    expected: '900150983cd24fb0d6963f7d28e17f72'
  },
  {
    name: 'addtext() concatenates the text form of every arg',
    dm: `/datum/probe/proc/run()\n\treturn addtext("a", 1, "b")`,
    expected: 'a1b'
  },
  {
    name: 'trimtext() strips surrounding whitespace',
    dm: `/datum/probe/proc/run()\n\treturn trimtext("  x  ")`,
    expected: 'x'
  },
  {
    name: 'cmptext() compares case-insensitively',
    dm: `/datum/probe/proc/run()\n\treturn cmptext("abc", "ABC")`,
    expected: '1'
  },
  {
    name: 'cmptextEx() compares case-sensitively',
    dm: `/datum/probe/proc/run()\n\treturn cmptextEx("abc", "ABC")`,
    expected: '0'
  },
  {
    name: 'findtext_char() is char-based (code points)',
    dm: `/datum/probe/proc/run()\n\treturn findtext_char("a😀b", "😀")`,
    expected: '2'
  },
  {
    name: 'findlasttext_char() finds the last match',
    dm: `/datum/probe/proc/run()\n\treturn findlasttext_char("abcabc", "b")`,
    expected: '5'
  },
  {
    name: 'splittext_char() splits into a list',
    dm: `/datum/probe/proc/run()\n\tvar/L = splittext_char("a,b,c", ",")\n\treturn L.len`,
    expected: '3'
  },
  {
    name: 'nonspantext() returns offset to first needle char',
    dm: `/datum/probe/proc/run()\n\treturn nonspantext("abc1", "0123456789")`,
    expected: '3'
  },
  {
    name: 'spantext() counts the leading needle-char run',
    dm: `/datum/probe/proc/run()\n\treturn spantext("112a", "0123456789")`,
    expected: '3'
  },
  {
    name: 'url_encode() percent-encodes',
    dm: `/datum/probe/proc/run()\n\treturn url_encode("a b&c")`,
    expected: 'a%20b%26c'
  },
  {
    name: 'url_decode() reverses url_encode',
    dm: `/datum/probe/proc/run()\n\treturn url_decode("a%20b%26c")`,
    expected: 'a b&c'
  },
  {
    name: 'ckeyEx() preserves case and -_ punctuation',
    dm: `/datum/probe/proc/run()\n\treturn ckeyEx("OhSoWe'ReKeeping!MyCapitalLetters?Now")`,
    expected: 'OhSoWeReKeepingMyCapitalLettersNow' // BYOND ref example
  },
  {
    name: 'sorttextEx() compares case-sensitively',
    dm: `/datum/probe/proc/run()\n\treturn sorttextEx("b", "A")`,
    expected: '1' // case-sensitive ordinal: "b" sorts after "A"
  },
  {
    name: 'text2ascii_char() returns char code',
    dm: `/datum/probe/proc/run()\n\treturn text2ascii_char("ABC", 2)`,
    expected: '66'
  },
  {
    name: 'lerp() interpolates linearly',
    dm: `/datum/probe/proc/run()\n\treturn lerp(0, 10, 0.5)`,
    expected: '5'
  },
  {
    name: 'trunc() truncates toward zero',
    dm: `/datum/probe/proc/run()\n\treturn trunc(-3.7)`,
    expected: '-3'
  },
  {
    name: 'tan() takes degrees (tan 45 = 1)',
    dm: `/datum/probe/proc/run()\n\treturn round(tan(45) * 100)`,
    expected: '100'
  },
  {
    name: 'arcsin() returns degrees (asin 0.5 = 30)',
    dm: `/datum/probe/proc/run()\n\treturn round(arcsin(0.5) * 10)`,
    expected: '300'
  },
  {
    name: 'ohearers() excludes the center mob',
    dm: `/mob/dummy\n/datum/probe/proc/run()\n\tvar/a = new /mob/dummy()\n\tvar/b = new /mob/dummy()\n\ta.x = 3\n\ta.y = 3\n\tb.x = 3\n\tb.y = 5\n\treturn ohearers(7, a).len`,
    expected: '1' // hearers would report 2; ohearers drops the center
  },
  {
    name: 'bounds_dist() is 0 between adjacent atoms',
    dm: `/datum/probe2\n/datum/probe/proc/run()\n\tvar/a = new /datum/probe2()\n\tvar/b = new /datum/probe2()\n\ta.x = 3\n\ta.y = 3\n\tb.x = 4\n\tb.y = 3\n\treturn bounds_dist(a, b)`,
    expected: '0' // neighbouring 32px boxes touch
  },
  {
    name: 'generator("num") returns a value in [A,B]',
    dm: `/datum/probe/proc/run()\n\tvar/g = generator("num", 5, 5)\n\treturn g.Rand()`,
    expected: '5' // degenerate bounds return the constant
  },
  {
    name: 'findtextEx_char() is case-sensitive and char-based',
    dm: `/datum/probe/proc/run()\n\treturn findtextEx_char("aBc", "c")`,
    expected: '3'
  },
  {
    name: 'replacetext_char() replaces literally',
    dm: `/datum/probe/proc/run()\n\treturn replacetext_char("one two", "two", "2")`,
    expected: 'one 2'
  },
  // ==== B-3 appearance probes (item 71) — engine-free datum semantics ====
  {
    name: 'atom .alpha defaults to 255',
    dm: `/datum/probe/proc/run()\n\tvar/obj/o = new /obj()\n\treturn o.alpha`,
    expected: '255'
  },
  {
    name: 'atom .mouse_opacity defaults to 1',
    dm: `/datum/probe/proc/run()\n\tvar/obj/o = new /obj()\n\treturn o.mouse_opacity`,
    expected: '1'
  },
  {
    name: 'atom .layer defaults: obj 3 / mob 4 / turf 1',
    dm: `/datum/probe/proc/run()\n\tvar/obj/o = new /obj()\n\tvar/mob/m = new /mob()\n\tvar/turf/t = new /turf()\n\treturn o.layer + m.layer + t.layer`,
    expected: '8'
  },
  {
    name: 'atom .invisibility and .opacity default to 0',
    dm: `/datum/probe/proc/run()\n\tvar/obj/o = new /obj()\n\treturn o.invisibility + o.opacity`,
    expected: '0'
  },
  {
    name: 'atom .pixel_x/.pixel_y default to 0',
    dm: `/datum/probe/proc/run()\n\tvar/obj/o = new /obj()\n\treturn o.pixel_x + o.pixel_y`,
    expected: '0'
  },
  {
    name: 'atom .icon_state defaults to empty string',
    dm: `/datum/probe/proc/run()\n\tvar/obj/o = new /obj()\n\treturn o.icon_state == ""`,
    expected: '1'
  },
  {
    name: 'atom .underlays defaults to an empty list',
    dm: `/datum/probe/proc/run()\n\tvar/obj/o = new /obj()\n\treturn o.underlays.len`,
    expected: '0'
  },
  {
    name: 'appearance vars read back after write',
    dm: `/datum/probe/proc/run()\n\tvar/obj/o = new /obj()\n\to.alpha = 64\n\to.pixel_x = -7\n\to.color = "#ff00ff"\n\treturn o.alpha + o.pixel_x + (o.color == "#ff00ff")`,
    expected: '58'
  },
  {
    name: 'overlays += adds a text icon_state entry',
    dm: `/datum/probe/proc/run()\n\tvar/obj/o = new /obj()\n\to.overlays += "glow"\n\treturn o.overlays.len`,
    expected: '1'
  },
  {
    name: 'underlays += adds an entry',
    dm: `/datum/probe/proc/run()\n\tvar/obj/o = new /obj()\n\to.underlays += "shadow"\n\treturn o.underlays.len`,
    expected: '1'
  },
  {
    name: 'animate() with time=0 applies the named var',
    dm: `/datum/probe/proc/run()\n\tvar/obj/o = new /obj()\n\tanimate(o, alpha = 0, time = 0)\n\tsleep(2)\n\treturn o.alpha`,
    expected: '0'
  },
  {
    name: 'animate() tween completes after duration',
    dm: `/datum/probe/proc/run()\n\tvar/obj/o = new /obj()\n\tanimate(o, pixel_x = 10, time = 1)\n\tsleep(4)\n\treturn o.pixel_x`,
    expected: '10'
  },
  {
    name: 'animate() named args do not write caller vars',
    dm: `/datum/probe/proc/run()\n\tvar/obj/o = new /obj()\n\tanimate(o, alpha = 5, time = 0)\n\tsleep(2)\n\treturn isnull(src.alpha) ? o.alpha : -1`,
    expected: '5'
  },
  {
    name: 'flick() swaps icon_state then restores it',
    dm: `/datum/probe/proc/run()\n\tvar/obj/o = new /obj()\n\to.icon_state = "base"\n\tflick("hit", o)\n\tvar/mid = o.icon_state\n\tsleep(4)\n\treturn mid + o.icon_state`,
    expected: 'hitbase'
  },
  {
    name: 'image() named args set vars on the image datum',
    dm: `/datum/probe/proc/run()\n\tvar/image/im = image("x.dmi", icon_state = "hit", pixel_x = 4)\n\treturn im.icon_state + im.pixel_x`,
    expected: 'hit4'
  },
  {
    name: 'flick() of an /image adds then removes an overlay',
    dm: `/datum/probe/proc/run()\n\tvar/obj/o = new /obj()\n\tvar/image/im = image("x.dmi", icon_state = "hit")\n\tflick(im, o)\n\tvar/mid = o.overlays.len\n\tsleep(4)\n\treturn mid * 10 + o.overlays.len`,
    expected: '10'
  },
  // ==== B-4 probes (item 72): << dispatch + verb runtime ====
  {
    // `x << y` picks semantics by LHS type: list appends, numbers shift,
    // datum targets route through the output path (engine-free -> console,
    // and the operator evaluates to the message).
    name: '<< dispatches: list appends, numbers shift-assign, datum output returns target',
    dm: `/datum/probe/proc/run()\n\tvar/x = 4\n\tx << 2\n\tvar/list/L = list(1)\n\tL << 5\n\tvar/m = (world << "hi")\n\treturn "[x]|[L.len]|[L[2]]|[istype(m,/world)]"`,
    expected: '16|2|5|1'
  },
  {
    name: 'src << chains (returns the datum for the next <<)',
    dm: `/datum/probe/proc/run()\n\tvar/m = (src << "a" << "b")\n\treturn istype(m, /datum/probe)`,
    expected: '1'
  },
  {
    // Verb dispatch: CallVerbAsUsr runs the target datum's proc with
    // src = the verb's datum and usr = the *caller's* mob — BYOND's verb
    // semantics for verbs that live on other atoms.
    name: 'DMVerbRuntime.CallVerbAsUsr binds src=target, usr=caller mob',
    dm: '/datum/probe/proc/run()\n\treturn DMValue.Null',
    expected: 'src=/mob/probe;usr=/mob/player;msg=hi',
    files: {
      'ConvertedDMProcs.cs': `using System;
using System.Threading.Tasks;
using SS13.DM.Runtime;

namespace Content.Server.DM
{
public static class ConvertedDMProcs
{
    public static void RegisterProcs()
    {
        ProcRegistry.Register("/mob/probe", "hello", Proc_MobProbe_Hello, new[] { "msg" });
        ProcRegistry.Register("/datum/probe", "run", Proc_DatumProbe_Run);
    }
    public static async Task<DMValue> Proc_MobProbe_Hello(DMRuntime comp, DMValue[] args)
    {
        var usr = DMRuntimeHelpers.CurrentUsr.DatumRef as DMRuntime;
        return DMValue.FromString("src=" + comp.DMTypePath + ";usr=" + (usr?.DMTypePath ?? "null") + ";msg=" + (args.Length > 0 ? args[0].ToString() : ""));
    }
    public static async Task<DMValue> Proc_DatumProbe_Run(DMRuntime comp, DMValue[] args)
    {
        var mob = new DMRuntime { DMTypePath = "/mob/probe" };
        var usr = new DMRuntime { DMTypePath = "/mob/player" };
        return await DMVerbRuntime.CallVerbAsUsr(mob, usr, "hello", DMValue.FromString("hi"));
    }
}
}`
    }
  },
  {
    // Command-style named args: `dmverb hello msg=named` collapses into a
    // single assoc list; CallVerbAsUsr binds it onto the callee's parameter
    // names (BYOND arglist semantics).
    name: 'verb named-arg binding via assoc list (k=v -> param names)',
    dm: '/datum/probe/proc/run()\n\treturn DMValue.Null',
    expected: 'msg=named',
    files: {
      'ConvertedDMProcs.cs': `using System;
using System.Threading.Tasks;
using SS13.DM.Runtime;

namespace Content.Server.DM
{
public static class ConvertedDMProcs
{
    public static void RegisterProcs()
    {
        ProcRegistry.Register("/mob/probe", "hello", Proc_MobProbe_Hello, new[] { "msg" });
        ProcRegistry.Register("/datum/probe", "run", Proc_DatumProbe_Run);
    }
    public static async Task<DMValue> Proc_MobProbe_Hello(DMRuntime comp, DMValue[] args)
    {
        comp.SetVar("msg", args.Length > 0 ? args[0] : DMValue.Null);
        return DMValue.FromString("msg=" + comp.GetVar("msg").ToString());
    }
    public static async Task<DMValue> Proc_DatumProbe_Run(DMRuntime comp, DMValue[] args)
    {
        var mob = new DMRuntime { DMTypePath = "/mob/probe" };
        var named = new DMList();
        named.SetAssoc("msg", DMValue.FromString("named"));
        return await DMVerbRuntime.CallVerbAsUsr(mob, mob, "hello", DMValue.FromList(named));
    }
}
}`
    }
  },
  // ==== Fidelity wave-2 probes (docs/plans/25) — locate + movement + misc ====
  {
    name: 'locate(x,y,z) returns the turf at those coords',
    dm: `/datum/probe/proc/run()\n\tvar/turf/t = new /turf()\n\tt.x = 12\n\tt.y = 34\n\tt.z = 1\n\treturn locate(12, 34, 1) == t`,
    expected: '1'
  },
  {
    name: 'locate(/type) finds the first live datum of that type',
    dm: `/datum/probe/proc/run()\n\tvar/datum/probe/d = new /datum/probe()\n\treturn locate(/datum/probe) == d`,
    expected: '1'
  },
  {
    name: 'locate(X, container) searches contents recursively',
    dm: `/datum/probe/proc/run()\n\tvar/obj/c = new /obj()\n\tvar/obj/i = new /obj()\n\ti.loc = c\n\treturn locate(i, c) == i`,
    expected: '1'
  },
  {
    name: 'locate misses return null',
    dm: `/datum/probe/proc/run()\n\treturn locate(77, 77, 77)`,
    expected: 'null'
  },
  {
    name: 'step_to moves one step toward the target',
    dm: `/datum/probe/proc/run()\n\tvar/mob/m = new /mob()\n\tvar/mob/t = new /mob()\n\tm.x = 10\n\tm.y = 10\n\tt.x = 14\n\tt.y = 10\n\tstep_to(m, t)\n\treturn m.x`,
    expected: '11'
  },
  {
    name: 'step_to inside trange returns 1 without moving',
    dm: `/datum/probe/proc/run()\n\tvar/mob/m = new /mob()\n\tvar/mob/t = new /mob()\n\tm.x = 10\n\tm.y = 10\n\tt.x = 12\n\tt.y = 10\n\tstep_to(m, t, 5)\n\treturn m.x`,
    expected: '10'
  },
  {
    name: 'step_rand lands on an adjacent tile',
    dm: `/datum/probe/proc/run()\n\tvar/mob/m = new /mob()\n\tm.x = 20\n\tm.y = 20\n\tstep_rand(m)\n\treturn (abs(m.x - 20) <= 1) && (abs(m.y - 20) <= 1) && (m.x != 20 || m.y != 20)`,
    expected: '1'
  },
  {
    name: 'walk() keeps stepping the atom each tick',
    dm: `/datum/probe/proc/run()\n\tvar/mob/m = new /mob()\n\tm.x = 30\n\tm.y = 30\n\twalk(m, 4, 1)\n\tsleep(3)\n\treturn m.x - 30`,
    expected: '2' // dir 4 steps +x each tick; the proc resumes ahead of the same-tick step
  },
  {
    name: 'walk(Ref,0) stops a prior walk',
    dm: `/datum/probe/proc/run()\n\tvar/mob/m = new /mob()\n\tm.x = 40\n\tm.y = 40\n\twalk(m, 4, 1)\n\tsleep(2)\n\twalk(m, 0)\n\tvar/at = m.x\n\tsleep(2)\n\treturn m.x - at`,
    expected: '0' // no further steps after the stop
  },
  {
    name: 'ASSERT on a true condition does not abort the proc',
    dm: `/datum/probe/proc/run()\n\tASSERT(1)\n\treturn 7`,
    expected: '7'
  },
  {
    name: 'EXCEPTION() produces an /exception datum with message vars',
    dm: `/datum/probe/proc/run()\n\tvar/e = EXCEPTION("boom")\n\treturn e.desc`,
    expected: 'boom' // throw/catch binding of the datum is emitter-owned
  },
  {
    name: 'fract() returns the fractional part',
    dm: `/datum/probe/proc/run()\n\treturn fract(1.75)`,
    expected: '0.75'
  },
  {
    name: 'fract() of a negative keeps the sign',
    dm: `/datum/probe/proc/run()\n\treturn fract(-2.5)`,
    expected: '-0.5'
  },
  {
    name: 'sha1() hashes text deterministically',
    dm: `/datum/probe/proc/run()\n\treturn sha1("abc")`,
    expected: 'a9993e364706816aba3e25717850c26c9cd0d89d'
  },
  {
    name: 'num2hex() formats lowercase hex with padding',
    dm: `/datum/probe/proc/run()\n\treturn num2hex(255, 4)`,
    expected: '00ff'
  },
  {
    name: 'values_cut_under sums the amounts under the bound',
    dm: `/datum/probe/proc/run()\n\treturn values_cut_under(list(3, 8), 5)`,
    expected: '2'
  },
  {
    name: 'values_cut_over sums the amounts over the bound',
    dm: `/datum/probe/proc/run()\n\treturn values_cut_over(list(3, 8), 5)`,
    expected: '3'
  },
  {
    name: 'spantext_char() counts the leading needle-char run',
    dm: `/datum/probe/proc/run()\n\treturn spantext_char("bbba", "b")`,
    expected: '3' // delegates to the spantext convention (run length)
  },
  {
    name: 'replacetextEx_char() replaces case-sensitively',
    dm: `/datum/probe/proc/run()\n\treturn replacetextEx_char("one ONE", "one", "1")`,
    expected: '1 ONE'
  },
  {
    name: 'shutdown() returns null without throwing',
    dm: `/datum/probe/proc/run()\n\treturn shutdown()`,
    expected: 'null'
  },
  {
    name: 'vector() exposes x/y/z vars',
    dm: `/datum/probe/proc/run()\n\tvar/v = vector(1, 2, 3)\n\treturn v.y`,
    expected: '2'
  },
  {
    name: 'gradient() returns a /gradient datum',
    dm: `/datum/probe/proc/run()\n\tvar/g = gradient()\n\treturn istype(g, /gradient)`,
    expected: '1'
  },
  // ==== W-A parent-call (item 22): defining-type probes ====
  {
    // Subtype override -> base's ..() must reach the GRANDPARENT once.
    // Anchoring at the concrete type re-found /datum/mid/stamp and recursed
    // forever (the pre-22 stack-overflow bug).
    name: '..() subtype override chains to grandparent once',
    dm: `/datum
	var/hits
	proc/stamp()
		src.hits += 1
/datum/mid
	proc/stamp()
		..()
		src.hits += 10
/datum/mid/leaf
	proc/stamp()
		..()
		src.hits += 100
/datum/probe
	proc/run()
		var/datum/mid/leaf/d = new /datum/mid/leaf()
		d.hits = 0
		d.stamp()
		return d.hits`,
    expected: '111'
  },
  {
    // '..()' inside a body only the BASE defines, invoked on a subtype
    // instance, resolves parent-of-defining — not parent-of-instance.
    name: '..() inside base-defined body on subtype instance',
    dm: `/datum
	proc/who()
		return 1
/datum/mid2
	proc/who()
		return ..() + 10
/datum/mid2/leaf2
	var/dummy = 1
/datum/probe
	proc/run()
		var/datum/mid2/leaf2/d = new /datum/mid2/leaf2()
		return d.who()`,
    expected: '11'
  },
  {
    name: '..() with explicit args binds positionally on the parent',
    dm: `/datum
	proc/addem(a, b)
		return a + b
/datum/mid3
	proc/addem(a, b)
		return ..(a * 2, b + 1)
/datum/probe
	proc/run()
		var/datum/mid3/d = new /datum/mid3()
		return d.addem(3, 4)`,
    expected: '11'
  },
  {
    // '..(x = v)' named args bind to the RESOLVED ancestor's param names,
    // not positionally and not to the child's params.
    name: '..() named args bind by name on the resolved parent',
    dm: `/datum
	proc/subt(a, b)
		return a - b
/datum/mid4
	proc/subt(a, b)
		return ..(b = 10, a = 2)
/datum/probe
	proc/run()
		var/datum/mid4/d = new /datum/mid4()
		return d.subt(0, 0)`,
    expected: '-8'
  },
  {
    // BYOND: '..()' with no arguments forwards the current proc's argument
    // values — the parent sees what the override was called with.
    name: '..() with no args forwards current arg values',
    dm: `/datum
	proc/ident(x)
		return x
/datum/mid5
	proc/ident(x)
		return ..() + 1
/datum/probe
	proc/run()
		var/datum/mid5/d = new /datum/mid5()
		return d.ident(41)`,
    expected: '42'
  },
  {
    // Verbs register under the same (type, name) key; ..() in a verb body
    // anchors at the declaring type like any proc.
    name: '..() in a verb body resolves parent-of-defining',
    dm: `/datum/proc/vtest()
	src.v = 1
/datum/probe/verb/vtest()
	..()
	src.v += 10
/datum/probe/proc/run()
	src.v = 0
	src.vtest()
	return src.v`,
    expected: '11'
  },
  {
    // No ancestor implementation and no /proc fallback: BYOND ..() is null.
    name: '..() at top of the type chain returns null',
    dm: `/datum/probe/proc/run()
	return ..() == null`,
    expected: '1'
  },
  // ==== W-G input (docs/plans/28): type var defaults seeded at DMNew ====
  {
    name: 'datum name seeded from declared type default',
    dm: `/datum/probe/proc/run()
	var/m = new /obj/wgtest_named()
	return m.name
/obj/wgtest_named
	name = "named thing"`,
    expected: 'named thing'
  },
  {
    name: 'datum name inherits ancestor declared name',
    dm: `/datum/probe/proc/run()
	var/m = new /obj/wgtest_base/child()
	return m.name
/obj/wgtest_base
	name = "ancestor name"
/obj/wgtest_base/child`,
    expected: 'ancestor name'
  },
  {
    name: 'datum name defaults to type basename',
    dm: `/datum/probe/proc/run()
	var/m = new /obj/wgtest_basename()
	return m.name
/obj/wgtest_basename`,
    expected: 'wgtest_basename'
  },
  {
    name: 'runtime var write wins over seeded default',
    dm: `/datum/probe/proc/run()
	var/m = new /obj/wgtest_over()
	m.name = "written"
	return m.name
/obj/wgtest_over
	name = "seeded"`,
    expected: 'written'
  },
  {
    name: 'scalar custom var seeded from type default',
    dm: `/datum/probe/proc/run()
	var/m = new /obj/wgtest_scalar()
	return m.power
/obj/wgtest_scalar
	var/power = 42`,
    expected: '42'
  },
  {
    name: 'desc seeded from declared type default',
    dm: `/datum/probe/proc/run()
	var/m = new /obj/wgtest_desc()
	return m.desc
/obj/wgtest_desc
	desc = "a describer"`,
    expected: 'a describer'
  },
  {
    name: 'initial() reads the seeded type default after write',
    dm: `/datum/probe/proc/run()
	var/m = new /obj/wgtest_ini()
	m.name = "mutated"
	return initial(m.name)
/obj/wgtest_ini
	name = "initial name"`,
    expected: 'initial name'
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
