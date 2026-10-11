import * as fs from 'fs';
import * as path from 'path';
import { DMMMapData, DMMParser } from './dmmParser.js';

// SS14 map YAML, engine format 6 (verified against RobustToolbox commit
// 9cefa116 — EntityDeserializer: OldestSupportedVersion=3, MapFormatVersion=7):
//   - `meta.format: 6` + `postmapinit: true` so entities load unpaused/live.
//   - `tilemap:` maps an int yaml tile id to a TILE-DEF NAME (resolved via
//     ITileDefinitionManager[defName].TileId — names of `type: dmTile`
//     prototypes emitted by the yaml generator, not entity protos).
//   - `entities:` is grouped by prototype (`- proto: X` + `entities:`);
//     proto-less groups hold the map + grid entities.
//   - Transform `pos` is a 2D Vector2 (no z); each DMM z-level becomes one
//     grid entity parented to the map entity; `parent` is a yaml uid.
//   - MapGrid chunks are 16x16 binary blobs: node {ind: "cx,cy", tiles:
//     <base64>, version: 7} with 7 bytes per tile (int32 yamlTileId, u8
//     flags, u8 variant, u8 rotationMirroring) row-major.
const CHUNK_SIZE = 16;
const BYTES_PER_TILE = 7;

interface OutEntity {
  uid: number;
  proto?: string;
  components: Record<string, any>[];
}

/**
 * Force a flat copy: strings sliced out of a big buffer by slice()/regex stay
 * V8 SlicedStrings that pin their whole parent chunk (~8MB) for the life of
 * the owning map entry. Used for strings retained in the protos cache.
 */
function flatStr(s: string): string {
  return s.length >= 13 ? Buffer.from(s, 'utf-8').toString('utf-8') : s;
}

export class MapConverter {
  private parser = new DMMParser();

