import { RSIWriter } from '../dmi/rsiWriter.js';
import { DMIParser } from '../dmi/dmiParser.js';
import { encodePNG, decodePNG, crc32 } from '../dmi/pngCodec.js';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

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

// Build a DMI PNG: 4x4 RGBA sheet (4 cells of 2x2) + tEXt metadata.
// DMI cells are FRAME-MAJOR flat row-major: cell index f*dirs+d maps to
// (idx%gridwidth, idx/gridwidth) with gridwidth=2. With dirs=2, frames=2:
//   cell(f0,d0)=idx0@(0,0)  cell(f0,d1)=idx1@(2,0)
//   cell(f1,d0)=idx2@(0,2)  cell(f1,d1)=idx3@(2,2)
// Cell color r = 10*colX, g = 10*rowY/2 + 10 (i.e. (10*col, 10*row, 40)).
function buildSheetPng(): Buffer {
  const W = 2, H = 2, dirs = 2, frames = 2;
  const gridwidth = 2;
  const rgba = Buffer.alloc(W * gridwidth * H * ((dirs * frames) / gridwidth) * 4);
  for (let d = 0; d < dirs; d++) {
    for (let f = 0; f < frames; f++) {
      const cellIdx = f * dirs + d;
      const cellX = (cellIdx % gridwidth) * W;
      const cellY = Math.floor(cellIdx / gridwidth) * H;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = ((cellY + y) * (W * gridwidth) + (cellX + x)) * 4;
          rgba[i] = 10 * f;
          rgba[i + 1] = 10 * d + 10;
          rgba[i + 2] = 40;
          rgba[i + 3] = 255;
        }
      }
    }
  }
  const idatPng = encodePNG({ width: W * gridwidth, height: H * ((dirs * frames) / gridwidth), rgba });

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

  // Pin-format sprite: one flat <state>.png packed DIR-MAJOR — cell (d,f)
  // sits at (f*W, d*H). Output is frames*W x dirs*H.
  const sprite = decodePNG(fs.readFileSync(path.join(outDir, 'anim.png')));
  assertEqual({ w: sprite.width, h: sprite.height }, { w: 4, h: 4 }, 'State sprite is (frames*W) x (dirs*H), dir-major');
  const px = (x: number, y: number) => {
    const i = (y * sprite.width + x) * 4;
    return [sprite.rgba[i], sprite.rgba[i + 1], sprite.rgba[i + 2]];
  };
  assertEqual(px(0, 0), [0, 10, 40], 'Dir 0 frame 0 at (0,0)');
  assertEqual(px(2, 0), [10, 10, 40], 'Dir 0 frame 1 at (f*W,0) — horizontal stacking');
  assertEqual(px(0, 2), [0, 20, 40], 'Dir 1 frame 0 at (0,d*H)');
  assertEqual(px(2, 2), [10, 20, 40], 'Dir 1 frame 1 at (f*W,d*H)');

  // Tile sprite: first cell only (dir 0, frame 0).
  const tile = decodePNG(fs.readFileSync(path.join(outDir, 'anim.tile.png')));
  assertEqual({ w: tile.width, h: tile.height }, { w: 2, h: 2 }, 'Tile sprite is a single cell');
  assertEqual([tile.rgba[0], tile.rgba[1], tile.rgba[2]], [0, 10, 40], 'Tile sprite is dir 0 frame 0');

  assert(!fs.existsSync(path.join(outDir, 'anim', 'meta.json')), 'No per-state subdirectory/meta.json (pin flat layout)');

  // Cleanup
  for (const f of [pngPath]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });

  // Plan 10 B5: a sheet smaller than the declared cells warns and skips the
  // state's sprites instead of cropping out-of-bounds into black pixels.
  const smallPng = encodePNG({ width: 2, height: 2, rgba: Buffer.alloc(2 * 2 * 4, 0) });
  const smallText = `# BEGIN DMI
version = 4.0
width = 4
height = 4
state "big"
  dirs = 1
  frames = 1
# END DMI`;
  const smallSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const smallCrc = crc32(Buffer.concat([Buffer.from('tEXt'), Buffer.concat([Buffer.from('DMI'), Buffer.from([0]), Buffer.from(smallText, 'latin1')])]));
  const smallChunk = Buffer.concat([
    Buffer.from([0, 0, 0, Buffer.concat([Buffer.from('DMI'), Buffer.from([0]), Buffer.from(smallText, 'latin1')]).length]),
    Buffer.from('tEXt'),
    Buffer.concat([Buffer.from('DMI'), Buffer.from([0]), Buffer.from(smallText, 'latin1')]),
    Buffer.from([(smallCrc >>> 24) & 0xff, (smallCrc >>> 16) & 0xff, (smallCrc >>> 8) & 0xff, smallCrc & 0xff])
  ]);
  const smallDmi = Buffer.concat([
    smallSig,
    (() => { const d = Buffer.alloc(13); d.writeUInt32BE(2, 0); d.writeUInt32BE(2, 4); d[8] = 8; d[9] = 6; return d; })().length
      ? (() => { const d = Buffer.alloc(13); d.writeUInt32BE(2, 0); d.writeUInt32BE(2, 4); d[8] = 8; d[9] = 6; return Buffer.concat([Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR'), d, (() => { const c = Buffer.alloc(4); c.writeUInt32BE(crc32(Buffer.concat([Buffer.from('IHDR'), d])), 0); return c; })()]); })()
      : Buffer.alloc(0),
    smallChunk,
    (() => { const id = zlib.deflateSync(Buffer.concat([Buffer.from([0, 0]), Buffer.alloc(2 * 2 * 4)])); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(Buffer.concat([Buffer.from('IDAT'), id])), 0); return Buffer.concat([Buffer.from([0, 0, 0, id.length]), Buffer.from('IDAT'), id, c]); })(),
    (() => { const c = Buffer.alloc(4); c.writeUInt32BE(crc32(Buffer.from('IEND')), 0); return Buffer.concat([Buffer.from([0, 0, 0, 0]), Buffer.from('IEND'), Buffer.alloc(0), c]); })()
  ]);
  const smallPath = path.join(process.cwd(), 'temp_test_small.dmi');
  fs.writeFileSync(smallPath, smallDmi);
  const smallOut = path.join(process.cwd(), 'temp_test_small_rsi');
  const smallMeta = writer.convertDMIToRSI(smallPath, smallOut);
  assert(smallMeta.warnings.some(w => w.includes('cells but') && w.includes('were needed')), 'Undersized sheet produces a warning');
  assert(!fs.existsSync(path.join(smallOut, 'big.png')), 'Undersized sheet skips sprite emission');
  if (fs.existsSync(smallPath)) fs.unlinkSync(smallPath);
  if (fs.existsSync(smallOut)) fs.rmSync(smallOut, { recursive: true, force: true });

  console.log("\n✅ ALL RSI WRITER TESTS PASSED!");
}

runRSIWriterTests().catch(err => {
  console.error("Test error:", err);
  process.exit(1);
});
