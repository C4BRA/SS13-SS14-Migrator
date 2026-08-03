export interface DMIState {
    name: string;
    dirs: number;
    frames: number;
    delay?: number[];
}
export interface DMIMetadata {
    version: string;
    width: number;
    height: number;
    states: DMIState[];
    warnings: string[];
}
export declare class DMIParser {
    parseDMI(filePath: string): DMIMetadata;
    private extractDMITextFromPNG;
    private parseTextChunk;
    private parseDMIText;
}
