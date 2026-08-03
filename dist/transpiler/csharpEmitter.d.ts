import { DMIRType } from '../ir/dmIRGenerator.js';
import { DMGlobalVarDeclNode } from '../parser/dmParser.js';
import { SymbolTable } from '../ir/symbolTable.js';
export declare class CSharpEmitter {
    private tempCounter;
    private currentProcName;
    /** Corpus-wide symbol table (item 64): bare/method calls are resolved
     *  against declared procs and unknowns warn once. Runtime registry stays
     *  the fallback. */
    private symbols;
    private warnedCalls;
    private currentTypePath;
    private loopDepth;
    private switchDepth;
    private lambdaDepth;
    /** Per-loop continue labels (C# label or '' for loops where a plain
     *  `continue;` already reaches the correct point). Top of stack = the
     *  innermost loop; jumped to when a `continue` must cross a switch's
     *  while(true) wrapper or land on a C-for increment. */
    private continueLabels;
    /** While true, expressions are emitted in the GlobalVars initializer
     *  context (no `comp`, no current datum): src is Null, bare calls go
     *  through GlobalVars.CallGlobal, and new() uses a null datum. */
    private globalsMode;
    private nextTemp;
    emitCSharpSystems(irMap: Map<string, DMIRType>, outputServerDir: string, globals?: DMGlobalVarDeclNode[], symbols?: SymbolTable): void;
    /** Corpus-scale variant: streams the proc file instead of building it in
     *  memory (item 66). */
    emitCSharpSystemsFile(irMap: Map<string, DMIRType>, outputServerDir: string, globals?: DMGlobalVarDeclNode[], symbols?: SymbolTable): void;
    /**
     * Pure C# (no RobustToolbox references): the static proc registry and one
     * static method per DM proc, operating on the engine-free DMRuntime datum.
     */
    generateProcsCS(irMap: Map<string, DMIRType>, globals?: DMGlobalVarDeclNode[]): string;
    /** Corpus-scale emission streams the proc bodies to the FILE SYSTEM instead
     *  of one giant string. Splits into multiple partial-class files so Roslyn
     *  never compiles a single 100 MB+ source file (superlinear per-file cost —
     *  a 118 MB ConvertedDMProcs.cs for tgstation hung the build). Each member
     *  chunk becomes ConvertedDMProcs_<n>.cs with a partial-class wrapper. */
    generateProcsCSFile(irMap: Map<string, DMIRType>, globals: DMGlobalVarDeclNode[], filePath: string): void;
    private emitProcsCS;
    /**
     * SS14 engine adapter against the real RobustToolbox API:
     *   - EntitySystem (abstract partial class) with a [Dependency] EntityManager field
     *   - SubscribeLocalEvent<DMRuntimeComponent, ComponentInit> with the
     *     ComponentEventRefHandler signature (EntityUid, TComp, ref TEvent)
     *   - ComponentInit : EntityEventArgs (class)
     *   - DMRuntimeComponent : Component (RegisterComponent) holding a DMRuntime datum
     * Verified against RobustToolbox commit 9cefa1167c9ac45f7258094129daf46b6c3516d3.
     */
    generateSystemCS(): string;
    private transpileStatement;
    private transpileExpression;
    private transpileLiteral;
    private transpileVariable;
    private normalizeTypePath;
    private referencesIdentifier;
    private transpileBinary;
    private transpileUnary;
    private transpileCall;
    private transpileTernary;
    private transpileProperty;
    private transpileIndex;
    private escapeString;
    /** Path -> deduped class name, and the class names already taken, for the
     *  current generateProcsCS run. Distinct paths can map to the same class
     *  name (/obj/item/foo vs /obj/ItemFoo both give ObjItemFoo); the second
     *  gets a numeric suffix so the generated static methods do not collide
     *  (CS0102). */
    private pathClassNameMap;
    private usedClassNames;
    private pathToClassName;
    /** DM identifiers (operator"", foo.bar) are not valid C# identifier
     *  characters; strip everything outside [A-Za-z0-9_]. Applied to class
     *  names and proc member names so hostile-but-legal DM never emits a
     *  syntax error (WS5-1..3). */
    private sanitizeIdentifier;
    /** Deduped, identifier-safe C# member name for a proc (DM names are
     *  case-insensitive, so `foo` and `Foo` on one type collide — CS0111).
     *  Pass 1 (registrations) and pass 2 (members) must agree on the name. */
    private nextProcMemberName;
    /** Item 64: resolve a call target against the corpus symbol table and warn
     *  once per unknown name. The runtime registry remains the fallback, so a
     *  missed declaration is a diagnostic, not a crash. */
    private resolveAndWarn;
    private capitalize;
}
