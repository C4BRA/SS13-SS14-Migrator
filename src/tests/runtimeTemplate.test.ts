// Regression guard for the runtime template file. The C# runtime sources in
// src/runtimeTemplate/dmRuntimeCS.ts live inside backtick template literals;
// a stray backtick in a C# comment silently breaks the TS build (tsc still
// emits broken JS), which previously produced confusing runtime failures.
// This test pins the template structure so that failure mode is caught here.

import * as fs from 'fs';
import * as path from 'path';
import { DMRuntimeCS } from '../runtimeTemplate/dmRuntimeCS.js';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ TEST FAILED: ${message}`);
    process.exit(1);
  } else {
    console.log(`✅ ${message}`);
  }
}

const srcPathCandidates = [
  path.join(__dirname, '..', '..', 'src', 'runtimeTemplate', 'dmRuntimeCS.ts'),
  path.join(__dirname, '..', 'runtimeTemplate', 'dmRuntimeCS.ts')
];
const srcPath = srcPathCandidates.find(p => fs.existsSync(p));
assert(srcPath !== undefined, `Found the runtime template source at ${srcPathCandidates.join(' or ')}`);
const src = fs.readFileSync(srcPath!, 'utf-8');

const contentBlocks = (src.match(/content: `/g) || []).length;
const totalBackticks = (src.match(/`/g) || []).length;
assert(contentBlocks > 0, `Found ${contentBlocks} C# content blocks in the runtime template`);
assert(totalBackticks === contentBlocks * 2,
  `Template literal integrity: ${totalBackticks} backticks vs ${contentBlocks} blocks x2 (a stray backtick in a C# comment would break this)`);

const EXPECTED_FILES = ['DMValue.cs', 'DMList.cs', 'DMRuntime.cs', 'DMTickScheduler.cs', 'DMRuntimeHelpers.cs', 'RustGAdapterStubs.cs'];
const files = DMRuntimeCS.getRuntimeCSFiles();
assert(files.length === EXPECTED_FILES.length, `getRuntimeCSFiles returns ${files.length} files (expected ${EXPECTED_FILES.length})`);
for (const expected of EXPECTED_FILES) {
  const file = files.find(f => f.filename === expected);
  assert(file !== undefined, `getRuntimeCSFiles contains ${expected}`);
  assert(file!.content.length > 100, `${expected} has substantial content (${file!.content.length} chars)`);
}

console.log("\n✅ ALL RUNTIME TEMPLATE INTEGRITY TESTS PASSED!");
