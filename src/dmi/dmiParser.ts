import * as fs from 'fs';
import * as zlib from 'zlib';
import * as path from 'path';

export interface DMIState {
  name: string;
  dirs: number;
  frames: number;
  delay?: number[];
}

export interface DMIMetadata {
  version: string;
  width: number;
  height: number;
  states: DMIState[];
  warnings: string[];
}

export class DMIParser {
  public parseDMI(filePath: string): DMIMetadata {
    const defaultMeta: DMIMetadata = {
      version: '4.0',
      width: 32,
      height: 32,
      states: [
        { name: 'default', dirs: 1, frames: 1 }
      ],
      warnings: []
    };

    if (!fs.existsSync(filePath)) {
      return defaultMeta;
    }

    try {
      const buffer = fs.readFileSync(filePath);
      
      // Parse PNG chunks to find DMI metadata in tEXt/iTXt/zTXt chunks
      const dmiText = this.extractDMITextFromPNG(buffer);
      
      if (dmiText) {
        return this.parseDMIText(dmiText);
      }
    } catch (e) {
      // Fallback if binary parsing encounters issues
    }

    return defaultMeta;
  }

  private extractDMITextFromPNG(buffer: Buffer): string | null {
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    if (buffer.length < 8 || 
        buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4E || buffer[3] !== 0x47 ||
        buffer[4] !== 0x0D || buffer[5] !== 0x0A || buffer[6] !== 0x1A || buffer[7] !== 0x0A) {
      return null;
    }

    let offset = 8;
    const dmiTexts: string[] = [];

    while (offset < buffer.length) {
      if (offset + 8 > buffer.length) break;
      
      const length = buffer.readUInt32BE(offset);
      const chunkType = buffer.toString('ascii', offset + 4, offset + 8);
      
      if (offset + 8 + length + 4 > buffer.length) break;
      
      const chunkData = buffer.slice(offset + 8, offset + 8 + length);
      const crc = buffer.readUInt32BE(offset + 8 + length);
      
      // Check for text chunks containing DMI data
      if (chunkType === 'tEXt' || chunkType === 'iTXt' || chunkType === 'zTXt') {
        const text = this.parseTextChunk(chunkType, chunkData);
        if (text && text.includes('# BEGIN DMI')) {
          dmiTexts.push(text);
        }
      }
      
      // IEND chunk marks end
      if (chunkType === 'IEND') break;
      
      offset += 12 + length;
    }

    // Multiple # BEGIN DMI chunks are INDEPENDENT metadata blocks (WS10-11):
    // concatenating them merged states and let a later width/height win.
    // Join them with a separator that parseDMIText treats as a boundary.
    return dmiTexts.length > 0 ? dmiTexts.join('\n# BEGIN DMI\n') : null;
  }

  private parseTextChunk(chunkType: string, data: Buffer): string {
    if (chunkType === 'tEXt') {
      // tEXt: keyword\0text (ISO/IEC 8859-1)
      const nullIdx = data.indexOf(0);
      if (nullIdx > 0) {
        const keyword = data.toString('latin1', 0, nullIdx);
        if (keyword === 'DMI' || keyword === 'Description') {
          return data.toString('latin1', nullIdx + 1);
        }
      }
    } else if (chunkType === 'iTXt') {
      // iTXt: keyword\0compressionFlag\0compressionMethod\0languageTag\0translatedKeyword\0text (UTF-8)
      // The language tag and translated keyword are NUL-terminated strings that
      // are usually EMPTY, so adjacent NULs collapse — do not require exactly 5
      // distinct NUL bytes; walk the fields positionally instead.
      const firstNul = data.indexOf(0);
      if (firstNul > 0) {
        const keyword = data.toString('utf8', 0, firstNul);
        if (keyword === 'DMI' || keyword === 'Description') {
          const compressionFlag = data[firstNul + 1];
          let i = firstNul + 2; // skip flag + method bytes
          if (data[i] === 0) i++; // empty language tag
          else {
            const tagEnd = data.indexOf(0, i);
            i = tagEnd > 0 ? tagEnd + 1 : data.length;
          }
          if (i >= data.length) return '';
          if (data[i] === 0) i++; // empty translated keyword
          else {
            const kwEnd = data.indexOf(0, i);
            i = kwEnd > 0 ? kwEnd + 1 : data.length;
          }
          if (i >= data.length) return '';
          if (compressionFlag === 1) {
            try {
              return zlib.inflateSync(data.subarray(i)).toString('utf8');
            } catch {
              return '';
            }
          }
          return data.toString('utf8', i);
        }
      }
    } else if (chunkType === 'zTXt') {
      // zTXt: keyword\0compressionMethod\0compressedText (zlib-deflated)
      const nullIdx = data.indexOf(0);
      if (nullIdx > 0) {
        const keyword = data.toString('latin1', 0, nullIdx);
        if (keyword === 'DMI' || keyword === 'Description') {
          const compressed = data.slice(nullIdx + 2);
          try {
            return zlib.inflateSync(compressed).toString('utf8');
          } catch {
            return '';
          }
        }
      }
    }
    return '';
  }

