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

  // ==== W-B tiles (item 75): always-32x32 tile32 variant ================
  {
    const { resampleNearest, toTileImage32, TILE_PX } = await import('../dmi/imageScale.js');
    assertEqual(TILE_PX, 32, 'Tile size constant is the engine tile size (item 75)');

    // resampleNearest downscale: 4x4 gradient -> 2x2 picks floor(x*2,y*2).
    const src4 = Buffer.alloc(4 * 4 * 4);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      const i = (y * 4 + x) * 4;
      src4[i] = x * 60; src4[i + 1] = y * 60; src4[i + 2] = 9; src4[i + 3] = 255;
    }
    const down = resampleNearest({ width: 4, height: 4, rgba: src4 }, 2, 2);
    const dpx = (x: number, y: number) => [down[(y * 2 + x) * 4], down[(y * 2 + x) * 4 + 1]];
    assertEqual(dpx(0, 0), [0, 0], 'Nearest downsample picks top-left source pixel (item 75)');
    assertEqual(dpx(1, 0), [120, 0], 'Nearest downsample x maps to floor(x*srcW/dstW) (item 75)');
    assertEqual(dpx(0, 1), [0, 120], 'Nearest downsample y maps to floor(y*srcH/dstH) (item 75)');
    assertEqual(dpx(1, 1), [120, 120], 'Nearest downsample bottom-right source pixel (item 75)');

    // resampleNearest upscale: 2x2 -> 4x4 pixel-doubles (nearest = chunky).
    const src2 = Buffer.alloc(2 * 2 * 4);
    for (let i = 0; i < 4; i++) { src2[i * 4] = i * 80; src2[i * 4 + 3] = 255; }
    const up = resampleNearest({ width: 2, height: 2, rgba: src2 }, 4, 4);
    assertEqual(up[(1 * 4 + 1) * 4], 0, 'Nearest upscale pixel-doubles top-left (item 75)');
    assertEqual(up[(1 * 4 + 2) * 4], 80, 'Nearest upscale next quad starts at x=2 (item 75)');
    assertEqual(up[(3 * 4 + 3) * 4], 240, 'Nearest upscale bottom-right = src(1,1) (item 75)');

    // toTileImage32: 32x32 pass-through returns the same buffer.
    const exact = Buffer.alloc(32 * 32 * 4, 7);
    assert(toTileImage32({ width: 32, height: 32, rgba: exact }).rgba === exact, '32x32 cell passes through unresampled (item 75)');

    // toTileImage32: 32x40 wall cell -> 32x32 (aspect squash, keeps top+bottom).
    const wall = Buffer.alloc(32 * 40 * 4);
    for (let y = 0; y < 40; y++) for (let x = 0; x < 32; x++) {
      const i = (y * 32 + x) * 4; wall[i] = y * 6; wall[i + 3] = 255;
    }
    const wallTile = toTileImage32({ width: 32, height: 40, rgba: wall });
    assertEqual({ w: wallTile.width, h: wallTile.height }, { w: 32, h: 32 }, '32x40 wall resampled to 32x32 (item 75)');
    assertEqual(wallTile.rgba[0], 0, 'squashed tile keeps source top row (item 75)');
    const lastI = (31 * 32 + 0) * 4;
    assertEqual(wallTile.rgba[lastI], Math.floor(31 * 40 / 32) * 6, 'squashed tile bottom row maps nearest source row (item 75)');

    // toTileImage32: 16x16 -> 32x32 upscale for undersized legacy icons.
    const small16 = toTileImage32({ width: 16, height: 16, rgba: Buffer.alloc(16 * 16 * 4, 5) });
    assertEqual({ w: small16.width, h: small16.height }, { w: 32, h: 32 }, '16x16 icon upscaled to 32x32 (item 75)');
  }

  // Integration: a declared 4x3-cell DMI still yields a 32x32 tile32.png,
  // while .tile.png keeps the native crop for non-atlas consumers.
  {
    const cellW = 4, cellH = 3;
    const sheetBuf = Buffer.alloc(cellW * cellH * 4);
    for (let y = 0; y < cellH; y++) for (let x = 0; x < cellW; x++) {
      const i = (y * cellW + x) * 4;
      sheetBuf[i] = x * 30; sheetBuf[i + 1] = y * 30; sheetBuf[i + 2] = 200; sheetBuf[i + 3] = 255;
    }
    const sheetPng = encodePNG({ width: cellW, height: cellH, rgba: sheetBuf });
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const dmiText = `# BEGIN DMI\nversion = 4.0\nwidth = ${cellW}\nheight = ${cellH}\nstate "odd"\n  dirs = 1\n  frames = 1\n# END DMI`;
    const td = Buffer.concat([Buffer.from('DMI'), Buffer.from([0]), Buffer.from(dmiText, 'latin1')]);
    const tc = Buffer.alloc(4); tc.writeUInt32BE(crc32(Buffer.concat([Buffer.from('tEXt'), td])), 0);
    const tChunk = Buffer.concat([Buffer.alloc(4), Buffer.from('tEXt'), td, tc]);
    tChunk.writeUInt32BE(td.length, 0);
    const ihdrLen = sheetPng.readUInt32BE(8);
    const at = 8 + 12 + ihdrLen;
    const oddPath = path.join(process.cwd(), 'temp_test_odd.dmi');
    fs.writeFileSync(oddPath, Buffer.concat([sig, sheetPng.subarray(8, at), tChunk, sheetPng.subarray(at)]));
    const oddOut = path.join(process.cwd(), 'temp_test_odd_rsi');
    if (fs.existsSync(oddOut)) fs.rmSync(oddOut, { recursive: true, force: true });
    writer.convertDMIToRSI(oddPath, oddOut);

    const oddTile = decodePNG(fs.readFileSync(path.join(oddOut, 'odd.tile.png')));
    assertEqual({ w: oddTile.width, h: oddTile.height }, { w: cellW, h: cellH }, '.tile.png stays the native first-cell crop (item 75)');
    const odd32 = decodePNG(fs.readFileSync(path.join(oddOut, 'odd.tile32.png')));
    assertEqual({ w: odd32.width, h: odd32.height }, { w: 32, h: 32 }, '.tile32.png is always 32x32 — the atlas rule (item 75)');
    // 4x3 -> 32x32 upscale: output (0,0) and (31,31) sample src (0,0)/(3,2).
    const o32 = (x: number, y: number) => { const i = (y * 32 + x) * 4; return [odd32.rgba[i], odd32.rgba[i + 1], odd32.rgba[i + 2]]; };
    assertEqual(o32(0, 0), [0, 0, 200], 'upscaled tile32 top-left = src(0,0) (item 75)');
    assertEqual(o32(31, 31), [90, 60, 200], 'upscaled tile32 bottom-right = src(3,2) (item 75)');
    if (fs.existsSync(oddPath)) fs.unlinkSync(oddPath);
    if (fs.existsSync(oddOut)) fs.rmSync(oddOut, { recursive: true, force: true });
  }

  console.log("\n✅ ALL RSI WRITER TESTS PASSED!");
}

