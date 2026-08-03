import { DMMMapData } from './dmmParser.js';
export declare class MapConverter {
    private parser;
    convertDMMToSS14Map(dmmPath: string, outputYAMLPath: string): DMMMapData;
    private turfToTileId;
    private tileIdToPrototype;
    private addTile;
    private typePathToPrototypeId;
    private serializeToYAML;
}
