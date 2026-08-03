export interface Diagnostic {
    file?: string;
    line: number;
    column: number;
    message: string;
}
export declare class DiagnosticCollector {
    private _errors;
    private _warnings;
    file: string | undefined;
    get errors(): readonly Diagnostic[];
    get warnings(): readonly Diagnostic[];
    error(message: string, line?: number, column?: number): void;
    warning(message: string, line?: number, column?: number): void;
    merge(other: DiagnosticCollector): void;
    hasErrors(): boolean;
    hasWarnings(): boolean;
}
