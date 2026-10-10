import { PNGImage } from './pngCodec.js';

// ==== W-B tiles (item 75) ==============================================
// The pin's tile atlas builder (ClydeTileDefinitionManager @ 9cefa116)
// accepts only raw PNGs whose height is EyeManager.PixelsPerMeter (32) and
// whose width is 32*Variants — anything else throws NotSupportedException
// during atlas rebuild, so oversized dmTile sprites are blanked server-side
// by ValidateTileSprite. BYOND turf icons are free-sized (paradise walls
// are 32x40, some floors 50x50, older icons can be undersized too), which
// left ~24% of paradise dmTiles invisible.
//
// `toTileImage32` produces the always-32x32 variant the dmTile protos now
// point at (`<state>.tile32.png`): an identical copy when the source cell
// is already 32x32, otherwise a NEAREST-NEIGHBOUR resample. Nearest is the
// right filter for SS13 pixel art — bilinear smears the hard palette edges
// that make turf sprites read correctly at 1:1 zoom. Scale-to-fit (not
// center-crop) keeps the whole sprite visible: a 32x40 wall squashes ~20%
// vertically instead of losing its top cap or bottom edge, and a 50x50
// floor just shrinks to 64%.
export const TILE_PX = 32;

export interface RGBAImage {
  width: number;
  height: number;
  rgba: Buffer;
}

/// <summary>
/// Nearest-neighbour resample of an RGBA buffer to dstW x dstH. Source
/// pixel for output (x, y) is (floor(x*srcW/dstW), floor(y*srcH/dstH)).
/// </summary>
export function resampleNearest(src: RGBAImage, dstW: number, dstH: number): Buffer {
  const out = Buffer.alloc(dstW * dstH * 4);
  for (let y = 0; y < dstH; y++) {
    const sy = Math.min(src.height - 1, Math.floor(y * src.height / dstH));
    for (let x = 0; x < dstW; x++) {
      const sx = Math.min(src.width - 1, Math.floor(x * src.width / dstW));
      const si = (sy * src.width + sx) * 4;
      const di = (y * dstW + x) * 4;
      out[di] = src.rgba[si];
      out[di + 1] = src.rgba[si + 1];
      out[di + 2] = src.rgba[si + 2];
      out[di + 3] = src.rgba[si + 3];
    }
  }
  return out;
}

/// <summary>
/// The atlas-legal tile image for a first-cell crop: 32x32 always. An
/// already-32x32 cell returns its own buffer (no copy cost, identical
/// output to the old crop path).
/// </summary>
export function toTileImage32(cell: RGBAImage): PNGImage {
  if (cell.width === TILE_PX && cell.height === TILE_PX) {
    return { width: TILE_PX, height: TILE_PX, rgba: cell.rgba };
  }
  return {
    width: TILE_PX,
    height: TILE_PX,
    rgba: resampleNearest(cell, TILE_PX, TILE_PX)
  };
}
