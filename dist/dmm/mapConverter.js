"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.MapConverter = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const dmmParser_js_1 = require("./dmmParser.js");
// SS14 map YAML (format 2): entities carry `uid` + optional `proto`, grids are
// MapGrid entities with per-chunk tile arrays, and every Transform pos has an
// explicit z taken from the source grid's z-level.
const CHUNK_SIZE = 8;
class MapConverter {
    parser = new dmmParser_js_1.DMMParser();
    convertDMMToSS14Map(dmmPath, outputYAMLPath) {
        const dmmData = this.parser.parseDMM(dmmPath);
        const tilemap = new Map();
        const entities = [];
        let entityIdCounter = 1;
        for (const grid of dmmData.grids) {
            const gridId = entityIdCounter++;
            const chunks = new Map();
            const gridEntity = {
                uid: gridId,
                type: 'MapGrid',
                components: [
                    { type: 'MetaData', name: `grid_z${grid.z}` },
                    { type: 'Transform', pos: `0, 0, ${grid.z}` },
                    { type: 'MapGrid', chunks: chunks, tileSize: 1 }
                ]
            };
            entities.push(gridEntity);
            for (let y = 0; y < grid.height; y++) {
                const row = grid.cells[y];
                if (!row)
                    continue;
                for (let x = 0; x < row.length; x++) {
                    const key = row[x];
                    if (!key)
                        continue;
                    const def = dmmData.definitions.get(key);
                    if (!def)
                        continue;
                    if (def.attributes && Object.keys(def.attributes).length > 0) {
                        dmmData.warnings.push(`tile key "${key}": per-tile attributes (${Object.keys(def.attributes).join(', ')}) are not mapped to SS14 components (documented limitation)`);
                    }
                    // Grid row 0 is the northernmost row (world y = originY); SS14 y
                    // grows northward, so descending rows are world y = originY - y.
                    const worldY = grid.originY - y;
                    const worldX = grid.originX + x;
                    for (const typePath of def.typePaths) {
                        if (typePath.startsWith('/area'))
                            continue;
                        if (typePath.startsWith('/turf')) {
                            const tileId = this.turfToTileId(typePath);
                            tilemap.set(tileId, this.tileIdToPrototype(tileId));
                            this.addTile(chunks, worldX, worldY, tileId, dmmData.warnings);
                        }
                        else {
                            const protoId = this.typePathToPrototypeId(typePath);
                            entities.push({
                                uid: entityIdCounter++,
                                proto: protoId,
                                components: [
                                    { type: 'Transform', pos: `${worldX}, ${worldY}, ${grid.z}` }
                                ]
                            });
                        }
                    }
                }
            }
        }
        const yamlOutput = this.serializeToYAML(entities, tilemap);
        const dir = path.dirname(outputYAMLPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(outputYAMLPath, yamlOutput, 'utf-8');
        return dmmData;
    }
    turfToTileId(typePath) {
        const parts = typePath.split('/').filter(Boolean);
        const base = parts[parts.length - 1].toLowerCase().replace(/[^a-z0-9_]/g, '_');
        return base || 'floor';
    }
    tileIdToPrototype(tileId) {
        // SS14 turf prototypes are PascalCase real content prototypes (Floor,
        // Plating, Wall, Space...). Invented "TurfFloor" names would fail
        // prototype resolution on load (WS11-2).
        const known = {
            floor: 'Floor',
            plating: 'Plating',
            wall: 'Wall',
            space: 'Space',
            lava: 'Lava',
            water: 'Water',
            sand: 'Sand',
            grass: 'Grass',
            snow: 'Snow',
            rock: 'Rock',
            catwalk: 'Catwalk',
            metal: 'Metal'
        };
        if (known[tileId])
            return known[tileId];
        return 'Turf' + tileId.charAt(0).toUpperCase() + tileId.slice(1);
    }
    addTile(chunks, worldX, worldY, tileId, warnings) {
        // RobustToolbox chunk math: floor division so negative coords land in the
        // correct chunk with a positive local index.
        const cx = Math.floor(worldX / CHUNK_SIZE);
        const cy = Math.floor(worldY / CHUNK_SIZE);
        const lx = worldX - cx * CHUNK_SIZE;
        const ly = worldY - cy * CHUNK_SIZE;
        const key = `${cx},${cy}`;
        const local = `${lx},${ly}`;
        let chunk = chunks.get(key);
        if (!chunk) {
            chunk = new Map();
            chunks.set(key, chunk);
        }
        if (chunk.has(local)) {
            // Two turfs on one tile (WS11-9): duplicate lx,ly lines are an invalid
            // map — keep the first, warn once per key.
            if (!warnings.includes(`duplicate turf on tile ${local}`)) {
                warnings.push(`duplicate turf on tile ${local} — keeping the first`);
            }
            return;
        }
        chunk.set(local, tileId);
    }
    typePathToPrototypeId(typePath) {
        // Best-effort mapping to SS14 content prototype names: the last path
        // segment PascalCased (obj/structure/table -> Table). Invented
        // underscore-joined ids do not exist in content (WS11-2).
        const parts = typePath.split('/').filter(Boolean);
        const last = parts[parts.length - 1].replace(/[^a-zA-Z0-9_]/g, '_');
        if (!last)
            return typePath.replace(/\//g, '_').toLowerCase();
        return last.charAt(0).toUpperCase() + last.slice(1);
    }
    serializeToYAML(entities, tilemap) {
        let yaml = '# SS14 Grid Map converted from SS13 DMM\nmeta:\n  format: 2\n  name: ConvertedStation\n';
        if (tilemap.size > 0) {
            yaml += 'tilemap:\n';
            for (const [tileId, proto] of tilemap) {
                yaml += `  ${tileId}: ${proto}\n`;
            }
        }
        yaml += 'entities:\n';
        for (const ent of entities) {
            yaml += `- uid: ${ent.uid}\n`;
            if (ent.proto)
                yaml += `  proto: ${ent.proto}\n`;
            if (ent.type)
                yaml += `  type: ${ent.type}\n`;
            if (ent.components) {
                yaml += '  components:\n';
                for (const comp of ent.components) {
                    yaml += `  - type: ${comp.type}\n`;
                    if (comp.pos)
                        yaml += `    pos: ${comp.pos}\n`;
                    if (comp.name)
                        yaml += `    name: ${comp.name}\n`;
                    if (comp.tileSize)
                        yaml += `    tileSize: ${comp.tileSize}\n`;
                    if (comp.chunks) {
                        yaml += '    chunks:\n';
                        // Format-2 chunk values are LISTS of "lx,ly: tile" entries nested
                        // under the chunk key (WS11-1: tiles emitted as siblings were
                        // dropped from the chunks map entirely).
                        for (const [chunkKey, tiles] of comp.chunks) {
                            yaml += `      ${chunkKey}:\n`;
                            for (const [local, tileId] of tiles) {
                                yaml += `      - ${local}: ${tileId}\n`;
                            }
                        }
                    }
                }
            }
        }
        return yaml;
    }
}
exports.MapConverter = MapConverter;
