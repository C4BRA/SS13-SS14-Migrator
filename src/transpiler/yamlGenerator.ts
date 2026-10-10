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

      // B-3 (item 71): Sprite component for iconned atoms. `sprite` is
      // relative to /Textures/ (the pin's SpriteComponent resolves
      // TextureRoot / rsi), `state` must be the verbatim RSI state name —
      // the loader does an exact string lookup of <rsi>/<name>.png.
      if (irType.iconState) {
        const spriteComp: any = {
          type: 'Sprite',
          sprite: irType.icon ? YAMLGenerator.iconToRsiResource(irType.icon) : 'Structures/Walls/solid.rsi',
          state: irType.iconState
        };
        // Static color/pixel offsets land on the layer; every other
        // appearance var (dir, alpha, layer, invisibility, ...) is pushed
        // at runtime through AppearanceComponent data (B-3 bridge).
        const color = irType.customVars.get('color');
        if (color !== undefined && color !== null && String(color) !== 'null') {
          spriteComp.color = String(color).replace(/^['"]|['"]$/g, '');
        }
        const px = Number(irType.customVars.get('pixel_x')) || 0;
        const py = Number(irType.customVars.get('pixel_y')) || 0;
        if (px !== 0 || py !== 0) {
          // Vector2 serializes as a scalar "x,y" at this pin, not a sequence.
          spriteComp.offset = `${px / 32},${py / 32}`;
        }
        components.push(spriteComp);
      }

      // B-3: AppearanceComponent is the engine's server-visible appearance
      // channel (the pin ignores Sprite on the server) — every atom proto
      // gets one so the appearance bridge can publish icon/state/dir/…
      if (/^\/(obj|mob|turf|area)(\/|$)/.test(irType.path)) {
        components.push({ type: 'Appearance' });
      }

      // B-3 lighting basics: BYOND luminosity/light_range/light_power/
      // light_color map to the server PointLight component.
      const lum = Number(irType.customVars.get('light_range') ?? irType.customVars.get('luminosity')) || 0;
      if (lum > 0) {
        const lightComp: any = {
          type: 'PointLight',
          radius: lum,
          enabled: true
        };
        const lightPower = Number(irType.customVars.get('light_power'));
        if (lightPower > 0) lightComp.energy = lightPower;
        const lightColor = irType.customVars.get('light_color');
        if (lightColor !== undefined && lightColor !== null && String(lightColor) !== 'null') {
          lightComp.color = String(lightColor).replace(/^['"]|['"]$/g, '');
        }
        components.push(lightComp);
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

      // Attach DMRuntimeComponent: dynamic types (custom vars/procs) always;
      // atom types (obj/mob/turf/area) too, so map-spawned tiles and objects
      // carry a live DM runtime (item 69, B-1). Pure static /datum types
      // stay lean.
      if (irType.isDynamic || /^\/(obj|mob|turf|area)(\/|$)/.test(irType.path)) {
        const customVarObj: Record<string, any> = {};
        for (const [k, v] of irType.customVars.entries()) {
          customVarObj[k] = v;
        }
        // icon/icon_state are consumed by the IR switch (not customVars),
        // but the datum still needs them: the runtime appearance bridge
        // reads datum vars to publish appearance data (B-3).
        if (irType.icon) customVarObj['icon'] = irType.icon;
        if (irType.iconState) customVarObj['icon_state'] = irType.iconState;
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

      // Turfs are ALSO engine tile definitions (item 69, B-1): the engine's
      // map loader resolves grid tiles by tile-def name, not entity protos,
      // so the map converter's tilemap points at these `type: dmTile` protos
      // (registered with ITileDefinitionManager by ConvertedDMSystem). The
      // dmPath field lets the grid-init hook mint the turf's DM datum.
      if (/^\/turf(\/|$)/.test(pathKey)) {
        const tileFields: Record<string, any> = { friction: 0.2, variants: 1 };
        // B-3: the pin's tile atlas needs a plain W x H PNG. The RSI
        // writer emits <state>.tile.png (dir 0 frame 0) next to every
        // state sprite for exactly this purpose; the server validates
        // size/existence in RegisterTileDefs before registering.
        if (irType.icon && irType.iconState) {
          tileFields.sprite = `/Textures/${YAMLGenerator.iconToRsiResource(irType.icon)}/${irType.iconState}.tile.png`;
        }
        prototypes.push({
          type: 'dmTile',
          id: protoId,
          dmPath: irType.path,
          name: irType.name === 'null' ? null : irType.name,
          fields: tileFields
        });
      }
    }

    // Player-mob prototype (item 69, B-1): the entity ConvertedDMSystem
    // attaches joining sessions to. Eye gives the client a camera; the DM
    // datum uses a converted /mob path when the codebase defines one, else
    // the generic /mob path. Sprite borrows the first iconned /mob type.
    const mobSprite = [...irMap.values()].find(t => /^\/mob(\/|$)/.test(t.path) && t.iconState);
    const humanPath = irMap.has('/mob/living/carbon/human') ? '/mob/living/carbon/human' : '/mob';
    const playerComponents: any[] = [
      { type: 'Eye' },
      { type: 'DMRuntime', dmTypePath: humanPath, initialVars: {} }
    ];
    if (mobSprite?.iconState) {
      playerComponents.unshift({
        type: 'Sprite',
        sprite: mobSprite.icon ? YAMLGenerator.iconToRsiResource(mobSprite.icon) : 'Structures/Walls/solid.rsi',
        state: mobSprite.iconState
      });
    }
    playerComponents.push({ type: 'Appearance' });
    prototypes.push({
      type: 'entity',
      id: 'dm_player_mob',
      name: 'player',
      components: playerComponents
    });

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
      if (proto.dmPath) emit(`  dmPath: ${this.yamlScalar(proto.dmPath)}\n`);
      if (proto.fields) emit(this.serializeProps(proto.fields, 2));
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

  // B-3: DM icon var -> /Textures/-relative RSI resource path.
  // 'icons/mob/human.dmi' -> 'icons/mob/human.rsi' — the conversion stage
  // writes RSIs at Resources/Textures/<dmi rel path with .dmi->.rsi>.
  public static iconToRsiResource(icon: string): string {
    return icon
      .replace(/^['"]|['"]$/g, '')
      .replace(/\\/g, '/')
      .replace(/^\/+/, '')
      .replace(/\.dmi$/i, '.rsi');
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
  // Scalars that must be quoted or they deserialize to the wrong type in
  // YamlDotNet: booleans, nulls, numeric forms, and values that START with a
  // YAML indicator (`-`/`?` — a bare `-` parses as a block-sequence marker:
  // "Block sequence entries are not allowed in this context", corpus:
  // tgstation random_name_spacer = "-").
  private static readonly YAML_PLAIN_UNSAFE = /^(yes|no|on|off|true|false|null|~)$|^[-+]?[0-9]|^0x[0-9a-fA-F]|^\.(inf|nan)|^[-?]/i;

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
