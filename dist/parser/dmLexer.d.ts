export declare enum TokenType {
    Keyword = 0,
    TypePath = 1,
    Identifier = 2,
    Number = 3,
    StringLiteral = 4,
    FileLiteral = 5,
    Operator = 6,
    Punctuation = 7,
    Indent = 8,
    Dedent = 9,
    Newline = 10,
    EOF = 11
}
export interface Token {
    type: TokenType;
    value: string;
    line: number;
    column: number;
}
import { DiagnosticCollector } from '../diagnostics.js';
export declare class DMLexer {
    private input;
    private pos;
    private line;
    private col;
    readonly diagnostics: DiagnosticCollector;
    private static KEYWORDS;
    private static THREE_CHAR_OPS;
    private static TWO_CHAR_OPS;
    private static SINGLE_CHAR_OPS;
    private static PUNCTUATION;
    constructor(input: string);
    tokenize(): Token[];
    private advance;
    private peek;
    private isAlpha;
    private isDigit;
    private isHexDigit;
    private skipLineComment;
    private skipBlockComment;
    private readTypePath;
    private readRawString;
    private readString;
    private readTemplateString;
    private readRegex;
    private readNumber;
    private readIdentifier;
}
