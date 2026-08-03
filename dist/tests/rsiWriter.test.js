"use strict";
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
const rsiWriter_js_1 = require("../dmi/rsiWriter.js");
const pngCodec_js_1 = require("../dmi/pngCodec.js");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const zlib = __importStar(require("zlib"));
function assert(condition, message) {
    if (!condition) {
        console.error(`❌ TEST FAILED: ${message}`);
        process.exit(1);
    }
    else {
        console.log(`✅ ${message}`);
    }
}
function assertEqual(actual, expected, message) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        console.error(`❌ TEST FAILED: ${message}`);
        console.error(`  Expected: ${JSON.stringify(expected)}`);
        console.error(`  Actual: ${JSON.stringify(actual)}`);
        process.exit(1);
    }
    else {
        console.log(`✅ ${message}`);
    }
}
// Build a DMI PNG: 4x4 RGBA sheet (2 dirs x 2 frames of 2x2 cells) + tEXt
// metadata. Cell (frame f, dir d) is filled with a distinctive color:
// r = 10*f, g = 10*d, b = 40.
function buildSheetPng() {
    const W = 2, H = 2, dirs = 2, frames = 2;
    const rgba = Buffer.alloc(W * frames * H * dirs * 4);
    for (let d = 0; d < dirs; d++) {
        for (let f = 0; f < frames; f++) {
            for (let y = 0; y < H; y++) {
                for (let x = 0; x < W; x++) {
                    const i = ((d * H + y) * (W * frames) + (f * W + x)) * 4;
                    rgba[i] = 10 * f;
                    rgba[i + 1] = 10 * d + 10;
                    rgba[i + 2] = 40;
                    rgba[i + 3] = 255;
                }
            }
        }
    }
    const idatPng = (0, pngCodec_js_1.encodePNG)({ width: W * frames, height: H * dirs, rgba });
    // Rebuild the PNG with a tEXt chunk inserted after IHDR.
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const dmiText = `# BEGIN DMI
version = 4.0
width = 2
height = 2
state "anim"
  dirs = 2
  frames = 2
  delay = 1,2,3,4
# END DMI`;
    const textChunkData = Buffer.concat([Buffer.from('DMI'), Buffer.from([0]), Buffer.from(dmiText, 'latin1')]);
    const textCrc = Buffer.alloc(4);
    textCrc.writeUInt32BE((0, pngCodec_js_1.crc32)(Buffer.concat([Buffer.from('tEXt'), textChunkData])), 0);
    const textChunk = Buffer.concat([Buffer.alloc(4).fill(0), Buffer.from('tEXt'), textChunkData, textCrc]);
    textChunk.writeUInt32BE(textChunkData.length, 0);
    // Find IHDR chunk end (after its data + crc) to splice the text chunk in.
    const ihdrLen = idatPng.readUInt32BE(8);
    const spliceAt = 8 + 12 + ihdrLen;
    return Buffer.concat([signature, idatPng.subarray(8, spliceAt), textChunk, idatPng.subarray(spliceAt)]);
}
async function runRSIWriterTests() {
    console.log("=== Running RSI Writer Tests ===");
    const pngPath = path.join(process.cwd(), 'temp_test_sheet.dmi');
    fs.writeFileSync(pngPath, buildSheetPng());
    const outDir = path.join(process.cwd(), 'temp_test_icon.rsi');
    if (fs.existsSync(outDir))
        fs.rmSync(outDir, { recursive: true, force: true });
    const writer = new rsiWriter_js_1.RSIWriter();
    const meta = writer.convertDMIToRSI(pngPath, outDir);
    assertEqual(meta.states[0].name, 'anim', 'DMI parsed from real sheet');
    // Top-level RSI meta.json
    const topMeta = JSON.parse(fs.readFileSync(path.join(outDir, 'meta.json'), 'utf-8'));
    assertEqual(topMeta.size, { x: 2, y: 2 }, 'Top-level RSI meta size');
    // Frame-major delay indexing: delay = [1,2,3,4] with dirs=2, frames=2
    // -> dir 0 = [1,3], dir 1 = [2,4].
    assertEqual(topMeta.states[0].delays, [[1, 3], [2, 4]], 'Frame-major delay slicing per direction');
    // Per-state sprite files: one png per direction, frames stacked vertically.
    for (const d of [0, 1]) {
        const sprite = (0, pngCodec_js_1.decodePNG)(fs.readFileSync(path.join(outDir, 'anim', `${d}.png`)));
        assertEqual({ w: sprite.width, h: sprite.height }, { w: 2, h: 4 }, `Direction ${d} sprite is width x (frames*height)`);
        // Pixel (0,0) = frame 0 of dir d; pixel (0,2) = frame 1 of dir d.
        const rowStride = sprite.width * 4;
        const f0 = [sprite.rgba[0], sprite.rgba[1], sprite.rgba[2]];
        const f1 = [sprite.rgba[2 * rowStride], sprite.rgba[2 * rowStride + 1], sprite.rgba[2 * rowStride + 2]];
        assertEqual(f0, [0, 10 * d + 10, 40], `Direction ${d} frame 0 pixel`);
        assertEqual(f1, [10, 10 * d + 10, 40], `Direction ${d} frame 1 pixel (vertical stacking)`);
    }
    const stateMeta = JSON.parse(fs.readFileSync(path.join(outDir, 'anim', 'meta.json'), 'utf-8'));
    assertEqual(stateMeta.states[0].directions, 2, 'Per-state meta directions');
    // Cleanup
    for (const f of [pngPath]) {
        if (fs.existsSync(f))
            fs.unlinkSync(f);
    }
    if (fs.existsSync(outDir))
        fs.rmSync(outDir, { recursive: true, force: true });
    // Plan 10 B5: a sheet smaller than the declared cells warns and skips the
    // state's sprites instead of cropping out-of-bounds into black pixels.
    const smallPng = (0, pngCodec_js_1.encodePNG)({ width: 2, height: 2, rgba: Buffer.alloc(2 * 2 * 4, 0) });
    const smallText = `# BEGIN DMI
version = 4.0
width = 4
height = 4
state "big"
  dirs = 1
  frames = 1
# END DMI`;
    const smallSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const smallCrc = (0, pngCodec_js_1.crc32)(Buffer.concat([Buffer.from('tEXt'), Buffer.concat([Buffer.from('DMI'), Buffer.from([0]), Buffer.from(smallText, 'latin1')])]));
    const smallChunk = Buffer.concat([
        Buffer.from([0, 0, 0, Buffer.concat([Buffer.from('DMI'), Buffer.from([0]), Buffer.from(smallText, 'latin1')]).length]),
        Buffer.from('tEXt'),
        Buffer.concat([Buffer.from('DMI'), Buffer.from([0]), Buffer.from(smallText, 'latin1')]),
        Buffer.from([(smallCrc >>> 24) & 0xff, (smallCrc >>> 16) & 0xff, (smallCrc >>> 8) & 0xff, smallCrc & 0xff])
    ]);
    const smallDmi = Buffer.concat([
        smallSig,
        (() => { const d = Buffer.alloc(13); d.writeUInt32BE(2, 0); d.writeUInt32BE(2, 4); d[8] = 8; d[9] = 6; return d; })().length
            ? (() => { const d = Buffer.alloc(13); d.writeUInt32BE(2, 0); d.writeUInt32BE(2, 4); d[8] = 8; d[9] = 6; return Buffer.concat([Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR'), d, (() => { const c = Buffer.alloc(4); c.writeUInt32BE((0, pngCodec_js_1.crc32)(Buffer.concat([Buffer.from('IHDR'), d])), 0); return c; })()]); })()
            : Buffer.alloc(0),
        smallChunk,
        (() => { const id = zlib.deflateSync(Buffer.concat([Buffer.from([0, 0]), Buffer.alloc(2 * 2 * 4)])); const c = Buffer.alloc(4); c.writeUInt32BE((0, pngCodec_js_1.crc32)(Buffer.concat([Buffer.from('IDAT'), id])), 0); return Buffer.concat([Buffer.from([0, 0, 0, id.length]), Buffer.from('IDAT'), id, c]); })(),
        (() => { const c = Buffer.alloc(4); c.writeUInt32BE((0, pngCodec_js_1.crc32)(Buffer.from('IEND')), 0); return Buffer.concat([Buffer.from([0, 0, 0, 0]), Buffer.from('IEND'), Buffer.alloc(0), c]); })()
    ]);
    const smallPath = path.join(process.cwd(), 'temp_test_small.dmi');
    fs.writeFileSync(smallPath, smallDmi);
    const smallOut = path.join(process.cwd(), 'temp_test_small_rsi');
    const smallMeta = writer.convertDMIToRSI(smallPath, smallOut);
    assert(smallMeta.warnings.some(w => w.includes('smaller than declared')), 'Undersized sheet produces a warning');
    assert(!fs.existsSync(path.join(smallOut, 'big', '0.png')), 'Undersized sheet skips sprite emission');
    if (fs.existsSync(smallPath))
        fs.unlinkSync(smallPath);
    if (fs.existsSync(smallOut))
        fs.rmSync(smallOut, { recursive: true, force: true });
    console.log("\n✅ ALL RSI WRITER TESTS PASSED!");
}
runRSIWriterTests().catch(err => {
    console.error("Test error:", err);
    process.exit(1);
});
