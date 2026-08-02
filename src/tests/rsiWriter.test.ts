import { RSIWriter } from '../dmi/rsiWriter.js';
import { DMIParser } from '../dmi/dmiParser.js';
import { encodePNG, decodePNG, crc32 } from '../dmi/pngCodec.js';
import * as fs from 'fs';
import * as path from 'path';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ TEST FAILED: ${message}`);
    process.exit(1);
  } else {
    console.log(`✅ ${message}`);
  }
}

function assertEqual(actual: any, expected: any, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error(`❌ TEST FAILED: ${message}`);
    console.error(`  Expected: ${JSON.stringify(expected)}`);
    console.error(`  Actual: ${JSON.stringify(actual)}`);
    process.exit(1);
  } else {
    console.log(`✅ ${message}`);
  }
}

// Build a DMI PNG: 4x4 RGBA sheet (2 dirs x 2 frames of 2x2 cells) + tEXt
// metadata. Cell (frame f, dir d) is filled with a distinctive color:
// r = 10*f, g = 10*d, b = 40.
function buildSheetPng(): Buffer {
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
  const idatPng = encodePNG({ width: W * frames, height: H * dirs, rgba });

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
  textCrc.writeUInt32BE(crc32(Buffer.concat([Buffer.from('tEXt'), textChunkData])), 0);
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
  if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });

  const writer = new RSIWriter();
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
    const sprite = decodePNG(fs.readFileSync(path.join(outDir, 'anim', `${d}.png`)));
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
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });

  console.log("\n✅ ALL RSI WRITER TESTS PASSED!");
}

runRSIWriterTests().catch(err => {
  console.error("Test error:", err);
  process.exit(1);
});
