"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.DMPreprocessor = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const MAX_MACRO_EXPANSION_DEPTH = 30;
// Total expansion budget per file: bounds exponential blow-ups that the depth
// cap alone cannot stop (#define A B B + #define B A A → 2^depth sites).
const MAX_MACRO_EXPANSION_WORK = 200000;
class DMPreprocessor {
    defines = new Map();
    functionDefines = new Map();
    collector;
    blockCommentState = { inBlockComment: false };
    // BYOND includes each file at most once per compilation; `#pragma multiple`
    // opts back into re-inclusion.
    includedFiles = new Set();
    allowMultipleIncludes = false;
    macroExpansionBudget = MAX_MACRO_EXPANSION_WORK;
    constructor(collector, seedDefines = undefined, seedFunctionDefines = undefined) {
        this.collector = collector;
        if (seedDefines) {
            for (const [name, value] of seedDefines) {
                if (!this.defines.has(name)) {
                    this.defines.set(name, value);
                }
            }
        }
        if (seedFunctionDefines) {
            for (const [name, macro] of seedFunctionDefines) {
                if (!this.functionDefines.has(name)) {
                    this.functionDefines.set(name, macro);
                }
            }
        }
    }
    process(code, filePath) {
        this.blockCommentState.inBlockComment = false;
        return this.processText(code, path.dirname(path.resolve(filePath)));
    }
    processFile(filePath) {
        const code = fs.readFileSync(filePath, 'utf-8');
        return this.process(code, filePath);
    }
    processText(code, dir) {
        // Strip CRLF line endings: splitting on '\n' leaves a trailing '\r' on
        // every line, which corrupts #define bodies and string literals.
        const joined = this.joinParenBlocks(this.joinContinuations(code.split('\n').map(l => (l.endsWith('\r') ? l.slice(0, -1) : l))));
        const lines = joined;
        const out = [];
        const condStack = [];
        const isActive = () => condStack.length === 0 || condStack[condStack.length - 1].active;
        for (let i = 0; i < lines.length; i++) {
            const raw = lines[i];
            const trimmed = raw.trim();
            const startsInComment = this.blockCommentState.inBlockComment;
            if (!startsInComment && trimmed.startsWith('#')) {
                const dirLine = DMPreprocessor.stripInlineComment(trimmed);
                const m = dirLine.match(/^#(\w+)(.*)$/);
                const name = m ? m[1] : '';
                const arg = (m ? m[2] : '').trim();
                switch (name) {
                    case 'if':
                    case 'ifdef':
                    case 'ifndef': {
                        const value = name === 'ifdef' ? this.defines.has(arg) || this.functionDefines.has(arg)
                            : name === 'ifndef' ? !this.defines.has(arg) && !this.functionDefines.has(arg)
                                : this.evalIf(arg);
                        const parentActive = isActive();
                        condStack.push({ parentActive, branchTaken: parentActive && value, active: parentActive && value });
                        break;
                    }
                    case 'elif': {
                        const frame = condStack[condStack.length - 1];
                        if (!frame) {
                            this.collector.error('#elif without matching #if', i + 1, 1);
                            break;
                        }
                        if (!frame.parentActive)
                            break;
                        if (frame.branchTaken) {
                            frame.active = false;
                        }
                        else {
                            const value = this.evalIf(arg);
                            frame.active = value;
                            if (value)
                                frame.branchTaken = true;
                        }
                        break;
                    }
                    case 'else': {
                        const frame = condStack[condStack.length - 1];
                        if (!frame) {
                            this.collector.error('#else without matching #if', i + 1, 1);
                            break;
                        }
                        if (!frame.parentActive)
                            break;
                        if (frame.branchTaken) {
                            frame.active = false;
                        }
                        else {
                            frame.active = true;
                            frame.branchTaken = true;
                        }
                        break;
                    }
                    case 'endif': {
                        condStack.pop();
                        break;
                    }
                    case 'define': {
                        if (!isActive())
                            break;
                        const dm = arg.match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\((.*?)\))?\s*(.*)$/);
                        if (!dm)
                            break;
                        // Multi-line bodies: keep absorbing lines until strings are
                        // balanced and parens/brackets/braces close.
                        let body = dm[3];
                        while (i + 1 < lines.length && !DMPreprocessor.isBalancedDefineBody(body)) {
                            body += '\n' + lines[++i];
                        }
                        const bodyClean = DMPreprocessor.stripInlineComment(body).trim();
                        if (dm[2] !== undefined) {
                            // Function-like macro: #define NAME(a, b) body
                            const params = this.splitArgs(dm[2]).map(p => p.trim()).filter(p => p.length > 0);
                            let variadic = false;
                            const cleanParams = [];
                            for (const p of params) {
                                if (p === '...') {
                                    variadic = true;
                                }
                                else if (p.endsWith('...')) {
                                    // Named variadic: #define FOO(focus...) — name is focus.
                                    variadic = true;
                                    cleanParams.push(p.slice(0, -3));
                                }
                                else {
                                    cleanParams.push(p);
                                }
                            }
                            this.functionDefines.set(dm[1], { params: cleanParams, variadic, body: bodyClean });
                            break;
                        }
                        this.defines.set(dm[1], bodyClean);
                        break;
                    }
                    case 'undef': {
                        if (!isActive())
                            break;
                        this.defines.delete(arg);
                        this.functionDefines.delete(arg);
                        break;
                    }
                    case 'include': {
                        if (!isActive())
                            break;
                        const im = arg.match(/^["<]([^">]+)[">]$/);
                        if (!im) {
                            this.collector.error('Malformed #include directive', i + 1, 1);
                            break;
                        }
                        const incPath = path.resolve(dir, im[1].replace(/\\/g, '/'));
                        if (!fs.existsSync(incPath)) {
                            this.collector.error(`#include file not found: '${im[1]}'`, i + 1, 1);
                            break;
                        }
                        // Only DM sources are inlined. Map data (.dmm) and other assets
                        // (.txt/.html/.json/...) are not DM syntax; inlining them produces
                        // cascading parse errors (map keys like "aaa" at top level).
                        const incExt = path.extname(incPath).toLowerCase();
                        if (incExt !== '.dm' && incExt !== '.dme' && incExt !== '') {
                            break;
                        }
                        // BYOND include-once: the first occurrence of a file is processed,
                        // repeats are skipped unless `#pragma multiple` is in effect.
                        if (this.includedFiles.has(incPath) && !this.allowMultipleIncludes) {
                            break;
                        }
                        this.includedFiles.add(incPath);
                        const incCode = this.processFile(incPath);
                        if (incCode.length > 0) {
                            out.push(incCode);
                        }
                        break;
                    }
                    case 'warn': {
                        if (isActive())
                            this.collector.warning(`#warn: ${arg}`, i + 1, 1);
                        break;
                    }
                    case 'error': {
                        if (isActive())
                            this.collector.error(`#error: ${arg}`, i + 1, 1);
                        break;
                    }
                    case 'pragma': {
                        if (!isActive())
                            break;
                        if (arg === 'once') {
                            // Include-once is BYOND's default behavior — no-op.
                            break;
                        }
                        if (arg === 'multiple') {
                            this.allowMultipleIncludes = true;
                            break;
                        }
                        this.collector.warning(`Unsupported #pragma '${arg}' ignored`, i + 1, 1);
                        break;
                    }
                    default: {
                        if (name && isActive()) {
                            this.collector.warning(`Unknown preprocessor directive '#${name}' ignored`, i + 1, 1);
                        }
                    }
                }
                // Directives skip expandMacros, so advance the block-comment state
                // here for comment markers inside the directive text.
                if (isActive()) {
                    this.updateBlockCommentState(raw);
                }
                continue;
            }
            if (isActive()) {
                out.push(this.expandMacros(raw, 0, this.blockCommentState));
            }
        }
        if (condStack.length > 0) {
            this.collector.error('Unterminated #if/#ifdef block (missing #endif)', 1, 1);
        }
        return out.join('\n');
    }
    // Join backslash-continued lines so multi-line #define bodies are treated as
    // a single logical line.
    joinContinuations(lines) {
        const out = [];
        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];
            let lastChar = line.trimEnd().slice(-1);
            while (lastChar === '\\' && i + 1 < lines.length) {
                line = line.slice(0, line.trimEnd().length - 1) + ' ' + lines[++i].trimStart();
                lastChar = line.trimEnd().slice(-1);
            }
            out.push(line);
        }
        return out;
    }
    // BYOND expressions may span lines inside parentheses (multiline list()
    // literals and macro calls). Merge those lines so the macro engine sees the
    // full call. Line comments are stripped from merged lines because they would
    // otherwise swallow the rest of the block (comments terminate at the newline).
    joinParenBlocks(lines) {
        const out = [];
        let i = 0;
        const state = { inBlockComment: false, inString: false, inIcon: false, inTemplate: false, inInterp: false, innerStr: false, innerIcon: false, inRaw: false };
        while (i < lines.length) {
            let line = lines[i];
            let balance = DMPreprocessor.parenBalance(line, state);
            // Join while parens are open OR a {"..."} template string is open
            // (multi-line #define js_byjax {"..."} bodies). Inline comments are
            // stripped only outside template strings — JS // comments inside the
            // template content must survive.
            const condFrames = [];
            const isActive = () => condFrames.length === 0 || condFrames[condFrames.length - 1].active;
            while ((balance > 0 || state.inTemplate) && i + 1 < lines.length) {
                const nextLine = lines[i + 1];
                const trimmed = nextLine.trim();
                if (trimmed.startsWith('#')) {
                    // Directives inside an open paren block (e.g. #ifdef TESTING
                    // guarding a chunk of a multi-line list literal) are resolved
                    // inline so the join can continue on the active branch
                    // (item 56: beestation modules/admin/verbs/mapping.dm).
                    const dirLine = DMPreprocessor.stripInlineComment(trimmed);
                    const dm = dirLine.match(/^#(\w+)(.*)$/);
                    const name = dm ? dm[1] : '';
                    const arg = (dm ? dm[2] : '').trim();
                    if (name === 'ifdef' || name === 'ifndef' || name === 'if') {
                        const parentActive = isActive();
                        const value = name === 'ifdef' ? this.defines.has(arg) || this.functionDefines.has(arg)
                            : name === 'ifndef' ? !this.defines.has(arg) && !this.functionDefines.has(arg)
                                : this.evalIf(arg);
                        condFrames.push({ parentActive, branchTaken: parentActive && value, active: parentActive && value });
                    }
                    else if (name === 'elif' || name === 'else') {
                        const frame = condFrames[condFrames.length - 1];
                        if (frame && frame.parentActive) {
                            if (frame.branchTaken) {
                                frame.active = false;
                            }
                            else {
                                frame.active = true;
                                frame.branchTaken = true;
                            }
                        }
                    }
                    else if (name === 'endif') {
                        condFrames.pop();
                    }
                    i++;
                    continue;
                }
                if (!isActive()) {
                    // Inactive branch of a conditional inside the paren block: drop
                    // the line, keep joining.
                    i++;
                    continue;
                }
                if (!state.inTemplate) {
                    // The accumulator is re-stripped every iteration: appended lines
                    // may carry quotes whose state depends on the accumulated context
                    // (template boundaries — jobban_holder.dm), so a standalone strip
                    // of the appended line could hide a // comment. O(n^2) on the
                    // merged length, but merged lines are short in practice.
                    line = DMPreprocessor.stripInlineComment(line);
                    line += ' ' + DMPreprocessor.stripInlineComment(nextLine).trim();
                }
                else {
                    line += ' ' + nextLine.trim();
                }
                balance += DMPreprocessor.parenBalance(nextLine, state);
                i++;
            }
            out.push(line);
            i++;
        }
        return out;
    }
    // Count unbalanced '(', '[' and '{' (string/icon literal aware; stops at //).
    // Block-comment and string/icon state is carried across lines via `state`
    // (DM strings may span lines).
    static parenBalance(line, state) {
        const blockComment = state ?? { inBlockComment: false, inString: false, inIcon: false, inTemplate: false, inInterp: false, innerStr: false, innerIcon: false, inRaw: false };
        let balance = 0;
        let inString = blockComment.inString;
        let inIcon = blockComment.inIcon;
        let interpDepth = blockComment.inInterp ? 1 : 0;
        let innerStr = blockComment.innerStr;
        let innerIcon = blockComment.innerIcon;
        for (let i = 0; i < line.length; i++) {
            const c0 = line[i];
            if (blockComment.inRaw) {
                // Inside a @@ raw string spanning lines: only a lone '@' closes it
                // ('@@' is an escaped @).
                if (c0 === '@') {
                    if (line[i + 1] === '@') {
                        i += 2;
                        continue;
                    }
                    blockComment.inRaw = false;
                }
                continue;
            }
            const ch = c0;
            if (blockComment.inTemplate) {
                // DM template string {"..."}: only the '"' followed by '}' closes it;
                // quotes and brackets inside are content.
                if (ch === '"') {
                    let j = i + 1;
                    while (j < line.length && (line[j] === ' ' || line[j] === '\t'))
                        j++;
                    if (line[j] === '}') {
                        blockComment.inTemplate = false;
                        i = j;
                    }
                }
                continue;
            }
            if (blockComment.inBlockComment) {
                if (ch === '*' && line[i + 1] === '/') {
                    blockComment.inBlockComment = false;
                    i++;
                }
                continue;
            }
            if (interpDepth > 0) {
                // A string interpolation [code] spanning lines: scan with inner
                // literal tracking so quotes/apostrophes inside it don't corrupt
                // the outer string state.
                if (ch === '\\' && (innerStr || innerIcon)) {
                    i++;
                    continue;
                }
                if (!innerStr && !innerIcon) {
                    if (ch === '"')
                        innerStr = true;
                    else if (ch === "'")
                        innerIcon = true;
                    else if (ch === '[')
                        interpDepth++;
                    else if (ch === ']')
                        interpDepth--;
                }
                else if (innerStr && ch === '"') {
                    innerStr = false;
                }
                else if (innerIcon && ch === "'") {
                    innerIcon = false;
                }
                if (interpDepth === 0) {
                    blockComment.inInterp = false;
                    blockComment.innerStr = false;
                    blockComment.innerIcon = false;
                }
                continue;
            }
            if (!inString && !inIcon && ch === '/' && line[i + 1] === '*') {
                blockComment.inBlockComment = true;
                i++;
                continue;
            }
            if (ch === '\\' && (line[i + 1] === '"' || line[i + 1] === "'")) {
                // Backslash-escaped quote/apostrophe inside a string (item 56:
                // paradise client_procs.dm embeds JS with \" in strings).
                i++;
                continue;
            }
            if (ch === '"' && !inIcon) {
                inString = !inString;
            }
            else if (ch === "'" && !inString) {
                inIcon = !inIcon;
            }
            else if (!inString && !inIcon) {
                if (ch === '/' && line[i + 1] === '/')
                    break;
                if (ch === '@' && line[i + 1] === '{') {
                    // DM braced verbatim string @{...}: skip to the matching '}'.
                    let depth = 1;
                    i += 2;
                    while (i < line.length && depth > 0) {
                        const c = line[i];
                        if (c === '{')
                            depth++;
                        else if (c === '}')
                            depth--;
                        i++;
                    }
                    i--;
                }
                else if (ch === '@') {
                    // DM raw string / regex literal: @pattern@, or @@raw...@ (an inner
                    // @@ is an escaped @); may span lines. `@"..."` / `@'...'` are
                    // regex strings — a plain '@' prefix, so the quote handles the rest.
                    const nextCh = line[i + 1];
                    const isRaw = nextCh === '@';
                    const isRegex = nextCh !== '"' && nextCh !== "'" && !/[\s]/.test(nextCh ?? '');
                    if (isRaw || isRegex) {
                        let j = i + (isRaw ? 2 : 1);
                        while (j < line.length) {
                            if (line[j] === '@') {
                                if (line[j + 1] === '@') {
                                    j += 2;
                                    continue;
                                }
                                break;
                            }
                            j++;
                        }
                        if (j >= line.length)
                            blockComment.inRaw = true;
                        i = j;
                    }
                }
                else if (ch === '{' && line[i + 1] === '"') {
                    // DM template string opener {" — handled by the inTemplate state
                    // above (may span lines).
                    blockComment.inTemplate = true;
                    i++;
                }
                else {
                    if (ch === '(' || ch === '[' || ch === '{')
                        balance++;
                    else if (ch === ')' || ch === ']' || ch === '}')
                        balance--;
                }
            }
            else if (inString && ch === '[') {
                // DM string interpolation [code] may contain nested brackets and
                // inner string literals; scan to the matching ']' tracking quotes so
                // inner strings and apostrophes don't corrupt the outer state.
                let depth = 1;
                let str = false;
                let icon = false;
                i++;
                while (i < line.length && depth > 0) {
                    const c = line[i];
                    if (c === '\\' && (str || icon)) {
                        i += 2; // escaped char inside an inner literal
                        continue;
                    }
                    if (!str && !icon) {
                        if (c === '"')
                            str = true;
                        else if (c === "'")
                            icon = true;
                        else if (c === '[')
                            depth++;
                        else if (c === ']')
                            depth--;
                    }
                    else if (str && c === '"') {
                        str = false;
                    }
                    else if (icon && c === "'") {
                        icon = false;
                    }
                    i++;
                }
                i--;
                if (depth > 0) {
                    // Interpolation not closed on this line: carry the state so the
                    // next line's inner strings don't corrupt the outer string.
                    interpDepth = 1;
                    innerStr = str;
                    innerIcon = icon;
                }
            }
            else if (inString && ch === '\\') {
                // Escaped quote inside a string: skip the escaped char.
                i++;
            }
        }
        blockComment.inString = inString;
        blockComment.inIcon = inIcon;
        blockComment.inInterp = interpDepth > 0;
        blockComment.innerStr = innerStr;
        blockComment.innerIcon = innerIcon;
        return balance;
    }
    // True when a #define body is complete: strings/icons balanced, and parens/
    // brackets/braces not left open. Used to absorb multi-line define bodies.
    // Quote-AWARE balance for the interpolation guard (item 56/67): an
    // apostrophe inside a "..." string must not unbalance the check — e.g.
    // #define n(limb) (limb.owner ? "[limb.owner]'s ..." : limb) expanded
    // inside an interpolation would otherwise be kept unexpanded forever.
    static isQuoteBalanced(s) {
        let inString = false;
        let inIcon = false;
        for (let i = 0; i < s.length; i++) {
            const c = s[i];
            if (c === '\\') {
                i++;
                continue;
            }
            if (c === '"' && !inIcon)
                inString = !inString;
            else if (c === "'" && !inString)
                inIcon = !inIcon;
        }
        return !inString && !inIcon;
    }
    // True when a #define body is complete: strings/icons balanced, and parens/
    // brackets/braces not left open. Used to absorb multi-line define bodies.
    static isBalancedDefineBody(body) {
        let inString = false;
        let inIcon = false;
        let depth = 0;
        for (let i = 0; i < body.length; i++) {
            const ch = body[i];
            if (ch === '\\' && (body[i + 1] === '"' || body[i + 1] === "'")) {
                i++;
                continue;
            }
            if (ch === '"' && !inIcon) {
                inString = !inString;
            }
            else if (ch === "'" && !inString) {
                inIcon = !inIcon;
            }
            else if (!inString && !inIcon) {
                if (ch === '(' || ch === '[' || ch === '{')
                    depth++;
                else if (ch === ')' || ch === ']' || ch === '}')
                    depth--;
            }
        }
        return !inString && !inIcon && depth <= 0;
    }
    static stripInlineComment(line) {
        let inString = false;
        let inIcon = false;
        let inBlock = false;
        for (let i = 0; i < line.length - 1; i++) {
            const ch = line[i];
            if (inBlock) {
                if (ch === '*' && line[i + 1] === '/') {
                    inBlock = false;
                    i++;
                }
                continue;
            }
            if (!inString && !inIcon && ch === '/' && line[i + 1] === '*') {
                inBlock = true;
                i++;
                continue;
            }
            if (ch === '{' && line[i + 1] === '"' && !inString && !inIcon) {
                // DM template string {"..."}: skip to the closing '"}' so // inside
                // the content is not mistaken for an inline comment.
                let j = i + 2;
                while (j < line.length) {
                    if (line[j] === '"') {
                        let k = j + 1;
                        while (k < line.length && (line[k] === ' ' || line[k] === '\t'))
                            k++;
                        if (line[k] === '}') {
                            j = k;
                            break;
                        }
                    }
                    j++;
                }
                i = j;
                continue;
            }
            if (ch === '\\' && (line[i + 1] === '"' || line[i + 1] === "'")) {
                i++;
                continue;
            }
            if (!inString && !inIcon && ch === '*' && line[i + 1] === '/') {
                // A block-comment CLOSER (*//... — e.g. a decorative banner like
                // `*/////////////////////////`) must pass through: the following `//`
                // would otherwise truncate the line to `*` and the matching `/*`
                // would never close (corpus: tgmc modules.dm unterminated-comment
                // parse error). The strip is line-based with no carried block state,
                // so the closer itself has to survive.
                i++;
                continue;
            }
            if (ch === '"' && !inIcon) {
                inString = !inString;
            }
            else if (ch === "'" && !inString) {
                inIcon = !inIcon;
            }
            else if (!inString && !inIcon && ch === '/' && line[i + 1] === '/') {
                return line.slice(0, i);
            }
            else if (inString && ch === '[') {
                let depth = 1;
                i++;
                while (i < line.length - 1 && depth > 0) {
                    const c = line[i];
                    if (c === '[')
                        depth++;
                    else if (c === ']')
                        depth--;
                    i++;
                }
                i--;
            }
        }
        return line;
    }
    // Expand object-like and function-like macros on a single line. Strings,
    // icon paths ('...') and comments are never touched. Block-comment state is
    // carried across lines via `commentState`.
    expandMacros(line, depth, commentState) {
        const cmt = commentState ?? { inBlockComment: false };
        let result = '';
        let i = 0;
        let inString = false;
        let inIcon = false;
        while (i < line.length) {
            const ch = line[i];
            if (cmt.inBlockComment) {
                // Inside a /* */ comment: copy through until it closes.
                if (ch === '*' && line[i + 1] === '/') {
                    cmt.inBlockComment = false;
                    result += '*/';
                    i += 2;
                    continue;
                }
                result += ch;
                i++;
                continue;
            }
            if (!inString && !inIcon && ch === '/' && line[i + 1] === '*') {
                cmt.inBlockComment = true;
                result += '/*';
                i += 2;
                continue;
            }
            if (ch === '\\' && (line[i + 1] === '"' || line[i + 1] === "'")) {
                result += ch + (line[i + 1] ?? '');
                i += 2;
                continue;
            }
            if (!inString && !inIcon && ch === '/' && line[i + 1] === '/') {
                result += line.slice(i);
                break;
            }
            if (ch === '"' && !inIcon) {
                inString = !inString;
                result += ch;
                i++;
                continue;
            }
            if (ch === "'" && !inString) {
                inIcon = !inIcon;
                result += "'";
                i++;
                continue;
            }
            if ((inString || inIcon) && ch === '\\') {
                const esc = line[i + 1] ?? '';
                result += ch + esc;
                i += 2;
                continue;
            }
            if (inString && ch === '[') {
                // DM doubles brackets to escape them in text: [[ is a literal [,
                // never the start of interpolation.
                if (line[i + 1] === '[') {
                    result += '[[';
                    i += 2;
                    continue;
                }
                // String interpolation [expr]: the content is code — macro names
                // inside it must expand too (BYOND expands macros anywhere in code).
                // Scan to the matching ']' (bracket-depth counted, quotes tracked so
                // a "]" inside a nested string does not close the region). DM's
                // literal-bracket escapes (\[ ]\] [[) are skipped without depth change.
                let j = i + 1;
                let depth = 1;
                let nested = false;
                let nestedQuote = '';
                while (j < line.length && depth > 0) {
                    const c = line[j];
                    if (c === '\\') {
                        j += 2;
                        continue;
                    }
                    if (!nested) {
                        if (c === '"' || c === "'") {
                            nested = true;
                            nestedQuote = c;
                        }
                        else if (c === '[' && line[j + 1] === '[') {
                            j += 2;
                            continue;
                        }
                        else if (c === '[')
                            depth++;
                        else if (c === ']')
                            depth--;
                    }
                    else if (c === nestedQuote) {
                        nested = false;
                    }
                    else if (nested && c === '[') {
                        // A nested string may itself contain interpolation
                        // ("text [more [expr] text]" from macro substitution) — skip to
                        // its matching ']' so it cannot corrupt the outer tracking.
                        let sub = 1;
                        let k = j + 1;
                        while (k < line.length && sub > 0) {
                            if (line[k] === '[')
                                sub++;
                            else if (line[k] === ']')
                                sub--;
                            k++;
                        }
                        j = k;
                        continue;
                    }
                    j++;
                }
                const inner = line.slice(i + 1, j - 1);
                const expanded = this.expandMacros(inner, depth + 1, cmt);
                // The expansion is re-scanned by the lexer's quote-aware walk and
                // re-parsed as an expression. Expansions that introduce unbalanced
                // quotes (e.g. a macro whose body is HTML like span_notice) would
                // corrupt the enclosing string — keep the original text instead
                // (item 56: the unexpanded call resolves to Null at runtime, honest
                // loss, instead of breaking the whole statement).
                const expandedOk = DMPreprocessor.isQuoteBalanced(expanded) && DMPreprocessor.isQuoteBalanced(inner);
                result += expandedOk ? '[' + expanded + ']' : '[' + inner + ']';
                i = j;
                continue;
            }
            if (inString || inIcon) {
                result += ch;
                i++;
                continue;
            }
            if (ch === '{' && line[i + 1] === '"') {
                // DM template string {"..."}: copy verbatim to the closing '"}' —
                // quotes, brackets and // inside the content are not macro-relevant.
                let j = i + 2;
                while (j < line.length) {
                    if (line[j] === '"') {
                        let k = j + 1;
                        while (k < line.length && (line[k] === ' ' || line[k] === '\t'))
                            k++;
                        if (line[k] === '}') {
                            j = k;
                            break;
                        }
                    }
                    j++;
                }
                result += line.slice(i, j + 1);
                i = j + 1;
                continue;
            }
            if (ch === '@' && line[i + 1] === '{') {
                // DM braced verbatim string @{...}: copy through to the matching '}'.
                let depth = 1;
                let j = i + 2;
                while (j < line.length && depth > 0) {
                    const c = line[j];
                    if (c === '{')
                        depth++;
                    else if (c === '}')
                        depth--;
                    j++;
                }
                result += line.slice(i, j);
                i = j;
                continue;
            }
            if (!inString && !inIcon && /[A-Za-z_]/.test(ch)) {
                let j = i;
                while (j < line.length && /[A-Za-z0-9_]/.test(line[j]))
                    j++;
                const word = line.slice(i, j);
                const fnMacro = this.functionDefines.get(word);
                if (fnMacro) {
                    // Look ahead (past spaces) for '(' — required for function-like use
                    let k = j;
                    while (k < line.length && (line[k] === ' ' || line[k] === '\t'))
                        k++;
                    if (k < line.length && line[k] === '(') {
                        const end = this.findMatchingParen(line, k);
                        if (end >= 0 && depth < MAX_MACRO_EXPANSION_DEPTH && this.macroExpansionBudget > 0) {
                            this.macroExpansionBudget--;
                            const argText = line.slice(k + 1, end);
                            const args = this.splitArgs(argText).map(a => a.trim());
                            const expanded = this.expandFunctionMacro(fnMacro, args);
                            result += this.expandMacros(expanded, depth + 1, cmt);
                            i = end + 1;
                            continue;
                        }
                    }
                    // Not a call site (or depth/budget exhausted) — leave the word as-is
                    result += word;
                    i = j;
                    continue;
                }
                const def = this.defines.get(word);
                if (def !== undefined) {
                    if (depth < MAX_MACRO_EXPANSION_DEPTH && this.macroExpansionBudget > 0) {
                        this.macroExpansionBudget--;
                        result += this.expandMacros(def, depth + 1);
                    }
                    else {
                        result += word;
                    }
                    i = j;
                    continue;
                }
                result += word;
                i = j;
                continue;
            }
            result += ch;
            i++;
        }
        return result;
    }
    // Advance the shared block-comment state for lines that skip expandMacros
    // (preprocessor directives), so /* */ spans that include directive lines
    // still close correctly. Mirrors expandMacros' comment scanning rules.
    updateBlockCommentState(line) {
        let inString = false;
        let inIcon = false;
        const cmt = this.blockCommentState;
        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (cmt.inBlockComment) {
                if (ch === '*' && line[i + 1] === '/') {
                    cmt.inBlockComment = false;
                    i++;
                }
                continue;
            }
            if (!inString && !inIcon && ch === '/' && line[i + 1] === '*') {
                cmt.inBlockComment = true;
                i++;
                continue;
            }
            if (ch === '\\' && (line[i + 1] === '"' || line[i + 1] === "'")) {
                i++;
                continue;
            }
            if (!inString && !inIcon && ch === '/' && line[i + 1] === '/') {
                return;
            }
            if (ch === '"' && !inIcon) {
                inString = !inString;
            }
            else if (ch === "'" && !inString) {
                inIcon = !inIcon;
            }
        }
    }
    expandFunctionMacro(macro, args) {
        const subst = new Map();
        for (let i = 0; i < macro.params.length; i++) {
            subst.set(macro.params[i], i < args.length ? args[i] : '');
        }
        let extra = '';
        if (macro.variadic) {
            if (macro.params.length > 0) {
                // Named variadic (#define F(a, rest...) ...): the last parameter
                // absorbs the trailing arguments as a single comma-joined argument.
                const last = macro.params[macro.params.length - 1];
                subst.set(last, args.slice(macro.params.length - 1).join(', '));
            }
            else {
                // Anonymous variadic (#define F(...) ...): extras are injected at the
                // literal `...` placeholder in the body.
                extra = args.join(', ');
            }
        }
        let body = macro.body;
        body = this.substituteParams(body, subst);
        // Token pasting and the variadic placeholder must never touch string
        // literals or icon paths (a literal "##" or "..." inside a string is
        // content, not a directive).
        body = this.replaceOutsideStrings(body, /\s*##\s*/, '');
        if (macro.variadic) {
            body = this.replaceOutsideStrings(body, /\.\.\./, () => extra);
        }
        return body;
    }
    // Replace `re` matches only outside string literals and icon paths.
    replaceOutsideStrings(body, re, repl) {
        let result = '';
        let inString = false;
        let inIcon = false;
        for (let i = 0; i < body.length;) {
            const ch = body[i];
            if (ch === '\\' && (body[i + 1] === '"' || body[i + 1] === "'")) {
                result += ch + (body[i + 1] ?? '');
                i += 2;
                continue;
            }
            if (ch === '"' && !inIcon) {
                inString = !inString;
                result += ch;
                i++;
                continue;
            }
            if (ch === "'" && !inString) {
                inIcon = !inIcon;
                result += ch;
                i++;
                continue;
            }
            if (!inString && !inIcon) {
                const m = body.slice(i).match(re);
                if (m && m.index === 0) {
                    result += typeof repl === 'string' ? repl : repl();
                    i += m[0].length;
                    continue;
                }
            }
            result += ch;
            i++;
        }
        return result;
    }
    // Substitute macro parameters by word, skipping string literals, icon
    // paths and /* */ comments (a param name may legitimately appear inside
    // string content, e.g. `</head>` contains the word `head`).
    substituteParams(body, subst) {
        let result = '';
        let i = 0;
        let inString = false;
        let inIcon = false;
        let inBlockComment = false;
        while (i < body.length) {
            const ch = body[i];
            if (inBlockComment) {
                if (ch === '*' && body[i + 1] === '/') {
                    inBlockComment = false;
                    result += '*/';
                    i += 2;
                    continue;
                }
                result += ch;
                i++;
                continue;
            }
            if (!inString && !inIcon && ch === '/' && body[i + 1] === '*') {
                inBlockComment = true;
                result += '/*';
                i += 2;
                continue;
            }
            if (ch === '"' && !inIcon) {
                inString = !inString;
                result += ch;
                i++;
                continue;
            }
            if (ch === '\\' && (body[i + 1] === '"' || body[i + 1] === "'")) {
                result += ch + (body[i + 1] ?? '');
                i += 2;
                continue;
            }
            if (ch === "'" && !inString) {
                inIcon = !inIcon;
                result += ch;
                i++;
                continue;
            }
            if (inString && ch === '[') {
                // DM doubles brackets to escape them in text: [[ is a literal [,
                // never the start of interpolation.
                if (body[i + 1] === '[') {
                    result += '[[';
                    i += 2;
                    continue;
                }
                // String interpolation [expr]: parameters inside it are code and must
                // be substituted (e.g. span macros with "[text]" bodies).
                let j = i + 1;
                let depth = 1;
                let nested = false;
                let nestedQuote = '';
                while (j < body.length && depth > 0) {
                    const c = body[j];
                    if (c === '\\') {
                        // Escaped char inside the interpolation (\" \' \\ \[ \] ...):
                        // skip both — an escaped bracket does not change depth.
                        j += 2;
                        continue;
                    }
                    if (!nested) {
                        if (c === '"' || c === "'") {
                            nested = true;
                            nestedQuote = c;
                        }
                        else if (c === '[' && body[j + 1] === '[') {
                            j += 2;
                            continue;
                        }
                        else if (c === '[')
                            depth++;
                        else if (c === ']')
                            depth--;
                    }
                    else if (c === nestedQuote) {
                        nested = false;
                    }
                    else if (nested && c === '[') {
                        // A nested string may itself contain interpolation
                        // ("text [more [expr] text]" from macro substitution) — skip to
                        // its matching ']' so it cannot corrupt the outer tracking.
                        let sub = 1;
                        let k = j + 1;
                        while (k < body.length && sub > 0) {
                            if (body[k] === '[')
                                sub++;
                            else if (body[k] === ']')
                                sub--;
                            k++;
                        }
                        j = k;
                        continue;
                    }
                    j++;
                }
                const inner = body.slice(i + 1, j - 1);
                result += '[' + this.substituteParams(inner, subst) + ']';
                i = j;
                continue;
            }
            if (inString && ch === '\\') {
                // Escaped char inside a string: the next char is literal, never a
                // bracket/quote that starts or ends structure (\[ \[[ ]\] \" \\).
                const esc = body[i + 1] ?? '';
                result += ch + esc;
                i += 2;
                continue;
            }
            if (!inString && !inIcon && (/[A-Za-z_]/.test(ch) || (ch === '#' && (body[i + 1] === '#' || /[A-Za-z_]/.test(body[i + 1] || ''))))) {
                let j = i;
                let stringify = false;
                if (ch === '#') {
                    if (body[i + 1] === '#') {
                        // ##name -> token pasting: drop both markers, substitute plainly
                        j += 2;
                    }
                    else {
                        // #name -> stringified argument
                        stringify = true;
                        j++;
                    }
                }
                while (j < body.length && /[A-Za-z0-9_]/.test(body[j]))
                    j++;
                const word = body.slice(i, j);
                const plain = word.replace(/^#+/, '');
                if (plain !== '' && subst.has(plain)) {
                    const val = subst.get(plain);
                    result += stringify ? `"${val.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : val;
                    i = j;
                    continue;
                }
                result += word;
                i = j;
                continue;
            }
            result += ch;
            i++;
        }
        return result;
    }
    // Find the index of the ')' matching the '(' at position open.
    findMatchingParen(line, open) {
        let depth = 0;
        let inString = false;
        let inIcon = false;
        let inBlock = false;
        for (let i = open; i < line.length; i++) {
            const ch = line[i];
            if (inBlock) {
                if (ch === '*' && line[i + 1] === '/') {
                    inBlock = false;
                    i++;
                }
                continue;
            }
            if (!inString && !inIcon && ch === '/' && line[i + 1] === '*') {
                inBlock = true;
                i++;
                continue;
            }
            if (ch === '"' && !inIcon) {
                inString = !inString;
                continue;
            }
            if (ch === "'" && !inString) {
                inIcon = !inIcon;
                continue;
            }
            if ((inString || inIcon) && ch === '\\') {
                i++;
                continue;
            }
            if ((inString || inIcon) && ch === '[') {
                // String interpolation: skip to the matching ']' so quotes/brackets
                // inside it cannot break the outer string state or paren balance.
                // A nested string keeps ITS OWN quote char (`'` inside a "..." does
                // not close it — e.g. "[target]'s" in mechanical_repair.dm, item 56).
                let depth = 1;
                let nested = false;
                let nestedQuote = '';
                i++;
                while (i < line.length && depth > 0) {
                    const c = line[i];
                    if (c === '\\') {
                        i += 2;
                        continue;
                    }
                    if (!nested) {
                        if (c === '"' || c === "'") {
                            nested = true;
                            nestedQuote = c;
                        }
                        else if (c === '[')
                            depth++;
                        else if (c === ']')
                            depth--;
                    }
                    else if (c === nestedQuote) {
                        nested = false;
                    }
                    i++;
                }
                i--; // loop's i++ would otherwise skip the char after ']'
                continue;
            }
            if (inString || inIcon)
                continue;
            if (ch === '@' && line[i + 1] === '{') {
                // DM braced verbatim string @{...}: skip to the matching '}'.
                let depth = 1;
                i += 2;
                while (i < line.length && depth > 0) {
                    const c = line[i];
                    if (c === '{')
                        depth++;
                    else if (c === '}')
                        depth--;
                    i++;
                }
                i--;
                continue;
            }
            if (ch === '{' && line[i + 1] === '"') {
                // DM template string {"..."}: skip to the '"' followed by '}'.
                let j = i + 2;
                while (j < line.length) {
                    if (line[j] === '"') {
                        let k = j + 1;
                        while (k < line.length && (line[k] === ' ' || line[k] === '\t'))
                            k++;
                        if (line[k] === '}') {
                            i = k;
                            break;
                        }
                    }
                    j++;
                }
                continue;
            }
            if (ch === '(')
                depth++;
            else if (ch === ')') {
                depth--;
                if (depth === 0)
                    return i;
            }
        }
        return -1;
    }
    // Split on top-level commas (respecting (), [], {}, string/icon literals and
    // block comments).
    splitArgs(text) {
        const parts = [];
        let depth = 0;
        let current = '';
        let inString = false;
        let inIcon = false;
        let inBlock = false;
        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            const next = text[i + 1];
            if (inBlock) {
                if (ch === '*' && next === '/') {
                    inBlock = false;
                    current += ch + next;
                    i++;
                    continue;
                }
                current += ch;
                continue;
            }
            if (!inString && !inIcon && ch === '/' && next === '*') {
                inBlock = true;
                i++;
                current += ch + next;
                continue;
            }
            if (ch === '"' && !inIcon) {
                inString = !inString;
                current += ch;
                continue;
            }
            if (ch === "'" && !inString) {
                inIcon = !inIcon;
                current += ch;
                continue;
            }
            if ((inString || inIcon) && ch === '\\') {
                current += ch + (text[i + 1] ?? '');
                i++;
                continue;
            }
            if ((inString || inIcon) && ch === '[') {
                // DM string interpolation [expr]: copy verbatim to the matching ']'.
                // Quotes inside the interpolation are part of nested string literals
                // and must not toggle the outer string state (e.g. span_danger("...
                // [damage ? "." : "..."]") arguments would otherwise split mid-string).
                // A nested string keeps ITS OWN quote char (item 56: "[target]'s").
                let depth = 1;
                let nested = false;
                let nestedQuote = '';
                i++;
                current += ch;
                while (i < text.length && depth > 0) {
                    const c = text[i];
                    current += c;
                    if (c === '\\') {
                        i++;
                        current += text[i] ?? '';
                    }
                    else if (!nested) {
                        if (c === '"' || c === "'") {
                            nested = true;
                            nestedQuote = c;
                        }
                        else if (c === '[')
                            depth++;
                        else if (c === ']')
                            depth--;
                    }
                    else if (c === nestedQuote) {
                        nested = false;
                    }
                    i++;
                }
                i--; // loop's i++ would otherwise skip the char after ']'
                continue;
            }
            if (inString || inIcon) {
                current += ch;
                continue;
            }
            if (ch === '@' && next === '{') {
                // DM braced verbatim string @{...}: skip to the matching '}'.
                let depth = 1;
                i += 2;
                current += '@{';
                while (i < text.length && depth > 0) {
                    const c = text[i];
                    if (c === '{')
                        depth++;
                    else if (c === '}')
                        depth--;
                    current += c;
                    i++;
                }
                i--;
                continue;
            }
            if (ch === '{' && next === '"') {
                // DM template string {"..."}: skip to the '"' followed by '}'.
                i++;
                current += ch;
                while (i < text.length) {
                    const c = text[i];
                    current += c;
                    if (c === '"') {
                        let j = i + 1;
                        while (j < text.length && (text[j] === ' ' || text[j] === '\t'))
                            j++;
                        if (text[j] === '}') {
                            current += text.slice(i + 1, j + 1);
                            i = j;
                            break;
                        }
                    }
                    i++;
                }
                continue;
            }
            if (ch === '(' || ch === '[' || ch === '{') {
                depth++;
                current += ch;
            }
            else if (ch === ')' || ch === ']' || ch === '}') {
                depth--;
                current += ch;
            }
            else if (ch === ',' && depth === 0) {
                parts.push(current);
                current = '';
            }
            else {
                current += ch;
            }
        }
        if (current.length > 0 || text.length > 0) {
            parts.push(current);
        }
        return parts;
    }
    // Numeric #if evaluator (BYOND: `#if VERSION >= 514`, `#if 1`, `#if X == Y`).
    // Supports numbers, macro identifiers (their values are re-evaluated),
    // defined(X), arithmetic (+ - * / %), comparisons (== != < > <= >=), logical
    // (&& || !) and parentheses. Undefined identifiers evaluate to 0.
    evalIf(expr) {
        return this.evalIfValue(expr) !== 0;
    }
    evalIfValue(expr, depth = 0) {
        if (depth > 16)
            return 0;
        const s = expr.replace(/\s+/g, '');
        let pos = 0;
        const parseOr = () => {
            let v = parseAnd();
            while (s.slice(pos, pos + 2) === '||') {
                pos += 2;
                v = v !== 0 || parseAnd() !== 0 ? 1 : 0;
            }
            return v;
        };
        const parseAnd = () => {
            let v = parseEq();
            while (s.slice(pos, pos + 2) === '&&') {
                pos += 2;
                v = v !== 0 && parseEq() !== 0 ? 1 : 0;
            }
            return v;
        };
        const parseEq = () => {
            let v = parseRel();
            for (;;) {
                if (s.slice(pos, pos + 2) === '==') {
                    pos += 2;
                    v = v === parseRel() ? 1 : 0;
                }
                else if (s.slice(pos, pos + 2) === '!=') {
                    pos += 2;
                    v = v !== parseRel() ? 1 : 0;
                }
                else {
                    break;
                }
            }
            return v;
        };
        const parseRel = () => {
            let v = parseAdd();
            for (;;) {
                if (s.slice(pos, pos + 2) === '<=') {
                    pos += 2;
                    v = v <= parseAdd() ? 1 : 0;
                }
                else if (s.slice(pos, pos + 2) === '>=') {
                    pos += 2;
                    v = v >= parseAdd() ? 1 : 0;
                }
                else if (s[pos] === '<') {
                    pos++;
                    v = v < parseAdd() ? 1 : 0;
                }
                else if (s[pos] === '>') {
                    pos++;
                    v = v > parseAdd() ? 1 : 0;
                }
                else {
                    break;
                }
            }
            return v;
        };
        const parseAdd = () => {
            let v = parseMul();
            for (;;) {
                if (s[pos] === '+') {
                    pos++;
                    v += parseMul();
                }
                else if (s[pos] === '-') {
                    pos++;
                    v -= parseMul();
                }
                else {
                    break;
                }
            }
            return v;
        };
        const parseMul = () => {
            let v = parseUnary();
            for (;;) {
                if (s[pos] === '*') {
                    pos++;
                    v *= parseUnary();
                }
                else if (s[pos] === '/') {
                    pos++;
                    const d = parseUnary();
                    v = d === 0 ? 0 : Math.floor(v / d);
                }
                else if (s[pos] === '%') {
                    pos++;
                    const d = parseUnary();
                    v = d === 0 ? 0 : v % d;
                }
                else {
                    break;
                }
            }
            return v;
        };
        const parseUnary = () => {
            if (s[pos] === '!') {
                pos++;
                return parseUnary() === 0 ? 1 : 0;
            }
            if (s[pos] === '-') {
                pos++;
                return -parseUnary();
            }
            return parsePrimary();
        };
        const parsePrimary = () => {
            if (s[pos] === '(') {
                pos++;
                const v = parseOr();
                if (s[pos] === ')')
                    pos++;
                return v;
            }
            if (s.slice(pos, pos + 8) === 'defined(') {
                pos += 8;
                const start = pos;
                while (pos < s.length && s[pos] !== ')')
                    pos++;
                const name = s.slice(start, pos);
                pos++;
                return this.defines.has(name) || this.functionDefines.has(name) ? 1 : 0;
            }
            const num = /^\d+(\.\d+)?/.exec(s.slice(pos));
            if (num) {
                pos += num[0].length;
                return parseFloat(num[0]);
            }
            const start = pos;
            while (pos < s.length && /[A-Za-z0-9_]/.test(s[pos]))
                pos++;
            const name = s.slice(start, pos);
            if (name.length === 0)
                return 0;
            // BYOND built-in defines (DM_VERSION etc.) — real compilers carry
            // these, so #if (DM_VERSION < 510) must not fire with 0 (item 56).
            const builtin = { DM_VERSION: 516, DM_BUILD: 1666, BYOND_MAJOR: 516 }[name];
            if (builtin !== undefined)
                return builtin;
            const def = this.defines.get(name);
            if (def !== undefined)
                return this.evalIfValue(def, depth + 1);
            return 0;
        };
        return parseOr();
    }
    // Collect object-like and function-like #defines from a set of source files,
    // mirroring how BYOND exposes a single global macro dictionary to the whole
    // compilation. First definition wins; #if guards are not evaluated here.
    static collectDefinesFromFiles(files) {
        const object = new Map();
        const fnMap = new Map();
        for (const file of files) {
            let raw;
            try {
                raw = fs.readFileSync(file, 'utf-8');
            }
            catch {
                continue;
            }
            const lines = raw.split('\n');
            for (let i = 0; i < lines.length; i++) {
                const trimmed = lines[i].trim();
                if (!trimmed.startsWith('#define'))
                    continue;
                let body = trimmed.slice(8).trim();
                while (body.endsWith('\\') && i + 1 < lines.length) {
                    body = body.slice(0, -1).trim() + ' ' + lines[++i].trim();
                }
                const m = body.match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\((.*?)\))?\s*(.*)$/);
                if (!m)
                    continue;
                if (m[2] !== undefined) {
                    if (!fnMap.has(m[1])) {
                        const params = m[2].split(',').map(p => p.trim()).filter(p => p.length > 0);
                        let variadic = false;
                        const cleanParams = [];
                        for (const p of params) {
                            if (p === '...')
                                variadic = true;
                            else if (p.endsWith('...')) {
                                // Named variadic: #define FOO(focus...) — name is focus.
                                variadic = true;
                                cleanParams.push(p.slice(0, -3));
                            }
                            else
                                cleanParams.push(p);
                        }
                        fnMap.set(m[1], { params: cleanParams, variadic, body: DMPreprocessor.stripInlineComment(m[3]).trim() });
                    }
                    continue;
                }
                if (!object.has(m[1])) {
                    object.set(m[1], DMPreprocessor.stripInlineComment(m[3]).trim());
                }
            }
        }
        return { object, function: fnMap };
    }
}
exports.DMPreprocessor = DMPreprocessor;
