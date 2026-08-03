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
exports.RSIWriter = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const dmiParser_js_1 = require("./dmiParser.js");
const pngCodec_js_1 = require("./pngCodec.js");
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
class RSIWriter {
    parser = new dmiParser_js_1.DMIParser();
    convertDMIToRSI(dmiPath, outputRSIPath) {
        const meta = this.parser.parseDMI(dmiPath);
        if (!fs.existsSync(outputRSIPath)) {
            fs.mkdirSync(outputRSIPath, { recursive: true });
        }
        let sheet = null;
        if (fs.existsSync(dmiPath)) {
            try {
                sheet = (0, pngCodec_js_1.decodePNG)(fs.readFileSync(dmiPath));
            }
            catch (e) {
                sheet = null;
                meta.warnings.push(`failed to decode sheet '${dmiPath}': ${e?.message ?? e} — metadata-only RSI emitted`);
            }
        }
        const rsiStates = meta.states.map(s => {
            const state = {
                name: s.name,
                directions: s.dirs
            };
            if (s.delay) {
                // Frame-major: delay[d + f*dirs] is the delay of dir d, frame f.
                const perDir = Array.from({ length: s.dirs }, (_, d) => Array.from({ length: s.frames }, (_, f) => s.delay[d + f * s.dirs] ?? 1));
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
                // A sheet smaller than the declared cells would crop out-of-bounds
                // into silent black/garbage pixels — skip with a warning instead.
                const needW = state.frames * meta.width;
                const needH = state.dirs * meta.height;
                if (sheet.width < needW || sheet.height < needH) {
                    meta.warnings.push(`state '${state.name}': sheet ${sheet.width}x${sheet.height} is smaller than declared ${needW}x${needH} — sprites skipped`);
                    continue;
                }
                for (let d = 0; d < state.dirs; d++) {
                    // DMI 4-dir rows are S,N,E,W; SS14 RSI direction indices are
                    // S,E,N,W (0,1,2,3). Copying rows verbatim swapped North and East
                    // (WS10-1 — color-row probe proof). dirs=8 has no SS14 equivalent
                    // (SS14 supports 1/4); emit with a warning.
                    if (state.dirs === 8) {
                        meta.warnings.push(`state '${state.name}': dirs=8 is not supported by SS14 RSIs (1/4 only) — emitting rows verbatim`);
                    }
                    const ss14Dir = state.dirs === 4 ? [0, 2, 1, 3][d] : d;
                    // Stack all frames of this direction vertically.
                    const stacked = Buffer.alloc(meta.width * meta.height * state.frames * 4);
                    const frameSize = meta.width * meta.height * 4;
                    const sheetStride = sheet.width * 4;
                    const rowBytes = meta.width * 4;
                    for (let f = 0; f < state.frames; f++) {
                        const sx = f * meta.width * 4;
                        const sy = d * meta.height;
                        const destOffset = f * frameSize;
                        const srcRowStart = sy * sheetStride + sx;
                        // Bulk copy entire scanlines instead of per-pixel operations
                        for (let y = 0; y < meta.height; y++) {
                            const srcOffset = srcRowStart + y * sheetStride;
                            const dstOffset = destOffset + y * rowBytes;
                            sheet.rgba.copy(stacked, dstOffset, srcOffset, srcOffset + rowBytes);
                        }
                    }
                    const png = (0, pngCodec_js_1.encodePNG)({ width: meta.width, height: meta.height * state.frames, rgba: stacked });
                    fs.writeFileSync(path.join(stateDir, `${ss14Dir}.png`), png);
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
    sanitizeStateName(name) {
        return name.replace(/[\\/]/g, '_').replace(/[^A-Za-z0-9_.-]/g, '_');
    }
}
exports.RSIWriter = RSIWriter;