  private parseDMIText(text: string): DMIMetadata {
    const lines = text.split('\n');
    let width = 32;
    let height = 32;
    let version = '4.0';
    const states: DMIState[] = [];
    const warnings: string[] = [];

    let currentState: DMIState | null = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // A second # BEGIN DMI block ends any open state (WS10-11).
      if (trimmed.startsWith('# BEGIN DMI')) {
        if (currentState) {
          states.push(currentState);
          currentState = null;
        }
        continue;
      }

      if (trimmed.startsWith('version =')) {
        version = trimmed.split('=')[1].trim();
      } else if (trimmed.startsWith('width =')) {
        width = parseInt(trimmed.split('=')[1].trim(), 10) || 32;
      } else if (trimmed.startsWith('height =')) {
        height = parseInt(trimmed.split('=')[1].trim(), 10) || 32;
      } else if (trimmed.startsWith('state')) {
        if (currentState) {
          states.push(currentState);
        }
        const stateNameMatch = trimmed.match(/^state\s*=\s*"([^"]+)"/) || trimmed.match(/^state\s+"([^"]+)"/);
        const name = stateNameMatch ? (stateNameMatch[1] ?? stateNameMatch[2]) : 'unnamed';
        currentState = { name, dirs: 1, frames: 1 };
      } else if (currentState) {
        if (trimmed.startsWith('dirs =')) {
          const rawDirs = parseInt(trimmed.split('=')[1].trim(), 10);
          // dirs = 0 silently coerced to 1 before; an explicit 0 is invalid
          // (WS10-9).
          if (Number.isNaN(rawDirs) || rawDirs <= 0) {
            warnings.push(`state '${currentState.name}': invalid dirs=${rawDirs} (expected 1, 4, or 8) — using 1`);
            currentState.dirs = 1;
          } else {
            currentState.dirs = rawDirs;
            if (currentState.dirs !== 1 && currentState.dirs !== 4 && currentState.dirs !== 8) {
              warnings.push(`state '${currentState.name}': invalid dirs=${currentState.dirs} (expected 1, 4, or 8)`);
            }
          }
        } else if (trimmed.startsWith('frames =')) {
          const rawFrames = parseInt(trimmed.split('=')[1].trim(), 10);
          if (Number.isNaN(rawFrames) || rawFrames <= 0) {
            warnings.push(`state '${currentState.name}': invalid frames=${rawFrames} — using 1`);
            currentState.frames = 1;
          } else {
            currentState.frames = rawFrames;
          }
        } else if (trimmed.startsWith('delay =')) {
          const rawDelays = trimmed.split('=')[1].trim().split(',').map(s => s.trim());
          const stateName = currentState.name;
          currentState.delay = rawDelays.map((d, i) => {
            const v = parseFloat(d);
            if (Number.isNaN(v) || v <= 0) {
              // Delay 0/non-numeric is invalid (WS10-10); negatives must not
              // pass through to the RSI delays.
              warnings.push(`state '${stateName}': invalid delay entry '${d}' (entry ${i + 1}) — using 1`);
              return 1;
            }
            return v;
          });
        }
      }
    }

    if (currentState) {
      states.push(currentState);
    }

    for (const state of states) {
      if (state.delay && state.delay.length !== state.frames * state.dirs) {
        warnings.push(
          `state '${state.name}': delay list length ${state.delay.length} does not match frames(${state.frames}) * dirs(${state.dirs})`
        );
      }
    }

    return {
      version,
      width,
      height,
      states: states.length > 0 ? states : [{ name: 'default', dirs: 1, frames: 1 }],
      warnings
    };
  }
}