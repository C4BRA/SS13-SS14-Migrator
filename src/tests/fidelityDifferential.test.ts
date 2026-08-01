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
    expected: '[list]' // DM: list(1,2,3)
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
    dm: `/datum\n\tproc/hello()\n\t\tsrc.mark = 9\n/datum/probe\n\tproc/hello()\n\t\t..()\n\t\treturn src.mark`,
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
  fs.writeFileSync(path.join(outDir, 'ConvertedDMProcs.cs'), emitter.generateProcsCS(ir), 'utf-8');
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
  const dotnetCheck = execSync('dotnet --version', { stdio: 'pipe' });
  if (!dotnetCheck) {
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
    let output: string;
    try {
      output = execSync('dotnet run --project ProbeDriver.csproj --nologo -v q', {
        cwd: scratch,
        timeout: 180000,
        maxBuffer: 16 * 1024 * 1024,
        stdio: 'pipe',
        env: { ...process.env, DOTNET_ROLL_FORWARD: 'LatestMajor' }
      }).toString();
    } catch (e: any) {
      output = (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '');
      const compileErrors = output.split('\n').filter(l => l.includes('error CS')).slice(0, 3);
      const match = false;
      results.push({ name: probe.name, expected: probe.expected, observed: `BUILD FAILED: ${compileErrors.join('; ')}`, match });
      console.log(`❌ ${probe.name}  (expected ${probe.expected}) — BUILD FAILED ${compileErrors.length > 0 ? compileErrors[0].trim() : ''}`);
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
