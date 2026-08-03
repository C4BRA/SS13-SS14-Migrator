"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DMLexer = exports.TokenType = void 0;
var TokenType;
(function (TokenType) {
    TokenType[TokenType["Keyword"] = 0] = "Keyword";
    TokenType[TokenType["TypePath"] = 1] = "TypePath";
    TokenType[TokenType["Identifier"] = 2] = "Identifier";
    TokenType[TokenType["Number"] = 3] = "Number";
    TokenType[TokenType["StringLiteral"] = 4] = "StringLiteral";
    TokenType[TokenType["FileLiteral"] = 5] = "FileLiteral";
    TokenType[TokenType["Operator"] = 6] = "Operator";
    TokenType[TokenType["Punctuation"] = 7] = "Punctuation";
    TokenType[TokenType["Indent"] = 8] = "Indent";
    TokenType[TokenType["Dedent"] = 9] = "Dedent";
    TokenType[TokenType["Newline"] = 10] = "Newline";
    TokenType[TokenType["EOF"] = 11] = "EOF";
})(TokenType || (exports.TokenType = TokenType = {}));
const diagnostics_js_1 = require("../diagnostics.js");
class DMLexer {
    input;
    pos = 0;
    line = 1;
    col = 1;
    diagnostics = new diagnostics_js_1.DiagnosticCollector();
    static KEYWORDS = new Set([
        'var', 'proc', 'verb', 'const', 'global', 'tmp',
        'if', 'else', 'for', 'while', 'do', 'return', 'break', 'continue',
        'spawn', 'sleep', 'usr', 'src', 'args', 'new', 'del', 'qdel',
        'as', 'in', 'to', 'step', 'prob', 'locate', 'istype', 'ispath',
        'null', 'TRUE', 'FALSE', 'area', 'turf', 'obj', 'mob', 'datum'
    ]);
    // Static Sets for O(1) operator matching instead of O(n) array.includes()
    static THREE_CHAR_OPS = new Set(['<<=', '>>=', '||=', '&&=']);
    static TWO_CHAR_OPS = new Set(['==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '&&', '||', '::', '..', '++', '--', '<<', '>>', '?.', '%=', '&=', '|=', '^=', '%%', '**', '~=', '~!']);
    static SINGLE_CHAR_OPS = '+-*/=<>!&|^?:.%~@$';
    static PUNCTUATION = '(){}[],;';
    constructor(input) {
        // Strip a UTF-8 BOM so the first token of Windows-edited files lexes cleanly.
        this.input = input.startsWith('\uFEFF') ? input.slice(1) : input;
    }
    tokenize() {
        const tokens = [];
        const indentStack = [0];
        while (this.pos < this.input.length) {
            const ch = this.input[this.pos];
            // Handle comments
            if (ch === '/' && this.peek() === '/') {
                this.skipLineComment();
                continue;
            }
            if (ch === '/' && this.peek() === '*') {
                this.skipBlockComment();
                continue;
            }
            // Handle Newlines and Indentation
            if (ch === '\n') {
                const lineNum = this.line;
                const colNum = this.col;
                this.advance();
                tokens.push({ type: TokenType.Newline, value: '\n', line: lineNum, column: colNum });
                // Measure leading whitespace on new line
                let indent = 0;
                while (this.pos < this.input.length) {
                    const nextCh = this.input[this.pos];
                    if (nextCh === ' ') {
                        indent++;
                        this.advance();
                    }
                    else if (nextCh === '\t') {
                        indent += 4;
                        this.advance();
                    }
                    else {
                        break;
                    }
                }
                // If line is empty, a //-comment, or a /* */ comment that spans the
                // whole line, ignore indentation changes (a //-comment consumes the
                // rest of the line). A /* */ comment followed by code on the same
                // line must affect indentation normally — otherwise the indent stack
                // never unwinds and following code is parsed inside the previous
                // block.
                if (this.pos < this.input.length && (this.input[this.pos] === '\n' || (this.input[this.pos] === '/' && this.peek() === '/'))) {
                    continue;
                }
                if (this.pos < this.input.length && this.input[this.pos] === '/' && this.peek() === '*') {
                    const commentEnd = this.input.indexOf('*/', this.pos + 2);
                    if (commentEnd !== -1) {
                        let i = commentEnd + 2;
                        while (i < this.input.length && (this.input[i] === ' ' || this.input[i] === '\t' || this.input[i] === '\r'))
                            i++;
                        if (i >= this.input.length || this.input[i] === '\n')
                            continue;
                    }
                }
                const currentIndent = indentStack[indentStack.length - 1];
                if (indent > currentIndent) {
                    indentStack.push(indent);
                    tokens.push({ type: TokenType.Indent, value: '', line: this.line, column: this.col });
                }
                else {
                    while (indent < indentStack[indentStack.length - 1]) {
                        indentStack.pop();
                        tokens.push({ type: TokenType.Dedent, value: '', line: this.line, column: this.col });
                    }
                    if (indent !== indentStack[indentStack.length - 1]) {
                        // Inconsistent indentation (e.g. 4 -> 8 -> 5) would otherwise be
                        // silently treated as a full dedent. Report it; block structure is
                        // still guessed from the nearest enclosing level.
                        this.diagnostics.warning(`Inconsistent indentation: ${indent} spaces does not match any enclosing block level`, this.line, this.col);
                    }
                }
                continue;
            }
            // Skip whitespace except newlines
            if (ch === ' ' || ch === '\t' || ch === '\r') {
                this.advance();
                continue;
            }
            // TypePaths starting with / (e.g. /obj/item/weapon/sword)
            if (ch === '/' && (this.isAlpha(this.peek()) || this.peek() === '_')) {
                tokens.push(this.readTypePath());
                continue;
            }
            // String Literals ("string" or 'file.dmi')
            if (ch === '"') {
                tokens.push(this.readString('"'));
                continue;
            }
            if (ch === "'") {
                tokens.push(this.readString("'"));
                continue;
            }
            // DM regex literal: @pattern@ (an inner @@ is an escaped @).
            // `@'...'` / `@"..."` are handled earlier as regex strings. A
            // standalone `@` operator is followed by whitespace, so require a
            // non-whitespace next char here.
            if (ch === '@' && this.peek() === '@') {
                // DM raw string literal: @@raw...@ — readRegex consumes the 2nd @
                // opener and scans to the closing single @ (an inner @@ is an
                // escaped @). Lexed as a plain string token.
                this.advance();
                tokens.push(this.readRegex());
                continue;
            }
            if (ch === '@' && this.peek() === '{') {
                // @{"..."} template-string prefix: the { is the template opener and
                // must not fall into the raw-@ branch below (item 56 — readRegex
                // would scan to the next @ anywhere in the file and swallow it).
                this.advance();
                continue;
            }
            if (ch === '@' && this.peek() !== '"' && this.peek() !== "'" && !/[\s]/.test(this.peek())) {
                tokens.push(this.readRegex());
                continue;
            }
            // Numbers
            if (this.isDigit(ch) || (ch === '.' && this.isDigit(this.peek()))) {
                // `.5` — a leading-dot float literal (item 60); readNumber already
                // accepts the dot as the first char.
                tokens.push(this.readNumber());
                continue;
            }
            // Identifiers / Keywords
            if (this.isAlpha(ch) || ch === '_') {
                const token = this.readIdentifier();
                if (DMLexer.KEYWORDS.has(token.value)) {
                    token.type = TokenType.Keyword;
                }
                tokens.push(token);
                continue;
            }
            // Operators and Punctuation
            const startLine = this.line;
            const startCol = this.col;
            // Multi-char operators - using static Sets for O(1) lookup
            const twoChar = ch + this.peek();
            const threeChar = ch + this.peek() + (this.pos + 2 < this.input.length ? this.input[this.pos + 2] : '');
            if (DMLexer.THREE_CHAR_OPS.has(threeChar)) {
                this.advance();
                this.advance();
                this.advance();
                tokens.push({ type: TokenType.Operator, value: threeChar, line: startLine, column: startCol });
                continue;
            }
            if (DMLexer.TWO_CHAR_OPS.has(twoChar)) {
                this.advance();
                this.advance();
                tokens.push({ type: TokenType.Operator, value: twoChar, line: startLine, column: startCol });
                continue;
            }
            // DM raw string literal: @"..." / @'...' — verbatim text: no escapes,
            // no [interpolation] (a doubled quote is an escaped quote). This is
            // distinct from the @regex@ form handled above.
            if (ch === '@' && (this.peek() === '"' || this.peek() === "'")) {
                this.advance(); // consume @
                tokens.push(this.readRawString(this.input[this.pos]));
                continue;
            }
            if (DMLexer.SINGLE_CHAR_OPS.includes(ch)) {
                this.advance();
                tokens.push({ type: TokenType.Operator, value: ch, line: startLine, column: startCol });
                continue;
            }
            // Backslash line continuation (e.g. multi-line #define bodies)
            if (ch === '\\' && (this.peek() === '\n' || this.peek() === '\r')) {
                this.advance();
                continue;
            }
            // DM multi-line template string: {" ... "} — scan to the closing "}.
            // A `{"a", "b"}` is a brace-LIST of strings, not a template: peek at the
            // first closing quote — followed by `,` → list literal (item 60).
            if (ch === '{' && this.peek() === '"') {
                let j = this.pos + 2;
                while (j < this.input.length && this.input[j] !== '"')
                    j++;
                const after = j < this.input.length ? this.input[j + 1] : '';
                if (after === ',') {
                    // fall through to the '{' punctuation branch (list literal)
                }
                else {
                    tokens.push(this.readTemplateString());
                    continue;
                }
            }
            if (DMLexer.PUNCTUATION.includes(ch)) {
                this.advance();
                tokens.push({ type: TokenType.Punctuation, value: ch, line: startLine, column: startCol });
                continue;
            }
            // Preprocessor directive fallback
            if (ch === '#') {
                this.skipLineComment();
                continue;
            }
            this.diagnostics.error(`Unexpected character '${ch}'`, this.line, this.col);
            this.advance();
        }
        tokens.push({ type: TokenType.EOF, value: '', line: this.line, column: this.col });
        return tokens;
    }
    advance() {
        const ch = this.input[this.pos++];
        if (ch === '\n') {
            this.line++;
            this.col = 1;
        }
        else {
            this.col++;
        }
        return ch;
    }
    peek() {
        return this.pos + 1 < this.input.length ? this.input[this.pos + 1] : '';
    }
    isAlpha(ch) {
        return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
    }
    isDigit(ch) {
        return ch >= '0' && ch <= '9';
    }
    isHexDigit(ch) {
        return this.isDigit(ch) || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F');
    }
    skipLineComment() {
        while (this.pos < this.input.length && this.input[this.pos] !== '\n') {
            this.advance();
        }
    }
    skipBlockComment() {
        this.advance(); // /
        this.advance(); // *
        // BYOND block comments nest: `/* a /* b */ c */` closes only at the
        // matching depth. Tracking depth prevents the inner `*/` from re-lexing
        // the remaining outer-comment content as executable code.
        let depth = 1;
        while (this.pos < this.input.length) {
            const ch = this.input[this.pos];
            if (ch === '/' && this.peek() === '*') {
                depth++;
                this.advance();
                this.advance();
                continue;
            }
            if (ch === '*' && this.peek() === '/') {
                depth--;
                this.advance();
                this.advance();
                if (depth === 0)
                    return;
                continue;
            }
            this.advance();
        }
        this.diagnostics.error('Unterminated block comment', this.line, this.col);
    }
    readTypePath() {
        const startLine = this.line;
        const startCol = this.col;
        let path = '';
        while (this.pos < this.input.length) {
            const ch = this.input[this.pos];
            if (ch === '/' && this.input[this.pos + 1] === '/') {
                // `//` always starts a comment, even directly after a path
                // (e.g. /datum/action/lung_punch//comment).
                break;
            }
            if (ch === '/' && this.input[this.pos + 1] === '*') {
                // `/*` starts a block comment — the trailing '/' of the path must
                // not be consumed into it (item 56: assert_gases(/datum/gas/nitrogen/*, ...)).
                break;
            }
            if (ch === '/' || this.isAlpha(ch) || this.isDigit(ch) || ch === '_') {
                path += ch;
                this.advance();
            }
            else if (ch === '.') {
                // Path-dot notation: /datum.proc/foo — allow a dot followed by a
                // word char to continue the path (e.g. /datum.proc/ or /mob.verb/).
                const next = this.input[this.pos + 1];
                if (next !== undefined && this.isAlpha(next)) {
                    path += '.';
                    this.advance();
                }
                else {
                    break;
                }
            }
            else if (ch === '"' && path.endsWith('operator') && this.input[this.pos + 1] === '"') {
                // operator"" — the stringify operator overload is part of the proc name.
                path += '""';
                this.advance();
                this.advance();
            }
            else {
                break;
            }
        }
        return { type: TokenType.TypePath, value: path, line: startLine, column: startCol };
    }
    readRawString(quoteChar) {
        const startLine = this.line;
        const startCol = this.col;
        this.advance(); // quote
        let str = '';
        let closed = false;
        while (this.pos < this.input.length) {
            const ch = this.input[this.pos];
            if (ch === quoteChar) {
                // Doubled quote is an escaped quote ("say ""hi""").
                if (this.input[this.pos + 1] === quoteChar) {
                    str += quoteChar;
                    this.advance();
                    this.advance();
                    continue;
                }
                this.advance();
                closed = true;
                break;
            }
            str += ch;
            this.advance();
        }
        if (!closed) {
            this.diagnostics.error('Unterminated string literal', startLine, startCol);
        }
        return { type: TokenType.StringLiteral, value: str, line: startLine, column: startCol };
    }
    readString(quoteChar) {
        const startLine = this.line;
        const startCol = this.col;
        this.advance(); // quote
        let str = '';
        let closed = false;
        while (this.pos < this.input.length) {
            const ch = this.input[this.pos];
            if (ch === quoteChar) {
                // DM escapes a quote inside a string by doubling it: "say ""hi""".
                // An empty `""` is an empty string, so only treat the doubling as
                // an escape once the string already has content.
                if (str.length > 0 && this.input[this.pos + 1] === quoteChar) {
                    str += quoteChar;
                    this.advance();
                    this.advance();
                    continue;
                }
                this.advance();
                closed = true;
                break;
            }
            if (ch === '[') {
                // DM doubles brackets to escape them in text: [[ is a literal [ —
                // not the start of interpolation.
                if (this.input[this.pos + 1] === '[') {
                    str += '[[';
                    this.advance();
                    this.advance();
                    continue;
                }
                // DM string interpolation: [expr] may contain quotes and nested
                // brackets; scan to the matching ']' keeping the raw text. The scan
                // is quote-aware: a nested "string" or 'file' literal is tracked with
                // ITS OWN quote char, so href='byond://…' inside a "…" does not
                // toggle the nesting (WS1-3 + item 56). Backslash escapes (\[ \] \"
                // \\) are skipped without changing depth.
                let depth = 0;
                let closedBracket = false;
                let nested = false;
                let nestedQuote = '';
                while (this.pos < this.input.length) {
                    const c = this.input[this.pos];
                    if (c === '\\' && (nested || depth > 0)) {
                        str += c + (this.input[this.pos + 1] ?? '');
                        this.advance();
                        this.advance();
                        continue;
                    }
                    if (!nested) {
                        if (c === '"' || c === "'") {
                            nested = true;
                            nestedQuote = c;
                        }
                        else if (c === '[' && this.input[this.pos + 1] === '[') {
                            str += '[[';
                            this.advance();
                            this.advance();
                            continue;
                        }
                        else if (c === '[') {
                            depth++;
                        }
                        else if (c === ']') {
                            depth--;
                            if (depth === 0) {
                                str += c;
                                this.advance();
                                closedBracket = true;
                                break;
                            }
                        }
                    }
                    else if (c === nestedQuote) {
                        nested = false;
                    }
                    else if (nested && c === '[') {
                        // A nested string may itself contain interpolation
                        // ("text [more [expr] text]" from macro substitution) — skip to
                        // its matching ']' so it cannot corrupt the outer tracking.
                        let sub = 1;
                        let k = this.pos + 1;
                        while (k < this.input.length && sub > 0) {
                            if (this.input[k] === '[')
                                sub++;
                            else if (this.input[k] === ']')
                                sub--;
                            k++;
                        }
                        while (this.pos < k) {
                            str += this.input[this.pos];
                            this.advance();
                        }
                        continue;
                    }
                    str += c;
                    this.advance();
                }
                if (!closedBracket) {
                    this.diagnostics.error('Unterminated string interpolation', this.line, this.col);
                }
                continue;
            }
            if (ch === '\\') {
                this.advance();
                const esc = this.pos < this.input.length ? this.input[this.pos] : '';
                // DM text macros are word markers; match the longest known one and
                // preserve it verbatim (the runtime does not process them, but they
                // must not be corrupted into tabs/escapes). A following identifier
                // character disambiguates `\theta` as `\t` + "heta".
                let matchedMarker = false;
                for (const mk of ['improper', 'proper', 'roman', 'icon', 'ref', 'the', 'th', 's']) {
                    if (this.input.slice(this.pos, this.pos + mk.length).toLowerCase() === mk) {
                        const after = this.input[this.pos + mk.length] ?? '';
                        if (!/[A-Za-z0-9_]/.test(after)) {
                            str += '\\' + this.input.slice(this.pos, this.pos + mk.length);
                            for (let k = 0; k < mk.length; k++)
                                this.advance();
                            matchedMarker = true;
                            break;
                        }
                    }
                }
                if (matchedMarker)
                    continue;
                switch (esc) {
                    case 'n':
                        str += '\n';
                        break;
                    case 't':
                        str += '\t';
                        break;
                    case 'r':
                        str += '\r';
                        break;
                    case '\\':
                        str += '\\';
                        break;
                    case '"':
                        str += '"';
                        break;
                    case "'":
                        str += "'";
                        break;
                    case 'x': {
                        // \xHH — hex byte.
                        const hex = this.input.slice(this.pos + 1, this.pos + 3);
                        if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
                            str += String.fromCharCode(parseInt(hex, 16));
                            this.advance();
                            this.advance();
                        }
                        else {
                            str += '\\x';
                        }
                        break;
                    }
                    case 'u': {
                        // \uHHHH — Unicode code point.
                        const hex = this.input.slice(this.pos + 1, this.pos + 5);
                        if (/^[0-9A-Fa-f]{4}$/.test(hex)) {
                            str += String.fromCodePoint(parseInt(hex, 16));
                            for (let k = 0; k < 4; k++)
                                this.advance();
                        }
                        else {
                            str += '\\u';
                        }
                        break;
                    }
                    default:
                        str += '\\' + esc;
                        break; // unknown escape: keep the backslash
                }
                this.advance();
            }
            else {
                str += ch;
                this.advance();
            }
        }
        if (!closed) {
            this.diagnostics.error('Unterminated string literal', startLine, startCol);
        }
        const type = quoteChar === "'" ? TokenType.FileLiteral : TokenType.StringLiteral;
        return { type, value: str, line: startLine, column: startCol };
    }
    readTemplateString() {
        const startLine = this.line;
        const startCol = this.col;
        const openPos = this.pos;
        this.advance(); // {
        this.advance(); // "
        let str = '';
        let closed = false;
        while (this.pos < this.input.length) {
            const ch = this.input[this.pos];
            if (ch === '\\') {
                // Escaped char: \" \} — never a closing quote.
                str += ch + (this.input[this.pos + 1] ?? '');
                this.advance();
                this.advance();
                continue;
            }
            if (ch === '"' && this.input[this.pos + 1] === '}') {
                // The template closes at the first " DIRECTLY followed by '}'.
                // Quotes inside the content (JSON objects, " }" with whitespace)
                // do not close it (item 56).
                this.advance(); // "
                this.advance(); // }
                closed = true;
                break;
            }
            str += ch;
            this.advance();
        }
        if (!closed) {
            this.diagnostics.error('Unterminated template string literal', startLine, startCol);
        }
        return { type: TokenType.StringLiteral, value: str, line: startLine, column: startCol };
    }
    // DM regex literal: @pattern@ (an inner @@ is an escaped @).
    readRegex() {
        const startLine = this.line;
        const startCol = this.col;
        this.advance(); // @
        let str = '';
        let closed = false;
        while (this.pos < this.input.length) {
            const ch = this.input[this.pos];
            if (ch === '@') {
                if (this.input[this.pos + 1] === '@') {
                    str += '@';
                    this.advance();
                    this.advance();
                    continue;
                }
                this.advance();
                closed = true;
                break;
            }
            str += ch;
            this.advance();
        }
        if (!closed) {
            this.diagnostics.error('Unterminated regex literal', startLine, startCol);
        }
        return { type: TokenType.StringLiteral, value: str, line: startLine, column: startCol };
    }
    readNumber() {
        const startLine = this.line;
        const startCol = this.col;
        let numStr = '';
        // DM 0x / 0b literals: 0x1F, 0b101. The 0b form is only consumed when a
        // binary digit follows (0badcafe is 0 + identifier, not hex).
        if (this.input[this.pos] === '0') {
            const next = this.input[this.pos + 1];
            if (next === 'x' || next === 'X') {
                this.advance();
                this.advance();
                let hex = '';
                while (this.pos < this.input.length && this.isHexDigit(this.input[this.pos])) {
                    hex += this.input[this.pos];
                    this.advance();
                }
                if (hex.length > 0) {
                    return { type: TokenType.Number, value: String(parseInt(hex, 16)), line: startLine, column: startCol };
                }
                this.diagnostics.error('Invalid hex literal', startLine, startCol);
                return { type: TokenType.Number, value: '0', line: startLine, column: startCol };
            }
            if ((next === 'b' || next === 'B')
                && (this.input[this.pos + 2] === '0' || this.input[this.pos + 2] === '1')) {
                this.advance();
                this.advance();
                let bin = '';
                while (this.pos < this.input.length && (this.input[this.pos] === '0' || this.input[this.pos] === '1')) {
                    bin += this.input[this.pos];
                    this.advance();
                }
                return { type: TokenType.Number, value: String(parseInt(bin, 2)), line: startLine, column: startCol };
            }
        }
        while (this.pos < this.input.length) {
            const ch = this.input[this.pos];
            if (this.isDigit(ch)) {
                numStr += ch;
                this.advance();
                continue;
            }
            // Only consume a '.' if it is a decimal point (followed by a digit) and
            // we have not already seen one. This keeps DM range literals like
            // `1..5` (and `1.5..3`) intact: the range operator `..` is left for
            // the operator scanner instead of being swallowed by the number.
            // A trailing `0.` (as in `0. *10`) is a valid float in DM.
            if (ch === '.' && numStr.indexOf('.') === -1 && (this.isDigit(this.peek()) || this.peek() !== '.')) {
                numStr += ch;
                this.advance();
                continue;
            }
            break;
        }
        // Scientific notation: 1E-4, 2.5e+10 (only when followed by an exponent).
        if ((this.input[this.pos] === 'e' || this.input[this.pos] === 'E')) {
            const next1 = this.input[this.pos + 1];
            const isSign = next1 === '+' || next1 === '-';
            const expStart = isSign ? this.pos + 2 : this.pos + 1;
            if (expStart < this.input.length && this.isDigit(this.input[expStart])) {
                numStr += this.input[this.pos];
                this.advance();
                if (isSign) {
                    numStr += this.input[this.pos];
                    this.advance();
                }
                while (this.pos < this.input.length && this.isDigit(this.input[this.pos])) {
                    numStr += this.input[this.pos];
                    this.advance();
                }
            }
        }
        // Special float values: 1.#INF (infinity), 1.#QNAN (NaN), -1.#IND (NaN).
        // parseFloat("1.#INF") would silently yield 1, so the token value is
        // translated to a form the parser/emitter can map (Infinity/NaN).
        const specialMatch = this.input.slice(this.pos).match(/^#(INF|QNAN|IND)/);
        if (specialMatch) {
            for (let i = 0; i < specialMatch[0].length; i++) {
                this.advance();
            }
            const special = specialMatch[1];
            return { type: TokenType.Number, value: special === 'INF' ? 'Infinity' : 'NaN', line: startLine, column: startCol };
        }
        return { type: TokenType.Number, value: numStr, line: startLine, column: startCol };
    }
    readIdentifier() {
        const startLine = this.line;
        const startCol = this.col;
        let id = '';
        while (this.pos < this.input.length) {
            const ch = this.input[this.pos];
            if (this.isAlpha(ch) || this.isDigit(ch) || ch === '_') {
                id += ch;
                this.advance();
            }
            else {
                break;
            }
        }
        // operator"" — the stringify operator overload is a single proc name.
        if (id === 'operator' && this.input[this.pos] === '"' && this.input[this.pos + 1] === '"') {
            id += '""';
            this.advance();
            this.advance();
        }
        return { type: TokenType.Identifier, value: id, line: startLine, column: startCol };
    }
}
exports.DMLexer = DMLexer;
