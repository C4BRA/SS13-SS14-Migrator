import { DMTypeDeclNode, DMVarDeclNode } from '../parser/dmParser.js';
export interface TypeSymbol {
    path: string;
    parentPath: string | null;
    procNames: Set<string>;
    varNames: Map<string, DMVarDeclNode>;
}
export declare class SymbolTable {
    types: Map<string, TypeSymbol>;
    globalProcs: Set<string>;
    rootPath: string;
    private bareProcCache;
    private typeProcCache;
    /** Merge a file's parsed type declarations into the table. */
    addTypeDecls(typeDecls: DMTypeDeclNode[]): void;
    hasGlobalProc(name: string): boolean;
    /** Proc reachable from a bare call inside a proc of `typePath`: the type's
     *  own hierarchy plus /proc globals (mirrors ProcRegistry.CallProc order:
     *  exact type -> ancestors -> /proc). */
    resolveBareProc(typePath: string | null | undefined, name: string): boolean;
    /** Proc reachable through the type hierarchy of `typePath` only. */
    resolveTypeProc(typePath: string, name: string): boolean;
    /** Clear resolution caches when symbol table changes. */
    clearCaches(): void;
}
export declare function normalizeTypePath(path: string): string;
export declare function computeParentPath(path: string): string | null;
