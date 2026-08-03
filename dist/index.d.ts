export interface TranspilerOptions {
    inputDir: string;
    outputDir: string;
    buildSolution?: boolean;
}
export declare class DM2SS14Transpiler {
    private rsiWriter;
    private mapConverter;
    private yamlGenerator;
    private csharpEmitter;
    private templateGen;
    transpile(options: TranspilerOptions): Promise<void>;
    private reportDiagnostics;
    private findFiles;
}
