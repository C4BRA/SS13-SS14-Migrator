import * as fs from 'fs';
import * as path from 'path';
import { DMIMetadata, DMIParser } from './dmiParser.js';

export class RSIWriter {
  private parser: DMIParser = new DMIParser();

  public convertDMIToRSI(dmiPath: string, outputRSIPath: string): DMIMetadata {
    const meta = this.parser.parseDMI(dmiPath);

    if (!fs.existsSync(outputRSIPath)) {
      fs.mkdirSync(outputRSIPath, { recursive: true });
    }

    const rsiMeta = {
      version: 1,
      license: "CC-BY-SA-3.0",
      copyright: "Converted from SS13 DMI",
      size: { x: meta.width, y: meta.height },
      states: meta.states.map(s => {
        const state: any = {
          name: s.name,
          directions: s.dirs
        };
        if (s.delay) {
          // DMI delay lists cover frames*dirs entries (frame-major per
          // direction); SS14 `delays` is one array per direction holding the
          // per-frame delays, so slice to the frame count per direction.
          const frameDelays = s.delay.slice(0, s.frames);
          state.delays = Array.from({ length: s.dirs }, () => frameDelays);
        }
        return state;
      })
    };

    fs.writeFileSync(path.join(outputRSIPath, 'meta.json'), JSON.stringify(rsiMeta, null, 2));

    // Copy original DMI image as primary texture png or icon sheet
    const pngOutputPath = path.join(outputRSIPath, 'texture.png');
    if (fs.existsSync(dmiPath)) {
      fs.copyFileSync(dmiPath, pngOutputPath);
    }

    return meta;
  }
}
