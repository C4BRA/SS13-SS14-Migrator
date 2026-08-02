import * as fs from 'fs';

export interface DMMTileDefinition {
  key: string;
  typePaths: string[];
  attributes?: Record<string, string>;
}

export interface DMMGrid {
  z: number;
  originX: number;
  originY: number;
  width: number;
  height: number;
  cells: string[][]; // 2D array of tile keys
}

export interface DMMMapData {
  definitions: Map<string, DMMTileDefinition>;
  grids: DMMGrid[];
  warnings: string[];
}

interface Section {
  z: number;
  originX: number;
  originY: number;
  lines: string[];
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

    const sections: Section[] = [];
    let pendingDef = '';
    let pendingDefKey = '';

    for (let rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line.startsWith('#') || line.startsWith('//')) continue;

      // TGM multi-line definitions: a def body ends only when its parentheses
      // balance, so "..." = (/turf/floor\n/obj/table) accumulates across lines.
      if (pendingDef) {
        pendingDef += '\n' + line;
        if (this.parenBalanced(pendingDef)) {
          this.parseDefinition(pendingDefKey, pendingDef, mapData);
          pendingDef = '';
          pendingDefKey = '';
        }
        continue;
      }

      // Match tile key definition line: "aaa" = (/turf/simulated/floor, /obj/item/sword)
      const defMatch = line.match(/^"([^"]+)"\s*=\s*(.+)$/);
      if (defMatch && defMatch[2].startsWith('(')) {
        if (this.parenBalanced(defMatch[2])) {
          this.parseDefinition(defMatch[1], defMatch[2], mapData);
        } else {
          pendingDef = defMatch[2];
          pendingDefKey = defMatch[1];
        }
        continue;
      }

      // Match Grid Coordinate header line: (1,1,1) = {"  (negative coords allowed)
      const gridHeaderMatch = line.match(/^\((-?\d+),(-?\d+),(-?\d+)\)\s*=\s*\{"$/);
      if (gridHeaderMatch) {
        sections.push({
          z: parseInt(gridHeaderMatch[3], 10),
          originX: parseInt(gridHeaderMatch[1], 10),
          originY: parseInt(gridHeaderMatch[2], 10),
          lines: []
        });
        continue;
      }

      if (line === '"}') {
        // section closed by end marker
      } else if (sections.length > 0) {
        sections[sections.length - 1].lines.push(line);
      } else {
        mapData.warnings.push(`unrecognized line in map file: ${line}`);
      }
    }

    if (pendingDef) {
      mapData.warnings.push(`unterminated tile key definition "${pendingDefKey}": ${pendingDef.slice(0, 80)}`);
    }

    // Per-column sections: a z-level may be split into multiple (x,y) sections
    // ("per-column" columns of the same z). Merge all sections of one z into a
    // single grid spanning the union, padding gaps with empty cells.
    const byZ = new Map<number, Section[]>();
    for (const s of sections) {
      const list = byZ.get(s.z);
      if (list) list.push(s);
      else byZ.set(s.z, [s]);
    }
    for (const [z, zSections] of byZ) {
      const grid = this.mergeSections(z, zSections, mapData);
      if (grid.width > 0 && grid.height > 0) mapData.grids.push(grid);
    }

    // Validate: every grid cell key must have a definition
    const usedKeys = new Set<string>();
    for (const grid of mapData.grids) {
      for (const row of grid.cells) {
        for (const key of row) {
          if (key) usedKeys.add(key);
        }
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

  private parenBalanced(text: string): boolean {
    let depth = 0;
    let inString = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        if (c === '"' && text[i - 1] !== '\\') inString = false;
      } else if (c === '"') {
        inString = true;
      } else if (c === '(') depth++;
      else if (c === ')') depth--;
      if (depth < 0) return true;
    }
    return depth === 0;
  }

  private parseDefinition(key: string, body: string, mapData: DMMMapData): void {
    // Strip outer parens and split on commas at brace/quote depth 0.
    const inner = body.trim().replace(/^\(\s*([\s\S]*?)\s*\)$/, '$1');
    const segments = this.splitTopLevel(inner, ',');

    const typePaths: string[] = [];
    let attributes: Record<string, string> | undefined;

    for (const seg of segments) {
      // TGM "= /path" continuations: "/obj/foo{layer=5} = /obj/bar" are two
      // entries on one line — split on top-level '=' first.
      for (const entry of this.splitTopLevel(seg, '=')) {
        const t = entry.trim();
        if (!t) continue;
        const parsed = this.parseEntry(t);
        if (!parsed) continue;
        typePaths.push(parsed.path);
        if (parsed.attrs && Object.keys(parsed.attrs).length > 0) {
          if (!attributes) attributes = {};
          Object.assign(attributes, parsed.attrs);
        }
      }
    }

    if (typePaths.length > 0) {
      mapData.definitions.set(key, { key, typePaths, attributes });
    }
  }

  private parseEntry(text: string): { path: string; attrs?: Record<string, string> } | null {
    const trimmed = text.trim().replace(/^['"]|['"]$/g, '');
    // Per-tile attributes: /turf/floor{dir=4;icon_state="x"}
    const attrMatch = trimmed.match(/^(.+)\{([^}]*)\}$/);
    if (!attrMatch) return { path: trimmed, attrs: undefined };
    const attrs: Record<string, string> = {};
    for (const pair of attrMatch[2].split(';')) {
      const eq = pair.indexOf('=');
      if (eq > 0) attrs[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
    return { path: attrMatch[1].trim(), attrs };
  }

  private splitTopLevel(text: string, sep: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let inString = false;
    let cur = '';
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        cur += c;
        if (c === '"' && text[i - 1] !== '\\') inString = false;
        continue;
      }
      if (c === '"') { inString = true; cur += c; continue; }
      if (c === '(' || c === '{' || c === '[') { depth++; cur += c; continue; }
      if (c === ')' || c === '}' || c === ']') { depth--; cur += c; continue; }
      if ((c === sep || c === '\n') && depth === 0) {
        parts.push(cur);
        cur = '';
        continue;
      }
      cur += c;
    }
    if (cur.trim()) parts.push(cur);
    return parts;
  }

  private decodeLine(rawLine: string, keyLen: number): string[] {
    const trimmedLine = rawLine.trim();
    if (!trimmedLine) return [];

    // Single key per line, concatenated fixed-width keys, or space-separated.
    if (trimmedLine.length === keyLen) return [trimmedLine];
    if (trimmedLine.length % keyLen === 0 && trimmedLine.length > keyLen) {
      const keys: string[] = [];
      for (let i = 0; i < trimmedLine.length; i += keyLen) {
        const k = trimmedLine.substring(i, i + keyLen);
        if (k) keys.push(k);
      }
      return keys;
    }
    return trimmedLine.split(/\s+/).filter(k => k);
  }

  private buildSectionGrid(section: Section, keyLen: number, warnings: string[]): string[][] {
    const cells: string[][] = [];
    for (const rawLine of section.lines) {
      const keys = this.decodeLine(rawLine, keyLen);
      if (keys.length > 0) cells.push(keys);
    }
    return cells;
  }

  private mergeSections(z: number, sections: Section[], mapData: DMMMapData): DMMGrid {
    const sampleKey = mapData.definitions.keys().next().value;
    if (typeof sampleKey !== 'string' || sampleKey.length === 0) {
      mapData.warnings.push(`grid z=${z}: no tile key definitions found; grid skipped`);
      return { z, originX: 0, originY: 0, width: 0, height: 0, cells: [] };
    }
    const keyLen = sampleKey.length;

    const decoded: { x: number; y: number; width: number; height: number; cells: string[][] }[] = [];
    for (const s of sections) {
      const cells = this.buildSectionGrid(s, keyLen, mapData.warnings);
      if (cells.length === 0) continue;
      // Rectangularity: all rows within a section must have the same width.
      const rowLen = cells[0].length;
      for (const row of cells) {
        if (row.length !== rowLen) {
          mapData.warnings.push(`grid z=${z}: row has ${row.length} tiles, expected ${rowLen} (grid must be rectangular)`);
          break;
        }
      }
      // Section row r (0 = northernmost) is at world y = originY + height-1-r.
      const worldTop = s.originY + cells.length - 1;
      decoded.push({ x: s.originX, y: worldTop, width: cells[0].length, height: cells.length, cells });
    }
    if (decoded.length === 0) {
      mapData.warnings.push(`grid z=${z}: no decodable rows; grid skipped`);
      return { z, originX: 0, originY: 0, width: 0, height: 0, cells: [] };
    }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, minSouth = Infinity;
    for (const d of decoded) {
      minX = Math.min(minX, d.x);
      minY = Math.min(minY, d.y);
      maxX = Math.max(maxX, d.x + d.width - 1);
      maxY = Math.max(maxY, d.y);
      minSouth = Math.min(minSouth, d.y - d.height + 1);
    }
    const width = maxX - minX + 1;
    const height = maxY - minSouth + 1;

    // Row 0 of the merged grid = world row maxY (northernmost).
    const grid: string[][] = Array.from({ length: height }, () => Array(width).fill(''));
    for (const d of decoded) {
      for (let r = 0; r < d.height; r++) {
        const worldRow = d.y - r; // section row r is at world y = d.y - r
        const gridRow = maxY - worldRow;
        for (let c = 0; c < d.cells[r].length; c++) {
          grid[gridRow][d.x - minX + c] = d.cells[r][c];
        }
      }
    }

    return { z, originX: minX, originY: minY, width, height, cells: grid };
  }
}