  public convertDMMToSS14Map(dmmPath: string, outputYAMLPath: string): DMMMapData {
    const dmmData = this.parser.parseDMM(dmmPath);

    // Proto initialVars for the variant unions: a map entity's DMRuntime
    // component REPLACES the proto's initialVars wholesale (engine
    // CombineMappings is shallow), so attributed atoms' variant protos must
    // restate the proto's vars + their own attrs. Parsed once per output dir
    // (cached); empty when the prototypes file is absent (tests).
    const protoInitialVars = this.loadProtoInitialVars(outputYAMLPath);

    // yaml tile id -> tile def name (the dmTile prototype id).
    const tileIds = new Map<string, number>();
    // 0 is written for every unset cell in a chunk blob; the engine's
    // MapChunkSerializer resolves EVERY cell through tileMap[id], so `0`
    // must map to a registered tile def (same convention as stock maps'
    // `0: Space`). The emitted `dm_space` dmTile proto has no sprite, so
    // out-of-map cells render as space; RegisterGrid still mints a generic
    // /turf datum for them (BYOND world.turf default semantics).
    const tilemap: [number, string][] = [[0, 'dm_space']];
    let nextTileId = 1;
    const tileIdFor = (protoId: string): number => {
      const hit = tileIds.get(protoId);
      if (hit !== undefined) return hit;
      const id = nextTileId++;
      tileIds.set(protoId, id);
      tilemap.push([id, protoId]);
      return id;
    };

    // uid 1 = the map entity; grids get 2..; other entities follow.
    const mapEntity: OutEntity = {
      uid: 1,
      components: [
        { type: 'MetaData', name: 'ConvertedStation' },
        { type: 'Map' },
        { type: 'Transform' }
      ]
    };
    const gridEntities: OutEntity[] = [];
    const protoGroups = new Map<string, OutEntity[]>();
    let entityIdCounter = 2;
    // Attrs on /area + /turf entries have no landing spot (areas aren't
    // entities, turfs are tiles): collect the unmappable names per tile key
    // and warn ONCE per key after the scan — a real station re-uses an
    // attributed key thousands of times (~88k lines pre-dedupe on paradise).
    const unmappableAttrs = new Map<string, Set<string>>();

    // Per-tile attribute overrides land on generated variant protos: a map
    // entity's DMRuntime mapping merges over the proto's WHOLESALE (engine
    // CombineMappings is top-level), so a per-entity component would have to
    // repeat the proto's entire initialVars dict — on boxstation that's
    // ~18k entities x ~45 vars. One variant proto per distinct
    // (proto, attr-set) combo instead: 2.5k small protos, entities stay bare.
    interface VariantProto { id: string; parent: string; dmTypePath: string; vars: Record<string, string>; }
    const variants = new Map<string, VariantProto>();
    const variantIds = new Map<string, string>();

    for (const grid of dmmData.grids) {
      const gridUid = entityIdCounter++;
      const chunks = new Map<string, Map<string, number>>(); // "cx,cy" -> "lx,ly" -> yamlTileId

      // Defer the grid entity push until cells are scanned (entity uids are
      // pre-assigned above so entity parents can reference the grid).
      const gridEntity: OutEntity = {
        uid: gridUid,
        components: [
          { type: 'MetaData', name: `grid_z${grid.z}` },
          {
            type: 'MapGrid',
            tileSize: 1,
            chunkSize: CHUNK_SIZE,
            chunks
          },
          { type: 'Transform', pos: '0, 0', parent: mapEntity.uid }
        ]
      };
      gridEntities.push(gridEntity);

      for (let y = 0; y < grid.height; y++) {
        const row = grid.cells[y];
        if (!row) continue;
        for (let x = 0; x < row.length; x++) {
          const key = row[x];
          if (!key) continue;
          const def = dmmData.definitions.get(key);
          if (!def) continue;

          // Grid row 0 is the northernmost row (world y = originY); SS14 y
          // grows northward, so descending rows are world y = originY - y.
          const worldY = grid.originY - y;
          const worldX = grid.originX + x;

          for (let ti = 0; ti < def.typePaths.length; ti++) {
            const typePath = def.typePaths[ti];
            const attrs = def.entryAttrs?.[ti];
            if (typePath.startsWith('/area')) {
              if (attrs) {
                let set = unmappableAttrs.get(key);
                if (!set) { set = new Set(); unmappableAttrs.set(key, set); }
                for (const a of Object.keys(attrs)) set.add(a);
              }
              continue;
            }
            if (typePath.startsWith('/turf')) {
              if (attrs) {
                let set = unmappableAttrs.get(key);
                if (!set) { set = new Set(); unmappableAttrs.set(key, set); }
                for (const a of Object.keys(attrs)) set.add(a);
              }
              const protoId = this.typePathToPrototypeId(typePath);
              this.addTile(chunks, worldX - 1, worldY - 1, tileIdFor(protoId), dmmData.warnings);
            } else {
              let protoId = this.typePathToPrototypeId(typePath);
              if (attrs && Object.keys(attrs).length > 0) {
                // Placed-atom attrs ride a generated variant proto's
                // DMRuntime.initialVars (proto defaults + map edits) — the
                // entity itself stays bare. See mapVariantFor for why.
                protoId = this.mapVariantFor(
                  variants, variantIds, protoId, typePath, attrs, protoInitialVars);
              }
              let list = protoGroups.get(protoId);
              if (!list) {
                list = [];
                protoGroups.set(protoId, list);
              }
              const ent: OutEntity = {
                uid: entityIdCounter++,
                proto: protoId,
                components: [
                  // DM tile (x, y) is the SS14 tile index (x-1, y-1); an
                  // entity on the tile sits at its center ((x-1)+0.5).
                  { type: 'Transform', pos: `${worldX - 0.5}, ${worldY - 0.5}`, parent: gridUid }
                ]
              };
              list.push(ent);
            }
          }
        }
      }
    }

    for (const [key, names] of unmappableAttrs) {
      dmmData.warnings.push(
        `tile key "${key}": attributes on /turf or /area entries (${[...names].join(', ')}) are not mapped — tiles/areas carry no entity`
      );
    }

    if (variants.size > 0) {
      this.emitVariantProtos(outputYAMLPath, variants, dmmData.warnings);
    }

    const yamlOutput = this.serializeToYAML(mapEntity, gridEntities, protoGroups, tilemap);

    const dir = path.dirname(outputYAMLPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(outputYAMLPath, yamlOutput, 'utf-8');

    return dmmData;
  }

  /**
   * Resolve the variant proto id for one (proto, attrs) combo, creating the
   * VariantProto record on first sight. Variant id reuses the proto-id shape
   * plus a stable `__mv<N>` suffix assigned in scan order (deterministic).
   */
  private mapVariantFor(
    variants: Map<string, { id: string; parent: string; dmTypePath: string; vars: Record<string, string> }>,
    variantIds: Map<string, string>,
    protoId: string,
    typePath: string,
    attrs: Record<string, string>,
    protoInitialVars: Map<string, Record<string, string>>
  ): string {
    const sig = protoId + '|' + Object.keys(attrs).sort().map(k => `${k}=${attrs[k]}`).join(';');
    const hit = variantIds.get(sig);
    if (hit) return hit;
    const id = `${protoId}__mv${variants.size}`;
    variantIds.set(sig, id);
    variants.set(id, {
      id,
      parent: protoId,
      dmTypePath: typePath,
      vars: { ...(protoInitialVars.get(protoId) ?? {}), ...attrs }
    });
    return id;
  }

  /**
   * Emit Resources/Prototypes/map_variants/<map>.yml: one concrete entity
   * proto per distinct placed-atom attr combo. `parent:` keeps every other
   * component inherited; the child's DMRuntime.initialVars replaces the
   * parent's dict (top-level merge) and so carries the full union.
   */
  private emitVariantProtos(
    outputYAMLPath: string,
    variants: Map<string, { id: string; parent: string; dmTypePath: string; vars: Record<string, string> }>,
    warnings: string[]
  ): void {
    const parts = outputYAMLPath.split(path.sep);
    const mapsIdx = parts.lastIndexOf('Maps');
    if (mapsIdx < 0) {
      warnings.push('variant protos could not be emitted: output path is not under Resources/Maps');
      return;
    }
    // Mirror the map's path under Maps/ — basenames collide across dirs
    // (stations/boxstation.dmm vs submaps/boxstation.dmm in paradise).
    const outPath = path.join(
      parts.slice(0, mapsIdx).join(path.sep),
      'Prototypes', 'map_variants',
      ...parts.slice(mapsIdx + 1)
    );
    let vy = '# Map-instance proto variants — per-tile attribute overrides.\n';
    vy += '# A placed atom\'s {k=v} edits ride the variant\'s DMRuntime\n';
    vy += '# initialVars (proto defaults + map edits), one proto per distinct\n';
    vy += '# combo instead of one extra component per placed entity.\n';
    for (const v of variants.values()) {
      vy += `- type: entity\n  id: ${v.id}\n  parent: ${v.parent}\n  components:\n`;
      vy += `  - type: DMRuntime\n    dmTypePath: ${v.dmTypePath}\n    initialVars:\n`;
      for (const [k, val] of Object.entries(v.vars)) {
        vy += `      ${k}: ${JSON.stringify(val)}\n`;
      }
    }
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, vy, 'utf-8');
  }

