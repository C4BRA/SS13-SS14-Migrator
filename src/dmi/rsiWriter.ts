import * as fs from 'fs';
import * as path from 'path';
import { DMIMetadata, DMIParser } from './dmiParser.js';
import { decodePNG, encodePNG } from './pngCodec.js';

// Converts a BYOND .dmi into the SS14 RSI directory layout:
//   <rsi>/
//     meta.json                  (top-level: version, license, size, states)
//     <state>/
//       <dir>.png                (one sprite per direction)
//       meta.json                (per-state: directions + delays)
//
// DMI sheet layout: `dirs` rows of `frames` frames, each cell width x height.
// SS14 RSI animation frames are stacked VERTICALLY inside the direction png,
// so frame f of direction d is cropped from sheet cell (f*width, d*height)
// and placed at y = f*height.
//
// DMI delay lists cover frames*dirs entries in FRAME-MAJOR order:
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
      } catch {
        sheet = null;
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
      for (const state of meta.states) {
        const stateDir = path.join(outputRSIPath, this.sanitizeStateName(state.name));
        fs.mkdirSync(stateDir, { recursive: true });
        for (let d = 0; d < state.dirs; d++) {
          // Stack all frames of this direction vertically.
          const stacked = Buffer.alloc(meta.width * meta.height * state.frames * 4);
          for (let f = 0; f < state.frames; f++) {
            const sx = f * meta.width;
            const sy = d * meta.height;
            for (let y = 0; y < meta.height; y++) {
              for (let x = 0; x < meta.width; x++) {
                const si = ((sy + y) * sheet.width + (sx + x)) * 4;
                const di = ((f * meta.height + y) * meta.width + x) * 4;
                stacked[di] = sheet.rgba[si];
                stacked[di + 1] = sheet.rgba[si + 1];
                stacked[di + 2] = sheet.rgba[si + 2];
                stacked[di + 3] = sheet.rgba[si + 3];
              }
            }
          }
          const png = encodePNG({ width: meta.width, height: meta.height * state.frames, rgba: stacked });
          fs.writeFileSync(path.join(stateDir, `${d}.png`), png);
        }
        fs.writeFileSync(path.join(stateDir, 'meta.json'), JSON.stringify({
          version: 1,
          size: { x: meta.width, y: meta.height },
          states: [rsiStates.find(s => s.name === state.name)]
        }, null, 2));
      }
    }

    return meta;
  }

  private sanitizeStateName(name: string): string {
    return name.replace(/[\\/]/g, '_').replace(/[^A-Za-z0-9_.-]/g, '_');
  }
}
