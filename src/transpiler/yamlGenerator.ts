import * as fs from 'fs';
import * as path from 'path';
import { DMIRType } from '../ir/dmIRGenerator.js';

export class YAMLGenerator {
  // Structural parent prototypes the converter references (BaseItem etc.)
  // that no DM type defines — plain entity stubs so the engine's prototype
  // loader resolves every `parent:` (item 66 boot).
  private static readonly BASE_PARENT_STUBS = ['BaseItem', 'BaseFloor', 'BaseWall', 'BaseMobDummy'];

  public generateYAMLPrototypes(irMap: Map<string, DMIRType>, outputDir: string): void {
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const prototypes: any[] = [];
    for (const stub of YAMLGenerator.BASE_PARENT_STUBS) {
      prototypes.push({ type: 'entity', id: stub });
    }
    // Deterministic id assignment with collision dedupe: distinct DM paths can
    // map to the same id (/obj/item/a_b vs /obj/item/a/b — WS6-4), and
    // duplicates would break prototype loading.
    const idMap = new Map<string, string>();
    const usedIds = new Set<string>();
    for (const pathKey of irMap.keys()) {
      const base = pathKey.replace(/^\//, '').replace(/\//g, '_').toLowerCase();
      let id = base;
      let n = 2;
      while (usedIds.has(id)) id = `${base}_${n++}`;
      usedIds.add(id);
      idMap.set(pathKey, id);
    }

    for (const [pathKey, irType] of irMap.entries()) {
      if (pathKey === '/datum' || pathKey === '/atom') continue;

      const protoId = idMap.get(pathKey)!;
      const parentId = this.parentIdFor(irType, pathKey, idMap);

      const components: any[] = [];

      // Sprite component if icon state exists
      if (irType.iconState) {
        components.push({
          type: 'Sprite',
          sprite: irType.icon ? irType.icon.replace(/\.dmi$/i, '.rsi') : 'Structures/Walls/solid.rsi',
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
              // The engine's IPhysShape is not polymorphic-serializable at
              // this pin (no ImplicitDataDefinitionForInheritors marker), so
              // a `shape:` mapping fails to deserialize ("No data definition
              // found for type IPhysShape"). Fixture.Shape defaults to
              // PhysShapeAabb when omitted — the boot-clean form (item 66).
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
        // A bare `var/name` with no initializer surfaces as the string "null"
        // (WS4-5) — don't emit a null display name.
        name: irType.name === 'null' ? null : irType.name,
        description: irType.desc === 'null' ? null : irType.desc,
        components
      });
    }

    const yamlPath = path.join(outputDir, 'converted_entities.yml');
    // Streaming write: at corpus scale the YAML for 45k+ types is too large
    // to accumulate as one string without risking the node heap (item 66).
    fs.writeFileSync(yamlPath, '# Auto-generated SS14 Prototypes converted from SS13 DM\n');
    let buffer = '';
    const FLUSH_AT = 4 * 1024 * 1024;
    const emit = (chunk: string): void => {
      buffer += chunk;
      if (buffer.length >= FLUSH_AT) {
        fs.appendFileSync(yamlPath, buffer);
        buffer = '';
      }
    };
    for (const proto of prototypes) {
      emit(`- type: ${proto.type}\n`);
      emit(`  id: ${proto.id}\n`);
      if (proto.parent) emit(`  parent: ${proto.parent}\n`);
      if (proto.name) emit(`  name: ${this.yamlScalar(proto.name, true)}\n`);
      if (proto.description) emit(`  description: ${this.yamlScalar(proto.description, true)}\n`);
      if (proto.components && proto.components.length > 0) {
        emit(`  components:\n`);
        for (const comp of proto.components) {
          emit(`  - type: ${comp.type}\n`);
          emit(this.serializeProps(comp, 4, true));
        }
      }
      emit('\n');
    }
    fs.appendFileSync(yamlPath, buffer);
  }

  private parentIdFor(irType: DMIRType, pathKey: string, idMap: Map<string, string>): string | null {
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
    return idMap.get(irType.parentPath) ?? null;
  }

  public pathToId(dmPath: string): string {
    return dmPath.replace(/^\//, '').replace(/\//g, '_').toLowerCase();
  }

  private serializeProps(obj: any, indent: number, skipTopLevelType = false): string {
    let out = '';
    for (const [k, v] of Object.entries(obj ?? {})) {
      // The component's own `type` is emitted by the caller as `- type: X`;
      // serializing it again produces a duplicate YAML key that the engine's
      // parser rejects ("An item with the same key has already been added",
      // item 66 boot). Nested objects keep `type` (fixture shape.type, user
      // vars named `type` — WS6-3/WS6-6).
      if (skipTopLevelType && k === 'type') continue;
      out += `${' '.repeat(indent)}${k}:`;
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        const entries = Object.entries(v);
        if (entries.length === 0) {
          // An empty mapping must be `{}` — a bare `key:` parses as null and
          // the engine rejects it for non-nullable fields like the
          // DMRuntimeComponent's initialVars dictionary (item 66 boot).
          out += ' {}\n';
          continue;
        }
        out += `\n${this.serializeProps(v, indent + 2)}`;
      } else if (Array.isArray(v)) {
        out += `\n`;
        for (const item of v) {
          out += `${' '.repeat(indent + 2)}- ${this.yamlScalar(item)}\n`;
        }
      } else {
        out += ` ${this.yamlScalar(v)}\n`;
      }
    }
    return out;
  }

  // YAML 1.1 scalars that must be quoted or they deserialize to the wrong
  // type in YamlDotNet: booleans, nulls, and numeric forms (WS6-1).
  private static readonly YAML_PLAIN_UNSAFE = /^(yes|no|on|off|true|false|null|~)$|^[-+]?[0-9]|^0x[0-9a-fA-F]|^\.(inf|nan)/i;

  private yamlScalar(v: any, forceQuote = false): string {
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    const s = String(v);
    if (!forceQuote && /^[A-Za-z0-9_.\/-]+$/.test(s) && !YAMLGenerator.YAML_PLAIN_UNSAFE.test(s)) {
      return s;
    }
    // Backslashes and quotes must be escaped inside double-quoted YAML
    // scalars (WS6-2: an unescaped \ before " breaks the whole document).
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
  }
}
