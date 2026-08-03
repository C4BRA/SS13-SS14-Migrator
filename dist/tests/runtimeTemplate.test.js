"use strict";
// Regression guard for the runtime template file. The C# runtime sources in
// src/runtimeTemplate/dmRuntimeCS.ts live inside backtick template literals;
// a stray backtick in a C# comment silently breaks the TS build (tsc still
// emits broken JS), which previously produced confusing runtime failures.
// This test pins the template structure so that failure mode is caught here.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const dmRuntimeCS_js_1 = require("../runtimeTemplate/dmRuntimeCS.js");
function assert(condition, message) {
    if (!condition) {
        console.error(`❌ TEST FAILED: ${message}`);
        process.exit(1);
    }
    else {
        console.log(`✅ ${message}`);
    }
}
const srcPathCandidates = [
    path.join(__dirname, '..', '..', 'src', 'runtimeTemplate', 'dmRuntimeCS.ts'),
    path.join(__dirname, '..', 'runtimeTemplate', 'dmRuntimeCS.ts')
];
const srcPath = srcPathCandidates.find(p => fs.existsSync(p));
assert(srcPath !== undefined, `Found the runtime template source at ${srcPathCandidates.join(' or ')}`);
const src = fs.readFileSync(srcPath, 'utf-8');
const contentBlocks = (src.match(/content: `/g) || []).length;
const totalBackticks = (src.match(/`/g) || []).length;
assert(contentBlocks > 0, `Found ${contentBlocks} C# content blocks in the runtime template`);
assert(totalBackticks === contentBlocks * 2, `Template literal integrity: ${totalBackticks} backticks vs ${contentBlocks} blocks x2 (a stray backtick in a C# comment would break this)`);
const EXPECTED_FILES = ['DMValue.cs', 'DMList.cs', 'DMRuntime.cs', 'DMTickScheduler.cs', 'DMRuntimeHelpers.cs', 'RustGAdapterStubs.cs'];
const files = dmRuntimeCS_js_1.DMRuntimeCS.getRuntimeCSFiles();
assert(files.length === EXPECTED_FILES.length, `getRuntimeCSFiles returns ${files.length} files (expected ${EXPECTED_FILES.length})`);
for (const expected of EXPECTED_FILES) {
    const file = files.find(f => f.filename === expected);
    assert(file !== undefined, `getRuntimeCSFiles contains ${expected}`);
    assert(file.content.length > 100, `${expected} has substantial content (${file.content.length} chars)`);
}
// Plan 09 B2: multi-arg overloads for calls that previously failed to compile
// (CS1501). Each signature must exist in the DMRuntimeHelpers template.
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
const helpersContent = files.find(f => f.filename === 'DMRuntimeHelpers.cs').content;
for (const sig of OVERLOAD_SIGNATURES) {
    assert(helpersContent.includes(sig), `DMRuntimeHelpers overload exists: ${sig}`);
}
console.log("\n✅ ALL RUNTIME TEMPLATE INTEGRITY TESTS PASSED!");
