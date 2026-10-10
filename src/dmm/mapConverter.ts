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

export class MapConverter {
  private parser = new DMMParser();

  public convertDMMToSS14Map(dmmPath: string, outputYAMLPath: string): DMMMapData {
    const dmmData = this.parser.parseDMM(dmmPath);

    // yaml tile id -> tile def name (the dmTile prototype id).
    const tileIds = new Map<string, number>();
    const tilemap: [number, string][] = [];
    let nextTileId = 1; // 0 is reserved: Tile.Empty
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

          if (def.attributes && Object.keys(def.attributes).length > 0) {
            dmmData.warnings.push(
              `tile key "${key}": per-tile attributes (${Object.keys(def.attributes).join(', ')}) are not mapped to SS14 components (documented limitation)`
            );
          }

          // Grid row 0 is the northernmost row (world y = originY); SS14 y
          // grows northward, so descending rows are world y = originY - y.
          const worldY = grid.originY - y;
          const worldX = grid.originX + x;

          for (const typePath of def.typePaths) {
            if (typePath.startsWith('/area')) continue;
            if (typePath.startsWith('/turf')) {
              const protoId = this.typePathToPrototypeId(typePath);
              this.addTile(chunks, worldX - 1, worldY - 1, tileIdFor(protoId), dmmData.warnings);
            } else {
              const protoId = this.typePathToPrototypeId(typePath);
              let list = protoGroups.get(protoId);
              if (!list) {
                list = [];
                protoGroups.set(protoId, list);
              }
              list.push({
                uid: entityIdCounter++,
                proto: protoId,
                components: [
                  // DM tile (x, y) is the SS14 tile index (x-1, y-1); an
                  // entity on the tile sits at its center ((x-1)+0.5).
                  { type: 'Transform', pos: `${worldX - 0.5}, ${worldY - 0.5}`, parent: gridUid }
                ]
              });
            }
          }
        }
      }
    }

    const yamlOutput = this.serializeToYAML(mapEntity, gridEntities, protoGroups, tilemap);

    const dir = path.dirname(outputYAMLPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(outputYAMLPath, yamlOutput, 'utf-8');

    return dmmData;
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
        out += `      ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}\n`;
      }
    }
    return out;
  }
}
