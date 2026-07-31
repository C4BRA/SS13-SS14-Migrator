export enum TokenType {
  Keyword,
  TypePath,
  Identifier,
  Number,
  StringLiteral,
  FileLiteral,
  Operator,
  Punctuation,
  Indent,
  Dedent,
  Newline,
  EOF
}

export interface Token {
  type: TokenType;
  value: string;
  line: number;
  column: number;
}

import { DiagnosticCollector } from '../diagnostics.js';

export class DMLexer {
  private input: string;
  private pos: number = 0;
  private line: number = 1;
  private col: number = 1;
  public readonly diagnostics = new DiagnosticCollector();

  private static KEYWORDS = new Set([
    'var', 'proc', 'verb', 'const', 'global', 'tmp',
    'if', 'else', 'for', 'while', 'do', 'return', 'break', 'continue',
    'spawn', 'sleep', 'usr', 'src', 'args', 'new', 'del', 'qdel',
    'as', 'in', 'to', 'step', 'prob', 'locate', 'istype', 'ispath',
    'null', 'TRUE', 'FALSE', 'area', 'turf', 'obj', 'mob', 'datum'
  ]);

  constructor(input: string) {
    this.input = input;
  }

  public tokenize(): Token[] {
    const tokens: Token[] = [];
    const indentStack: number[] = [0];

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
          } else if (nextCh === '\t') {
            indent += 4;
            this.advance();
          } else {
            break;
          }
        }

        // If line is empty or comment, ignore indentation changes
        if (this.pos < this.input.length && (this.input[this.pos] === '\n' || (this.input[this.pos] === '/' && (this.peek() === '/' || this.peek() === '*')))) {
          continue;
        }

        const currentIndent = indentStack[indentStack.length - 1];
        if (indent > currentIndent) {
          indentStack.push(indent);
          tokens.push({ type: TokenType.Indent, value: '', line: this.line, column: this.col });
        } else {
          while (indent < indentStack[indentStack.length - 1]) {
            indentStack.pop();
            tokens.push({ type: TokenType.Dedent, value: '', line: this.line, column: this.col });
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
      if (ch === '/' && this.isAlpha(this.peek())) {
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

      // Numbers
      if (this.isDigit(ch)) {
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

      // TypePaths starting with / (e.g. /obj/item/weapon/sword)
      if (ch === '/' && this.isAlpha(this.peek())) {
        tokens.push(this.readTypePath());
        continue;
      }

      // Operators and Punctuation
      const startLine = this.line;
      const startCol = this.col;

      // Multi-char operators
      const twoChar = ch + this.peek();
      const threeChar = ch + this.peek() + (this.pos + 2 < this.input.length ? this.input[this.pos + 2] : '');
      if (['<<=', '>>='].includes(threeChar)) {
        this.advance();
        this.advance();
        this.advance();
        tokens.push({ type: TokenType.Operator, value: threeChar, line: startLine, column: startCol });
        continue;
      }
      if (['==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '&&', '||', '::', '..', '++', '--', '<<', '>>'].includes(twoChar)) {
        this.advance();
        this.advance();
        tokens.push({ type: TokenType.Operator, value: twoChar, line: startLine, column: startCol });
        continue;
      }

      if ('+-*/=<>!&|^?:.'.includes(ch)) {
        this.advance();
        tokens.push({ type: TokenType.Operator, value: ch, line: startLine, column: startCol });
        continue;
      }

      if ('(){}[],;'.includes(ch)) {
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

  private advance(): string {
    const ch = this.input[this.pos++];
    if (ch === '\n') {
      this.line++;
      this.col = 1;
    } else {
      this.col++;
    }
    return ch;
  }

  private peek(): string {
    return this.pos + 1 < this.input.length ? this.input[this.pos + 1] : '';
  }

  private isAlpha(ch: string): boolean {
    return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
  }

  private isDigit(ch: string): boolean {
    return ch >= '0' && ch <= '9';
  }

  private skipLineComment(): void {
    while (this.pos < this.input.length && this.input[this.pos] !== '\n') {
      this.advance();
    }
  }

  private skipBlockComment(): void {
    this.advance(); // /
    this.advance(); // *
    while (this.pos < this.input.length) {
      if (this.input[this.pos] === '*' && this.peek() === '/') {
        this.advance();
        this.advance();
        break;
      }
      this.advance();
    }
  }

  private readTypePath(): Token {
    const startLine = this.line;
    const startCol = this.col;
    let path = '';

    while (this.pos < this.input.length) {
      const ch = this.input[this.pos];
      if (ch === '/' || this.isAlpha(ch) || this.isDigit(ch) || ch === '_') {
        path += ch;
        this.advance();
      } else {
        break;
      }
    }

    return { type: TokenType.TypePath, value: path, line: startLine, column: startCol };
  }

  private readString(quoteChar: string): Token {
    const startLine = this.line;
    const startCol = this.col;
    this.advance(); // quote
    let str = '';
    let closed = false;

    while (this.pos < this.input.length) {
      const ch = this.input[this.pos];
      if (ch === quoteChar) {
        this.advance();
        closed = true;
        break;
      }
      if (ch === '[') {
        // DM string interpolation: [expr] may contain quotes and nested
        // brackets; scan to the matching ']' keeping the raw text.
        let depth = 0;
        while (this.pos < this.input.length) {
          const c = this.input[this.pos];
          if (c === '[') depth++;
          else if (c === ']') {
            depth--;
            if (depth === 0) {
              str += c;
              this.advance();
              break;
            }
          }
          str += c;
          this.advance();
        }
        continue;
      }
      if (ch === '\\') {
        this.advance();
        const esc = this.pos < this.input.length ? this.input[this.pos] : '';
        switch (esc) {
          case 'n': str += '\n'; break;
          case 't': str += '\t'; break;
          case 'r': str += '\r'; break;
          case '\\': str += '\\'; break;
          case '"': str += '"'; break;
          case "'": str += "'"; break;
          default: str += esc; break;
        }
        this.advance();
      } else {
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

  private readNumber(): Token {
    const startLine = this.line;
    const startCol = this.col;
    let numStr = '';

    while (this.pos < this.input.length) {
      const ch = this.input[this.pos];
      if (this.isDigit(ch) || ch === '.') {
        numStr += ch;
        this.advance();
      } else {
        break;
      }
    }

    return { type: TokenType.Number, value: numStr, line: startLine, column: startCol };
  }

  private readIdentifier(): Token {
    const startLine = this.line;
    const startCol = this.col;
    let id = '';

    while (this.pos < this.input.length) {
      const ch = this.input[this.pos];
      if (this.isAlpha(ch) || this.isDigit(ch) || ch === '_') {
        id += ch;
        this.advance();
      } else {
        break;
      }
    }

    return { type: TokenType.Identifier, value: id, line: startLine, column: startCol };
  }
}
