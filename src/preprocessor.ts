import * as fs from 'fs';
import * as path from 'path';
import { DiagnosticCollector } from './diagnostics.js';

interface CondFrame {
  parentActive: boolean;
  branchTaken: boolean;
  active: boolean;
}

export class DMPreprocessor {
  private defines = new Map<string, string>();
  private includeStack: string[] = [];
  private collector: DiagnosticCollector;

  constructor(collector: DiagnosticCollector) {
    this.collector = collector;
  }

  process(code: string, filePath: string): string {
    const absPath = path.resolve(filePath);
    if (this.includeStack.includes(absPath)) {
      this.collector.error(`Recursive #include of '${path.basename(absPath)}'`, 0, 0);
      return '';
    }
    this.includeStack.push(absPath);
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
    const lines = code.split('\n');
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
              name === 'ifdef' ? this.defines.has(arg)
                : name === 'ifndef' ? !this.defines.has(arg)
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
            const dm = arg.match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\((.*)\))?\s*(.*)$/);
            if (!dm) break;
            if (dm[2] !== undefined) {
              this.collector.warning(`Function-like #define '${dm[1]}' not supported (out of scope)`, i + 1, 1);
              break;
            }
            this.defines.set(dm[1], dm[3].trim());
            break;
          }
          case 'undef': {
            if (!isActive()) break;
            this.defines.delete(arg);
            break;
          }
          case 'include': {
            if (!isActive()) break;
            const im = arg.match(/^["<]([^">]+)[">]$/);
            if (!im) {
              this.collector.error('Malformed #include directive', i + 1, 1);
              break;
            }
            const incPath = path.resolve(dir, im[1]);
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
        out.push(this.expandMacros(raw));
      }
    }

    if (condStack.length > 0) {
      this.collector.error('Unterminated #if/#ifdef block (missing #endif)', 1, 1);
    }
    return out.join('\n');
  }

  private stripComment(line: string): string {
    const idx = line.indexOf('//');
    return idx >= 0 ? line.slice(0, idx) : line;
  }

  private expandMacros(line: string): string {
    let result = '';
    let i = 0;
    let inString = false;
    let inIcon = false;
    while (i < line.length) {
      const ch = line[i];
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
        result += this.defines.has(word) ? this.defines.get(word)! : word;
        i = j;
        continue;
      }
      result += ch;
      i++;
    }
    return result;
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
        return this.defines.has(name);
      }
      const start = pos;
      while (pos < s.length && /[A-Za-z0-9_]/.test(s[pos])) pos++;
      const name = s.slice(start, pos);
      return name.length > 0 && this.defines.has(name);
    };
    return parseOr();
  }
}
