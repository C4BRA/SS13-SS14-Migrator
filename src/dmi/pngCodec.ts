import * as zlib from 'zlib';

// Minimal PNG codec (decode -> RGBA, encode RGBA -> PNG) covering the color
// types BYOND emits (0 gray, 2 RGB, 3 indexed, 4 gray+alpha, 6 RGBA) at
// 8-bit (and 16-bit, MSB kept) depth. Used by RSIWriter to slice DMI icon
// sheets into per-state, per-direction sprites.

export interface PNGImage {
  width: number;
  height: number;
  rgba: Buffer; // width * height * 4
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

export function decodePNG(buffer: Buffer): PNGImage {
  if (buffer.length < 8 || buffer.readUInt32BE(0) !== 0x89504e47 || buffer.readUInt32BE(4) !== 0x0d0a1a0a) {
    throw new Error('Not a PNG');
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let colorType = 6;
  let interlace = 0;
  let palette: Buffer | null = null;
  let trns: Buffer | null = null;
  const idat: Buffer[] = [];

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    if (offset + 12 + length > buffer.length) {
      throw new Error('PNG chunk length exceeds file bounds');
    }
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    // CRC validation (WS10-2): the stored CRC must match the type+data; a
    // corrupted chunk previously decoded silently (even flipped text bytes).
    const storedCrc = buffer.readUInt32BE(offset + 8 + length);
    const actualCrc = crc32(buffer.subarray(offset + 4, offset + 8 + length));
    if (storedCrc !== actualCrc) {
      throw new Error(`PNG CRC mismatch in ${type} chunk`);
    }
    if (type === 'IHDR') {
      if (length < 13) throw new Error('Invalid IHDR chunk');
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') {
      palette = Buffer.from(data);
    } else if (type === 'tRNS') {
      trns = Buffer.from(data);
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  // IHDR sanity: sane dimensions, valid color type / bit depth combos,
  // no interlace (Adam7 is not implemented), compression/filter methods 0.
  const VALID_DEPTHS: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
  if (width <= 0 || height <= 0 || width > 65536 || height > 65536) {
    throw new Error(`Invalid PNG dimensions ${width}x${height}`);
  }
  if (!VALID_DEPTHS[colorType] || !VALID_DEPTHS[colorType].includes(bitDepth)) {
    throw new Error(`Unsupported PNG color type ${colorType} bit depth ${bitDepth}`);
  }
  if (interlace !== 0) {
    throw new Error('Interlaced PNGs are not supported');
  }

  const raw = zlib.inflateSync(Buffer.concat(idat));

  // Channels per color type: 0=gray(1), 2=RGB(3), 3=indexed(1), 4=gray+alpha(2), 6=RGBA(4).
  const channels = [1, 0, 3, 1, 2, 4, 4][colorType];
  const bpp = Math.max(1, Math.floor(channels * bitDepth / 8));
  const stride = Math.ceil(width * channels * bitDepth / 8);

  // A complete scanline stream has exactly (stride + filterByte) per row;
  // anything shorter would decode as silent black pixels.
  if (raw.length !== (stride + 1) * height) {
    throw new Error(`PNG scanline data length mismatch (${raw.length} != ${(stride + 1) * height})`);
  }

  // Unfilter scanlines
  const out = Buffer.alloc(stride * height);
  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    const line = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      let val = raw[src++];
      switch (filter) {
        case 1: val += a; break;
        case 2: val += b; break;
        case 3: val += (a + b) >> 1; break;
        case 4: val += (a + b - c); break;
      }
      line[x] = val & 0xff;
    }
  }

  // Convert to RGBA8
  const rgba = Buffer.alloc(width * height * 4);
  const px = (i: number): number => (bitDepth === 16 ? out[i * 2] : out[i]); // MSB
  // Packed sample for bit depths < 8 (indexed / gray).
  const sample = (byteOffset: number, bitOffset: number, bits: number): number =>
    (out[byteOffset] >> (8 - bits - bitOffset)) & ((1 << bits) - 1);
  const sampleAt = (si: number, x: number): number =>
    bitDepth < 8
      ? sample(si + Math.floor((x * bitDepth) / 8), (x * bitDepth) % 8, bitDepth)
      : px(si + x);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const di = (y * width + x) * 4;
      const si = y * stride;
      if (colorType === 6) {
        const i = si + x * 4;
        rgba[di] = px(i); rgba[di + 1] = px(i + 1); rgba[di + 2] = px(i + 2); rgba[di + 3] = px(i + 3);
      } else if (colorType === 2) {
        const i = si + x * 3;
        rgba[di] = px(i); rgba[di + 1] = px(i + 1); rgba[di + 2] = px(i + 2); rgba[di + 3] = 255;
      } else if (colorType === 0) {
        let g: number;
        if (bitDepth < 8) {
          const v = sampleAt(si, x);
          g = bitDepth === 1 ? (v ? 255 : 0) : bitDepth === 2 ? v * 85 : v * 17;
        } else {
          g = px(si + x);
        }
        rgba[di] = g; rgba[di + 1] = g; rgba[di + 2] = g; rgba[di + 3] = 255;
      } else if (colorType === 4) {
        const i = si + x * 2;
        rgba[di] = px(i); rgba[di + 1] = px(i); rgba[di + 2] = px(i); rgba[di + 3] = px(i + 1);
      } else if (colorType === 3) {
        const idx = sampleAt(si, x);
        const p = palette ? palette.subarray(idx * 3, idx * 3 + 3) : Buffer.from([255, 0, 255]);
        rgba[di] = p[0] ?? 255; rgba[di + 1] = p[1] ?? 0; rgba[di + 2] = p[2] ?? 255;
        rgba[di + 3] = trns && idx < trns.length ? trns[idx] : 255;
      }
    }
  }
  return { width, height, rgba };
}

export function encodePNG(image: PNGImage): Buffer {
  const { width, height, rgba } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`Invalid PNG dimensions ${width}x${height}`);
  }
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}
