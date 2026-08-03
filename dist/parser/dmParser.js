"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DMParser = void 0;
const dmLexer_js_1 = require("./dmLexer.js");
const diagnostics_js_1 = require("../diagnostics.js");
class DMParser {
    tokens;
    pos = 0;
    diagnostics;
    // Depth of list()/alist() argument parsing — inside one, `a = 1` is an
    // associative key/value pair, not an assignment (item 58).
    assocArgDepth = 0;
    // Global variable declarations (/global/var/x = v). Not yet materialized in
    // IR output — collected so nothing is silently dropped.
    globalVars = [];
    constructor(tokens, collector) {
        this.tokens = tokens;
        this.diagnostics = collector ?? new diagnostics_js_1.DiagnosticCollector();
    }
    parse() {
        const typeDecls = new Map();
        let currentTypePath = '/datum';
        while (this.pos < this.tokens.length && !this.isType(dmLexer_js_1.TokenType.EOF)) {
            this.skipNewlines();
            if (this.isType(dmLexer_js_1.TokenType.EOF))
                break;
            // Stray indentation at top level (e.g. from comment-only lines) is not
            // valid DM structure; skip it instead of erroring.
            if (this.isType(dmLexer_js_1.TokenType.Indent)) {
                this.advance();
                continue;
            }
            const token = this.peek();
            // Leading-slash-less declarations: mob/verb/say(...), world/New(),
            // obj/item/sword — the leading type name lexes as a Keyword/Identifier
            // and the rest as a TypePath; synthesize the full path and fall
            // through to the TypePath declaration handling below.
            const nextTok = this.peekNext();
            if ((token.type === dmLexer_js_1.TokenType.Keyword || token.type === dmLexer_js_1.TokenType.Identifier) &&
                nextTok && nextTok.type === dmLexer_js_1.TokenType.TypePath) {
                const kwTok = this.advance();
                const pathTok = this.advance();
                this.tokens.splice(this.pos, 0, {
                    type: dmLexer_js_1.TokenType.TypePath,
                    value: '/' + kwTok.value + pathTok.value,
                    line: pathTok.line,
                    column: pathTok.column
                });
                continue;
            }
            // Top level type declaration (e.g. /obj/item/weapon/sword or /obj/item/proc/swing)
            if (token.type === dmLexer_js_1.TokenType.TypePath) {
                let rawPath = token.value;
                this.advance();
                // Global variable declaration: /global/var/list/x = value
                if (rawPath.startsWith('/global/var/') || rawPath.startsWith('/global/')) {
                    const rest = rawPath.startsWith('/global/var/')
                        ? rawPath.slice('/global/var/'.length)
                        : rawPath.slice('/global/'.length);
                    let varName = rest;
                    let varType = '';
                    const varMarker = rest.indexOf('/var/');
                    if (varMarker >= 0) {
                        varName = rest.slice(varMarker + '/var/'.length);
                        varType = rest.slice(0, varMarker + 1);
                    }
                    const lastSlash = varName.lastIndexOf('/');
                    if (lastSlash >= 0) {
                        varType = varName.slice(0, lastSlash) + (varType || '');
                        varName = varName.slice(lastSlash + 1);
                    }
                    let initialValue = '';
                    if (this.matchOperator('=')) {
                        initialValue = this.parseInitialValueText();
                    }
                    const globalNode = {
                        type: 'GlobalVarDecl',
                        name: varName,
                        varType,
                        initialValue,
                        initialValueExpr: this.parseInitializerTextToExpr(initialValue)
                    };
                    this.globalVars.push(globalNode);
                    continue;
                }
                // Classic BYOND var declaration: /type/path/var/[global/][type/]name = value
                // (bare `var/x = 5` at the top level is a global var — WS2-5)
                const varDeclMatch = rawPath.match(/^((?:.*?))\/var\/(global\/)?(.*)$/);
                if (varDeclMatch) {
                    const ownerPath = varDeclMatch[1];
                    const isGlobal = varDeclMatch[2] !== undefined || ownerPath === '';
                    const rest = varDeclMatch[3].split('/').filter((s) => s.length > 0);
                    const varName = rest.pop() ?? '';
                    const varType = rest.join('/');
                    // Array length: var/list/x[6] — consumed and dropped (the length is
                    // not materialized; same as in-block array-length handling).
                    if (this.isType(dmLexer_js_1.TokenType.Punctuation) && this.peek().value === '[') {
                        this.advance();
                        while (!this.isType(dmLexer_js_1.TokenType.EOF) &&
                            !(this.isType(dmLexer_js_1.TokenType.Punctuation) && this.peek().value === ']')) {
                            this.advance();
                        }
                        if (this.isType(dmLexer_js_1.TokenType.Punctuation) && this.peek().value === ']')
                            this.advance();
                    }
                    let initialValue = '';
                    if (this.matchOperator('=')) {
                        initialValue = this.parseInitialValueText();
                    }
                    if (isGlobal) {
                        this.globalVars.push({ type: 'GlobalVarDecl', name: varName, varType, initialValue, initialValueExpr: this.parseInitializerTextToExpr(initialValue) });
                    }
                    else {
                        const ownerNode = this.getOrCreateTypeNode(ownerPath, typeDecls);
                        ownerNode.vars.push({ type: 'DMVarDecl', name: varName, varType, initialValue });
                    }
                    continue;
                }
                // Check if path represents a proc definition: e.g. /obj/item/proc/swing
                const procMatch = rawPath.match(/^(.+)\/(proc|verb)\/([^\/]+)$/);
                if (procMatch) {
                    const ownerPath = procMatch[1];
                    let procName = procMatch[3];
                    // Operator overloads: /datum/x/proc/operator+=(A) — the compound
                    // operator token follows the path and is part of the name (item 56).
                    if (this.isType(dmLexer_js_1.TokenType.Operator) &&
                        ['+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '||=', '&&='].includes(this.peek().value)) {
                        procName += this.advance().value;
                    }
                    // operator[](A) — the bracket pair is punctuation (item 59: the
                    // registration key must preserve it; only the C# member name is
                    // sanitized downstream).
                    if (this.isType(dmLexer_js_1.TokenType.Punctuation) && this.peek().value === '[') {
                        procName += this.advance().value + this.advance().value; // [ ]
                    }
                    const ownerNode = this.getOrCreateTypeNode(ownerPath, typeDecls);
                    const args = this.parseProcArgs();
                    // Optional return type: /proc/foo(...) as /list
                    if (this.peek().value === 'as') {
                        this.advance();
                        if (this.isType(dmLexer_js_1.TokenType.TypePath) || this.isType(dmLexer_js_1.TokenType.Identifier) || this.isType(dmLexer_js_1.TokenType.Keyword)) {
                            this.advance();
                        }
                    }
                    const procNode = {
                        type: 'DMProcDecl',
                        name: procName,
                        args,
                        statements: []
                    };
                    this.skipNewlines();
                    if (this.isType(dmLexer_js_1.TokenType.Punctuation) && this.peek().value === '{') {
                        this.advance();
                        procNode.statements = this.parseProcBody(true);
                        this.matchPunctuation('}');
                    }
                    else if (this.isType(dmLexer_js_1.TokenType.Indent)) {
                        this.advance();
                        procNode.statements = this.parseProcBody();
                    }
                    else {
                        // Single-line body: /proc/foo() return expr
                        procNode.statements = this.parseProcBody(false, true);
                    }
                    ownerNode.procs.push(procNode);
                    continue;
                }
                // Path-scoped proc without /proc/ segment (modern /tg/ style):
                // /mob/living/Initialize(mapload) — a '(' directly after the path
                // means the last segment is a proc name, not a type.
                this.skipNewlines();
                if (this.isType(dmLexer_js_1.TokenType.Punctuation) && this.peek().value === '(') {
                    const lastSlash = rawPath.lastIndexOf('/');
                    if (lastSlash > 0) {
                        const ownerPath = rawPath.slice(0, lastSlash);
                        const procName = rawPath.slice(lastSlash + 1);
                        const ownerNode = this.getOrCreateTypeNode(ownerPath, typeDecls);
                        const args = this.parseProcArgs();
                        // Optional return type: /path/foo(...) as /list
                        if (this.peek().value === 'as') {
                            this.advance();
                            if (this.isType(dmLexer_js_1.TokenType.TypePath) || this.isType(dmLexer_js_1.TokenType.Identifier) || this.isType(dmLexer_js_1.TokenType.Keyword)) {
                                this.advance();
                            }
                        }
                        const procNode = {
                            type: 'DMProcDecl',
                            name: procName,
                            args,
                            statements: []
                        };
                        this.skipNewlines();
                        if (this.isType(dmLexer_js_1.TokenType.Punctuation) && this.peek().value === '{') {
                            this.advance();
                            procNode.statements = this.parseProcBody(true);
                            this.matchPunctuation('}');
                        }
                        else if (this.isType(dmLexer_js_1.TokenType.Indent)) {
                            this.advance();
                            procNode.statements = this.parseProcBody();
                        }
                        else {
                            // Single-line body: /mob/living/Initialize() ..
                            procNode.statements = this.parseProcBody(false, true);
                        }
                        ownerNode.procs.push(procNode);
                        continue;
                    }
                }
                currentTypePath = rawPath;
                if (!typeDecls.has(currentTypePath)) {
                    typeDecls.set(currentTypePath, {
                        type: 'DMTypeDecl',
                        path: currentTypePath,
                        vars: [],
                        procs: []
                    });
                }
                const currentTypeNode = typeDecls.get(currentTypePath);
                // Check if inline block follows
                this.skipNewlines();
                if (this.isType(dmLexer_js_1.TokenType.Punctuation) && this.peek().value === '{') {
                    this.advance();
                    this.parseTypeBlock(currentTypeNode, typeDecls, true);
                    this.matchPunctuation('}');
                }
                else if (this.isType(dmLexer_js_1.TokenType.Indent)) {
                    this.advance();
                    this.parseTypeBlock(currentTypeNode, typeDecls);
                }
                else if (this.peek().value === '=') {
                    // Top-level path assignment (/savefile/byond_version = 516): a
                    // compile-time constant on a type path. Parsed and dropped — there
                    // is no IR surface for it, but it must not break the file.
                    this.advance();
                    this.parseInitialValueText();
                }
                continue;
            }
            // Root level var or proc
            if (token.value === 'var' || token.value === 'proc' || token.value === 'verb') {
                const typeNode = this.getOrCreateTypeNode(currentTypePath, typeDecls);
                this.parseMemberDecl(typeNode);
                continue;
            }
            // Handle simple var assignment under current type
            if (token.type === dmLexer_js_1.TokenType.Identifier) {
                const varName = token.value;
                this.advance();
                if (this.matchOperator('=')) {
                    const typeNode = this.getOrCreateTypeNode(currentTypePath, typeDecls);
                    typeNode.vars.push({
                        type: 'DMVarDecl',
                        name: varName,
                        initialValue: this.parseInitialValueText() || null
                    });
                }
                continue;
            }
            // Statement separator at top level (macros expand to /global/var/... ; /global/var/...)
            if (this.peek().value === ';') {
                this.advance();
                continue;
            }
            // Structural Dedent leftover from an indented block whose body was
            // consumed inline (e.g. a verb with a set header) — skip (item 56).
            if (this.isType(dmLexer_js_1.TokenType.Dedent)) {
                this.advance();
                continue;
            }
            // A bare string literal at top level (e.g. tgstation's
            // __interop_version.dm, which is `"5.11.0"` alone) is a CI interop
            // marker — skip silently (item 56).
            if (this.isType(dmLexer_js_1.TokenType.StringLiteral) || this.isType(dmLexer_js_1.TokenType.Number)) {
                this.advance();
                continue;
            }
            // Top-level token we don't understand: report and recover
            const skip = this.advance();
            this.diagnostics.error(`Unexpected top-level token '${skip.value}'`, skip.line, skip.column);
        }
        return Array.from(typeDecls.values());
    }
    parseTypeBlock(currentTypeNode, typeDecls, stopAtBrace = false) {
        const atClosingBrace = () => stopAtBrace && this.isType(dmLexer_js_1.TokenType.Punctuation) && this.peek().value === '}';
        while (!this.isType(dmLexer_js_1.TokenType.Dedent) && !this.isType(dmLexer_js_1.TokenType.EOF) && !atClosingBrace()) {
            this.skipNewlines();
            if (this.isType(dmLexer_js_1.TokenType.Dedent) || this.isType(dmLexer_js_1.TokenType.EOF) || atClosingBrace())
                break;
            // Members at a deeper indent than the block itself (macro-expanded
            // chains) — indentation is not structural inside a type block.
            if (this.isType(dmLexer_js_1.TokenType.Indent)) {
                this.advance();
                continue;
            }
            const token = this.peek();
            // Statement separators in { } bodies (macro-generated type decls)
            if (this.isType(dmLexer_js_1.TokenType.Punctuation) && this.peek().value === ';') {
                this.advance();
                continue;
            }
            // Sub-path under block (e.g. sword, or sword/name = "x", or /obj/item/sword)
            if (token.type === dmLexer_js_1.TokenType.TypePath || (token.type === dmLexer_js_1.TokenType.Identifier && this.peekNext()?.type === dmLexer_js_1.TokenType.TypePath)) {
                const isAbsolute = token.type === dmLexer_js_1.TokenType.TypePath;
                let subPath;
                if (isAbsolute) {
                    subPath = token.value;
                    this.advance();
                }
                else {
                    const ident = this.advance();
                    subPath = '/' + ident.value + this.advance().value;
                }
                this.skipNewlines();
                if (this.matchOperator('=')) {
                    // Sub-path var override: `sword/name = "x"` → var `name` on
                    // `/obj/item/sword` (WS2-4).
                    const segs = subPath.split('/').filter((s) => s.length > 0);
                    const varName = segs.pop();
                    if (varName) {
                        const typePart = '/' + segs.join('/');
                        const fullPath = isAbsolute ? typePart : currentTypeNode.path + typePart;
                        const subTypeNode = this.getOrCreateTypeNode(fullPath, typeDecls);
                        subTypeNode.vars.push({
                            type: 'DMVarDecl',
                            name: varName,
                            initialValue: this.parseInitialValueText() || null
                        });
                    }
                    continue;
                }
                const fullPath = isAbsolute ? subPath : currentTypeNode.path + subPath;
                const subTypeNode = this.getOrCreateTypeNode(fullPath, typeDecls);
                if (this.isType(dmLexer_js_1.TokenType.Punctuation) && this.peek().value === '{') {
                    // Brace-form type body: /obj/type { member = x; ... } — macro-
                    // expanded declarations can emit several per line
                    // (item 56: paradise turf_decal.dm TURF_DECAL_COLOR_HELPER).
                    this.advance();
                    while (!this.isType(dmLexer_js_1.TokenType.EOF) && !this.isType(dmLexer_js_1.TokenType.Newline) && !this.isType(dmLexer_js_1.TokenType.Dedent)) {
                        this.skipNewlines();
                        if (this.isType(dmLexer_js_1.TokenType.Punctuation) && this.peek().value === '}') {
                            this.advance();
                            break;
                        }
                        if (this.isType(dmLexer_js_1.TokenType.Punctuation) && this.peek().value === ';') {
                            this.advance();
                            continue;
                        }
                        const bt = this.peek();
                        if (bt.value === 'var' || bt.value === 'proc' || bt.value === 'verb') {
                            this.parseMemberDecl(subTypeNode);
                            continue;
                        }
                        if (bt.type === dmLexer_js_1.TokenType.Identifier || bt.type === dmLexer_js_1.TokenType.Keyword) {
                            const varName = this.advance().value;
                            if (this.matchOperator('=')) {
                                subTypeNode.vars.push({
                                    type: 'DMVarDecl',
                                    name: varName,
                                    initialValue: this.parseInitialValueText() || null
                                });
                            }
                            continue;
                        }
                        // Unknown content inside the brace body: skip to the next ';'
                        // or '}' (honest loss).
                        while (!this.isType(dmLexer_js_1.TokenType.EOF) && !this.isType(dmLexer_js_1.TokenType.Newline) &&
                            !(this.isType(dmLexer_js_1.TokenType.Punctuation) && (this.peek().value === ';' || this.peek().value === '}'))) {
                            this.advance();
                        }
                    }
                    continue;
                }
                if (this.isType(dmLexer_js_1.TokenType.Indent)) {
                    this.advance();
                    this.parseTypeBlock(subTypeNode, typeDecls);
                }
                continue;
            }
            // Members inside type block
            if (token.value === 'var' || token.value === 'proc' || token.value === 'verb') {
                this.parseMemberDecl(currentTypeNode);
                continue;
            }
            // Var assignment override (e.g. name = "Sword", density = 1). DM
            // keywords like step/to/as/in are legal var names (item 56).
            if (token.type === dmLexer_js_1.TokenType.Identifier ||
                (token.type === dmLexer_js_1.TokenType.Keyword && !['var', 'proc', 'verb', 'const', 'global', 'tmp', 'new', 'del', 'qdel', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'spawn', 'sleep', 'try', 'catch', 'null', 'TRUE', 'FALSE', 'usr', 'src', 'args', 'prob', 'locate', 'istype', 'ispath'].includes(token.value))) {
                // Bare relative child type on its own line (WS2-3): `/obj/item` +
                // indented `sword` + indented members declares `/obj/item/sword`.
                if (this.peekNext()?.type === dmLexer_js_1.TokenType.Newline && this.tokens[this.pos + 2]?.type === dmLexer_js_1.TokenType.Indent) {
                    const ident = this.advance();
                    const subTypeNode = this.getOrCreateTypeNode(currentTypeNode.path + '/' + ident.value, typeDecls);
                    this.skipNewlines();
                    if (this.isType(dmLexer_js_1.TokenType.Indent)) {
                        this.advance();
                        this.parseTypeBlock(subTypeNode, typeDecls);
                    }
                    continue;
                }
                const varName = token.value;
                this.advance();
                if (this.matchOperator('=')) {
                    currentTypeNode.vars.push({
                        type: 'DMVarDecl',
                        name: varName,
                        initialValue: this.parseInitialValueText() || null
                    });
                }
                continue;
            }
            // A stray `else` (macro-expanded type blocks where an if/else chain was
            // flattened) — skip with a warning (item 56).
            if (this.isType(dmLexer_js_1.TokenType.Keyword) && token.value === 'else') {
                this.advance();
                this.diagnostics.warning('else without a matching if in type block', token.line, token.column);
                continue;
            }
            // Unrecognized member: report and recover
            const skip = this.advance();
            this.diagnostics.error(`Unexpected token '${skip.value}' in type block`, skip.line, skip.column);
        }
        if (this.isType(dmLexer_js_1.TokenType.Dedent)) {
            this.advance();
        }
    }
    /**
     * Parse a proc/verb argument list: `(a, mob/user, var/x, args, ...)`.
     * DM keyword names (`args`, `usr`, `src`) and `var`-prefixed forms are
     * accepted; `as <type>` clauses are parsed and dropped (documented
     * limitation). Type hints are recorded when they appear as a `/type/name`
     * path segment.
     */
    parseProcArgs() {
        const args = [];
        if (!this.matchPunctuation('('))
            return args;
        // Track parenthesis nesting: defaults like `controller in list("A", "B")`
        // or `flag = (1<<5)` contain nested parens and commas that must not
        // terminate or split the argument list.
        let depth = 0;
        while (!this.isType(dmLexer_js_1.TokenType.EOF)) {
            const tok = this.peek();
            if (tok.type === dmLexer_js_1.TokenType.Punctuation && tok.value === ')') {
                if (depth === 0) {
                    this.advance();
                    break;
                }
                depth--;
                this.advance();
                continue;
            }
            if (tok.type === dmLexer_js_1.TokenType.Punctuation && tok.value === '(') {
                depth++;
                this.advance();
                continue;
            }
            if (depth === 0 && tok.type === dmLexer_js_1.TokenType.Punctuation && tok.value === ',') {
                this.advance();
                continue;
            }
            const arg = this.parseProcArg();
            if (arg)
                args.push(arg);
        }
        return args;
    }
    parseProcArg() {
        const tok = this.peek();
        let name = '';
        let typeHint;
        const splitPath = (pathVal) => {
            const lastSlash = pathVal.lastIndexOf('/');
            if (lastSlash > 0) {
                typeHint = pathVal.substring(0, lastSlash);
                name = pathVal.substring(lastSlash + 1);
            }
            else {
                name = pathVal.replace(/^\//, '');
            }
        };
        if (tok.type === dmLexer_js_1.TokenType.TypePath) {
            splitPath(this.advance().value);
        }
        else if (tok.type === dmLexer_js_1.TokenType.Identifier || tok.type === dmLexer_js_1.TokenType.Keyword) {
            this.advance();
            if (tok.value === 'var') {
                // var/x or var x — explicit local declaration
                const next = this.peek();
                if (next.type === dmLexer_js_1.TokenType.TypePath) {
                    splitPath(this.advance().value);
                }
                else if (next.type === dmLexer_js_1.TokenType.Identifier || next.type === dmLexer_js_1.TokenType.Keyword) {
                    name = this.advance().value;
                }
            }
            else if (this.peek().type === dmLexer_js_1.TokenType.TypePath) {
                // mob/user — keyword/identifier type hint followed by /name
                splitPath(this.advance().value);
            }
            else {
                // Plain name; DM keyword names (args, usr, src) must not be dropped.
                name = tok.value;
            }
        }
        else {
            this.advance(); // skip unrecognized junk
        }
        // Optional `as <type>` clause — parsed and dropped.
        if (this.peek().value === 'as') {
            this.advance();
            if (this.isType(dmLexer_js_1.TokenType.Identifier) || this.isType(dmLexer_js_1.TokenType.TypePath) || this.isType(dmLexer_js_1.TokenType.Keyword)) {
                this.advance();
            }
        }
        // Optional default value: epsilon = (1E-4 * 20) — kept as an AST so the
        // emitter applies it when the call site omits the argument (item 58).
        let defaultValue;
        if (name && this.matchOperator('=')) {
            defaultValue = this.parseExpression();
        }
        // `in`-clause: `target as mob in oview(1)` — the target expression is a
        // visibility/range filter, not a parameter; consume it so it never
        // becomes a phantom parameter (it would shift every call site).
        if (name && this.peek().value === 'in') {
            this.advance();
            this.parseExpression();
        }
        if (!name)
            return null;
        return { name, typeHint, defaultValue };
    }
    /**
     * Capture the remaining tokens of the current line as raw source text.
     * Used for type-level var initial values, which may be full expressions
     * (e.g. `var/list/stuff = list(1, 2, 3)`); the text is preserved for the
     * YAML initialVars rather than silently dropping everything after the
     * first token.
     */
    parseInitialValueText() {
        const parts = [];
        let depth = 0;
        while (!this.isType(dmLexer_js_1.TokenType.EOF)) {
            const token = this.peek();
            if (token.type === dmLexer_js_1.TokenType.Newline && depth === 0)
                break;
            if (token.type === dmLexer_js_1.TokenType.Dedent && depth === 0)
                break;
            if (token.type === dmLexer_js_1.TokenType.Punctuation && token.value === ';' && depth === 0)
                break;
            if (token.type === dmLexer_js_1.TokenType.Indent || token.type === dmLexer_js_1.TokenType.Newline) {
                // Inside multiline list()/bracket initializers, indentation and
                // newlines are just whitespace (classic DM allows lists to span lines).
                if (token.type === dmLexer_js_1.TokenType.Newline)
                    parts.push(' ');
                this.advance();
                continue;
            }
            const value = this.advance().value;
            if (value === '(' || value === '[' || value === '{')
                depth++;
            else if (value === ')' || value === ']' || value === '}') {
                // A stray closer at depth 0 is an error in the source, not a signal
                // to swallow the following declaration — clamp at 0 and stop (WS2-6).
                if (depth <= 0) {
                    parts.push(value);
                    break;
                }
                depth--;
            }
            // StringLiteral token values arrive unquoted; restore the quotes so the
            // captured text round-trips through the lexer in parseInitializerTextToExpr
            // (otherwise "hello world" re-lexes as two bare identifiers).
            if (token.type === dmLexer_js_1.TokenType.StringLiteral) {
                parts.push('"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"');
            }
            else {
                parts.push(value);
            }
        }
        return parts.join(' ').trim();
    }
    /**
     * Re-parse a captured initializer string (see parseInitialValueText) into a
     * full expression tree. Globals are declared at top level where no statement
     * parser is running, so their initializers are re-lexed into a sub-parser.
     */
    parseInitializerTextToExpr(text, collector) {
        if (!text)
            return null;
        try {
            const tokens = new dmLexer_js_1.DMLexer(text).tokenize();
            const sub = new DMParser(tokens, collector ?? this.diagnostics);
            const expr = sub.parseExpression() ?? null;
            if (collector && collector.hasErrors())
                return null;
            return expr;
        }
        catch {
            return null;
        }
    }
    /**
     * Split a raw string value into literal text and [interpolation] chunks,
     * mirroring the lexer's bracket scan (nested brackets count). Returns a
     * single element when there is no interpolation.
     */
    splitInterpolation(value) {
        const parts = [];
        let current = '';
        let i = 0;
        while (i < value.length) {
            const ch = value[i];
            // DM doubles brackets to escape them in text: [[ is a literal [.
            if (ch === '[' && value[i + 1] === '[') {
                current += '[';
                i += 2;
                continue;
            }
            if (ch === '[') {
                let depth = 1;
                let j = i + 1;
                while (j < value.length && depth > 0) {
                    if (value[j] === '\\') {
                        j += 2; // \[ \] \" \\ — escaped, never structural
                        continue;
                    }
                    if (value[j] === '[' && value[j + 1] === '[') {
                        j += 2; // [[ literal bracket — no depth change
                        continue;
                    }
                    if (value[j] === '[')
                        depth++;
                    else if (value[j] === ']')
                        depth--;
                    j++;
                }
                if (depth === 0) {
                    parts.push(current);
                    current = '';
                    parts.push({ interp: value.substring(i + 1, j - 1) });
                    i = j;
                    continue;
                }
            }
            current += ch;
            i++;
        }
        parts.push(current);
        return parts;
    }
    parseMemberDecl(targetTypeNode) {
        const keyword = this.advance().value; // var, proc, verb
        if (keyword === 'var') {
            let varType;
            if (this.isType(dmLexer_js_1.TokenType.Operator) && this.peek().value === '/') {
                this.advance();
            }
            let varName = '';
            // var/static/list/name — walk /-separated segments; keywords (static,
            // global, tmp) are valid type segments (item 56).
            const segments = [];
            while (true) {
                if (this.isType(dmLexer_js_1.TokenType.TypePath)) {
                    segments.push(this.advance().value.replace(/^\//, ''));
                }
                else if (this.isType(dmLexer_js_1.TokenType.Identifier) || this.isType(dmLexer_js_1.TokenType.Keyword)) {
                    segments.push(this.advance().value);
                }
                else {
                    break;
                }
                if (this.isType(dmLexer_js_1.TokenType.Operator) && this.peek().value === '/') {
                    this.advance();
                    continue;
                }
                break;
            }
            if (segments.length > 0) {
                const pathVal = segments.join('/');
                const lastSlash = pathVal.lastIndexOf('/');
                if (lastSlash > 0) {
                    varType = pathVal.substring(0, lastSlash);
                    varName = pathVal.substring(lastSlash + 1);
                }
                else {
                    varName = pathVal.replace(/^\//, '');
                }
            }
            // Block var declaration: `var` (or a trailing pseudo-var like
            // `var/SpacemanDMM_private` from VAR_PRIVATE) on its own line followed
            // by indented `type/name = value` lines.
            if (this.isType(dmLexer_js_1.TokenType.Newline)) {
                this.skipNewlines();
                if (this.isType(dmLexer_js_1.TokenType.Indent)) {
                    while (!this.isType(dmLexer_js_1.TokenType.Dedent) && !this.isType(dmLexer_js_1.TokenType.EOF)) {
                        if (this.isType(dmLexer_js_1.TokenType.Indent))
                            this.advance();
                        this.skipNewlines();
                        if (this.isType(dmLexer_js_1.TokenType.Dedent) || this.isType(dmLexer_js_1.TokenType.EOF))
                            break;
                        let blockType;
                        let blockName = '';
                        if (this.isType(dmLexer_js_1.TokenType.TypePath)) {
                            const pathVal = this.advance().value;
                            const lastSlash = pathVal.lastIndexOf('/');
                            if (lastSlash > 0) {
                                blockType = pathVal.substring(0, lastSlash);
                                blockName = pathVal.substring(lastSlash + 1);
                            }
                            else {
                                blockName = pathVal.replace(/^\//, '');
                            }
                        }
                        else if (this.isType(dmLexer_js_1.TokenType.Identifier)) {
                            blockName = this.advance().value;
                        }
                        else {
                            this.advance();
                            continue;
                        }
                        let initialVal = null;
                        if (this.isType(dmLexer_js_1.TokenType.Punctuation) && this.peek().value === '[') {
                            this.advance();
                            this.parseExpression();
                            this.matchPunctuation(']');
                        }
                        if (blockName && this.matchOperator('=')) {
                            initialVal = this.parseInitialValueText() || null;
                        }
                        if (blockName) {
                            targetTypeNode.vars.push({
                                type: 'DMVarDecl',
                                name: blockName,
                                varType: blockType,
                                initialValue: initialVal
                            });
                        }
                        this.skipNewlines();
                    }
                    if (this.isType(dmLexer_js_1.TokenType.Dedent))
                        this.advance();
                    return;
                }
            }
            let initialVal = null;
            // Initialized length: var/list/screen_groups[6] — drop the length expr.
            // Empty brackets: var/list/x[] — the list-declaration suffix.
            // Multi-dim: var/list/clients_by_zlevel[][] — repeated dims (item 56).
            while (this.isType(dmLexer_js_1.TokenType.Punctuation) && this.peek().value === '[') {
                this.advance();
                if (!(this.isType(dmLexer_js_1.TokenType.Punctuation) && this.peek().value === ']')) {
                    this.parseExpression();
                }
                this.matchPunctuation(']');
            }
            if (varName && this.matchOperator('=')) {
                initialVal = this.parseInitialValueText() || null;
            }
            if (varName) {
                targetTypeNode.vars.push({
                    type: 'DMVarDecl',
                    name: varName,
                    varType,
                    initialValue: initialVal
                });
            }
            return;
        }
        else if (keyword === 'proc' || keyword === 'verb') {
            let procName = '';
            if (this.isType(dmLexer_js_1.TokenType.Operator) && this.peek().value === '/') {
                this.advance();
            }
            if (this.isType(dmLexer_js_1.TokenType.TypePath)) {
                procName = this.advance().value.replace(/^\//, '');
            }
            else if (this.isType(dmLexer_js_1.TokenType.Identifier)) {
                procName = this.advance().value;
            }
            if (procName) {
                const args = this.parseProcArgs();
                // Optional return type: /proc/foo(...) as /list
                if (this.peek().value === 'as') {
                    this.advance();
                    if (this.isType(dmLexer_js_1.TokenType.TypePath) || this.isType(dmLexer_js_1.TokenType.Identifier) || this.isType(dmLexer_js_1.TokenType.Keyword)) {
                        this.advance();
                    }
                }
                const procNode = {
                    type: 'DMProcDecl',
                    name: procName,
                    args,
                    statements: []
                };
                // Parse proc body if block exists
                this.skipNewlines();
                if (this.isType(dmLexer_js_1.TokenType.Punctuation) && this.peek().value === '{') {
                    this.advance();
                    procNode.statements = this.parseProcBody(true);
                    this.matchPunctuation('}');
                }
                else if (this.isType(dmLexer_js_1.TokenType.Indent)) {
                    this.advance();
                    procNode.statements = this.parseProcBody();
                }
                else {
                    procNode.statements = this.parseProcBody(false, true);
                }
                targetTypeNode.procs.push(procNode);
            }
        }
    }
    parseProcBody(stopAtBrace = false, inline = false) {
        const statements = [];
        const atClosingBrace = () => stopAtBrace && this.isType(dmLexer_js_1.TokenType.Punctuation) && this.peek().value === '}';
        while (!this.isType(dmLexer_js_1.TokenType.Dedent) && !this.isType(dmLexer_js_1.TokenType.EOF) && !atClosingBrace()) {
            if (!inline)
                this.skipNewlines();
            if (this.isType(dmLexer_js_1.TokenType.Dedent) || this.isType(dmLexer_js_1.TokenType.EOF) || atClosingBrace())
                break;
            // Inline (single-line) bodies: a Newline ends the body — and so does a
            // top-level TypePath, because the parser may have skipped blank lines
            // and the "body" is actually the next /type/proc/ declaration.
            if (inline && (this.isType(dmLexer_js_1.TokenType.Newline) || this.isType(dmLexer_js_1.TokenType.TypePath)))
                break;
            // Statement separators: inside { } bodies and single-line statements
            if (this.isType(dmLexer_js_1.TokenType.Punctuation) && this.peek().value === ';') {
                this.advance();
                continue;
            }
            // DM `set` statements: set name = "x" / set hidden = FALSE — parsed
            // and dropped (they only affect the verb's UI configuration).
            if (this.peek().value === 'set') {
                this.advance();
                if (this.isType(dmLexer_js_1.TokenType.Identifier) || this.isType(dmLexer_js_1.TokenType.Keyword)) {
                    this.advance();
                }
                if (this.matchOperator('=')) {
                    this.parseExpression();
                }
                // Verb-set clauses like `set src in view(1)` / `set popup_menu = TRUE`:
                // consume the `in <expr>` tail so it never leaks as a phantom token
                // (item 56 — `Unexpected token 'in'` on macro-expanded verbs).
                if (this.peek().value === 'in') {
                    this.advance();
                    this.parseExpression();
                }
                if (this.isType(dmLexer_js_1.TokenType.Punctuation) && this.peek().value === ';') {
                    this.advance();
                }
                // A set header on the proc's declaration line (verb/foo() set hidden
                // = TRUE) is verb config — the real body continues on the next line
                // (item 56).
                if (inline && this.isType(dmLexer_js_1.TokenType.Newline)) {
                    this.advance();
                    while (this.isType(dmLexer_js_1.TokenType.Newline))
                        this.advance();
                    if (this.isType(dmLexer_js_1.TokenType.Indent))
                        this.advance();
                }
                continue;
            }
            // try { ... } catch(var/exception/e) { ... } — exception handling.
            if (this.peek().value === 'try') {
                this.advance();
                this.skipNewlines();
                const tryBody = [];
                if (this.isType(dmLexer_js_1.TokenType.Punctuation) && this.peek().value === '{') {
                    this.advance();
                    tryBody.push(...this.parseProcBody(true));
                    this.matchPunctuation('}');
                }
                else if (this.isType(dmLexer_js_1.TokenType.Indent)) {
                    this.advance();
                    tryBody.push(...this.parseProcBody());
                }
                else if (!this.isType(dmLexer_js_1.TokenType.Newline) && !this.isType(dmLexer_js_1.TokenType.Dedent) && !this.isType(dmLexer_js_1.TokenType.EOF)) {
                    // Inline body: try <statement> (item 56: beestation genpop.dm).
                    tryBody.push(this.parseSingleStatement());
                }
                let catchVar;
                let catchBody = [];
                this.skipNewlines();
                if (this.peek().value === 'catch') {
                    this.advance();
                    if (this.matchPunctuation('(')) {
                        let catchPath = '';
                        if (this.isType(dmLexer_js_1.TokenType.Keyword) && this.peek().value === 'var') {
                            this.advance();
                        }
                        if (this.isType(dmLexer_js_1.TokenType.TypePath) || this.isType(dmLexer_js_1.TokenType.Identifier)) {
                            catchPath = this.advance().value;
                        }
                        if (catchPath) {
                            const lastSlash = catchPath.lastIndexOf('/');
                            catchVar = lastSlash > 0 ? catchPath.substring(lastSlash + 1) : catchPath.replace(/^\//, '');
                        }
                        this.matchPunctuation(')');
                    }
                    this.skipNewlines();
                    if (this.isType(dmLexer_js_1.TokenType.Punctuation) && this.peek().value === '{') {
                        this.advance();
                        catchBody.push(...this.parseProcBody(true));
                        this.matchPunctuation('}');
                    }
                    else if (this.isType(dmLexer_js_1.TokenType.Indent)) {
                        this.advance();
                        catchBody.push(...this.parseProcBody());
                    }
                }
                statements.push({ type: 'TryStatement', tryBody, catchVar, catchBody });
                continue;
            }
            // continue / break statements (optionally with a label: break set_adj_in_dir)
            const ctrlToken = this.peek().value;
            if (ctrlToken === 'continue' || ctrlToken === 'break') {
                this.advance();
                let label;
                // A DM label is an identifier (or a select keyword). Statement
                // starters must NOT be grabbed as labels — `if(x) break else y`
                // would otherwise swallow the `else` (corpus: tgstation CS0159
                // 'No such label __dmBreak_else').
                if (this.isType(dmLexer_js_1.TokenType.Identifier) ||
                    (this.isType(dmLexer_js_1.TokenType.Keyword) && !['var', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'spawn', 'sleep', 'try', 'catch', 'continue', 'break', 'set', 'in'].includes(this.peek().value))) {
                    label = this.advance().value;
                }
                statements.push({ type: ctrlToken === 'continue' ? 'ContinueStatement' : 'BreakStatement', label });
                continue;
            }
            // Labeled block: name: { ... } — break name jumps out (treated as a scope)
            if (this.isType(dmLexer_js_1.TokenType.Identifier) && this.peekNext()?.value === ':') {
                const labelName = this.peek().value;
                this.advance();
                this.advance(); // :
                this.skipNewlines();
                let labeled = [];
                if (this.isType(dmLexer_js_1.TokenType.Punctuation) && this.peek().value === '{') {
                    this.advance();
                    labeled = this.parseProcBody(true);
                    this.matchPunctuation('}');
                }
                else if (this.isType(dmLexer_js_1.TokenType.Indent)) {
                    this.advance();
                    labeled = this.parseProcBody();
                }
                statements.push({ type: 'LabeledBlockStatement', label: labelName, body: labeled });
                continue;
            }
            const token = this.peek();
            // `{ ... }` at statement level is a statement BLOCK, not a list
            // literal (macro-expanded do/while and one-line chains — item 56).
            if (this.isType(dmLexer_js_1.TokenType.Punctuation) && token.value === '{') {
                this.advance();
                statements.push(...this.parseProcBody(true));
                this.matchPunctuation('}');
                continue;
            }
            // A stray `else` at statement level (macro-expanded single-line chains
            // where the else's if has already completed) — skip with a warning
            // instead of an expression error (item 56).
            if (this.isType(dmLexer_js_1.TokenType.Keyword) && token.value === 'else') {
                this.advance();
                this.diagnostics.warning('else without a matching if', token.line, token.column);
                continue;
            }
            if (token.value === 'return') {
                this.advance();
                let returnValue;
                const nextVal = this.peek().value;
                if (!this.isType(dmLexer_js_1.TokenType.Newline) && !this.isType(dmLexer_js_1.TokenType.Dedent) && !this.isType(dmLexer_js_1.TokenType.EOF) && nextVal !== ';' && nextVal !== '}' &&
                    !(this.isType(dmLexer_js_1.TokenType.Keyword) && ['var', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'spawn', 'sleep', 'try', 'catch', 'continue', 'break', 'set'].includes(nextVal))) {
                    returnValue = this.parseExpression();
                }
                statements.push({ type: 'ReturnStatement', returnValue });
                continue;
            }
            if (token.value === 'if') {
                statements.push(this.parseIfStatement());
                continue;
            }
            if (token.value === 'for') {
                const forStmt = this.parseForStatement();
                if (forStmt)
                    statements.push(forStmt);
                continue;
            }
            if (token.value === 'do') {
                statements.push(this.parseDoWhileStatement());
                continue;
            }
            if (token.value === 'while') {
                statements.push(this.parseWhileStatement());
                continue;
            }
            if (token.value === 'sleep' || token.value === 'spawn') {
                statements.push(this.parseSleepSpawnStatement());
                continue;
            }
            // del x / qdel x — the paren form qdel(x, force) is the builtin call
            // (mapped to DMDelete) and must not be swallowed by the statement form.
            if (token.value === 'del' || token.value === 'qdel') {
                if (token.value === 'qdel' && this.peekNext()?.value === '(') {
                    const expr = this.parseExpression();
                    statements.push({ type: 'ExpressionStatement', expression: expr });
                    continue;
                }
                this.advance();
                const target = this.parseExpression();
                statements.push({ type: 'DeleteStatement', target });
                continue;
            }
            // Verb modifiers: set name = value / set hidden / set src in view
            // (verb settings are out of scope; parse and drop without data loss)
            if (token.value === 'set') {
                this.advance();
                if (this.isType(dmLexer_js_1.TokenType.Identifier) || this.isType(dmLexer_js_1.TokenType.Keyword)) {
                    this.advance();
                }
                if (this.peek().value === 'in') {
                    this.advance();
                    this.parseExpression();
                }
                else if (this.matchOperator('=')) {
                    this.parseExpression();
                }
                continue;
            }
            // switch (x) with BYOND case syntax: if (v1, v2) / else
            if (token.value === 'switch') {
                statements.push(this.parseSwitchStatement());
                continue;
            }
            // Check for var declaration inside proc
            if (token.value === 'var') {
                this.advance();
                let varName = '';
                if (this.isType(dmLexer_js_1.TokenType.TypePath)) {
                    const pathVal = this.advance().value;
                    const lastSlash = pathVal.lastIndexOf('/');
                    varName = lastSlash > 0 ? pathVal.substring(lastSlash + 1) : pathVal.replace(/^\//, '');
                }
                else if (this.isType(dmLexer_js_1.TokenType.Identifier)) {
                    // var/list/x — bare type followed by /name (no leading slash)
                    const next = this.peekNext();
                    if (next && next.type === dmLexer_js_1.TokenType.Operator && next.value === '/') {
                        this.advance(); // type
                        this.advance(); // /
                        if (this.isType(dmLexer_js_1.TokenType.Identifier) || this.isType(dmLexer_js_1.TokenType.Keyword)) {
                            varName = this.advance().value;
                        }
                    }
                    else {
                        varName = this.advance().value;
                    }
                }
                else if (this.isType(dmLexer_js_1.TokenType.Keyword)) {
                    varName = this.advance().value;
                }
                else if (this.isType(dmLexer_js_1.TokenType.Operator) && this.peek().value === '/' && this.peekNext()?.type === dmLexer_js_1.TokenType.Number) {
                    // var/2 = 2 — a numeric var name, produced when a #define replaced
                    // the name before a type-qualified var (item 56: GrassGenerator.dm).
                    this.advance();
                    varName = this.advance().value;
                }
                // Initialized length: var/list/x[max(1, 0)] — drop the length expr.
                // Empty brackets: var/list/x[] — the list-declaration suffix.
                // Multi-dim: var/grid[a][b] — repeated dims (item 56).
                while (this.isType(dmLexer_js_1.TokenType.Punctuation) && this.peek().value === '[') {
                    this.advance();
                    if (!(this.isType(dmLexer_js_1.TokenType.Punctuation) && this.peek().value === ']')) {
                        this.parseExpression();
                    }
                    this.matchPunctuation(']');
                }
                let varInit;
                if (this.matchOperator('=')) {
                    varInit = this.parseExpression();
                }
                statements.push({ type: 'VarDeclStatement', varName, varInit });
                // DM multi-decl: var/i, ch, len = length(key)
                while (this.matchPunctuation(',')) {
                    let nextName = '';
                    if (this.isType(dmLexer_js_1.TokenType.TypePath)) {
                        const pathVal = this.advance().value;
                        const lastSlash = pathVal.lastIndexOf('/');
                        nextName = lastSlash > 0 ? pathVal.substring(lastSlash + 1) : pathVal.replace(/^\//, '');
                    }
                    else if (this.isType(dmLexer_js_1.TokenType.Identifier) || this.isType(dmLexer_js_1.TokenType.Keyword)) {
                        nextName = this.advance().value;
                    }
                    let nextInit;
                    if (this.matchOperator('=')) {
                        nextInit = this.parseExpression();
                    }
                    statements.push({ type: 'VarDeclStatement', varName: nextName, varInit: nextInit });
                }
                continue;
            }
            // Check for assignment: var = expr
            if (this.isType(dmLexer_js_1.TokenType.Identifier)) {
                const varName = this.peek().value;
                // Look ahead for =
                const next = this.peekNext();
                if (next && next.type === dmLexer_js_1.TokenType.Operator && next.value === '=') {
                    this.advance(); // consume identifier
                    this.advance(); // consume =
                    const assignmentValue = this.parseExpression();
                    statements.push({ type: 'AssignmentStatement', assignmentTarget: varName, assignmentValue });
                    continue;
                }
            }
            // Check for property assignment: obj.var = expr
            if (this.isType(dmLexer_js_1.TokenType.Identifier)) {
                const firstToken = this.peek().value;
                const secondToken = this.peekNext();
                if (secondToken && secondToken.value === '.') {
                    // This is a property access, parse as expression statement
                    const expr = this.parseExpression();
                    statements.push({ type: 'ExpressionStatement', expression: expr });
                    continue;
                }
            }
            // A TypePath naming a declaration (`/obj/x/proc/y`, `/obj/x/verb/y`,
            // anything containing /var/) at statement level is the start of a new
            // top-level declaration — macro-expanded single-line chains continue
            // with the next proc on the same line (item 56).
            if (this.isType(dmLexer_js_1.TokenType.TypePath) &&
                (/\/var\//.test(token.value) || /^(.+)\/(proc|verb)\/([^\/]+)$/.test(token.value))) {
                break;
            }
            // Generic expression statement
            const expr = this.parseExpression();
            statements.push({ type: 'ExpressionStatement', expression: expr });
        }
        if (this.isType(dmLexer_js_1.TokenType.Dedent)) {
            this.advance();
        }
        return statements;
    }
    /**
     * Parse the body of a control-flow statement: a { } block, an indented
     * block, a single-line body (if (x) return 5), or nothing at all. A
     * newline-delimited statement on the following line is NOT the body — DM
     * ends the statement at the newline.
     */
    parseLoopBody() {
        const parseBlock = () => {
            if (this.isType(dmLexer_js_1.TokenType.Punctuation) && this.peek().value === '{') {
                this.advance();
                const body = this.parseProcBody(true);
                this.matchPunctuation('}');
                return body;
            }
            if (this.isType(dmLexer_js_1.TokenType.Indent)) {
                this.advance();
                return this.parseProcBody();
            }
            return [];
        };
        if (this.isType(dmLexer_js_1.TokenType.Newline) || this.isType(dmLexer_js_1.TokenType.Dedent) || this.isType(dmLexer_js_1.TokenType.EOF)) {
            this.skipNewlines();
            return parseBlock();
        }
        if (this.isType(dmLexer_js_1.TokenType.Punctuation) && this.peek().value === '{') {
            return parseBlock();
        }
        if (this.isType(dmLexer_js_1.TokenType.Indent)) {
            return parseBlock();
        }
        // Empty-statement body: for(...); / while(x); — the ';' is a no-op
        // (item 56).
        if (this.isType(dmLexer_js_1.TokenType.Punctuation) && this.peek().value === ';') {
            this.advance();
            return [];
        }
        return [this.parseSingleStatement()];
    }
    parseWhileStatement() {
        this.advance(); // while
        const condition = this.parseExpression();
        const loopBody = this.parseLoopBody();
        return { type: 'WhileStatement', condition, loopBody };
    }
    parseDoWhileStatement() {
        this.advance(); // do
        const loopBody = this.parseLoopBody();
        this.skipNewlines();
        if (this.peek().value === 'while') {
            this.advance();
            const condition = this.parseExpression();
            return { type: 'DoWhileStatement', condition, loopBody };
        }
        const bad = this.peek();
        this.diagnostics.error(`Expected 'while (condition)' after 'do' block, found '${bad.value}'`, bad.line, bad.column);
        return { type: 'DoWhileStatement', condition: undefined, loopBody };
    }
    parseSleepSpawnStatement() {
        const kind = this.advance().value; // sleep / spawn
        let timeExpr;
        if (this.matchPunctuation('(')) {
            // Empty args: spawn() — the body runs immediately (item 56).
            if (!(this.isType(dmLexer_js_1.TokenType.Punctuation) && this.peek().value === ')')) {
                timeExpr = this.parseExpression();
            }
            this.matchPunctuation(')');
        }
        let body = [];
        if (kind === 'spawn') {
            this.skipNewlines();
            if (this.isType(dmLexer_js_1.TokenType.Punctuation) && this.peek().value === '{') {
                this.advance();
                body = this.parseProcBody(true);
                this.matchPunctuation('}');
            }
            else if (this.isType(dmLexer_js_1.TokenType.Indent)) {
                this.advance();
                body = this.parseProcBody();
            }
            else if (!this.isType(dmLexer_js_1.TokenType.Newline) && !this.isType(dmLexer_js_1.TokenType.Dedent) && !this.isType(dmLexer_js_1.TokenType.EOF)) {
                // spawn(5) foo() — single-line spawn body
                body = [this.parseSingleStatement()];
            }
        }
        return { type: kind === 'sleep' ? 'SleepStatement' : 'SpawnStatement', timeExpr, body };
    }
    parseForStatement() {
        this.advance();
        this.matchPunctuation('(');
        let loopVar = '';
        let loopVarType = '';
        if (this.isType(dmLexer_js_1.TokenType.Identifier)) {
            loopVar = this.advance().value;
        }
        else if (this.peek().value === 'var') {
            // for(var/i in list) or for(var i in list)
            this.advance();
            if (this.isType(dmLexer_js_1.TokenType.TypePath)) {
                const pathVal = this.advance().value;
                const lastSlash = pathVal.lastIndexOf('/');
                // The type is everything but the final /name segment: /mob/M -> /mob.
                loopVarType = lastSlash > 0 ? pathVal.substring(0, lastSlash) : '';
                loopVar = lastSlash > 0 ? pathVal.substring(lastSlash + 1) : pathVal.replace(/^\//, '');
            }
            else if (this.isType(dmLexer_js_1.TokenType.Identifier)) {
                loopVar = this.advance().value;
            }
            else if (this.isType(dmLexer_js_1.TokenType.Keyword)) {
                // for(var/turf in turfs) — type keyword used as the loop variable name
                loopVar = this.advance().value;
            }
            else if (this.isType(dmLexer_js_1.TokenType.Operator) && this.peek().value === '/') {
                this.advance();
                if (this.isType(dmLexer_js_1.TokenType.Identifier) || this.isType(dmLexer_js_1.TokenType.Keyword)) {
                    loopVar = this.advance().value;
                }
                else if (this.isType(dmLexer_js_1.TokenType.Punctuation) && this.peek().value === '(') {
                    // The loop-var name was macro-expanded into a parenthesized
                    // expression (define collision: APC → (MACHINERY + 1)) — consume
                    // the balanced parens so the loop head survives
                    // (item 56: paradise ai_life.dm).
                    let depth = 0;
                    while (!this.isType(dmLexer_js_1.TokenType.EOF)) {
                        if (this.matchPunctuation('('))
                            depth++;
                        else if (this.matchPunctuation(')')) {
                            depth--;
                            if (depth === 0)
                                break;
                        }
                        else {
                            this.advance();
                        }
                    }
                    loopVar = '(expanded)';
                }
            }
            if (!loopVar && this.isType(dmLexer_js_1.TokenType.Punctuation) && this.peek().value === '(') {
                // Type-qualified var whose name was macro-expanded away
                // (var/obj/machinery/power/apc/(((1)+1)+1)+1) in ...) — consume the
                // balanced parens as the loop var (item 56: paradise ai_life.dm).
                let depth = 0;
                while (!this.isType(dmLexer_js_1.TokenType.EOF)) {
                    if (this.matchPunctuation('('))
                        depth++;
                    else if (this.matchPunctuation(')')) {
                        depth--;
                        if (depth === 0)
                            break;
                    }
                    else {
                        this.advance();
                    }
                }
                loopVar = '(expanded)';
            }
        }
        this.skipNewlines();
        // DM multi-var loop: for(var/gas_path, amount in gasmix.moles) — the
        // ', X' groups are only loop variables when the head contains a
        // top-level 'in'; otherwise the ',' starts a C-style for with a bare
        // expression init: for(words, words > 0, words--).
        if (this.peek().value === ',' && this.isMultiVarLoopHead()) {
            while (this.matchPunctuation(',')) {
                if (this.isType(dmLexer_js_1.TokenType.TypePath)) {
                    this.advance();
                }
                else if (this.isType(dmLexer_js_1.TokenType.Identifier) || this.isType(dmLexer_js_1.TokenType.Keyword)) {
                    this.advance();
                }
            }
        }
        // for(var/x as anything in list) — 'as' filter clause. A concrete type
        // (for(var/x as /mob in list)) is preserved as the loop filter.
        if (this.peek().value === 'as') {
            this.advance();
            if (this.isType(dmLexer_js_1.TokenType.TypePath)) {
                if (!loopVarType)
                    loopVarType = this.advance().value;
            }
            while (!this.isType(dmLexer_js_1.TokenType.EOF) && this.peek().value !== 'in') {
                this.advance();
            }
        }
        if (this.peek().value === 'in') {
            this.advance();
            const loopRange = this.parseExpression();
            let step;
            if (this.peek().value === 'step') {
                this.advance();
                step = this.parseExpression();
            }
            this.matchPunctuation(')');
            const loopBody = this.parseLoopBody();
            return { type: 'ForStatement', loopVariable: loopVar, loopVariableType: loopVarType, loopRange, step, loopBody };
        }
        if (loopVar && this.matchPunctuation(')')) {
            // for(var/datum/thing) — iterate all instances of the declared type
            const loopBody = this.parseLoopBody();
            return { type: 'ForStatement', loopVariable: loopVar, loopRange: undefined, step: undefined, loopBody };
        }
        if (loopVar && this.matchOperator('=')) {
            // DM C-style for: for(var/i = init, cond, incr)
            const init = this.parseExpression();
            if (init.type === 'binary' && init.operator === 'to') {
                // Classic DM form: for(var/i = 1 to 5)
                let step;
                if (this.peek().value === 'step') {
                    this.advance();
                    step = this.parseExpression();
                }
                this.matchPunctuation(')');
                const loopBody = this.parseLoopBody();
                const loopRange = { type: 'range', start: init.left, end: init.right };
                return { type: 'ForStatement', loopVariable: loopVar, loopRange, step, loopBody };
            }
            if (this.matchPunctuation(',') || this.matchPunctuation(';')) {
                const condition = this.parseExpression();
                // 2-clause form: for(var/i = init, cond) — the increment is optional
                // (item 56).
                this.matchPunctuation(',') || this.matchPunctuation(';');
                let increment;
                if (!(this.isType(dmLexer_js_1.TokenType.Punctuation) && this.peek().value === ')')) {
                    increment = this.parseExpression();
                }
                this.matchPunctuation(')');
                const loopBody = this.parseLoopBody();
                return { type: 'CForStatement', loopVariable: loopVar, init, condition, increment, loopBody };
            }
        }
        // C-style for with a bare expression init: for(words, words>0, words--)
        // — the first expression was already consumed as loopVar; the ';' form
        // has an empty init; compound-assign inits (for(i += x, ...)) parse
        // the whole init as an expression.
        if (this.peek().value === ',' || this.peek().value === ';' ||
            this.peek().value === '++' || this.peek().value === '--' ||
            this.peek().value === '+=' || this.peek().value === '-=' || this.peek().value === '*=' || this.peek().value === '/=' ||
            this.peek().value === '%=' || this.peek().value === '&=' || this.peek().value === '|=' || this.peek().value === '^=') {
            let init;
            if (this.peek().value === ',' || this.peek().value === ';') {
                if (loopVar) {
                    init = { type: 'variable', name: loopVar };
                }
                if (this.peek().value === ',')
                    this.advance();
                else
                    this.advance(); // ';'
            }
            else if (loopVar && (this.peek().value === '++' || this.peek().value === '--')) {
                // for(i++, cond, incr) — the init is a postfix increment on the
                // bare loop var (item 56).
                const op = this.advance().value;
                init = this.buildPostfixIncrement({ type: 'variable', name: loopVar }, op);
                this.matchPunctuation(',') || this.matchPunctuation(';');
            }
            else if (loopVar) {
                // for(i += 1, cond, incr) — loopVar already holds the bare loop var;
                // rebuild the compound assignment from it.
                const op = this.advance().value;
                const right = this.parseExpression(1);
                init = {
                    type: 'assignment',
                    target: loopVar,
                    value: {
                        type: 'binary',
                        operator: op.slice(0, -1),
                        left: { type: 'variable', name: loopVar },
                        right,
                    },
                };
                this.matchPunctuation(',') || this.matchPunctuation(';');
            }
            else {
                init = this.parseExpression();
            }
            const condition = this.parseExpression();
            this.matchPunctuation(',') || this.matchPunctuation(';');
            // 2-clause form: for(expr, cond) — the increment is optional (item 56).
            let increment;
            if (!(this.isType(dmLexer_js_1.TokenType.Punctuation) && this.peek().value === ')')) {
                increment = this.parseExpression();
            }
            this.matchPunctuation(')');
            const loopBody = this.parseLoopBody();
            return { type: 'CForStatement', loopVariable: loopVar, init, condition, increment, loopBody };
        }
        return null;
    }
    parseSwitchStatement() {
        this.advance();
        const switchValue = this.parseExpression();
        this.skipNewlines();
        const cases = [];
        let defaultBody;
        // Brace form: switch(x) { if(1) {...} else {...} } — the '{' may sit
        // on its own indented line (macro-expanded switch bodies).
        let braceForm = this.isType(dmLexer_js_1.TokenType.Punctuation) && this.peek().value === '{';
        // Indents this handler consumed; the matching Dedents are drained at
        // the end so enclosing scopes still see their own Dedent.
        let pendingIndents = 0;
        if (this.isType(dmLexer_js_1.TokenType.Indent) || braceForm) {
            if (this.isType(dmLexer_js_1.TokenType.Indent)) {
                this.advance(); // block Indent
                pendingIndents += 1;
            }
            if (this.isType(dmLexer_js_1.TokenType.Punctuation) && this.peek().value === '{') {
                this.advance();
                braceForm = true;
            }
            while (true) {
                if (this.isType(dmLexer_js_1.TokenType.EOF))
                    break;
                if (!braceForm && this.isType(dmLexer_js_1.TokenType.Dedent))
                    break;
                if (braceForm && this.isType(dmLexer_js_1.TokenType.Punctuation) && this.peek().value === '}')
                    break;
                this.skipNewlines();
                if (braceForm && this.isType(dmLexer_js_1.TokenType.Indent)) {
                    this.advance(); // indentation is irrelevant inside { } switch blocks
                    pendingIndents += 1;
                }
                if (this.isType(dmLexer_js_1.TokenType.Dedent) || this.isType(dmLexer_js_1.TokenType.EOF))
                    break;
                if (braceForm && this.isType(dmLexer_js_1.TokenType.Punctuation) && this.peek().value === '}')
                    break;
                if (this.peek().value === 'if') {
                    this.advance();
                    this.matchPunctuation('(');
                    const values = [];
                    while (!this.matchPunctuation(')') && !this.isType(dmLexer_js_1.TokenType.EOF)) {
                        values.push(this.parseExpression());
                        if (this.matchPunctuation(','))
                            continue;
                    }
                    this.skipNewlines();
                    let body = [];
                    if (this.isType(dmLexer_js_1.TokenType.Indent)) {
                        this.advance();
                        // parseProcBody drains its own first Dedent (back to the case
                        // level); further Dedents (switch end, enclosing scopes) are
                        // left for the break-check / end handling below.
                        body = this.parseProcBody();
                    }
                    else if (this.isType(dmLexer_js_1.TokenType.Punctuation) && this.peek().value === '{') {
                        this.advance();
                        body = this.parseProcBody(true);
                        this.matchPunctuation('}');
                    }
                    else if (!braceForm && !this.isType(dmLexer_js_1.TokenType.Dedent) && !this.isType(dmLexer_js_1.TokenType.EOF) && !this.isType(dmLexer_js_1.TokenType.Newline) &&
                        this.peek().value !== 'if' && this.peek().value !== 'else') {
                        // Single-line body — but `if`/`else` at case level are the NEXT
                        // case clause, not a body: `if (A)` with a comment-only body is
                        // followed by `if (B) ...` / `else ...` (item 56: zcopy.dm,
                        // item_attack.dm).
                        body = [this.parseSingleStatement()];
                    }
                    else if (braceForm && !this.isType(dmLexer_js_1.TokenType.Newline) && !this.isType(dmLexer_js_1.TokenType.EOF) && !(this.isType(dmLexer_js_1.TokenType.Punctuation) && this.peek().value === '}') &&
                        this.peek().value !== 'if' && this.peek().value !== 'else') {
                        body = [this.parseSingleStatement()];
                    }
                    cases.push({ values, body });
                    this.skipNewlines();
                    if (!braceForm && !this.isType(dmLexer_js_1.TokenType.EOF) && this.peek().value !== 'if' && this.peek().value !== 'else')
                        break;
                }
                else if (this.peek().value === 'else') {
                    this.advance();
                    this.skipNewlines();
                    if (this.isType(dmLexer_js_1.TokenType.Indent)) {
                        this.advance();
                        defaultBody = this.parseProcBody();
                    }
                    else if (this.isType(dmLexer_js_1.TokenType.Punctuation) && this.peek().value === '{') {
                        this.advance();
                        defaultBody = this.parseProcBody(true);
                        this.matchPunctuation('}');
                    }
                    else if (!braceForm && !this.isType(dmLexer_js_1.TokenType.Dedent) && !this.isType(dmLexer_js_1.TokenType.EOF) && !this.isType(dmLexer_js_1.TokenType.Newline) &&
                        this.peek().value !== 'if' && this.peek().value !== 'else') {
                        defaultBody = [this.parseSingleStatement()];
                    }
                    else if (braceForm && !this.isType(dmLexer_js_1.TokenType.Newline) && !this.isType(dmLexer_js_1.TokenType.EOF) && !(this.isType(dmLexer_js_1.TokenType.Punctuation) && this.peek().value === '}') &&
                        this.peek().value !== 'if' && this.peek().value !== 'else') {
                        defaultBody = [this.parseSingleStatement()];
                    }
                    if (!braceForm && !this.isType(dmLexer_js_1.TokenType.EOF) && this.peek().value !== 'if' && this.peek().value !== 'else')
                        break;
                }
                else {
                    const bad = this.advance();
                    this.diagnostics.error(`Unexpected token '${bad.value}' in switch block`, bad.line, bad.column);
                }
            }
            if (braceForm) {
                // Inside braces, Dedents are cosmetic — skip them, then the '}'.
                while (this.isType(dmLexer_js_1.TokenType.Dedent)) {
                    this.advance();
                    pendingIndents -= 1;
                }
                if (this.isType(dmLexer_js_1.TokenType.Punctuation) && this.peek().value === '}') {
                    this.advance();
                }
                // The '}' may sit deeper than the switch itself (indented '{');
                // drain the Dedents back to the switch's own level.
                while (pendingIndents > 0) {
                    this.skipNewlines();
                    if (!this.isType(dmLexer_js_1.TokenType.Dedent))
                        break;
                    this.advance();
                    pendingIndents -= 1;
                }
            }
            else {
                this.skipNewlines();
                // Return from the case level to the switch's own level; the
                // enclosing scope's Dedent is left for the enclosing parse loop.
                if (pendingIndents > 0 && this.isType(dmLexer_js_1.TokenType.Dedent)) {
                    this.advance();
                    pendingIndents -= 1;
                }
            }
        }
        return { type: 'SwitchStatement', switchValue, cases, defaultBody };
    }
    parseSingleStatement() {
        const token = this.peek();
        if (token.value === 'var') {
            this.advance();
            let varName = '';
            if (this.isType(dmLexer_js_1.TokenType.TypePath)) {
                const pathVal = this.advance().value;
                const lastSlash = pathVal.lastIndexOf('/');
                varName = lastSlash > 0 ? pathVal.substring(lastSlash + 1) : pathVal.replace(/^\//, '');
            }
            else if (this.isType(dmLexer_js_1.TokenType.Identifier)) {
                const next = this.peekNext();
                if (next && next.type === dmLexer_js_1.TokenType.Operator && next.value === '/') {
                    this.advance();
                    this.advance();
                    if (this.isType(dmLexer_js_1.TokenType.Identifier) || this.isType(dmLexer_js_1.TokenType.Keyword)) {
                        varName = this.advance().value;
                    }
                }
                else {
                    varName = this.advance().value;
                }
            }
            else if (this.isType(dmLexer_js_1.TokenType.Keyword)) {
                varName = this.advance().value;
            }
            else if (this.isType(dmLexer_js_1.TokenType.Operator) && this.peek().value === '/' && this.peekNext()?.type === dmLexer_js_1.TokenType.Number) {
                // var/2 = 2 — a numeric var name, produced when a #define replaced
                // the name before a type-qualified var (item 56: GrassGenerator.dm).
                this.advance();
                varName = this.advance().value;
            }
            let varInit;
            if (this.matchOperator('=')) {
                varInit = this.parseExpression();
            }
            // Multi-dimensional var: var/grid[a][b] — consume the index dims
            // (item 56). The dims are kept as an array of expressions.
            const dims = [];
            while (this.matchPunctuation('[')) {
                dims.push(this.parseExpression());
                this.matchPunctuation(']');
            }
            if (dims.length > 0) {
                return { type: 'VarDeclStatement', varName, varInit, dims };
            }
            return { type: 'VarDeclStatement', varName, varInit };
        }
        if (token.value === 'return') {
            this.advance();
            let returnValue;
            const nextVal = this.peek().value;
            if (!this.isType(dmLexer_js_1.TokenType.Newline) && !this.isType(dmLexer_js_1.TokenType.Dedent) && !this.isType(dmLexer_js_1.TokenType.EOF) && nextVal !== ';' && nextVal !== '}' &&
                !(this.isType(dmLexer_js_1.TokenType.Keyword) && ['var', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'spawn', 'sleep', 'try', 'catch', 'continue', 'break', 'set'].includes(nextVal))) {
                returnValue = this.parseExpression();
            }
            return { type: 'ReturnStatement', returnValue };
        }
        if (token.value === 'continue' || token.value === 'break') {
            this.advance();
            return { type: token.value === 'continue' ? 'ContinueStatement' : 'BreakStatement' };
        }
        if (token.value === 'if') {
            return this.parseIfStatement();
        }
        // Control-flow statements as single-line bodies (else while(...) x,
        // if (y) for(var/i in list) z) — DM allows any statement here.
        if (token.value === 'while') {
            return this.parseWhileStatement();
        }
        if (token.value === 'do') {
            return this.parseDoWhileStatement();
        }
        if (token.value === 'for') {
            return this.parseForStatement() ?? { type: 'ExpressionStatement', expression: { type: 'literal', value: null, literalType: 'null' } };
        }
        if (token.value === 'sleep' || token.value === 'spawn') {
            return this.parseSleepSpawnStatement();
        }
        if (token.value === 'switch') {
            return this.parseSwitchStatement();
        }
        return { type: 'ExpressionStatement', expression: this.parseExpression() };
    }
    parseIfStatement() {
        this.advance(); // consume 'if'
        const condition = this.parseExpression();
        const thenBranch = this.parseLoopBody();
        let elseBranch;
        this.skipNewlines();
        // Macro-expanded one-line chains produce `if(x) { ... }; else ...` — a
        // stray `;` between the body and `else` is a no-op and must not detach
        // the else from its if.
        if (this.isType(dmLexer_js_1.TokenType.Punctuation) && this.peek().value === ';') {
            this.advance();
            this.skipNewlines();
        }
        if (this.peek().value === 'else') {
            this.advance();
            this.skipNewlines();
            if (this.peek().value === 'if') {
                // else if chain: represent as nested if statement
                elseBranch = [this.parseIfStatement()];
            }
            else if (this.isType(dmLexer_js_1.TokenType.Punctuation) && this.peek().value === '{') {
                this.advance();
                elseBranch = this.parseProcBody(true);
                this.matchPunctuation('}');
            }
            else if (this.isType(dmLexer_js_1.TokenType.Indent)) {
                this.advance();
                elseBranch = this.parseProcBody();
            }
            else if (!this.isType(dmLexer_js_1.TokenType.Newline) && !this.isType(dmLexer_js_1.TokenType.Dedent) && !this.isType(dmLexer_js_1.TokenType.EOF)) {
                // Single-line else body: if (x) a else b
                elseBranch = [this.parseSingleStatement()];
            }
        }
        return { type: 'IfStatement', condition, thenBranch, elseBranch };
    }
    // Expression parser using Pratt parsing / precedence climbing
    parseExpression(minPrec = 0, stopAtColon = false) {
        let left = this.parsePrimary();
        while (true) {
            const token = this.peek();
            if (token.type === dmLexer_js_1.TokenType.EOF || token.type === dmLexer_js_1.TokenType.Newline || token.type === dmLexer_js_1.TokenType.Dedent) {
                break;
            }
            // Statement separators terminate an expression: `;` (inline { } bodies,
            // C-style for) and `}` (brace-form blocks). The postfix arg loop handles
            // `;` itself (weighted pick), so this only fires at top expression level.
            if (token.type === dmLexer_js_1.TokenType.Punctuation && (token.value === ';' || token.value === '}')) {
                break;
            }
            if (stopAtColon && token.value === ':') {
                // Inside a ternary true-branch a ':' is the ternary colon, except when
                // it starts a dynamic access chain: a ? b:c?:d : e (null-conditional
                // after the deref) or a ? b:c : (e) (parenthesized false-branch). A
                // plain deref (b:c : d) is token-identical to a nested-ternary
                // true-branch (a ? b ? c : d : e), which wins in corpus code (item 56).
                const target = this.peekNext();
                const after = this.tokens[this.pos + 2];
                const afterAfter = this.tokens[this.pos + 3];
                const derefTarget = target &&
                    (target.type === dmLexer_js_1.TokenType.Identifier ||
                        (target.type === dmLexer_js_1.TokenType.Keyword && target.value === 'step'));
                if (!derefTarget || left.type !== 'variable')
                    break;
                // b:c?:d or b:c : (e) — the ':' starts a dynamic access chain; fall
                // through to the ':' handler below (the token must be consumed). A
                // '? ' with a non-':' after (a ? b : c ? c : d) is the ternary colon.
                const nullCond = after && after.value === '?' && afterAfter && afterAfter.value === ':';
                const parenFalse = after && after.value === ':' && afterAfter && afterAfter.value === '(';
                if (!(nullCond || parenFalse))
                    break;
            }
            const op = token.value;
            // x/type — a TypePath token directly after a complete expression is
            // division by one or more identifiers (the lexer merges a/b into
            // a + TypePath(/b) when no whitespace separates them). Treat each path
            // segment as a variable: a/b/c -> (a / b) / c. Real type constants are
            // never used in divisor position without a separating operator.
            if (token.type === dmLexer_js_1.TokenType.TypePath) {
                // A path naming a declaration (`/obj/x/proc/y`, `/verb/`, or any
                // /var/) is the NEXT top-level declaration on a macro-expanded line,
                // not a divisor — leave it for the statement/top-level loops (item 56).
                if (/\/var\//.test(token.value) || /^(.+)\/(proc|verb)\/([^\/]+)$/.test(token.value)) {
                    break;
                }
                this.advance();
                const segments = token.value.split('/').filter((s) => s.length > 0);
                for (const segment of segments) {
                    const right = { type: 'variable', name: segment };
                    left = { type: 'binary', operator: '/', left, right };
                }
                // The division chain may itself carry postfix operators — a call in
                // divisor position (`x / b(...)`) must consume its argument list
                // (WS2-2), otherwise the `(...)` leaks as a ghost statement.
                left = this.parsePostfix(left);
                continue;
            }
            // Postfix increment/decrement: x++ / x-- (also after a unary:
            // !x++ is !(x++) — item 56)
            if ((op === '++' || op === '--') && (left.type === 'unary' && (left.operand.type === 'variable' || left.operand.type === 'property' || left.operand.type === 'index'))) {
                // Re-run the increment on the unary's operand: !x++ == !(x++)
                this.advance();
                const inc = this.buildPostfixIncrement(left.operand, op);
                left = { type: 'unary', operator: left.operator, operand: inc };
                continue;
            }
            if ((op === '++' || op === '--') && (left.type === 'variable' || left.type === 'property' || left.type === 'index')) {
                // x--y is a typo-free way of writing x - -y (a decrement followed by
                // an operand) — when an operand-start follows, treat the '--' as a
                // binary minus with a unary-negated right (item 56:
                // ((L.health--100) / (L.maxHealth - -100))).
                const afterTok = this.peekNext();
                if (afterTok &&
                    (afterTok.type === dmLexer_js_1.TokenType.Number || afterTok.type === dmLexer_js_1.TokenType.Identifier || afterTok.type === dmLexer_js_1.TokenType.Keyword ||
                        (afterTok.type === dmLexer_js_1.TokenType.Punctuation && afterTok.value === '('))) {
                    this.advance();
                    const right = { type: 'unary', operator: op[1], operand: this.parsePrimary() };
                    left = { type: 'binary', operator: op[0], left, right };
                    continue;
                }
                this.advance();
                left = this.buildPostfixIncrement(left, op);
                continue;
            }
            // Compound assignment: x += 1 (DM allows it in expressions, e.g. the
            // increment clause of a C-style for loop).
            if ((op === '+=' || op === '-=' || op === '*=' || op === '/=' || op === '%=' ||
                op === '&=' || op === '|=' || op === '^=' || op === '<<=' || op === '>>=') &&
                (left.type === 'variable' || left.type === 'property' || left.type === 'index')) {
                this.advance();
                const right = this.parseExpression(1);
                const baseOp = op.slice(0, -1);
                const value = { type: 'binary', operator: baseOp, left, right };
                if (left.type === 'variable') {
                    left = { type: 'assignment', target: left.name, value };
                }
                else if (left.type === 'property') {
                    left = { type: 'property_assignment', target: left.target, property: left.property, value };
                }
                else {
                    left = { type: 'index_assignment', target: left.target, index: left.index, value };
                }
                continue;
            }
            const precedence = this.getOperatorPrecedence(op);
            if (precedence < minPrec)
                break;
            // DM range operator: 1..5, a..b (for(x in 1..5) etc.) — but `..`
            // directly after a closing paren is a parent call on the next
            // statement, not a range with a parenthesized RHS: `if (x) ..()`
            // (item 56: new_player.dm). parsePrimary handles a statement-level
            // `..(` as a parent call before the loop ever sees it.
            if (op === '..') {
                const prevTok = this.tokens[this.pos - 1];
                if (prevTok && prevTok.type === dmLexer_js_1.TokenType.Punctuation && prevTok.value === ')') {
                    break;
                }
                this.advance();
                const end = this.parseExpression(precedence + (this.isRightAssociative(op) ? 0 : 1));
                left = { type: 'range', start: left, end };
                continue;
            }
            // Static access: sometype::abstract_type — treated as a property read.
            if (op === '::') {
                this.advance();
                const propToken = this.advance();
                left = { type: 'property', target: left, property: propToken.value };
                // The property may itself carry postfix ops: /type::proc() is a call
                // (item 56 — `Unexpected token ')'` otherwise).
                left = this.parsePostfix(left);
                continue;
            }
            // Dynamic access: found_turf:type — treated as a property read.
            if (op === ':') {
                this.advance();
                const propToken = this.advance();
                left = { type: 'property', target: left, property: propToken.value };
                // The property may itself carry postfix ops: (x):InvokeAsync() is a
                // call (item 56).
                left = this.parsePostfix(left);
                continue;
            }
            // Legacy DM null-conditional access: x?:prop — treated as a property read.
            if (op === '?' && this.peekNext()?.value === ':') {
                this.advance();
                this.advance();
                const propToken = this.advance();
                left = { type: 'property', target: left, property: propToken.value };
                // The property may itself carry postfix ops: x?:y?:z(...) is a call
                // (item 56).
                left = this.parsePostfix(left);
                continue;
            }
            // Index: a::b[1] (parsePostfix handles plain a[1] already)
            if (op === '[') {
                this.advance(); // consume [
                const index = this.parseExpression();
                this.matchPunctuation(']');
                left = { type: 'index', target: left, index };
                continue;
            }
            // Handle right-associative operators
            const nextMinPrec = precedence + (this.isRightAssociative(op) ? 0 : 1);
            this.advance(); // consume operator
            // Special handling for ternary
            if (op === '?') {
                const trueExpr = this.parseExpression(0, true);
                if (!this.matchOperator(':')) {
                    const t = this.peek();
                    this.diagnostics.error("Expected ':' in ternary expression", t.line, t.column);
                }
                const falseExpr = this.parseExpression(0, stopAtColon);
                left = { type: 'ternary', condition: left, trueExpr, falseExpr };
                continue;
            }
            const right = this.parseExpression(nextMinPrec, stopAtColon);
            // Handle assignment specially
            if (op === '=') {
                if (left.type === 'variable' && this.assocArgDepth > 0) {
                    // list(a = 1) — an identifier key is the associative pair "a" = 1
                    // (DM treats the name as text), not an assignment
                    // (item 58: `comp.SetVar("a", ...)` was the old bug).
                    left = { type: 'assoc_pair', key: { type: 'literal', value: left.name, literalType: 'string' }, value: right };
                }
                else if (left.type === 'variable') {
                    left = { type: 'assignment', target: left.name, value: right };
                }
                else if (left.type === 'property') {
                    left = { type: 'property_assignment', target: left.target, property: left.property, value: right };
                }
                else if (left.type === 'index') {
                    left = { type: 'index_assignment', target: left.target, index: left.index, value: right };
                }
                else {
                    // list("a" = 1) — associative key/value pair (only valid inside a
                    // list()/alist() argument list, where the emitter handles it).
                    left = { type: 'assoc_pair', key: left, value: right };
                }
                continue;
            }
            // Handle compound assignment: a += 5  ->  a = a + 5
            if (['+=', '-=', '*=', '/=', '%=', '<<=', '>>=', '&=', '|=', '^=', '||=', '&&='].includes(op)) {
                const baseOp = op.slice(0, -1);
                if (left.type === 'variable') {
                    left = {
                        type: 'assignment',
                        target: left.name,
                        value: { type: 'binary', operator: baseOp, left: { type: 'variable', name: left.name }, right }
                    };
                    continue;
                }
                else if (left.type === 'property') {
                    left = {
                        type: 'property_assignment',
                        target: left.target,
                        property: left.property,
                        value: { type: 'binary', operator: baseOp, left, right }
                    };
                    continue;
                }
                else if (left.type === 'index') {
                    left = {
                        type: 'index_assignment',
                        target: left.target,
                        index: left.index,
                        value: { type: 'binary', operator: baseOp, left, right }
                    };
                    continue;
                }
            }
            left = { type: 'binary', operator: op, left, right };
        }
        return left;
    }
    parsePrimary() {
        const token = this.peek();
        // Parenthesized expression
        if (this.matchPunctuation('(')) {
            const expr = this.parseExpression();
            this.matchPunctuation(')');
            return this.parsePostfix(expr);
        }
        // DM list literal: {1, 2, 3} (also covers {"multi\nline"} string lists)
        if (this.isType(dmLexer_js_1.TokenType.Punctuation) && this.peek().value === '{') {
            this.advance();
            const elements = [];
            let closed = false;
            // {a = 1} — brace-form associative keys (item 58).
            this.assocArgDepth++;
            while (!this.isType(dmLexer_js_1.TokenType.EOF) && !this.isType(dmLexer_js_1.TokenType.Newline) && !this.isType(dmLexer_js_1.TokenType.Dedent)) {
                if (this.isType(dmLexer_js_1.TokenType.Punctuation) && this.peek().value === '}') {
                    this.advance();
                    closed = true;
                    break;
                }
                if (this.isType(dmLexer_js_1.TokenType.Punctuation) && this.peek().value === ',') {
                    this.advance();
                    continue;
                }
                elements.push(this.parseExpression());
            }
            this.assocArgDepth--;
            if (!closed) {
                this.diagnostics.error("Expected '}' to close list literal", this.peek().line, this.peek().column);
            }
            return this.parsePostfix({ type: 'list', elements });
        }
        // String literal (with optional [expr] interpolation)
        if (token.type === dmLexer_js_1.TokenType.StringLiteral) {
            this.advance();
            const parts = this.splitInterpolation(token.value);
            if (parts.length === 1) {
                return { type: 'literal', value: token.value, literalType: 'string' };
            }
            // "a [x] b" — interleave literal text and re-parsed expressions,
            // chained with string concatenation (DMValue.Add concatenates text).
            let node = { type: 'literal', value: '', literalType: 'string' };
            for (const part of parts) {
                let piece;
                if (typeof part === 'string') {
                    piece = { type: 'literal', value: part, literalType: 'string' };
                }
                else {
                    const collector = new diagnostics_js_1.DiagnosticCollector();
                    const expr = this.parseInitializerTextToExpr(part.interp, collector);
                    piece = expr ?? { type: 'literal', value: part.interp, literalType: 'string' };
                }
                node = { type: 'binary', operator: '+', left: node, right: piece };
            }
            return this.parsePostfix(node);
        }
        // File literal
        if (token.type === dmLexer_js_1.TokenType.FileLiteral) {
            this.advance();
            return { type: 'literal', value: token.value, literalType: 'string' };
        }
        // Number literal
        if (token.type === dmLexer_js_1.TokenType.Number) {
            this.advance();
            // Special values (1.#INF etc.) are carried as string markers.
            if (token.value === 'Infinity' || token.value === '-Infinity' || token.value === 'NaN') {
                return { type: 'literal', value: token.value, literalType: 'number' };
            }
            // Float literals (7.0, 1e3, 2.5e+10) keep a flag so the emitter can
            // preserve DM's int-vs-float division semantics (WS8-1).
            const floatLiteral = /[.eE]/.test(token.value);
            return { type: 'literal', value: parseFloat(token.value), literalType: 'number', floatLiteral };
        }
        // TypePath (e.g., /obj/item/sword) — a distinct literal kind: paths are
        // not text (ispath("/obj") = 0, ispath(/obj) = 1 in DM).
        if (token.type === dmLexer_js_1.TokenType.TypePath) {
            this.advance();
            return { type: 'literal', value: token.value, literalType: 'path' };
        }
        // Keywords: null, TRUE, FALSE
        if (token.type === dmLexer_js_1.TokenType.Keyword) {
            if (token.value === 'NULL' || token.value === 'null') {
                this.advance();
                return { type: 'literal', value: null, literalType: 'null' };
            }
            if (token.value === 'TRUE' || token.value === 'true') {
                this.advance();
                return { type: 'literal', value: true, literalType: 'bool' };
            }
            if (token.value === 'FALSE' || token.value === 'false') {
                this.advance();
                return { type: 'literal', value: false, literalType: 'bool' };
            }
            // usr, src, args, and common type keywords used as identifiers
            if (['usr', 'src', 'args', 'global', 'world', 'turf', 'mob', 'obj', 'area', 'datum', 'atom', 'client', 'proc', 'verb', 'icon', 'sound', 'tmp', 'qdel'].includes(token.value)) {
                this.advance();
                return this.parsePostfix({ type: 'variable', name: token.value });
            }
            // Builtin keyword calls: istype(), ispath(), locate(), prob() ...
            if (['istype', 'ispath', 'locate', 'prob', 'step', 'vars', 'sleep', 'spawn', 'del'].includes(token.value)) {
                this.advance();
                return this.parsePostfix({ type: 'variable', name: token.value });
            }
            // new /obj/item(x) or new/obj/item(x)
            if (token.value === 'new') {
                this.advance();
                let typePath = '';
                if (this.isType(dmLexer_js_1.TokenType.TypePath)) {
                    typePath = this.advance().value;
                }
                else if (this.isType(dmLexer_js_1.TokenType.Operator) && this.peek().value === '/') {
                    this.advance();
                    if (this.isType(dmLexer_js_1.TokenType.TypePath)) {
                        typePath = this.advance().value;
                    }
                }
                else if (this.isType(dmLexer_js_1.TokenType.Identifier)) {
                    typePath = '/' + this.advance().value;
                }
                const args = [];
                if (this.matchPunctuation('(')) {
                    let parenIndents = 0;
                    while (!this.matchPunctuation(')') && !this.isType(dmLexer_js_1.TokenType.EOF)) {
                        while (this.isType(dmLexer_js_1.TokenType.Newline) || this.isType(dmLexer_js_1.TokenType.Indent) || this.isType(dmLexer_js_1.TokenType.Dedent)) {
                            if (this.isType(dmLexer_js_1.TokenType.Indent))
                                parenIndents += 1;
                            else if (this.isType(dmLexer_js_1.TokenType.Dedent))
                                parenIndents -= 1;
                            this.advance();
                        }
                        if (this.matchPunctuation(')'))
                            break;
                        // DM allows empty arguments: f(a, , b) passes null (item 56).
                        if (this.isType(dmLexer_js_1.TokenType.Punctuation) && (this.peek().value === ',' || this.peek().value === ')')) {
                            args.push({ type: 'literal', value: null, literalType: 'null' });
                        }
                        else {
                            args.push(this.parseExpression());
                        }
                        if (this.matchPunctuation(','))
                            continue;
                    }
                    while (parenIndents > 0) {
                        this.skipNewlines();
                        if (!this.isType(dmLexer_js_1.TokenType.Dedent))
                            break;
                        this.advance();
                        parenIndents -= 1;
                    }
                }
                return this.parsePostfix({ type: 'new', typePath, arguments: args });
            }
        }
        // Identifier or proc call
        if (token.type === dmLexer_js_1.TokenType.Identifier) {
            const name = this.advance().value;
            return this.parsePostfix({ type: 'variable', name });
        }
        // Unary operators (and prefix ++/--, rewritten as assignment)
        if (token.type === dmLexer_js_1.TokenType.Operator && ['!', '-', '+', '~', '++', '--'].includes(token.value)) {
            const op = this.advance().value;
            const operand = this.parsePrimary();
            if (op === '++' || op === '--') {
                const one = { type: 'literal', value: 1, literalType: 'number' };
                const baseOp = op === '++' ? '+' : '-';
                const value = { type: 'binary', operator: baseOp, left: operand, right: one };
                if (operand.type === 'variable') {
                    return { type: 'assignment', target: operand.name, value };
                }
                if (operand.type === 'property') {
                    return { type: 'property_assignment', target: operand.target, property: operand.property, value };
                }
            }
            return { type: 'unary', operator: op, operand };
        }
        // Implicit return value: '.' is DM's per-proc return variable
        if (token.type === dmLexer_js_1.TokenType.Operator && token.value === '.') {
            this.advance();
            // .proc/name — path-dot proc reference used by nameof() and PROC_REF()
            if (this.peek().value === 'proc' || this.peek().value === 'verb') {
                const kind = this.advance().value;
                let path = '';
                if (this.isType(dmLexer_js_1.TokenType.TypePath)) {
                    path = this.advance().value;
                }
                return this.parsePostfix({ type: 'literal', value: `.${kind}${path}`, literalType: 'string' });
            }
            return this.parsePostfix({ type: 'variable', name: '.' });
        }
        // Parent call: ..() / ..(args) dispatches to the parent proc
        if (token.type === dmLexer_js_1.TokenType.Operator && token.value === '..') {
            this.advance();
            const args = [];
            if (this.matchPunctuation('(')) {
                while (!this.matchPunctuation(')') && !this.isType(dmLexer_js_1.TokenType.EOF)) {
                    args.push(this.parseExpression());
                    if (this.matchPunctuation(','))
                        continue;
                }
            }
            return this.parsePostfix({ type: 'call', name: '..', arguments: args });
        }
        // Fallback: report and recover (treat as null literal)
        const bad = this.advance();
        this.diagnostics.error(`Unexpected token '${bad.value}' in expression`, bad.line, bad.column);
        return { type: 'literal', value: null, literalType: 'null' };
    }
    // Postfix chain: a.b.c, obj.method(x), arr[i].x, foo().bar
    parsePostfix(node) {
        while (true) {
            // '.' is tokenized as an Operator (not Punctuation), so match by value.
            // '?.' is DM's null-conditional access; treated as plain access (the
            // runtime already returns Null for missing properties).
            if (this.peek().value === '.' || this.peek().value === '?.') {
                const nxt = this.peekNext();
                // Only a property access when an identifier/keyword follows — a bare
                // `.` (the return-value var) or a `.` before an operator starts a NEW
                // statement (item 56: `if(C) . += "</a>"` — the postfix loop must not
                // eat the body's leading dot).
                if (nxt && (nxt.type === dmLexer_js_1.TokenType.Identifier || nxt.type === dmLexer_js_1.TokenType.Keyword)) {
                    this.advance();
                    const propToken = this.peek();
                    this.advance();
                    node = { type: 'property', target: node, property: propToken.value };
                }
                else {
                    break;
                }
            }
            else if (this.matchPunctuation('(')) {
                const args = [];
                // DM text("format [x]", args...): the FORMAT is a literal — BYOND
                // does not interpolate it at parse time (the text() builtin renders
                // the format macros itself, WS9-2). The first argument of a bare
                // text(...) call is kept as a raw string literal.
                const isTextFormat = node.type === 'variable' && node.name === 'text';
                // Inside list()/alist() arguments, `a = 1` is an associative key
                // pair, not an assignment (item 58).
                const isListLiteral = node.type === 'variable' && (node.name === 'list' || node.name === 'alist');
                if (isListLiteral)
                    this.assocArgDepth++;
                let argIndex = 0;
                // Indents introduced by the argument lines; the matching Dedents are
                // drained after the ')' so enclosing scopes still see their own.
                let parenIndents = 0;
                while (!this.matchPunctuation(')') && !this.isType(dmLexer_js_1.TokenType.EOF)) {
                    // DM allows the argument list to span lines (a trailing comma
                    // before the closing paren is also legal); inside parens the
                    // line structure is purely cosmetic.
                    while (this.isType(dmLexer_js_1.TokenType.Newline) || this.isType(dmLexer_js_1.TokenType.Indent) || this.isType(dmLexer_js_1.TokenType.Dedent)) {
                        if (this.isType(dmLexer_js_1.TokenType.Indent))
                            parenIndents += 1;
                        else if (this.isType(dmLexer_js_1.TokenType.Dedent))
                            parenIndents -= 1;
                        this.advance();
                    }
                    if (this.matchPunctuation(')'))
                        break;
                    if (isTextFormat && argIndex === 0 && this.isType(dmLexer_js_1.TokenType.StringLiteral)) {
                        // Raw format string: keep [x] markers verbatim for the runtime.
                        const lit = this.advance();
                        args.push({ type: 'literal', value: lit.value, literalType: 'string' });
                    }
                    else if (this.isType(dmLexer_js_1.TokenType.Punctuation) && (this.peek().value === ',' || this.peek().value === ')')) {
                        // DM allows empty arguments: f(a, , b) passes null (item 56).
                        args.push({ type: 'literal', value: null, literalType: 'null' });
                    }
                    else {
                        args.push(this.parseExpression());
                    }
                    argIndex++;
                    // Weighted pick: pick(20;"brown", 30;"grey") — parse weight;value pairs.
                    if (this.peek().value === ';') {
                        this.advance();
                        args.push(this.parseExpression());
                        argIndex++;
                    }
                    if (this.matchPunctuation(','))
                        continue;
                }
                while (parenIndents > 0) {
                    this.skipNewlines();
                    if (!this.isType(dmLexer_js_1.TokenType.Dedent))
                        break;
                    this.advance();
                    parenIndents -= 1;
                }
                if (node.type === 'variable') {
                    node = { type: 'call', name: node.name, arguments: args };
                }
                else if (node.type === 'property') {
                    // obj.method(x) — the method name is the last property segment and
                    // the receiver is the chain before it. Previously this emitted a
                    // call with an empty name targeting the property lookup itself.
                    node = { type: 'call', name: node.property, target: node.target, arguments: args };
                }
                else {
                    node = { type: 'call', name: '', target: node, arguments: args };
                }
                if (isListLiteral)
                    this.assocArgDepth--;
            }
            else if (this.matchPunctuation('[')) {
                const index = this.parseExpression();
                this.matchPunctuation(']');
                node = { type: 'index', target: node, index };
            }
            else if (this.peek().value === '?' && this.peekNext()?.value === '[') {
                // Null-conditional index: x?[key] — treated as plain indexing.
                this.advance();
                this.advance();
                const index = this.parseExpression();
                this.matchPunctuation(']');
                node = { type: 'index', target: node, index };
            }
            else {
                break;
            }
        }
        return node;
    }
    getOperatorPrecedence(op) {
        // DM operator precedence (loosest to tightest), per the BYOND reference:
        // assignments < ?: < || < && < | < ^ < & < ==/!=/~/in/as < relational <
        // shift < + - < range < * / % < ** < access. The previous table ranked
        // '?' tighter than every binary operator (x == b ? c : d parsed as
        // x == (b ? c : d)) and collapsed & | ^ and << >> into the wrong levels.
        switch (op) {
            case '||': return 2;
            case '&&': return 3;
            case '|': return 4;
            case '^': return 5;
            case '&': return 6;
            case '==':
            case '!=':
            case '~=':
            case '~!':
            case 'as':
            case 'to': return 7;
            case '<':
            case '<=':
            case '>':
            case '>=': return 8;
            case '<<':
            case '>>': return 9;
            case '+':
            case '-': return 10;
            case '..': return 11; // range literal (1..5)
            case '*':
            case '/':
            case '%':
            case '%%': return 12;
            case '**': return 13; // power binds tighter than * /
            case '::':
            case ':':
            case '[': return 14; // static / dynamic member access, index
            case '?': return 1; // ternary — looser than || (a || b ? c : d)
            // `in` has the LOWEST precedence of all operators in BYOND — looser
            // than assignment, so `has_thing = thing in src` parses as
            // `(has_thing = thing) in src` (BYOND ref, `in` operator).
            case 'in': return 0;
            case '=':
            case '+=':
            case '-=':
            case '*=':
            case '/=':
            case '%=':
            case '<<=':
            case '>>=':
            case '&=':
            case '|=':
            case '^=':
            case '||=':
            case '&&=': return 0; // lowest (right-associative)
            default: return -1;
        }
    }
    isRightAssociative(op) {
        return ['=', '?', '+=', '-=', '*=', '/=', '%=', '<<=', '>>=', '&=', '|=', '^=', '||=', '&&='].includes(op);
    }
    // x++ / x-- rewritten as an assignment: x = x + 1 (or the property /
    // index form). Shared by the expression loop and the unary wrapper.
    buildPostfixIncrement(left, op) {
        const one = { type: 'literal', value: 1, literalType: 'number' };
        const baseOp = op === '++' ? '+' : '-';
        if (left.type === 'variable') {
            return {
                type: 'assignment',
                target: left.name,
                value: { type: 'binary', operator: baseOp, left: { type: 'variable', name: left.name }, right: one }
            };
        }
        if (left.type === 'property') {
            return {
                type: 'property_assignment',
                target: left.target,
                property: left.property,
                value: { type: 'binary', operator: baseOp, left, right: one }
            };
        }
        return {
            type: 'index_assignment',
            target: left.target,
            index: left.index,
            value: { type: 'binary', operator: baseOp, left, right: one }
        };
    }
    getOrCreateTypeNode(path, map) {
        if (!map.has(path)) {
            map.set(path, {
                type: 'DMTypeDecl',
                path,
                vars: [],
                procs: []
            });
        }
        return map.get(path);
    }
    peek() {
        return this.pos < this.tokens.length ? this.tokens[this.pos] : { type: dmLexer_js_1.TokenType.EOF, value: '', line: 0, column: 0 };
    }
    peekNext() {
        return this.pos + 1 < this.tokens.length ? this.tokens[this.pos + 1] : null;
    }
    // Lookahead: is the current for-head the multi-var form? True when a
    // top-level 'in' keyword appears before the closing ')' of the head
    // (e.g. for(var/gas_path, amount in gasmix.moles) is multi-var, while
    // for(words, words > 0, words--) is a C-style loop with a bare init).
    isMultiVarLoopHead() {
        let depth = 0;
        for (let i = this.pos; i < this.tokens.length; i++) {
            const t = this.tokens[i];
            if (t.type === dmLexer_js_1.TokenType.Punctuation) {
                if (t.value === '(')
                    depth++;
                else if (t.value === ')') {
                    if (depth === 0)
                        return false;
                    depth--;
                }
            }
            else if (t.type === dmLexer_js_1.TokenType.Keyword && t.value === 'in' && depth === 0) {
                return true;
            }
        }
        return false;
    }
    advance() {
        return this.tokens[this.pos++];
    }
    isType(type) {
        return this.peek().type === type;
    }
    matchOperator(op) {
        if (this.peek().type === dmLexer_js_1.TokenType.Operator && this.peek().value === op) {
            this.advance();
            return true;
        }
        return false;
    }
    matchPunctuation(p) {
        if (this.peek().type === dmLexer_js_1.TokenType.Punctuation && this.peek().value === p) {
            this.advance();
            return true;
        }
        return false;
    }
    skipNewlines() {
        while (this.isType(dmLexer_js_1.TokenType.Newline)) {
            this.advance();
        }
    }
}
exports.DMParser = DMParser;
