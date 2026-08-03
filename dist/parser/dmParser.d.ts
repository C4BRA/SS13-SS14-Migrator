import { Token } from './dmLexer.js';
import { DiagnosticCollector } from '../diagnostics.js';
export interface ASTNode {
    type: string;
}
export type ExpressionNode = {
    type: 'literal';
    value: string | number | boolean | null;
    literalType: 'string' | 'number' | 'bool' | 'null' | 'path';
    floatLiteral?: boolean;
} | {
    type: 'variable';
    name: string;
} | {
    type: 'binary';
    operator: string;
    left: ExpressionNode;
    right: ExpressionNode;
} | {
    type: 'unary';
    operator: string;
    operand: ExpressionNode;
} | {
    type: 'call';
    name: string;
    target?: ExpressionNode;
    arguments: ExpressionNode[];
} | {
    type: 'new';
    typePath: string;
    arguments: ExpressionNode[];
} | {
    type: 'ternary';
    condition: ExpressionNode;
    trueExpr: ExpressionNode;
    falseExpr: ExpressionNode;
} | {
    type: 'index';
    target: ExpressionNode;
    index: ExpressionNode;
} | {
    type: 'property';
    target: ExpressionNode;
    property: string;
} | {
    type: 'assignment';
    target: string;
    value: ExpressionNode;
} | {
    type: 'property_assignment';
    target: ExpressionNode;
    property: string;
    value: ExpressionNode;
} | {
    type: 'index_assignment';
    target: ExpressionNode;
    index: ExpressionNode;
    value: ExpressionNode;
} | {
    type: 'list';
    elements: ExpressionNode[];
} | {
    type: 'range';
    start: ExpressionNode;
    end: ExpressionNode;
};
export interface DMTypeDeclNode extends ASTNode {
    type: 'DMTypeDecl';
    path: string;
    vars: DMVarDeclNode[];
    procs: DMProcDeclNode[];
}
export interface DMVarDeclNode extends ASTNode {
    type: 'DMVarDecl';
    name: string;
    varType?: string;
    initialValue?: any;
    initialValueExpr?: ExpressionNode;
}
export interface DMProcDeclNode extends ASTNode {
    type: 'DMProcDecl';
    name: string;
    args: {
        name: string;
        typeHint?: string;
        defaultValue?: ExpressionNode;
    }[];
    statements: DMStatementNode[];
}
export interface DMGlobalVarDeclNode extends ASTNode {
    type: 'GlobalVarDecl';
    name: string;
    varType: string;
    initialValue?: any;
    /** Initializer re-parsed as an expression tree (used by the emitter to
     *  materialize /global/var/ declarations as runtime values). */
    initialValueExpr?: ExpressionNode | null;
}
export interface DMStatementNode extends ASTNode {
    type: string;
    [key: string]: any;
    expression?: ExpressionNode;
    returnValue?: ExpressionNode;
    assignmentTarget?: string;
    assignmentValue?: ExpressionNode;
    condition?: ExpressionNode;
    thenBranch?: DMStatementNode[];
    elseBranch?: DMStatementNode[];
    loopVariable?: string;
    loopRange?: ExpressionNode;
    loopBody?: DMStatementNode[];
    timeExpr?: ExpressionNode;
    varName?: string;
    varType?: string;
    varInit?: ExpressionNode;
    target?: ExpressionNode;
    switchValue?: ExpressionNode;
    switchCases?: {
        values: ExpressionNode[];
        body: DMStatementNode[];
    }[];
    defaultBody?: DMStatementNode[];
}
export declare class DMParser {
    private tokens;
    private pos;
    readonly diagnostics: DiagnosticCollector;
    private assocArgDepth;
    globalVars: DMGlobalVarDeclNode[];
    constructor(tokens: Token[], collector?: DiagnosticCollector);
    parse(): DMTypeDeclNode[];
    private parseTypeBlock;
    /**
     * Parse a proc/verb argument list: `(a, mob/user, var/x, args, ...)`.
     * DM keyword names (`args`, `usr`, `src`) and `var`-prefixed forms are
     * accepted; `as <type>` clauses are parsed and dropped (documented
     * limitation). Type hints are recorded when they appear as a `/type/name`
     * path segment.
     */
    private parseProcArgs;
    private parseProcArg;
    /**
     * Capture the remaining tokens of the current line as raw source text.
     * Used for type-level var initial values, which may be full expressions
     * (e.g. `var/list/stuff = list(1, 2, 3)`); the text is preserved for the
     * YAML initialVars rather than silently dropping everything after the
     * first token.
     */
    private parseInitialValueText;
    /**
     * Re-parse a captured initializer string (see parseInitialValueText) into a
     * full expression tree. Globals are declared at top level where no statement
     * parser is running, so their initializers are re-lexed into a sub-parser.
     */
    parseInitializerTextToExpr(text: string, collector?: DiagnosticCollector): ExpressionNode | null;
    /**
     * Split a raw string value into literal text and [interpolation] chunks,
     * mirroring the lexer's bracket scan (nested brackets count). Returns a
     * single element when there is no interpolation.
     */
    private splitInterpolation;
    private parseMemberDecl;
    private parseProcBody;
    /**
     * Parse the body of a control-flow statement: a { } block, an indented
     * block, a single-line body (if (x) return 5), or nothing at all. A
     * newline-delimited statement on the following line is NOT the body — DM
     * ends the statement at the newline.
     */
    private parseLoopBody;
    private parseWhileStatement;
    private parseDoWhileStatement;
    private parseSleepSpawnStatement;
    private parseForStatement;
    private parseSwitchStatement;
    private parseSingleStatement;
    private parseIfStatement;
    parseExpression(minPrec?: number, stopAtColon?: boolean): ExpressionNode;
    private parsePrimary;
    private parsePostfix;
    private getOperatorPrecedence;
    private isRightAssociative;
    private buildPostfixIncrement;
    private getOrCreateTypeNode;
    private peek;
    private peekNext;
    private isMultiVarLoopHead;
    private advance;
    private isType;
    private matchOperator;
    private matchPunctuation;
    private skipNewlines;
}
