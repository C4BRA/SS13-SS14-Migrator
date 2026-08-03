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
    cells: string[][];
}
export interface DMMMapData {
    definitions: Map<string, DMMTileDefinition>;
    grids: DMMGrid[];
    warnings: string[];
}
export declare class DMMParser {
    parseDMM(filePath: string): DMMMapData;
    private parenBalanced;
    private parseDefinition;
    private parseEntry;
    private splitTopLevel;
    private decodeLine;
    private buildSectionGrid;
    private mergeSections;
}
