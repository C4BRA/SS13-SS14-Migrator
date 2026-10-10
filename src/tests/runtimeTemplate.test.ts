// Integrity guard for the C# runtime sources copied into every generated
// solution (runtime/SS13.DM.Runtime/*.cs).

import { DMRuntimeCS } from '../runtimeTemplate/dmRuntimeCS.js';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ TEST FAILED: ${message}`);
    process.exit(1);
  } else {
    console.log(`✅ ${message}`);
  }
}

const EXPECTED_FILES = ['DMValue.cs', 'DMList.cs', 'DMRuntime.cs', 'DMTickScheduler.cs', 'DMRuntimeHelpers.cs',
  'DMCore.cs', 'DMBuiltinTypes.cs', 'RustGAdapterStubs.cs'];
const files = DMRuntimeCS.getRuntimeCSFiles();
for (const expected of EXPECTED_FILES) {
  const file = files.find(f => f.filename === expected);
  assert(file !== undefined, `runtime contains ${expected}`);
  assert(file!.content.length > 100, `${expected} has substantial content (${file!.content.length} chars)`);
  assert(!file!.content.includes('\0'), `${expected} has no raw NUL bytes`);
}

// Multi-arg overloads for calls that previously failed to compile (CS1501).
const OVERLOAD_SIGNATURES = [
  'Text2Num(DMValue value, DMValue radix)',
  'Num2Text(DMValue value, DMValue len, DMValue pad)',
  'FindText(DMValue text, DMValue needle, DMValue start = default, DMValue end = default, DMValue caseSensitive = default)',
  'ReplaceText(DMValue haystack, DMValue needle, DMValue replacement, DMValue start = default, DMValue end = default)',
  'SplitText(DMValue text, DMValue separator, DMValue start = default, DMValue end = default, DMValue includeDelimiters = default)',
  'StepTowards(DMValue atom, DMValue trg, DMValue speed)',
  'StepAway(DMValue atom, DMValue trg, DMValue max = default, DMValue speed = default)',
  'JoinText(DMValue value, DMValue separator, DMValue start = default, DMValue end = default)'
];
const helpersContent = files.find(f => f.filename === 'DMRuntimeHelpers.cs')!.content;
for (const sig of OVERLOAD_SIGNATURES) {
  assert(helpersContent.includes(sig), `DMRuntimeHelpers overload exists: ${sig}`);
}

console.log("\n✅ ALL RUNTIME TEMPLATE INTEGRITY TESTS PASSED!");
