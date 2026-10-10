// Generates tests/m1-demo/icons/m1.dmi — a real DMI (PNG + tEXt metadata)
// with five 32x32 single-direction, single-frame solid-color states.
// Run: node tests/m1-demo/tools/make_dmi.mjs   (from repo root)
import { encodePNG, crc32 } from '../../../dist/dmi/pngCodec.js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.join(here, '..', 'icons', 'm1.dmi');

const states = [
  ['space',  [10, 10, 18]],
  ['floor',  [110, 110, 115]],
  ['wall',   [55, 50, 45]],
  ['button', [200, 40, 40]],
  ['human',  [60, 170, 80]],
];

const CELL = 32;
const w = CELL * states.length;
const h = CELL;
const rgba = Buffer.alloc(w * h * 4);
states.forEach(([name, [r, g, b]], i) => {
  for (let y = 0; y < CELL; y++) {
    for (let x = 0; x < CELL; x++) {
      const px = i * CELL + x;
      const off = (y * w + px) * 4;
      rgba[off] = r; rgba[off + 1] = g; rgba[off + 2] = b; rgba[off + 3] = 255;
    }
  }
});

// DMI metadata text block (one state per 32x32 cell, frame-major order).
let dmiText = '# BEGIN DMI\nversion = 4.0\n\twidth = 32\n\theight = 32\n';
for (const [name] of states) {
  dmiText += `state = "${name}"\n\tdirs = 1\n\tframes = 1\n\tdelay = 1\n`;
}
dmiText += '# END DMI\n';

// encodePNG gives a plain PNG; splice a tEXt chunk in before IEND.
const png = encodePNG({ width: w, height: h, rgba });
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
};
const textChunk = chunk('tEXt', Buffer.concat([Buffer.from('Description', 'latin1'), Buffer.from([0]), Buffer.from(dmiText, 'latin1')]));
const iend = png.subarray(png.length - 12); // IEND is the last 12 bytes
const out = Buffer.concat([png.subarray(0, png.length - 12), textChunk, iend]);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, out);
console.log(`wrote ${outPath} (${out.length} bytes, ${states.length} states)`);
