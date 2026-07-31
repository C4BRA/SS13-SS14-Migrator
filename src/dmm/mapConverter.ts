import * as fs from 'fs';
import * as path from 'path';
import { DMMMapData, DMMParser } from './dmmParser.js';

export class MapConverter {
  private parser = new DMMParser();

  public convertDMMToSS14Map(dmmPath: string, outputYAMLPath: string): DMMMapData {
    const dmmData = this.parser.parseDMM(dmmPath);

    const entities: any[] = [
      {
        type: 'MapGrid',
        id: 1,
        format: 1
      }
    ];

    let entityIdCounter = 2;

    if (dmmData.grids.length > 0) {
      const grid = dmmData.grids[0];

      for (let y = 0; y < grid.height; y++) {
        const row = grid.cells[y];
        for (let x = 0; x < row.length; x++) {
          const key = row[x];
          const def = dmmData.definitions.get(key);
          if (!def) continue;

          for (const typePath of def.typePaths) {
            if (typePath.startsWith('/area')) continue;
            const protoId = this.typePathToPrototypeId(typePath);
            entities.push({
              proto: protoId,
              id: entityIdCounter++,
              components: [
                {
                  type: 'Transform',
                  pos: `${x}, ${grid.height - y}`
                }
              ]
            });
          }
        }
      }
    }

    const yamlOutput = this.serializeToYAML(entities);

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

  private serializeToYAML(entities: any[]): string {
    let yaml = '# SS14 Grid Map converted from SS13 DMM\nmeta:\n  format: 1\n  name: ConvertedStation\nentities:\n';
    for (const ent of entities) {
      yaml += `- id: ${ent.id}\n`;
      if (ent.proto) yaml += `  proto: ${ent.proto}\n`;
      if (ent.type) yaml += `  type: ${ent.type}\n`;
      if (ent.components) {
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
