import * as fs from 'fs';
import * as path from 'path';
import { DiagnosticCollector } from './diagnostics.js';

interface CondFrame {
  parentActive: boolean;
  branchTaken: boolean;
  active: boolean;
}

export interface FunctionMacro {
  params: string[];
  variadic: boolean;
  body: string;
}

export interface CollectedDefines {
  object: Map<string, string>;
  function: Map<string, FunctionMacro>;
}

const MAX_MACRO_EXPANSION_DEPTH = 30;

export class DMPreprocessor {
  private defines = new Map<string, string>();
  private functionDefines = new Map<string, FunctionMacro>();
  private includeStack: string[] = [];
  private collector: DiagnosticCollector;
  private blockCommentState: { inBlockComment: boolean } = { inBlockComment: false };

  constructor(
    collector: DiagnosticCollector,
    seedDefines: Map<string, string> | undefined = undefined,
    seedFunctionDefines: Map<string, FunctionMacro> | undefined = undefined
  ) {
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

  process(code: string, filePath: string): string {
    const absPath = path.resolve(filePath);
    if (this.includeStack.includes(absPath)) {
      this.collector.error(`Recursive #include of '${path.basename(absPath)}'`, 0, 0);
      return '';
    }
    this.includeStack.push(absPath);
    this.blockCommentState.inBlockComment = false;
    try {
      return this.processText(code, path.dirname(absPath));
    } finally {
      this.includeStack.pop();
    }
  }

  processFile(filePath: string): string {
    const code = fs.readFileSync(filePath, 'utf-8');
    return this.process(code, filePath);
  }

  private processText(code: string, dir: string): string {
    const joined = this.joinParenBlocks(this.joinContinuations(code.split('\n')));
    const lines = joined;
    const out: string[] = [];
    const condStack: CondFrame[] = [];
    const isActive = (): boolean => condStack.length === 0 || condStack[condStack.length - 1].active;

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const trimmed = raw.trim();
      const startsInComment = this.blockCommentState.inBlockComment;
      if (!startsInComment && trimmed.startsWith('#')) {
        const dirLine = this.stripComment(trimmed);
        const m = dirLine.match(/^#(\w+)(.*)$/);
        const name = m ? m[1] : '';
        const arg = (m ? m[2] : '').trim();
        switch (name) {
          case 'if':
          case 'ifdef':
          case 'ifndef': {
            const value =
              name === 'ifdef' ? this.defines.has(arg) || this.functionDefines.has(arg)
                : name === 'ifndef' ? !this.defines.has(arg) && !this.functionDefines.has(arg)
                  : this.evalIf(arg);
            const parentActive = isActive();
            condStack.push({ parentActive, branchTaken: parentActive && value, active: parentActive && value });
            break;
          }
          case 'else': {
            const frame = condStack[condStack.length - 1];
            if (!frame) {
              this.collector.error('#else without matching #if', i + 1, 1);
              break;
            }
            if (!frame.parentActive) break;
            if (frame.branchTaken) {
              frame.active = false;
            } else {
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
            if (!isActive()) break;
            const dm = arg.match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\((.*?)\))?\s*(.*)$/);
            if (!dm) break;
            if (dm[2] !== undefined) {
              // Function-like macro: #define NAME(a, b) body
              const params = this.splitArgs(dm[2]).map(p => p.trim()).filter(p => p.length > 0);
              let variadic = false;
              const cleanParams: string[] = [];
              for (const p of params) {
                if (p === '...') {
                  variadic = true;
                } else if (p.endsWith('...')) {
                  // Named variadic: #define FOO(focus...) — name is focus.
                  variadic = true;
                  cleanParams.push(p.slice(0, -3));
                } else {
                  cleanParams.push(p);
                }
              }
              this.functionDefines.set(dm[1], { params: cleanParams, variadic, body: DMPreprocessor.stripInlineComment(dm[3]).trim() });
              break;
            }
            this.defines.set(dm[1], DMPreprocessor.stripInlineComment(dm[3]).trim());
            break;
          }
          case 'undef': {
            if (!isActive()) break;
            this.defines.delete(arg);
            this.functionDefines.delete(arg);
            break;
          }
          case 'include': {
            if (!isActive()) break;
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
            const incCode = this.processFile(incPath);
            if (incCode.length > 0) {
              out.push(incCode);
            }
            break;
          }
          case 'warn': {
            if (isActive()) this.collector.warning(`#warn: ${arg}`, i + 1, 1);
            break;
          }
          case 'pragma': {
            if (isActive() && arg !== 'once') {
              this.collector.warning(`Unsupported #pragma '${arg}' ignored`, i + 1, 1);
            }
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
  private joinContinuations(lines: string[]): string[] {
    const out: string[] = [];
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
  private joinParenBlocks(lines: string[]): string[] {
    const out: string[] = [];
    let i = 0;
    const state: { inBlockComment: boolean; inString: boolean; inIcon: boolean; inTemplate: boolean; inInterp: boolean; innerStr: boolean; innerIcon: boolean; inRaw: boolean } = { inBlockComment: false, inString: false, inIcon: false, inTemplate: false, inInterp: false, innerStr: false, innerIcon: false, inRaw: false };
    while (i < lines.length) {
      let line = lines[i];
      let balance = DMPreprocessor.parenBalance(line, state);
      // Join while parens are open OR a {"..."} template string is open
      // (multi-line #define js_byjax {"..."} bodies). Inline comments are
      // stripped only outside template strings — JS // comments inside the
      // template content must survive.
      while ((balance > 0 || state.inTemplate) && i + 1 < lines.length) {
        const nextLine = lines[i + 1];
        if (nextLine.trim().startsWith('#')) break;
        if (!state.inTemplate) {
          line = DMPreprocessor.stripInlineComment(line);
          line += ' ' + DMPreprocessor.stripInlineComment(nextLine).trim();
        } else {
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
  private static parenBalance(
    line: string,
    state?: { inBlockComment: boolean; inString: boolean; inIcon: boolean; inTemplate: boolean; inInterp: boolean; innerStr: boolean; innerIcon: boolean; inRaw: boolean }
  ): number {
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
          while (j < line.length && (line[j] === ' ' || line[j] === '\t')) j++;
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
          if (ch === '"') innerStr = true;
          else if (ch === "'") innerIcon = true;
          else if (ch === '[') interpDepth++;
          else if (ch === ']') interpDepth--;
        } else if (innerStr && ch === '"') {
          innerStr = false;
        } else if (innerIcon && ch === "'") {
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
      if (ch === '"' && !inIcon) {
        inString = !inString;
      } else if (ch === "'" && !inString) {
        inIcon = !inIcon;
      } else if (!inString && !inIcon) {
        if (ch === '/' && line[i + 1] === '/') break;
        if (ch === '@' && line[i + 1] === '{') {
          // DM braced verbatim string @{...}: skip to the matching '}'.
          let depth = 1;
          i += 2;
          while (i < line.length && depth > 0) {
            const c = line[i];
            if (c === '{') depth++;
            else if (c === '}') depth--;
            i++;
          }
          i--;
        } else if (ch === '@') {
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
            if (j >= line.length) blockComment.inRaw = true;
            i = j;
          }
        } else if (ch === '{' && line[i + 1] === '"') {
          // DM template string opener {" — handled by the inTemplate state
          // above (may span lines).
          blockComment.inTemplate = true;
          i++;
        } else {
          if (ch === '(' || ch === '[' || ch === '{') balance++;
          else if (ch === ')' || ch === ']' || ch === '}') balance--;
        }
      } else if (inString && ch === '[') {
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
            if (c === '"') str = true;
            else if (c === "'") icon = true;
            else if (c === '[') depth++;
            else if (c === ']') depth--;
          } else if (str && c === '"') {
            str = false;
          } else if (icon && c === "'") {
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
      } else if (inString && ch === '\\') {
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

  private static stripInlineComment(line: string): string {
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
            while (k < line.length && (line[k] === ' ' || line[k] === '\t')) k++;
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
      if (ch === '"' && !inIcon) {
        inString = !inString;
      } else if (ch === "'" && !inString) {
        inIcon = !inIcon;
      } else if (!inString && !inIcon && ch === '/' && line[i + 1] === '/') {
        return line.slice(0, i);
      } else if (inString && ch === '[') {
        let depth = 1;
        i++;
        while (i < line.length - 1 && depth > 0) {
          const c = line[i];
          if (c === '[') depth++;
          else if (c === ']') depth--;
          i++;
        }
        i--;
      }
    }
    return line;
  }

  private stripComment(line: string): string {
    const idx = line.indexOf('//');
    return idx >= 0 ? line.slice(0, idx) : line;
  }

  // Expand object-like and function-like macros on a single line. Strings,
  // icon paths ('...') and comments are never touched. Block-comment state is
  // carried across lines via `commentState`.
  private expandMacros(line: string, depth: number, commentState?: { inBlockComment: boolean }): string {
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
      if (!inString && !inIcon && ch === '/' && line[i + 1] === '/') {
        result += line.slice(i);
        break;
      }
      if (ch === '"' && !inIcon) {
        inString = !inString;
        result += '"';
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
            while (k < line.length && (line[k] === ' ' || line[k] === '\t')) k++;
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
          if (c === '{') depth++;
          else if (c === '}') depth--;
          j++;
        }
        result += line.slice(i, j);
        i = j;
        continue;
      }
      if (!inString && !inIcon && /[A-Za-z_]/.test(ch)) {
        let j = i;
        while (j < line.length && /[A-Za-z0-9_]/.test(line[j])) j++;
        const word = line.slice(i, j);

        const fnMacro = this.functionDefines.get(word);
        if (fnMacro) {
          // Look ahead (past spaces) for '(' — required for function-like use
          let k = j;
          while (k < line.length && (line[k] === ' ' || line[k] === '\t')) k++;
          if (k < line.length && line[k] === '(') {
            const end = this.findMatchingParen(line, k);
            if (end >= 0 && depth < MAX_MACRO_EXPANSION_DEPTH) {
              const argText = line.slice(k + 1, end);
              const args = this.splitArgs(argText).map(a => a.trim());
              const expanded = this.expandFunctionMacro(fnMacro, args);
              result += this.expandMacros(expanded, depth + 1);
              i = end + 1;
              continue;
            }
          }
          // Not a call site (or depth exhausted) — leave the word as-is
          result += word;
          i = j;
          continue;
        }

        const def = this.defines.get(word);
        if (def !== undefined) {
          if (depth < MAX_MACRO_EXPANSION_DEPTH) {
            result += this.expandMacros(def, depth + 1);
          } else {
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
  private updateBlockCommentState(line: string): void {
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
      if (!inString && !inIcon && ch === '/' && line[i + 1] === '/') {
        return;
      }
      if (ch === '"' && !inIcon) {
        inString = !inString;
      } else if (ch === "'" && !inString) {
        inIcon = !inIcon;
      }
    }
  }

  private expandFunctionMacro(macro: FunctionMacro, args: string[]): string {
    const subst = new Map<string, string>();
    for (let i = 0; i < macro.params.length; i++) {
      subst.set(macro.params[i], i < args.length ? args[i] : '');
    }
    let extra = '';
    if (macro.variadic && args.length > macro.params.length) {
      extra = args.slice(macro.params.length).join(', ');
    }

    let body = macro.body;
    body = this.substituteParams(body, subst);

    // Token pasting: remove ## markers so surrounding tokens concatenate
    body = body.replace(/\s*##\s*/g, '');
    // Variadic: replace the ... placeholder with the extra arguments
    if (macro.variadic) {
      body = body.replace(/\.\.\./g, () => extra);
    }
    return body;
  }

  // Substitute macro parameters by word, skipping string literals, icon
  // paths and /* */ comments (a param name may legitimately appear inside
  // string content, e.g. `</head>` contains the word `head`).
  private substituteParams(body: string, subst: Map<string, string>): string {
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
      if (ch === "'" && !inString) {
        inIcon = !inIcon;
        result += ch;
        i++;
        continue;
      }
      if (!inString && !inIcon && (/[A-Za-z_]/.test(ch) || (ch === '#' && (body[i + 1] === '#' || /[A-Za-z_]/.test(body[i + 1] || ''))))) {
        let j = i;
        let stringify = false;
        if (ch === '#') {
          if (body[i + 1] === '#') {
            // ##name -> token pasting: drop both markers, substitute plainly
            j += 2;
          } else {
            // #name -> stringified argument
            stringify = true;
            j++;
          }
        }
        while (j < body.length && /[A-Za-z0-9_]/.test(body[j])) j++;
        const word = body.slice(i, j);
        const plain = word.replace(/^#+/, '');
        if (plain !== '' && subst.has(plain)) {
          result += stringify ? `"${subst.get(plain)}"` : subst.get(plain)!;
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
  private findMatchingParen(line: string, open: number): number {
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
        let depth = 1;
        let nested = false;
        i++;
        while (i < line.length && depth > 0) {
          const c = line[i];
          if (c === '\\') {
            i += 2;
            continue;
          }
          if (!nested) {
            if (c === '"' || c === "'") nested = true;
            else if (c === '[') depth++;
            else if (c === ']') depth--;
          } else if (c === '"' || c === "'") {
            nested = false;
          }
          i++;
        }
        i--; // loop's i++ would otherwise skip the char after ']'
        continue;
      }
      if (inString || inIcon) continue;
      if (ch === '@' && line[i + 1] === '{') {
        // DM braced verbatim string @{...}: skip to the matching '}'.
        let depth = 1;
        i += 2;
        while (i < line.length && depth > 0) {
          const c = line[i];
          if (c === '{') depth++;
          else if (c === '}') depth--;
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
            while (k < line.length && (line[k] === ' ' || line[k] === '\t')) k++;
            if (line[k] === '}') {
              i = k;
              break;
            }
          }
          j++;
        }
        continue;
      }
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  // Split on top-level commas (respecting (), [], {}, string/icon literals and
  // block comments).
  private splitArgs(text: string): string[] {
    const parts: string[] = [];
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
        let depth = 1;
        let nested = false;
        i++;
        current += ch;
        while (i < text.length && depth > 0) {
          const c = text[i];
          current += c;
          if (c === '\\') {
            i++;
            current += text[i] ?? '';
          } else if (!nested) {
            if (c === '"' || c === "'") nested = true;
            else if (c === '[') depth++;
            else if (c === ']') depth--;
          } else if (c === '"' || c === "'") {
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
          if (c === '{') depth++;
          else if (c === '}') depth--;
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
            while (j < text.length && (text[j] === ' ' || text[j] === '\t')) j++;
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
      } else if (ch === ')' || ch === ']' || ch === '}') {
        depth--;
        current += ch;
      } else if (ch === ',' && depth === 0) {
        parts.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    if (current.length > 0 || text.length > 0) {
      parts.push(current);
    }
    return parts;
  }

  private evalIf(expr: string): boolean {
    const s = expr.replace(/\s+/g, '');
    let pos = 0;
    const parseOr = (): boolean => {
      let v = parseAnd();
      while (s.slice(pos, pos + 2) === '||') {
        pos += 2;
        v = v || parseAnd();
      }
      return v;
    };
    const parseAnd = (): boolean => {
      let v = parseNot();
      while (s.slice(pos, pos + 2) === '&&') {
        pos += 2;
        v = v && parseNot();
      }
      return v;
    };
    const parseNot = (): boolean => {
      if (s[pos] === '!') {
        pos++;
        return !parseNot();
      }
      return parsePrimary();
    };
    const parsePrimary = (): boolean => {
      if (s[pos] === '(') {
        pos++;
        const v = parseOr();
        pos++;
        return v;
      }
      if (s.slice(pos, pos + 8) === 'defined(') {
        pos += 8;
        const start = pos;
        while (pos < s.length && s[pos] !== ')') pos++;
        const name = s.slice(start, pos);
        pos++;
        return this.defines.has(name) || this.functionDefines.has(name);
      }
      const start = pos;
      while (pos < s.length && /[A-Za-z0-9_]/.test(s[pos])) pos++;
      const name = s.slice(start, pos);
      return name.length > 0 && (this.defines.has(name) || this.functionDefines.has(name));
    };
    return parseOr();
  }

  // Collect object-like and function-like #defines from a set of source files,
  // mirroring how BYOND exposes a single global macro dictionary to the whole
  // compilation. First definition wins; #if guards are not evaluated here.
  public static collectDefinesFromFiles(files: string[]): CollectedDefines {
    const object = new Map<string, string>();
    const fnMap = new Map<string, FunctionMacro>();
    for (const file of files) {
      let raw: string;
      try {
        raw = fs.readFileSync(file, 'utf-8');
      } catch {
        continue;
      }
      const lines = raw.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (!trimmed.startsWith('#define')) continue;
        let body = trimmed.slice(8).trim();
        while (body.endsWith('\\') && i + 1 < lines.length) {
          body = body.slice(0, -1).trim() + ' ' + lines[++i].trim();
        }
        const m = body.match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\((.*?)\))?\s*(.*)$/);
        if (!m) continue;
        if (m[2] !== undefined) {
          if (!fnMap.has(m[1])) {
            const params = m[2].split(',').map(p => p.trim()).filter(p => p.length > 0);
            let variadic = false;
            const cleanParams: string[] = [];
            for (const p of params) {
              if (p === '...') variadic = true;
              else if (p.endsWith('...')) {
                // Named variadic: #define FOO(focus...) — name is focus.
                variadic = true;
                cleanParams.push(p.slice(0, -3));
              } else cleanParams.push(p);
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
