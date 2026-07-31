import * as fs from 'fs';

export interface DMMTileDefinition {
  key: string;
  typePaths: string[];
  attributes?: Record<string, string>;
}

export interface DMMGrid {
  z: number;
  width: number;
  height: number;
  cells: string[][]; // 2D array of tile keys
}

export interface DMMMapData {
  definitions: Map<string, DMMTileDefinition>;
  grids: DMMGrid[];
  warnings: string[];
}

export class DMMParser {
  public parseDMM(filePath: string): DMMMapData {
    const mapData: DMMMapData = {
      definitions: new Map(),
      grids: [],
      warnings: []
    };

    if (!fs.existsSync(filePath)) {
      return mapData;
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    let inGridSection = false;
    let currentGridLines: string[] = [];
    let currentZ = 1;

    for (let line of lines) {
      line = line.trim();
      if (!line) continue;
      if (line.startsWith('#') || line.startsWith('//')) continue;

      // Match tile key definition line: "aaa" = (/turf/simulated/floor, /obj/item/sword)
      const defMatch = line.match(/^"([^"]+)"\s*=\s*\((.+)\)$/);
      if (defMatch) {
        const key = defMatch[1];
        const rawTypes = defMatch[2];
        const parsed = rawTypes.split(',').map((s: string) => {
          const trimmed = s.trim().replace(/^['"]|['"]$/g, '');
          // Strip per-tile attributes: /turf/floor{dir=4;icon_state="x"}
          const attrMatch = trimmed.match(/^(.+)\{([^}]*)\}$/);
          if (!attrMatch) return { path: trimmed, attrs: undefined };
          const attrs: Record<string, string> = {};
          for (const pair of attrMatch[2].split(';')) {
            const eq = pair.indexOf('=');
            if (eq > 0) attrs[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
          }
          return { path: attrMatch[1].trim(), attrs };
        });
        const typePaths: string[] = [];
        let attributes: Record<string, string> | undefined;
        for (const entry of parsed) {
          typePaths.push(entry.path);
          if (entry.attrs && Object.keys(entry.attrs).length > 0) {
            if (!attributes) attributes = {};
            Object.assign(attributes, entry.attrs);
          }
        }
        mapData.definitions.set(key, { key, typePaths, attributes });
        continue;
      }

      // Match Grid Coordinate header line: (1,1,1) = {"
      const gridHeaderMatch = line.match(/^\(\d+,\d+,(\d+)\)\s*=\s*\{"$/);
      if (gridHeaderMatch) {
        if (currentGridLines.length > 0) {
          mapData.grids.push(this.buildGrid(currentGridLines, currentZ, mapData.definitions, mapData.warnings));
          currentGridLines = [];
        }
        currentZ = parseInt(gridHeaderMatch[1], 10);
        inGridSection = true;
        continue;
      }

      if (inGridSection) {
        if (line === '"}') {
          inGridSection = false;
          if (currentGridLines.length > 0) {
            mapData.grids.push(this.buildGrid(currentGridLines, currentZ, mapData.definitions, mapData.warnings));
            currentGridLines = [];
          }
        } else {
          currentGridLines.push(line);
        }
      } else {
        mapData.warnings.push(`unrecognized line in map file: ${line}`);
      }
    }

    // Validate: every grid cell key must have a definition
    const usedKeys = new Set<string>();
    for (const grid of mapData.grids) {
      for (const row of grid.cells) {
        for (const key of row) usedKeys.add(key);
      }
    }
    for (const key of usedKeys) {
      if (!mapData.definitions.has(key)) {
        mapData.warnings.push(`grid uses undefined tile key "${key}"`);
      }
    }
    for (const key of mapData.definitions.keys()) {
      if (!usedKeys.has(key)) {
        mapData.warnings.push(`tile key "${key}" is defined but never used in any grid (orphan definition)`);
      }
    }

    return mapData;
  }

  private buildGrid(rawLines: string[], z: number, definitions: Map<string, DMMTileDefinition>, warnings: string[]): DMMGrid {
    // Key length is deduced from first key in definitions or raw line
    const sampleKey = definitions.keys().next().value || "aaa";
    const keyLen = sampleKey.length;

    const cells: string[][] = [];

    for (const rawLine of rawLines) {
      const trimmedLine = rawLine.trim();
      if (!trimmedLine) continue;
      
      // Detect format: if line length equals keyLen, it's one key per line (row with single column)
      // If line length is multiple of keyLen > 1, it's concatenated fixed-width keys
      // Otherwise, try space-separated
      let lineKeys: string[] = [];
      
      if (trimmedLine.length === keyLen) {
        // Single key per line (each line = one row, one column)
        lineKeys = [trimmedLine];
      } else if (trimmedLine.length % keyLen === 0 && trimmedLine.length > keyLen) {
        // Concatenated fixed-width keys
        for (let i = 0; i < trimmedLine.length; i += keyLen) {
          const k = trimmedLine.substring(i, i + keyLen);
          if (k) lineKeys.push(k);
        }
      } else {
        // Space-separated keys
        lineKeys = trimmedLine.split(/\s+/).filter(k => k);
      }
      
      if (lineKeys.length > 0) {
        cells.push(lineKeys);
      }
    }

    const height = cells.length;
    const width = height > 0 ? cells[0].length : 0;

    // Rectangularity: all rows must have the same width
    for (const row of cells) {
      if (row.length !== width) {
        warnings.push(`grid z=${z}: row has ${row.length} tiles, expected ${width} (grid must be rectangular)`);
      }
    }

    return {
      z,
      width,
      height,
      cells
    };
  }
}