  // The protos file is ~130MB on paradise — parse it once per output dir, not
  // once per map (199 maps share the same file; a naive re-read cost ~75s).
  private protoInitialVarsCache = new Map<string, Map<string, Record<string, string>>>();

  /**
   * proto id -> declared DMRuntime initialVars, read back out of the emitted
   * prototypes file (Resources/Prototypes/converted_entities.yml, generated
   * in stage 3 — always earlier than stage-5 map conversion). The emitted
   * YAML is machine-shaped: `  id: <id>` under `- type: entity`, then an
   * `    initialVars:` block of `      key: "value"` lines. Values are the
   * raw DM initializer text the runtime's ParseInitialVar coerces.
   */
  private loadProtoInitialVars(outputYAMLPath: string): Map<string, Record<string, string>> {
    const out = new Map<string, Record<string, string>>();
    const parts = outputYAMLPath.split(path.sep);
    const mapsIdx = parts.lastIndexOf('Maps');
    if (mapsIdx < 0) return out;
    const protosPath = path.join(
      parts.slice(0, mapsIdx).join(path.sep), 'Prototypes', 'converted_entities.yml');
    const cached = this.protoInitialVarsCache.get(protosPath);
    if (cached) return cached;
    this.protoInitialVarsCache.set(protosPath, out);
    if (!fs.existsSync(protosPath)) return out;

    let currentId: string | null = null;
    let currentVars: Record<string, string> | null = null;
    // Chunked line scan — the file is ~130MB, so readFileSync().split('\n')
    // peaks near a GB of live string garbage. 8MB chunks keep it flat.
    const fd = fs.openSync(protosPath, 'r');
    try {
      const chunk = Buffer.alloc(8 * 1024 * 1024);
      let tail = '';
      let bytesRead: number;
      while ((bytesRead = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) {
        const text = tail + chunk.toString('utf-8', 0, bytesRead);
        let start = 0;
        for (let i = 0; i <= text.length; i++) {
          if (i < text.length && text.charCodeAt(i) !== 10) continue;
          // `line` = text[start..i); last partial line carries into `tail`.
          if (i === text.length) break;
          const line = text.slice(start, i);
          start = i + 1;
          const idMatch = line.startsWith('  id: ') ? /^  id: (\S+)\s*$/.exec(line) : null;
          if (idMatch) { currentId = flatStr(idMatch[1]); currentVars = null; continue; }
          if (line === '    initialVars:') {
            currentVars = {};
            if (currentId) out.set(currentId, currentVars);
            continue;
          }
          if (currentVars) {
            if (line.charCodeAt(0) === 32 && line.charCodeAt(5) === 32) {
              // "      key: \"value\"" — 6-space indent inside initialVars.
              const kv = /^      (\S+): (".*")\s*$/.exec(line);
              if (kv) {
                // flatStr on the key: slice-derived strings keep their whole
                // 8MB parent chunk alive (V8 SlicedString) — flatten what we retain.
                try { currentVars[flatStr(kv[1])] = JSON.parse(kv[2]); }
                catch { currentVars[flatStr(kv[1])] = kv[2]; }
                continue;
              }
            }
            // Any line that isn't a 6-space kv entry ends the initialVars block.
            if (!line.startsWith('      ') || line.trim() === '') {
              currentVars = null;
            }
          }
        }
        tail = text.slice(start);
      }
      if (tail.length > 0 && currentVars) {
        const kv = /^      (\S+): (".*")\s*$/.exec(tail);
        if (kv) {
          try { currentVars[flatStr(kv[1])] = JSON.parse(kv[2]); }
          catch { currentVars[flatStr(kv[1])] = kv[2]; }
        }
      }
    } finally {
      fs.closeSync(fd);
    }
    return out;
  }

  private typePathToPrototypeId(typePath: string): string {
    // The generated prototype id (same scheme as YAMLGenerator.pathToId:
    // /obj/item/table -> obj_item_table). Both the entity proto and the
    // dmTile proto share this id (different prototype kinds, no collision).
    return typePath.replace(/^\//, '').replace(/\//g, '_').toLowerCase();
  }

  private addTile(chunks: Map<string, Map<string, number>>, tileX: number, tileY: number, yamlTileId: number, warnings: string[]): void {
    // RobustToolbox chunk math: floor division so negative coords land in
    // the correct chunk with a positive local index.
    const cx = Math.floor(tileX / CHUNK_SIZE);
    const cy = Math.floor(tileY / CHUNK_SIZE);
    const lx = tileX - cx * CHUNK_SIZE;
    const ly = tileY - cy * CHUNK_SIZE;
    const key = `${cx},${cy}`;
    const local = `${lx},${ly}`;
    let chunk = chunks.get(key);
    if (!chunk) {
      chunk = new Map();
      chunks.set(key, chunk);
    }
    if (chunk.has(local)) {
      // Two turfs on one tile (WS11-9): keep the first, warn once.
      if (!warnings.includes(`duplicate turf on tile ${local}`)) {
        warnings.push(`duplicate turf on tile ${local} — keeping the first`);
      }
      return;
    }
    chunk.set(local, yamlTileId);
  }

  /** Packs one 16x16 chunk's sparse tiles into the format-7 binary blob. */
  private packChunk(tiles: Map<string, number>): string {
    const buf = Buffer.alloc(CHUNK_SIZE * CHUNK_SIZE * BYTES_PER_TILE);
    for (const [local, yamlTileId] of tiles) {
      const [lx, ly] = local.split(',').map(Number);
      // Row-major: index = y * chunkSize + x (MapChunk.GetTile).
      const off = (ly * CHUNK_SIZE + lx) * BYTES_PER_TILE;
      buf.writeInt32LE(yamlTileId, off);
      // flags / variant / rotationMirroring stay 0.
    }
    return buf.toString('base64');
  }

  private serializeToYAML(
    mapEntity: OutEntity,
    gridEntities: OutEntity[],
    protoGroups: Map<string, OutEntity[]>,
    tilemap: [number, string][]
  ): string {
    let yaml = '# SS14 map converted from SS13 DMM (engine map format 6)\n';
    yaml += 'meta:\n  format: 6\n  name: ConvertedStation\n  postmapinit: true\n';
    if (tilemap.length > 0) {
      yaml += 'tilemap:\n';
      for (const [id, name] of tilemap) {
        yaml += `  ${id}: ${name}\n`;
      }
    }
    yaml += 'entities:\n';
    yaml += '- entities:\n';
    yaml += this.entityYaml(mapEntity, []);
    for (const grid of gridEntities) {
      yaml += this.entityYaml(grid, ['chunks']);
    }
    for (const [proto, entities] of protoGroups) {
      yaml += `- proto: ${proto}\n  entities:\n`;
      for (const ent of entities) {
        yaml += this.entityYaml(ent, []);
      }
    }
    return yaml;
  }

  private entityYaml(ent: OutEntity, specialKeys: string[]): string {
    let out = `  - uid: ${ent.uid}\n    components:\n`;
    for (const comp of ent.components) {
      out += `    - type: ${comp.type}\n`;
      for (const [k, v] of Object.entries(comp)) {
        if (k === 'type') continue;
        if (k === 'chunks' && v instanceof Map) {
          // Format-7 chunk nodes: {ind: "cx,cy", tiles: <base64>, version: 7}
          // under the MapGrid's `chunks` dictionary keyed by chunk index.
          out += '      chunks:\n';
          for (const [key, tiles] of v) {
            out += `        "${key}":\n`;
            out += `          ind: "${key}"\n`;
            out += `          version: 7\n`;
            out += `          tiles: "${this.packChunk(tiles)}"\n`;
          }
          continue;
        }
        if (typeof v === 'object' && v !== null && !(v instanceof Map)) {
          // Nested string map (DMRuntime initialVars): same block shape the
          // prototype emitter writes; values are raw DM text, JSON-quoted so
          // embedded quotes/escapes stay valid YAML scalars.
          out += `      ${k}:\n`;
          for (const [mk, mv] of Object.entries(v)) {
            out += `        ${mk}: ${JSON.stringify(mv)}\n`;
          }
          continue;
        }
        out += `      ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}\n`;
      }
    }
    return out;
  }
}