runRSIWriterTests().catch(err => {
  console.error("Test error:", err);
  process.exit(1);
});

// === Plan 32: duplicate icon_state dedupe (first-wins, BYOND semantics) ===
// Real DMIs contain same-named states; the RSI loader hard-fails on
// duplicate stateIds. First match wins like BYOND; identical-image dupes
// dedupe silently, distinct-content collisions get a per-name warning.

function buildDupSheetPng(): { png: Buffer; make: (lastBlue: boolean) => Buffer } {
  const W = 2, H = 2, cols = 3; // 3 cells of 2x2 in one row
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const dmiText = `# BEGIN DMI
version = 4.0
width = 2
height = 2
state "solo"
  dirs = 1
  frames = 1
state "dup"
  dirs = 1
  frames = 1
state "dup"
  dirs = 1
  frames = 1
# END DMI`;
  const textChunkData = Buffer.concat([Buffer.from('DMI'), Buffer.from([0]), Buffer.from(dmiText, 'latin1')]);
  const textCrc = Buffer.alloc(4);
  textCrc.writeUInt32BE(crc32(Buffer.concat([Buffer.from('tEXt'), textChunkData])), 0);
  const textChunk = Buffer.concat([Buffer.alloc(4).fill(0), Buffer.from('tEXt'), textChunkData, textCrc]);
  textChunk.writeUInt32BE(textChunkData.length, 0);

  const make = (lastBlue: boolean): Buffer => {
    const rgba = Buffer.alloc(cols * W * H * 4);
    const paint = (cellIdx: number, r: number, g: number, b: number) => {
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = (y * cols * W + cellIdx * W + x) * 4;
        rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255;
      }
    };
    paint(0, 255, 0, 0);                       // "solo"
    paint(1, 0, 255, 0);                       // "dup" #1 (kept)
    paint(2, 0, lastBlue ? 0 : 255, lastBlue ? 255 : 0); // "dup" #2 (green or blue)
    const idatPng = encodePNG({ width: cols * W, height: H, rgba });
    const ihdrLen = idatPng.readUInt32BE(8);
    const spliceAt = 8 + 12 + ihdrLen;
    return Buffer.concat([signature, idatPng.subarray(8, spliceAt), textChunk, idatPng.subarray(spliceAt)]);
  };
  return { png: make(false), make };
}

