import { DiagnosticCollector } from './diagnostics.js';
export interface FunctionMacro {
    params: string[];
    variadic: boolean;
    body: string;
}
export interface CollectedDefines {
    object: Map<string, string>;
    function: Map<string, FunctionMacro>;
}
export declare class DMPreprocessor {
    private defines;
    private functionDefines;
    private collector;
    private blockCommentState;
    private includedFiles;
    private allowMultipleIncludes;
    private macroExpansionBudget;
    constructor(collector: DiagnosticCollector, seedDefines?: Map<string, string> | undefined, seedFunctionDefines?: Map<string, FunctionMacro> | undefined);
    process(code: string, filePath: string): string;
    processFile(filePath: string): string;
    private processText;
    private joinContinuations;
    private joinParenBlocks;
    private static parenBalance;
    private static isQuoteBalanced;
    private static isBalancedDefineBody;
    static stripInlineComment(line: string): string;
    private expandMacros;
    private updateBlockCommentState;
    private expandFunctionMacro;
    private replaceOutsideStrings;
    private substituteParams;
    private findMatchingParen;
    private splitArgs;
    private evalIf;
    private evalIfValue;
    static collectDefinesFromFiles(files: string[]): CollectedDefines;
}
