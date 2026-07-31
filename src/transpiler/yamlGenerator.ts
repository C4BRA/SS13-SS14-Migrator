import * as fs from 'fs';
import * as path from 'path';
import { DMIRType } from '../ir/dmIRGenerator.js';

export class YAMLGenerator {
  public generateYAMLPrototypes(irMap: Map<string, DMIRType>, outputDir: string): void {
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const prototypes: any[] = [];

    for (const [pathKey, irType] of irMap.entries()) {
      if (pathKey === '/datum' || pathKey === '/atom') continue;

      const protoId = this.pathToId(pathKey);
      const parentId = this.parentIdFor(irType, pathKey);

      const components: any[] = [];

      // Sprite component if icon state exists
      if (irType.iconState) {
        components.push({
          type: 'Sprite',
          sprite: irType.icon ? irType.icon.replace(/\.dmi$/, '.rsi') : 'Structures/Walls/solid.rsi',
          state: irType.iconState
        });
      }

      // Physics / Fixtures if dense
      if (irType.density) {
        components.push({
          type: 'Physics',
          bodyType: 'Static'
        });
        components.push({
          type: 'Fixtures',
          fixtures: {
            fix1: {
              shape: {
                type: 'PhysShapeAABB'
              },
              density: 100,
              hard: true
            }
          }
        });
      }

      // Attach DMRuntimeComponent ONLY if entity needs dynamic DM variables or custom procs
      if (irType.isDynamic) {
        const customVarObj: Record<string, any> = {};
        for (const [k, v] of irType.customVars.entries()) {
          customVarObj[k] = v;
        }
        components.push({
          type: 'DMRuntime',
          dmTypePath: irType.path,
          initialVars: customVarObj
        });
      }

      prototypes.push({
        type: 'entity',
        id: protoId,
        parent: parentId,
        name: irType.name,
        description: irType.desc,
        components
      });
    }

    const yamlContent = this.serializePrototypesToYAML(prototypes);
    fs.writeFileSync(path.join(outputDir, 'converted_entities.yml'), yamlContent, 'utf-8');
  }

  private parentIdFor(irType: DMIRType, pathKey: string): string | null {
    if (pathKey === '/turf') {
      return irType.density ? 'BaseWall' : 'BaseFloor';
    }
    if (pathKey === '/mob') return 'BaseMobDummy';
    if (pathKey === '/area') return null;
    if (pathKey === '/obj') return 'BaseItem';
    if (pathKey === '/datum') return null;
    if (!irType.parentPath || irType.parentPath === '/datum' || irType.parentPath === '/atom') {
      return 'BaseItem';
    }
    return this.pathToId(irType.parentPath);
  }

  public pathToId(dmPath: string): string {
    return dmPath.replace(/^\//, '').replace(/\//g, '_').toLowerCase();
  }

  private serializePrototypesToYAML(prototypes: any[]): string {
    let yaml = '# Auto-generated SS14 Prototypes converted from SS13 DM\n';
    for (const proto of prototypes) {
      yaml += `- type: ${proto.type}\n`;
      yaml += `  id: ${proto.id}\n`;
      if (proto.parent) yaml += `  parent: ${proto.parent}\n`;
      if (proto.name) yaml += `  name: ${this.yamlScalar(proto.name)}\n`;
      if (proto.description) yaml += `  description: ${this.yamlScalar(proto.description)}\n`;
      if (proto.components && proto.components.length > 0) {
        yaml += `  components:\n`;
        for (const comp of proto.components) {
          yaml += `  - type: ${comp.type}\n`;
          yaml += this.serializeProps(comp, 4);
        }
      }
      yaml += '\n';
    }
    return yaml;
  }

  private serializeProps(obj: any, indent: number): string {
    let out = '';
    for (const [k, v] of Object.entries(obj ?? {})) {
      if (k === 'type') continue;
      out += `${' '.repeat(indent)}${k}:`;
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        out += `\n${this.serializeProps(v, indent + 2)}`;
      } else if (Array.isArray(v)) {
        out += `\n`;
        for (const item of v) {
          out += `${' '.repeat(indent + 2)}- ${item}\n`;
        }
      } else {
        out += ` ${this.yamlScalar(v)}\n`;
      }
    }
    return out;
  }

  private yamlScalar(v: any): string {
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (typeof v === 'string' && /^[A-Za-z0-9_.\/-]+$/.test(v)) return v;
    return `"${String(v).replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
  }
}
