interface LossCounters {
    numElif: number;
    numIfNumeric: number;
    numIfError: number;
    numPragmaOnce: number;
    numDefineStringTruncation: number;
    numGoto: number;
    numSetModifiers: number;
    numSwitchBraceForm: number;
    numWeightedPick: number;
    numMultiVarFor: number;
    numForStepClause: number;
    numForAsFilter: number;
    numVerbDecls: number;
    numClientDecls: number;
    numWorldDecls: number;
    numParentTypeDecls: number;
    numGlobalVars: number;
    numClassicGlobalVars: number;
    numGlobAccess: number;
    filesWithParseErrors: Map<string, number>;
    numTry: number;
    numLabeledBlock: number;
    numNew: number;
    numParentCall: number;
    numBinaryNull: number;
    numBinaryOutput: number;
    numAsCast: number;
    numUnaryTilde: number;
    numSpawnExpr: number;
    numStubbedBuiltin: number;
    numWorldRef: number;
    numPathConstPropRead: number;
    numBrokenPropRead: number;
    numRuntimeResolvedProps: number;
    numUnknownBuiltin: number;
    numBareGlobalProcCalls: number;
    numTypeResolvedBareCalls: number;
    numUnresolvedCalls: number;
    parseErrors: number;
    parseWarnings: number;
    totalLossSites: number;
    unknownBuiltins: Map<string, {
        count: number;
        samples: string[];
        contexts: Map<string, number>;
    }>;
    brokenProps: Map<string, number>;
    errorClasses: Map<string, {
        errors: number;
        warnings: number;
        samples: string[];
        tokens: Map<string, number>;
    }>;
    procCount: number;
    typeCount: number;
}
interface CodebaseResult {
    name: string;
    dir: string;
    files: number;
    counters: LossCounters;
}
export declare function runAudit(dir: string, name: string): CodebaseResult;
export {};