async function runPlan32DupStateTests() {
  console.log("=== Running Plan 32 duplicate-state dedupe tests ===");
  const writer = new RSIWriter();
  const { make } = buildDupSheetPng();

  // Identical-image duplicate: deduped, one meta entry, no DIFFERENT warning.
  const samePath = path.join(process.cwd(), 'temp_test_dup_same.dmi');
  fs.writeFileSync(samePath, make(false));
  const sameOut = path.join(process.cwd(), 'temp_test_dup_same_rsi');
  if (fs.existsSync(sameOut)) fs.rmSync(sameOut, { recursive: true, force: true });
  const sameMeta = writer.convertDMIToRSI(samePath, sameOut);
  const sameNames = (JSON.parse(fs.readFileSync(path.join(sameOut, 'meta.json'), 'utf8')).states as any[]).map(s => s.name);
  assertEqual(sameNames, ['solo', 'dup'], 'dup-state identical image: meta keeps one entry');
  assert(fs.existsSync(path.join(sameOut, 'dup.png')), 'dup-state identical image: kept state png written');
  assert(sameMeta.warnings.some(w => w.includes('identical image')), 'dup-state identical image reported as identical dedupe');
  assert(!sameMeta.warnings.some(w => w.includes('DIFFERENT')), 'dup-state identical image raises no collision warning');
  // First-wins pixels: dup.png decodes to cell 1's green, not cell 2's.
  const samePng = decodePNG(fs.readFileSync(path.join(sameOut, 'dup.png')));
  assertEqual([samePng.rgba[0], samePng.rgba[1], samePng.rgba[2]], [0, 255, 0], 'dup-state identical image: kept png is the first state');

  // Distinct-content duplicate: deduped first-wins + collision warning.
  const diffPath = path.join(process.cwd(), 'temp_test_dup_diff.dmi');
  fs.writeFileSync(diffPath, make(true));
  const diffOut = path.join(process.cwd(), 'temp_test_dup_diff_rsi');
  if (fs.existsSync(diffOut)) fs.rmSync(diffOut, { recursive: true, force: true });
  const diffMeta = writer.convertDMIToRSI(diffPath, diffOut);
  const diffNames = (JSON.parse(fs.readFileSync(path.join(diffOut, 'meta.json'), 'utf8')).states as any[]).map(s => s.name);
  assertEqual(diffNames, ['solo', 'dup'], 'dup-state distinct image: meta keeps one entry');
  assert(diffMeta.warnings.some(w => w.includes("'dup'") && w.includes('DIFFERENT')), 'dup-state distinct image reported per name');
  const diffPng = decodePNG(fs.readFileSync(path.join(diffOut, 'dup.png')));
  assertEqual([diffPng.rgba[0], diffPng.rgba[1], diffPng.rgba[2]], [0, 255, 0], 'dup-state distinct image: kept png is the FIRST state (BYOND)');

  for (const p of [samePath, diffPath]) if (fs.existsSync(p)) fs.unlinkSync(p);
  for (const d of [sameOut, diffOut]) if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
  console.log("\n✅ ALL PLAN-32 DUP-STATE TESTS PASSED!");
}

runPlan32DupStateTests().catch(err => {
  console.error("Test error:", err);
  process.exit(1);
});
