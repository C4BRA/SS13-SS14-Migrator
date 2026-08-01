import * as fs from 'fs';
import * as path from 'path';
import { DMMMapData, DMMParser } from './dmmParser.js';

export class MapConverter {
  private parser = new DMMParser();

  public convertDMMToSS14Map(dmmPath: string, outputYAMLPath: string): DMMMapData {
    const dmmData = this.parser.parseDMM(dmmPath);

    const entities: any[] = [];

    let entityIdCounter = 1;

    // DMM row 0 is the northernmost row; SS14 y grows northward, so world y
    // is the grid origin plus (height - 1 - row).
    for (const grid of dmmData.grids) {
      const gridId = entityIdCounter++;
      entities.push({
        type: 'MapGrid',
        id: gridId,
        format: 1
      });

      for (let y = 0; y < grid.height; y++) {
        const row = grid.cells[y];
        if (!row) continue;
        for (let x = 0; x < row.length; x++) {
          const key = row[x];
          const def = dmmData.definitions.get(key);
          if (!def) continue;

          if (def.attributes && Object.keys(def.attributes).length > 0) {
            dmmData.warnings.push(
              `tile key "${key}": per-tile attributes (${Object.keys(def.attributes).join(', ')}) are not mapped to SS14 components (documented limitation)`
            );
          }

          for (const typePath of def.typePaths) {
            if (typePath.startsWith('/area')) continue;
            const protoId = this.typePathToPrototypeId(typePath);
            entities.push({
              proto: protoId,
              id: entityIdCounter++,
              components: [
                {
                  type: 'Transform',
                  pos: `${grid.originX + x}, ${grid.originY + grid.height - 1 - y}`
                }
              ]
            });
          }
        }
      }
    }

    const yamlOutput = this.serializeToYAML(entities, dmmData.grids.length > 1);

    const dir = path.dirname(outputYAMLPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(outputYAMLPath, yamlOutput, 'utf-8');

    return dmmData;
  }

  private typePathToPrototypeId(typePath: string): string {
    const parts = typePath.split('/').filter(Boolean);
    return parts.join('_').toLowerCase();
  }

  private serializeToYAML(entities: any[], multiGrid: boolean): string {
    let yaml = '# SS14 Grid Map converted from SS13 DMM\nmeta:\n  format: 1\n  name: ConvertedStation\nentities:\n';
    for (const ent of entities) {
      yaml += `- id: ${ent.id}\n`;
      if (ent.proto) yaml += `  proto: ${ent.proto}\n`;
      if (ent.type) yaml += `  type: ${ent.type}\n`;
      if (multiGrid && ent.type === 'MapGrid') {
        // Multiple DMM z-levels become separate SS14 grids so no level is
        // dropped; each grid is a distinct entity in the map file.
        yaml += `  components:\n    - type: Grid\n      z: ${ent.id}\n`;
      } else if (ent.components) {
        yaml += `  components:\n`;
        for (const comp of ent.components) {
          yaml += `  - type: ${comp.type}\n`;
          if (comp.pos) yaml += `    pos: ${comp.pos}\n`;
        }
      }
    }
    return yaml;
  }
}
