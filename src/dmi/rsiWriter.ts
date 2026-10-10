import * as fs from 'fs';
import * as path from 'path';
import { DMIMetadata, DMIParser } from './dmiParser.js';
import { decodePNG, encodePNG } from './pngCodec.js';

// Converts a BYOND .dmi into the SS14 RSI layout used by the pinned engine
// (RobustToolbox @ 9cefa116, RSI v1):
//   <rsi>/
//     meta.json                  (version, license, size, states[])
//     <stateName>.png            (all dirs*frames cells, DIR-MAJOR)
//     <stateName>.tile.png       (first cell only — used by dmTile sprites)
//
// The pin's RSI loader reads `data.Path / (state.name + ".png")` and requires
// the image to be an exact multiple of the declared frame size, cells packed
// dir-major: for direction d, frame f the cell sits at (f*W, d*H).
//
// DMI sheets are FRAME-MAJOR: cell index within a state is `f*dirs + d`,
// laid out row-major over `gridwidth = sheet.width / icon.width` columns.
// DMI direction order S,N,E,W,SE,SW,NE,NW is the same order as the pin's
// RsiDirection enum, so dir indices pass through unremapped.
//
// DMI delay lists are also frame-major:
//   delay[d + f*dirs] = delay of direction d, frame f.
// SS14 `delays` is one array per direction of per-frame delays.

export class RSIWriter {
  private parser: DMIParser = new DMIParser();

  public convertDMIToRSI(dmiPath: string, outputRSIPath: string): DMIMetadata {
    const meta = this.parser.parseDMI(dmiPath);

    if (!fs.existsSync(outputRSIPath)) {
      fs.mkdirSync(outputRSIPath, { recursive: true });
    }

    let sheet: { width: number; height: number; rgba: Buffer } | null = null;
    if (fs.existsSync(dmiPath)) {
      try {
        sheet = decodePNG(fs.readFileSync(dmiPath));
      } catch (e: any) {
        sheet = null;
        meta.warnings.push(`failed to decode sheet '${dmiPath}': ${e?.message ?? e} — metadata-only RSI emitted`);
      }
    }

    const rsiStates = meta.states.map(s => {
      const state: any = {
        name: s.name,
        directions: s.dirs
      };
      if (s.delay) {
        // Frame-major: delay[d + f*dirs] is the delay of dir d, frame f.
        const perDir = Array.from({ length: s.dirs }, (_, d) =>
          Array.from({ length: s.frames }, (_, f) => s.delay![d + f * s.dirs] ?? 1)
        );
        state.delays = perDir;
      }
      return state;
    });

    fs.writeFileSync(path.join(outputRSIPath, 'meta.json'), JSON.stringify({
      version: 1,
      license: "CC-BY-SA-3.0",
      copyright: "Converted from SS13 DMI",
      size: { x: meta.width, y: meta.height },
      states: rsiStates
    }, null, 2));

    if (sheet) {
      const gridwidth = Math.floor(sheet.width / meta.width);
      const rows = Math.floor(sheet.height / meta.height);
      const totalCells = gridwidth * rows;
      let cellBase = 0;

      for (const state of meta.states) {
        const cellsNeeded = state.frames * state.dirs;
        cellBase += cellsNeeded;
        if (cellsNeeded === 0) continue;
        if (state.dirs !== 1 && state.dirs !== 4 && state.dirs !== 8) {
          meta.warnings.push(`state '${state.name}': dirs=${state.dirs} is not 1/4/8 — emitting anyway, engine may reject`);
        }
        // A sheet smaller than the declared cells would crop out-of-bounds
        // into silent black/garbage pixels — skip with a warning instead.
        if (gridwidth === 0 || cellBase > totalCells) {
          meta.warnings.push(
            `state '${state.name}': sheet ${sheet.width}x${sheet.height} holds ${totalCells} cells but ${cellBase} were needed — sprites skipped`
          );
          continue;
        }
        const fileName = this.stateFileName(state.name);
        if (fileName === null) {
          meta.warnings.push(`state '${state.name}': name is not a safe file name — sprites skipped`);
          continue;
        }
        const stateBase = cellBase - cellsNeeded;

        // Dir-major flat PNG: cell (d, f) -> (f*W, d*H).
        const outW = meta.width * state.frames;
        const outH = meta.height * state.dirs;
        const packed = Buffer.alloc(outW * outH * 4);
        for (let d = 0; d < state.dirs; d++) {
          for (let f = 0; f < state.frames; f++) {
            const srcCell = stateBase + f * state.dirs + d;
            const sx = (srcCell % gridwidth) * meta.width;
            const sy = Math.floor(srcCell / gridwidth) * meta.height;
            this.blitCell(sheet, sx, sy, meta.width, meta.height, packed, outW, f * meta.width, d * meta.height);
          }
        }
        const pngPath = path.join(outputRSIPath, `${fileName}.png`);
        fs.mkdirSync(path.dirname(pngPath), { recursive: true });
        fs.writeFileSync(pngPath, encodePNG({ width: outW, height: outH, rgba: packed }));

        // First-cell crop for ITileDefinition sprites (tiles need W x H,
        // exactly one cell — BYOND tiles always show dir 0 frame 0).
        const tile = Buffer.alloc(meta.width * meta.height * 4);
        const t0x = (stateBase % gridwidth) * meta.width;
        const t0y = Math.floor(stateBase / gridwidth) * meta.height;
        this.blitCell(sheet, t0x, t0y, meta.width, meta.height, tile, meta.width, 0, 0);
        const tilePath = path.join(outputRSIPath, `${fileName}.tile.png`);
        fs.mkdirSync(path.dirname(tilePath), { recursive: true });
        fs.writeFileSync(tilePath, encodePNG({ width: meta.width, height: meta.height, rgba: tile }));
      }
    }

    return meta;
  }

  private blitCell(
    sheet: { width: number; rgba: Buffer },
    sx: number, sy: number, w: number, h: number,
    dst: Buffer, dstWidth: number, dx: number, dy: number
  ): void {
    const sheetStride = sheet.width * 4;
    const rowBytes = w * 4;
    for (let y = 0; y < h; y++) {
      const srcOffset = (sy + y) * sheetStride + sx * 4;
      const dstOffset = (dy + y) * dstWidth * 4 + dx * 4;
      sheet.rgba.copy(dst, dstOffset, srcOffset, srcOffset + rowBytes);
    }
  }

  // The pin's loader resolves `<rsi>/<verbatim state name>.png`, so the file
  // name must match the meta name exactly. `/` inside a name is honoured as
  // a subdirectory separator (the loader resolves it the same way); names
  // that could escape the rsi dir are refused.
  private stateFileName(name: string): string | null {
    if (name === '' || name.startsWith('/') || name.includes('..') || name.includes('\\') || name.includes('\0')) {
      return null;
    }
    return name;
  }
}
