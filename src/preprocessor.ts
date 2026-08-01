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
      if (trimmed.startsWith('#')) {
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
    const state: { inBlockComment: boolean } = { inBlockComment: false };
    while (i < lines.length) {
      let line = lines[i];
      let balance = DMPreprocessor.parenBalance(line, state);
      while (balance > 0 && i + 1 < lines.length) {
        const nextLine = lines[i + 1];
        if (nextLine.trim().startsWith('#')) break;
        line = DMPreprocessor.stripInlineComment(line);
        line += ' ' + DMPreprocessor.stripInlineComment(nextLine).trim();
        balance += DMPreprocessor.parenBalance(nextLine, state);
        i++;
      }
      out.push(line);
      i++;
    }
    return out;
  }

  // Count unbalanced '(' and '[' (string/icon literal aware; stops at //).
  // Block-comment state is carried across lines via `state`.
  private static parenBalance(line: string, state?: { inBlockComment: boolean }): number {
    const blockComment = state ?? { inBlockComment: false };
    let balance = 0;
    let inString = false;
    let inIcon = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (blockComment.inBlockComment) {
        if (ch === '*' && line[i + 1] === '/') {
          blockComment.inBlockComment = false;
          i++;
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
        if (ch === '(' || ch === '[') balance++;
        else if (ch === ')' || ch === ']') balance--;
      } else if (inString && ch === '[') {
        // DM string interpolation [code] may contain nested brackets and
        // quotes; scan to the matching ']' like the lexer does.
        let depth = 1;
        i++;
        while (i < line.length && depth > 0) {
          const c = line[i];
          if (c === '[') depth++;
          else if (c === ']') depth--;
          i++;
        }
        i--;
      } else if (inString && ch === '\\') {
        // Escaped quote inside a string: skip the escaped char.
        i++;
      }
    }
    return balance;
  }

  private static stripInlineComment(line: string): string {
    let inString = false;
    let inIcon = false;
    for (let i = 0; i < line.length - 1; i++) {
      const ch = line[i];
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
    for (let i = open; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"' && !inIcon) {
        inString = !inString;
        continue;
      }
      if (ch === "'" && !inString) {
        inIcon = !inIcon;
        continue;
      }
      if (inString || inIcon) continue;
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  // Split on top-level commas (respecting (), [], {} and string/icon literals).
  private splitArgs(text: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let current = '';
    let inString = false;
    let inIcon = false;
    for (const ch of text) {
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
      if (inString || inIcon) {
        current += ch;
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
