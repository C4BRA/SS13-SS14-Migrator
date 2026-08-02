import { DMLexer, Token, TokenType } from './dmLexer.js';
import { DiagnosticCollector } from '../diagnostics.js';

export interface ASTNode {
  type: string;
}

// Expression AST Nodes
export type ExpressionNode =
  | { type: 'literal'; value: string | number | boolean | null; literalType: 'string' | 'number' | 'bool' | 'null' }
  | { type: 'variable'; name: string }
  | { type: 'binary'; operator: string; left: ExpressionNode; right: ExpressionNode }
  | { type: 'unary'; operator: string; operand: ExpressionNode }
  | { type: 'call'; name: string; target?: ExpressionNode; arguments: ExpressionNode[] }
  | { type: 'new'; typePath: string; arguments: ExpressionNode[] }
  | { type: 'ternary'; condition: ExpressionNode; trueExpr: ExpressionNode; falseExpr: ExpressionNode }
  | { type: 'index'; target: ExpressionNode; index: ExpressionNode }
  | { type: 'property'; target: ExpressionNode; property: string }
  | { type: 'assignment'; target: string; value: ExpressionNode }
  | { type: 'property_assignment'; target: ExpressionNode; property: string; value: ExpressionNode }
  | { type: 'index_assignment'; target: ExpressionNode; index: ExpressionNode; value: ExpressionNode }
  | { type: 'list'; elements: ExpressionNode[] }
  | { type: 'range'; start: ExpressionNode; end: ExpressionNode };

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
  initialValueExpr?: ExpressionNode; // Parsed expression for initial value
}

export interface DMProcDeclNode extends ASTNode {
  type: 'DMProcDecl';
  name: string;
  args: { name: string; typeHint?: string }[];
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
  // For expression statements, store the parsed expression AST
  expression?: ExpressionNode;
  // For return statements
  returnValue?: ExpressionNode;
  // For assignments
  assignmentTarget?: string;
  assignmentValue?: ExpressionNode;
  // For if statements
  condition?: ExpressionNode;
  thenBranch?: DMStatementNode[];
  elseBranch?: DMStatementNode[];
  // For loops
  loopVariable?: string;
  loopRange?: ExpressionNode;
  loopBody?: DMStatementNode[];
  // For sleep/spawn
  timeExpr?: ExpressionNode;
  // For variable declarations inside proc
  varName?: string;
  varType?: string;
  varInit?: ExpressionNode;
  // For delete statements
  target?: ExpressionNode;
  // For switch statements
  switchValue?: ExpressionNode;
  switchCases?: { values: ExpressionNode[]; body: DMStatementNode[] }[];
  defaultBody?: DMStatementNode[];
}

export class DMParser {
  private tokens: Token[];
  private pos: number = 0;
  public readonly diagnostics: DiagnosticCollector;
  // Global variable declarations (/global/var/x = v). Not yet materialized in
  // IR output — collected so nothing is silently dropped.
  public globalVars: DMGlobalVarDeclNode[] = [];

  constructor(tokens: Token[], collector?: DiagnosticCollector) {
    this.tokens = tokens;
    this.diagnostics = collector ?? new DiagnosticCollector();
  }

  public parse(): DMTypeDeclNode[] {
    const typeDecls: Map<string, DMTypeDeclNode> = new Map();
    let currentTypePath = '/datum';

    while (this.pos < this.tokens.length && !this.isType(TokenType.EOF)) {
      this.skipNewlines();

      if (this.isType(TokenType.EOF)) break;

      // Stray indentation at top level (e.g. from comment-only lines) is not
      // valid DM structure; skip it instead of erroring.
      if (this.isType(TokenType.Indent)) {
        this.advance();
        continue;
      }

      const token = this.peek();

      // Top level type declaration (e.g. /obj/item/weapon/sword or /obj/item/proc/swing)
      if (token.type === TokenType.TypePath) {
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
        const globalNode: DMGlobalVarDeclNode = {
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
      const varDeclMatch = rawPath.match(/^(.+)\/var\/(global\/)?(.+)$/);
      if (varDeclMatch) {
        const ownerPath = varDeclMatch[1];
        const isGlobal = varDeclMatch[2] !== undefined;
        const rest = varDeclMatch[3].split('/').filter((s) => s.length > 0);
        const varName = rest.pop() ?? '';
        const varType = rest.join('/');
        let initialValue = '';
        if (this.matchOperator('=')) {
          initialValue = this.parseInitialValueText();
        }
        if (isGlobal) {
          this.globalVars.push({ type: 'GlobalVarDecl', name: varName, varType, initialValue, initialValueExpr: this.parseInitializerTextToExpr(initialValue) });
        } else {
          const ownerNode = this.getOrCreateTypeNode(ownerPath, typeDecls);
          ownerNode.vars.push({ type: 'DMVarDecl', name: varName, varType, initialValue });
        }
        continue;
      }

        // Check if path represents a proc definition: e.g. /obj/item/proc/swing
        const procMatch = rawPath.match(/^(.+)\/(proc|verb)\/([^\/]+)$/);
        if (procMatch) {
          const ownerPath = procMatch[1];
          const procName = procMatch[3];
          const ownerNode = this.getOrCreateTypeNode(ownerPath, typeDecls);

          const args = this.parseProcArgs();

          // Optional return type: /proc/foo(...) as /list
          if (this.peek().value === 'as') {
            this.advance();
            if (this.isType(TokenType.TypePath) || this.isType(TokenType.Identifier) || this.isType(TokenType.Keyword)) {
              this.advance();
            }
          }

          const procNode: DMProcDeclNode = {
            type: 'DMProcDecl',
            name: procName,
            args,
            statements: []
          };

          this.skipNewlines();
          if (this.isType(TokenType.Punctuation) && this.peek().value === '{') {
            this.advance();
            procNode.statements = this.parseProcBody(true);
            this.matchPunctuation('}');
          } else if (this.isType(TokenType.Indent)) {
            this.advance();
            procNode.statements = this.parseProcBody();
          } else {
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
        if (this.isType(TokenType.Punctuation) && this.peek().value === '(') {
          const lastSlash = rawPath.lastIndexOf('/');
          if (lastSlash > 0) {
            const ownerPath = rawPath.slice(0, lastSlash);
            const procName = rawPath.slice(lastSlash + 1);
            const ownerNode = this.getOrCreateTypeNode(ownerPath, typeDecls);

            const args = this.parseProcArgs();

            // Optional return type: /path/foo(...) as /list
            if (this.peek().value === 'as') {
              this.advance();
              if (this.isType(TokenType.TypePath) || this.isType(TokenType.Identifier) || this.isType(TokenType.Keyword)) {
                this.advance();
              }
            }

            const procNode: DMProcDeclNode = {
              type: 'DMProcDecl',
              name: procName,
              args,
              statements: []
            };

            this.skipNewlines();
            if (this.isType(TokenType.Punctuation) && this.peek().value === '{') {
              this.advance();
              procNode.statements = this.parseProcBody(true);
              this.matchPunctuation('}');
            } else if (this.isType(TokenType.Indent)) {
              this.advance();
              procNode.statements = this.parseProcBody();
            } else {
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
        const currentTypeNode = typeDecls.get(currentTypePath)!;

        // Check if inline block follows
        this.skipNewlines();
        if (this.isType(TokenType.Punctuation) && this.peek().value === '{') {
          this.advance();
          this.parseTypeBlock(currentTypeNode, typeDecls, true);
          this.matchPunctuation('}');
        } else if (this.isType(TokenType.Indent)) {
          this.advance();
          this.parseTypeBlock(currentTypeNode, typeDecls);
        } else if (this.peek().value === '=') {
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
      if (token.type === TokenType.Identifier) {
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

      // Top-level token we don't understand: report and recover
      const skip = this.advance();
      this.diagnostics.error(`Unexpected top-level token '${skip.value}'`, skip.line, skip.column);
    }

    return Array.from(typeDecls.values());
  }

  private parseTypeBlock(currentTypeNode: DMTypeDeclNode, typeDecls: Map<string, DMTypeDeclNode>, stopAtBrace: boolean = false): void {
    const atClosingBrace = (): boolean =>
      stopAtBrace && this.isType(TokenType.Punctuation) && this.peek().value === '}';

    while (!this.isType(TokenType.Dedent) && !this.isType(TokenType.EOF) && !atClosingBrace()) {
      this.skipNewlines();
      if (this.isType(TokenType.Dedent) || this.isType(TokenType.EOF) || atClosingBrace()) break;

      const token = this.peek();

      // Statement separators in { } bodies (macro-generated type decls)
      if (this.isType(TokenType.Punctuation) && this.peek().value === ';') {
        this.advance();
        continue;
      }

      // Sub-path under block (e.g. sword)
      if (token.type === TokenType.TypePath || (token.type === TokenType.Identifier && this.peekNext()?.type === TokenType.TypePath)) {
        const subPath = token.type === TokenType.TypePath ? token.value : '/' + token.value;
        const fullPath = currentTypeNode.path + (subPath.startsWith('/') ? subPath : '/' + subPath);
        this.advance();

        const subTypeNode = this.getOrCreateTypeNode(fullPath, typeDecls);

        this.skipNewlines();
        if (this.isType(TokenType.Indent)) {
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

      // Var assignment override (e.g. name = "Sword", density = 1)
      if (token.type === TokenType.Identifier) {
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

      // Unrecognized member: report and recover
      const skip = this.advance();
      this.diagnostics.error(`Unexpected token '${skip.value}' in type block`, skip.line, skip.column);
    }

    if (this.isType(TokenType.Dedent)) {
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
  private parseProcArgs(): { name: string; typeHint?: string }[] {
    const args: { name: string; typeHint?: string }[] = [];
    if (!this.matchPunctuation('(')) return args;

    // Track parenthesis nesting: defaults like `controller in list("A", "B")`
    // or `flag = (1<<5)` contain nested parens and commas that must not
    // terminate or split the argument list.
    let depth = 0;
    while (!this.isType(TokenType.EOF)) {
      const tok = this.peek();
      if (tok.type === TokenType.Punctuation && tok.value === ')') {
        if (depth === 0) {
          this.advance();
          break;
        }
        depth--;
        this.advance();
        continue;
      }
      if (tok.type === TokenType.Punctuation && tok.value === '(') {
        depth++;
        this.advance();
        continue;
      }
      if (depth === 0 && tok.type === TokenType.Punctuation && tok.value === ',') {
        this.advance();
        continue;
      }
      const arg = this.parseProcArg();
      if (arg) args.push(arg);
    }
    return args;
  }

  private parseProcArg(): { name: string; typeHint?: string } | null {
    const tok = this.peek();
    let name = '';
    let typeHint: string | undefined;

    const splitPath = (pathVal: string): void => {
      const lastSlash = pathVal.lastIndexOf('/');
      if (lastSlash > 0) {
        typeHint = pathVal.substring(0, lastSlash);
        name = pathVal.substring(lastSlash + 1);
      } else {
        name = pathVal.replace(/^\//, '');
      }
    };

    if (tok.type === TokenType.TypePath) {
      splitPath(this.advance().value);
    } else if (tok.type === TokenType.Identifier || tok.type === TokenType.Keyword) {
      this.advance();
      if (tok.value === 'var') {
        // var/x or var x — explicit local declaration
        const next = this.peek();
        if (next.type === TokenType.TypePath) {
          splitPath(this.advance().value);
        } else if (next.type === TokenType.Identifier || next.type === TokenType.Keyword) {
          name = this.advance().value;
        }
      } else if (this.peek().type === TokenType.TypePath) {
        // mob/user — keyword/identifier type hint followed by /name
        splitPath(this.advance().value);
      } else {
        // Plain name; DM keyword names (args, usr, src) must not be dropped.
        name = tok.value;
      }
    } else {
      this.advance(); // skip unrecognized junk
    }

    // Optional `as <type>` clause — parsed and dropped.
    if (this.peek().value === 'as') {
      this.advance();
      if (this.isType(TokenType.Identifier) || this.isType(TokenType.TypePath) || this.isType(TokenType.Keyword)) {
        this.advance();
      }
    }
    // Optional default value: epsilon = (1E-4 * 20) — consumed and dropped.
    if (name && this.matchOperator('=')) {
      this.parseExpression();
    }
    if (!name) return null;
    return { name, typeHint };
  }

  /**
   * Capture the remaining tokens of the current line as raw source text.
   * Used for type-level var initial values, which may be full expressions
   * (e.g. `var/list/stuff = list(1, 2, 3)`); the text is preserved for the
   * YAML initialVars rather than silently dropping everything after the
   * first token.
   */
  private parseInitialValueText(): string {
    const parts: string[] = [];
    let depth = 0;
    while (!this.isType(TokenType.EOF)) {
      const token = this.peek();
      if (token.type === TokenType.Newline && depth === 0) break;
      if (token.type === TokenType.Dedent && depth === 0) break;
      if (token.type === TokenType.Punctuation && token.value === ';' && depth === 0) break;
      if (token.type === TokenType.Indent || token.type === TokenType.Newline) {
        // Inside multiline list()/bracket initializers, indentation and
        // newlines are just whitespace (classic DM allows lists to span lines).
        if (token.type === TokenType.Newline) parts.push(' ');
        this.advance();
        continue;
      }
      const value = this.advance().value;
      if (value === '(' || value === '[' || value === '{') depth++;
      else if (value === ')' || value === ']' || value === '}') depth--;
      parts.push(value);
    }
    return parts.join(' ').trim();
  }

  /**
   * Re-parse a captured initializer string (see parseInitialValueText) into a
   * full expression tree. Globals are declared at top level where no statement
   * parser is running, so their initializers are re-lexed into a sub-parser.
   */
  public parseInitializerTextToExpr(text: string): ExpressionNode | null {
    if (!text) return null;
    try {
      const tokens = new DMLexer(text).tokenize();
      const sub = new DMParser(tokens, this.diagnostics);
      return sub.parseExpression() ?? null;
    } catch {
      return null;
    }
  }

  private parseMemberDecl(targetTypeNode: DMTypeDeclNode): void {
    const keyword = this.advance().value; // var, proc, verb

    if (keyword === 'var') {
      let varType: string | undefined;
      if (this.isType(TokenType.Operator) && this.peek().value === '/') {
        this.advance();
      }
      let varName = '';
      if (this.isType(TokenType.TypePath)) {
        // var/type/name or var /type/name: split into type and last segment
        const pathVal = this.advance().value;
        const lastSlash = pathVal.lastIndexOf('/');
        if (lastSlash > 0) {
          varType = pathVal.substring(0, lastSlash);
          varName = pathVal.substring(lastSlash + 1);
        } else {
          varName = pathVal.replace(/^\//, '');
        }
      } else if (this.isType(TokenType.Identifier)) {
        varName = this.advance().value;
      }
      // Block var declaration: `var` (or a trailing pseudo-var like
      // `var/SpacemanDMM_private` from VAR_PRIVATE) on its own line followed
      // by indented `type/name = value` lines.
      if (this.isType(TokenType.Newline)) {
        this.skipNewlines();
        if (this.isType(TokenType.Indent)) {
          while (!this.isType(TokenType.Dedent) && !this.isType(TokenType.EOF)) {
            if (this.isType(TokenType.Indent)) this.advance();
            this.skipNewlines();
            if (this.isType(TokenType.Dedent) || this.isType(TokenType.EOF)) break;
            let blockType: string | undefined;
            let blockName = '';
            if (this.isType(TokenType.TypePath)) {
              const pathVal = this.advance().value;
              const lastSlash = pathVal.lastIndexOf('/');
              if (lastSlash > 0) {
                blockType = pathVal.substring(0, lastSlash);
                blockName = pathVal.substring(lastSlash + 1);
              } else {
                blockName = pathVal.replace(/^\//, '');
              }
            } else if (this.isType(TokenType.Identifier)) {
              blockName = this.advance().value;
            } else {
              this.advance();
              continue;
            }
            let initialVal: any = null;
            if (this.isType(TokenType.Punctuation) && this.peek().value === '[') {
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
          if (this.isType(TokenType.Dedent)) this.advance();
          return;
        }
      }
      let initialVal: any = null;
      // Initialized length: var/list/screen_groups[6] — drop the length expr.
      if (this.isType(TokenType.Punctuation) && this.peek().value === '[') {
        this.advance();
        if (!(this.isType(TokenType.Punctuation) && this.peek().value === ']')) {
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
    } else if (keyword === 'proc' || keyword === 'verb') {
      let procName = '';
      if (this.isType(TokenType.Operator) && this.peek().value === '/') {
        this.advance();
      }
      if (this.isType(TokenType.TypePath)) {
        procName = this.advance().value.replace(/^\//, '');
      } else if (this.isType(TokenType.Identifier)) {
        procName = this.advance().value;
      }

      if (procName) {
        const args = this.parseProcArgs();

        // Optional return type: /proc/foo(...) as /list
        if (this.peek().value === 'as') {
          this.advance();
          if (this.isType(TokenType.TypePath) || this.isType(TokenType.Identifier) || this.isType(TokenType.Keyword)) {
            this.advance();
          }
        }

        const procNode: DMProcDeclNode = {
          type: 'DMProcDecl',
          name: procName,
          args,
          statements: []
        };

        // Parse proc body if block exists
        this.skipNewlines();
        if (this.isType(TokenType.Punctuation) && this.peek().value === '{') {
          this.advance();
          procNode.statements = this.parseProcBody(true);
          this.matchPunctuation('}');
        } else if (this.isType(TokenType.Indent)) {
          this.advance();
          procNode.statements = this.parseProcBody();
        } else {
          procNode.statements = this.parseProcBody(false, true);
        }

        targetTypeNode.procs.push(procNode);
      }
    }
  }

  private parseProcBody(stopAtBrace: boolean = false, inline: boolean = false): DMStatementNode[] {
    const statements: DMStatementNode[] = [];
    const atClosingBrace = (): boolean =>
      stopAtBrace && this.isType(TokenType.Punctuation) && this.peek().value === '}';

    while (!this.isType(TokenType.Dedent) && !this.isType(TokenType.EOF) && !atClosingBrace()) {
      if (!inline) this.skipNewlines();
      if (this.isType(TokenType.Dedent) || this.isType(TokenType.EOF) || atClosingBrace()) break;
      // Inline (single-line) bodies: a Newline ends the body — and so does a
      // top-level TypePath, because the parser may have skipped blank lines
      // and the "body" is actually the next /type/proc/ declaration.
      if (inline && (this.isType(TokenType.Newline) || this.isType(TokenType.TypePath))) break;

      // Statement separators: inside { } bodies and single-line statements
      if (this.isType(TokenType.Punctuation) && this.peek().value === ';') {
        this.advance();
        continue;
      }

      // DM `set` statements: set name = "x" / set hidden = FALSE — parsed
      // and dropped (they only affect the verb's UI configuration).
      if (this.peek().value === 'set') {
        this.advance();
        if (this.isType(TokenType.Identifier) || this.isType(TokenType.Keyword)) {
          this.advance();
        }
        if (this.matchOperator('=')) {
          this.parseExpression();
        }
        if (this.isType(TokenType.Punctuation) && this.peek().value === ';') {
          this.advance();
        }
        continue;
      }

      // try { ... } catch(var/exception/e) { ... } — exception handling.
      if (this.peek().value === 'try') {
        this.advance();
        this.skipNewlines();
        const tryBody: DMStatementNode[] = [];
        if (this.isType(TokenType.Punctuation) && this.peek().value === '{') {
          this.advance();
          tryBody.push(...this.parseProcBody(true));
          this.matchPunctuation('}');
        } else if (this.isType(TokenType.Indent)) {
          this.advance();
          tryBody.push(...this.parseProcBody());
        }
        let catchVar: string | undefined;
        let catchBody: DMStatementNode[] = [];
        this.skipNewlines();
        if (this.peek().value === 'catch') {
          this.advance();
          if (this.matchPunctuation('(')) {
            let catchPath = '';
            if (this.isType(TokenType.Keyword) && this.peek().value === 'var') {
              this.advance();
            }
            if (this.isType(TokenType.TypePath) || this.isType(TokenType.Identifier)) {
              catchPath = this.advance().value;
            }
            if (catchPath) {
              const lastSlash = catchPath.lastIndexOf('/');
              catchVar = lastSlash > 0 ? catchPath.substring(lastSlash + 1) : catchPath.replace(/^\//, '');
            }
            this.matchPunctuation(')');
          }
          this.skipNewlines();
          if (this.isType(TokenType.Punctuation) && this.peek().value === '{') {
            this.advance();
            catchBody.push(...this.parseProcBody(true));
            this.matchPunctuation('}');
          } else if (this.isType(TokenType.Indent)) {
            this.advance();
            catchBody.push(...this.parseProcBody());
          }
        }
        statements.push({ type: 'TryStatement', tryBody, catchVar, catchBody } as any);
        continue;
      }

      // continue / break statements (optionally with a label: break set_adj_in_dir)
      const ctrlToken = this.peek().value;
      if (ctrlToken === 'continue' || ctrlToken === 'break') {
        this.advance();
        let label: string | undefined;
        if (this.isType(TokenType.Identifier) || this.isType(TokenType.Keyword)) {
          label = this.advance().value;
        }
        statements.push({ type: ctrlToken === 'continue' ? 'ContinueStatement' : 'BreakStatement', label });
        continue;
      }

      // Labeled block: name: { ... } — break name jumps out (treated as a scope)
      if (this.isType(TokenType.Identifier) && this.peekNext()?.value === ':') {
        const labelName = this.peek().value;
        this.advance();
        this.advance(); // :
        this.skipNewlines();
        let labeled: DMStatementNode[] = [];
        if (this.isType(TokenType.Punctuation) && this.peek().value === '{') {
          this.advance();
          labeled = this.parseProcBody(true);
          this.matchPunctuation('}');
        } else if (this.isType(TokenType.Indent)) {
          this.advance();
          labeled = this.parseProcBody();
        }
        statements.push({ type: 'LabeledBlockStatement', label: labelName, body: labeled });
        continue;
      }

      const token = this.peek();

      if (token.value === 'return') {
        this.advance();
        let returnValue: ExpressionNode | undefined;
        const nextVal = this.peek().value;
        if (!this.isType(TokenType.Newline) && !this.isType(TokenType.Dedent) && nextVal !== ';' && nextVal !== '}') {
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
        this.advance();
        this.matchPunctuation('(');
        let loopVar = '';
        if (this.isType(TokenType.Identifier)) {
          loopVar = this.advance().value;
        } else if (this.peek().value === 'var') {
          // for(var/i in list) or for(var i in list)
          this.advance();
          if (this.isType(TokenType.TypePath)) {
            const pathVal = this.advance().value;
            const lastSlash = pathVal.lastIndexOf('/');
            loopVar = lastSlash > 0 ? pathVal.substring(lastSlash + 1) : pathVal.replace(/^\//, '');
          } else if (this.isType(TokenType.Identifier)) {
            loopVar = this.advance().value;
          } else if (this.isType(TokenType.Keyword)) {
            // for(var/turf in turfs) — type keyword used as the loop variable name
            loopVar = this.advance().value;
          } else if (this.isType(TokenType.Operator) && this.peek().value === '/') {
            this.advance();
            if (this.isType(TokenType.Identifier) || this.isType(TokenType.Keyword)) {
              loopVar = this.advance().value;
            }
          }
        }
        this.skipNewlines();
        // DM multi-var loop: for(var/gas_path, amount in gasmix.moles) — the
        // ', X' groups are only loop variables when the head contains a
        // top-level 'in'; otherwise the ',' starts a C-style for with a bare
        // expression init: for(words, words > 0, words--).
        if (this.peek().value === ',' && this.isMultiVarLoopHead()) {
          while (this.matchPunctuation(',')) {
            if (this.isType(TokenType.TypePath)) {
              this.advance();
            } else if (this.isType(TokenType.Identifier) || this.isType(TokenType.Keyword)) {
              this.advance();
            }
          }
        }
        // for(var/x as anything in list) — 'as' filter clause; parse and drop
        // the type hint so the 'in' clause below still matches.
        if (this.peek().value === 'as') {
          this.advance();
          while (!this.isType(TokenType.EOF) && this.peek().value !== 'in') {
            this.advance();
          }
        }
        if (this.peek().value === 'in') {
          this.advance();
          const loopRange = this.parseExpression();
          let step: ExpressionNode | undefined;
          if (this.peek().value === 'step') {
            this.advance();
            step = this.parseExpression();
          }
          this.matchPunctuation(')');
          this.skipNewlines();
          let loopBody: DMStatementNode[] = [];
          if (this.isType(TokenType.Indent)) {
            this.advance();
            loopBody = this.parseProcBody();
          } else if (this.isType(TokenType.Punctuation) && this.peek().value === '{') {
            this.advance();
            loopBody = this.parseProcBody(true);
            this.matchPunctuation('}');
          }
          statements.push({ type: 'ForStatement', loopVariable: loopVar, loopRange, step, loopBody });
          continue;
        }
        if (loopVar && this.matchPunctuation(')')) {
          // for(var/datum/thing) — iterate all instances of the declared type
          this.skipNewlines();
          let loopBody: DMStatementNode[] = [];
          if (this.isType(TokenType.Indent)) {
            this.advance();
            loopBody = this.parseProcBody();
          } else if (this.isType(TokenType.Punctuation) && this.peek().value === '{') {
            this.advance();
            loopBody = this.parseProcBody(true);
            this.matchPunctuation('}');
          }
          statements.push({ type: 'ForStatement', loopVariable: loopVar, loopRange: undefined, step: undefined, loopBody });
          continue;
        }
        if (loopVar && this.matchOperator('=')) {
          // DM C-style for: for(var/i = init, cond, incr)
          const init = this.parseExpression();
          if (init.type === 'binary' && init.operator === 'to') {
            // Classic DM form: for(var/i = 1 to 5)
            let step: ExpressionNode | undefined;
            if (this.peek().value === 'step') {
              this.advance();
              step = this.parseExpression();
            }
            this.matchPunctuation(')');
            this.skipNewlines();
            let loopBody: DMStatementNode[] = [];
            if (this.isType(TokenType.Indent)) {
              this.advance();
              loopBody = this.parseProcBody();
            } else if (this.isType(TokenType.Punctuation) && this.peek().value === '{') {
              this.advance();
              loopBody = this.parseProcBody(true);
              this.matchPunctuation('}');
            }
            const loopRange: ExpressionNode = { type: 'range', start: init.left, end: init.right };
            statements.push({ type: 'ForStatement', loopVariable: loopVar, loopRange, step, loopBody });
            continue;
          }
          if (this.matchPunctuation(',') || this.matchPunctuation(';')) {
            const condition = this.parseExpression();
            this.matchPunctuation(',') || this.matchPunctuation(';');
            const increment = this.parseExpression();
            this.matchPunctuation(')');
            this.skipNewlines();
            let loopBody: DMStatementNode[] = [];
            if (this.isType(TokenType.Indent)) {
              this.advance();
              loopBody = this.parseProcBody();
            } else if (this.isType(TokenType.Punctuation) && this.peek().value === '{') {
              this.advance();
              loopBody = this.parseProcBody(true);
              this.matchPunctuation('}');
            }
            statements.push({
              type: 'CForStatement',
              loopVariable: loopVar,
              init,
              condition,
              increment,
              loopBody
            });
            continue;
          }
        }

        // C-style for with a bare expression init: for(words, words>0, words--)
        // — the first expression was already consumed as loopVar; the ';' form
        // has an empty init; compound-assign inits (for(i += x, ...)) parse
        // the whole init as an expression.
        if (this.peek().value === ',' || this.peek().value === ';' ||
            this.peek().value === '+=' || this.peek().value === '-=' || this.peek().value === '*=' || this.peek().value === '/=' ||
            this.peek().value === '%=' || this.peek().value === '&=' || this.peek().value === '|=' || this.peek().value === '^=') {
          let init: ExpressionNode | undefined;
        if (this.peek().value === ',' || this.peek().value === ';') {
          if (loopVar) {
            init = { type: 'variable', name: loopVar };
          }
          if (this.peek().value === ',') this.advance();
          else this.advance(); // ';'
        } else if (loopVar) {
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
        } else {
          init = this.parseExpression();
        }
          const condition = this.parseExpression();
          this.matchPunctuation(',') || this.matchPunctuation(';');
          const increment = this.parseExpression();
          this.matchPunctuation(')');
          this.skipNewlines();
          let loopBody: DMStatementNode[] = [];
          if (this.isType(TokenType.Indent)) {
            this.advance();
            loopBody = this.parseProcBody();
          } else if (this.isType(TokenType.Punctuation) && this.peek().value === '{') {
            this.advance();
            loopBody = this.parseProcBody(true);
            this.matchPunctuation('}');
          }
          statements.push({
            type: 'CForStatement',
            loopVariable: loopVar,
            init,
            condition,
            increment,
            loopBody
          });
          continue;
        }
      }

      if (token.value === 'do') {
        this.advance();
        this.skipNewlines();
        let loopBody: DMStatementNode[] = [];
        if (this.isType(TokenType.Punctuation) && this.peek().value === '{') {
          this.advance();
          loopBody = this.parseProcBody(true);
          this.matchPunctuation('}');
        } else if (this.isType(TokenType.Indent)) {
          this.advance();
          loopBody = this.parseProcBody();
        }
        this.skipNewlines();
        if (this.peek().value === 'while') {
          this.advance();
          const condition = this.parseExpression();
          statements.push({ type: 'DoWhileStatement', condition, loopBody });
          continue;
        }
        const bad = this.peek();
        this.diagnostics.error(`Expected 'while (condition)' after 'do' block, found '${bad.value}'`, bad.line, bad.column);
        statements.push({ type: 'DoWhileStatement', condition: undefined, loopBody });
        continue;
      }

      if (token.value === 'while') {
        this.advance();
        const condition = this.parseExpression();
        this.skipNewlines();
        let loopBody: DMStatementNode[] = [];
        if (this.isType(TokenType.Punctuation) && this.peek().value === '{') {
          this.advance();
          loopBody = this.parseProcBody(true);
          this.matchPunctuation('}');
        } else if (this.isType(TokenType.Indent)) {
          this.advance();
          loopBody = this.parseProcBody();
        }
        statements.push({ type: 'WhileStatement', condition, loopBody });
        continue;
      }

      if (token.value === 'sleep' || token.value === 'spawn') {
        const kind = token.value;
        this.advance();
        let timeExpr: ExpressionNode | undefined;
        if (this.matchPunctuation('(')) {
          timeExpr = this.parseExpression();
          this.matchPunctuation(')');
        }
        let body: DMStatementNode[] = [];
        if (kind === 'spawn') {
          this.skipNewlines();
          if (this.isType(TokenType.Punctuation) && this.peek().value === '{') {
            this.advance();
            body = this.parseProcBody(true);
            this.matchPunctuation('}');
          } else if (this.isType(TokenType.Indent)) {
            this.advance();
            body = this.parseProcBody();
          }
        }
        statements.push({ type: kind === 'sleep' ? 'SleepStatement' : 'SpawnStatement', timeExpr, body });
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
        if (this.isType(TokenType.Identifier) || this.isType(TokenType.Keyword)) {
          this.advance();
        }
        if (this.peek().value === 'in') {
          this.advance();
          this.parseExpression();
        } else if (this.matchOperator('=')) {
          this.parseExpression();
        }
        continue;
      }

      // switch (x) with BYOND case syntax: if (v1, v2) / else
      if (token.value === 'switch') {
        this.advance();
        const switchValue = this.parseExpression();
        this.skipNewlines();
        const cases: { values: ExpressionNode[]; body: DMStatementNode[] }[] = [];
        let defaultBody: DMStatementNode[] | undefined;
        // Brace form: switch(x) { if(1) {...} else {...} } — the '{' may sit
        // on its own indented line (macro-expanded switch bodies).
        let braceForm = this.isType(TokenType.Punctuation) && this.peek().value === '{';
        // Indents this handler consumed; the matching Dedents are drained at
        // the end so enclosing scopes still see their own Dedent.
        let pendingIndents = 0;
        if (this.isType(TokenType.Indent) || braceForm) {
          if (this.isType(TokenType.Indent)) {
            this.advance(); // block Indent
            pendingIndents += 1;
          }
          if (this.isType(TokenType.Punctuation) && this.peek().value === '{') {
            this.advance();
            braceForm = true;
          }
          while (true) {
            if (this.isType(TokenType.EOF)) break;
            if (!braceForm && this.isType(TokenType.Dedent)) break;
            if (braceForm && this.isType(TokenType.Punctuation) && this.peek().value === '}') break;
            this.skipNewlines();
            if (braceForm && this.isType(TokenType.Indent)) {
              this.advance(); // indentation is irrelevant inside { } switch blocks
              pendingIndents += 1;
            }
            if (this.isType(TokenType.Dedent) || this.isType(TokenType.EOF)) break;
            if (braceForm && this.isType(TokenType.Punctuation) && this.peek().value === '}') break;
            if (this.peek().value === 'if') {
              this.advance();
              this.matchPunctuation('(');
              const values: ExpressionNode[] = [];
              while (!this.matchPunctuation(')') && !this.isType(TokenType.EOF)) {
                values.push(this.parseExpression());
                if (this.matchPunctuation(',')) continue;
              }
              this.skipNewlines();
              let body: DMStatementNode[] = [];
              if (this.isType(TokenType.Indent)) {
                this.advance();
                // parseProcBody drains its own first Dedent (back to the case
                // level); further Dedents (switch end, enclosing scopes) are
                // left for the break-check / end handling below.
                body = this.parseProcBody();
              } else if (this.isType(TokenType.Punctuation) && this.peek().value === '{') {
                this.advance();
                body = this.parseProcBody(true);
                this.matchPunctuation('}');
              } else if (!braceForm && !this.isType(TokenType.Dedent) && !this.isType(TokenType.EOF) && !this.isType(TokenType.Newline)) {
                body = [this.parseSingleStatement()];
              } else if (braceForm && !this.isType(TokenType.Newline) && !this.isType(TokenType.EOF) && !(this.isType(TokenType.Punctuation) && this.peek().value === '}')) {
                body = [this.parseSingleStatement()];
              }
              cases.push({ values, body });
              this.skipNewlines();
              if (!braceForm && !this.isType(TokenType.EOF) && this.peek().value !== 'if' && this.peek().value !== 'else') break;
            } else if (this.peek().value === 'else') {
              this.advance();
              this.skipNewlines();
              if (this.isType(TokenType.Indent)) {
                this.advance();
                defaultBody = this.parseProcBody();
              } else if (this.isType(TokenType.Punctuation) && this.peek().value === '{') {
                this.advance();
                defaultBody = this.parseProcBody(true);
                this.matchPunctuation('}');
              } else if (!braceForm && !this.isType(TokenType.Dedent) && !this.isType(TokenType.EOF) && !this.isType(TokenType.Newline)) {
                defaultBody = [this.parseSingleStatement()];
              } else if (braceForm && !this.isType(TokenType.Newline) && !this.isType(TokenType.EOF) && !(this.isType(TokenType.Punctuation) && this.peek().value === '}')) {
                defaultBody = [this.parseSingleStatement()];
              }
              if (!braceForm && !this.isType(TokenType.EOF) && this.peek().value !== 'if' && this.peek().value !== 'else') break;
            } else {
              const bad = this.advance();
              this.diagnostics.error(`Unexpected token '${bad.value}' in switch block`, bad.line, bad.column);
            }
          }
          if (braceForm) {
            // Inside braces, Dedents are cosmetic — skip them, then the '}'.
            while (this.isType(TokenType.Dedent)) {
              this.advance();
              pendingIndents -= 1;
            }
            if (this.isType(TokenType.Punctuation) && this.peek().value === '}') {
              this.advance();
            }
            // The '}' may sit deeper than the switch itself (indented '{');
            // drain the Dedents back to the switch's own level.
            while (pendingIndents > 0) {
              this.skipNewlines();
              if (!this.isType(TokenType.Dedent)) break;
              this.advance();
              pendingIndents -= 1;
            }
          } else {
            this.skipNewlines();
            // Return from the case level to the switch's own level; the
            // enclosing scope's Dedent is left for the enclosing parse loop.
            if (pendingIndents > 0 && this.isType(TokenType.Dedent)) {
              this.advance();
              pendingIndents -= 1;
            }
          }
        }
        statements.push({ type: 'SwitchStatement', switchValue, cases, defaultBody });
        continue;
      }

      // Check for var declaration inside proc
      if (token.value === 'var') {
        this.advance();
        let varName = '';
        if (this.isType(TokenType.TypePath)) {
          const pathVal = this.advance().value;
          const lastSlash = pathVal.lastIndexOf('/');
          varName = lastSlash > 0 ? pathVal.substring(lastSlash + 1) : pathVal.replace(/^\//, '');
        } else if (this.isType(TokenType.Identifier)) {
          // var/list/x — bare type followed by /name (no leading slash)
          const next = this.peekNext();
          if (next && next.type === TokenType.Operator && next.value === '/') {
            this.advance(); // type
            this.advance(); // /
            if (this.isType(TokenType.Identifier) || this.isType(TokenType.Keyword)) {
              varName = this.advance().value;
            }
          } else {
            varName = this.advance().value;
          }
        } else if (this.isType(TokenType.Keyword)) {
          varName = this.advance().value;
        }
        // Initialized length: var/list/x[max(1, 0)] — drop the length expr.
        // Empty brackets: var/list/x[] — the list-declaration suffix.
        if (this.isType(TokenType.Punctuation) && this.peek().value === '[') {
          this.advance();
          if (!(this.isType(TokenType.Punctuation) && this.peek().value === ']')) {
            this.parseExpression();
          }
          this.matchPunctuation(']');
        }
        let varInit: ExpressionNode | undefined;
        if (this.matchOperator('=')) {
          varInit = this.parseExpression();
        }
        statements.push({ type: 'VarDeclStatement', varName, varInit });
        // DM multi-decl: var/i, ch, len = length(key)
        while (this.matchPunctuation(',')) {
          let nextName = '';
          if (this.isType(TokenType.TypePath)) {
            const pathVal = this.advance().value;
            const lastSlash = pathVal.lastIndexOf('/');
            nextName = lastSlash > 0 ? pathVal.substring(lastSlash + 1) : pathVal.replace(/^\//, '');
          } else if (this.isType(TokenType.Identifier) || this.isType(TokenType.Keyword)) {
            nextName = this.advance().value;
          }
          let nextInit: ExpressionNode | undefined;
          if (this.matchOperator('=')) {
            nextInit = this.parseExpression();
          }
          statements.push({ type: 'VarDeclStatement', varName: nextName, varInit: nextInit });
        }
        continue;
      }

      // Check for assignment: var = expr
      if (this.isType(TokenType.Identifier)) {
        const varName = this.peek().value;
        // Look ahead for =
        const next = this.peekNext();
        if (next && next.type === TokenType.Operator && next.value === '=') {
          this.advance(); // consume identifier
          this.advance(); // consume =
          const assignmentValue = this.parseExpression();
          statements.push({ type: 'AssignmentStatement', assignmentTarget: varName, assignmentValue });
          continue;
        }
      }

      // Check for property assignment: obj.var = expr
      if (this.isType(TokenType.Identifier)) {
        const firstToken = this.peek().value;
        const secondToken = this.peekNext();
        if (secondToken && secondToken.value === '.') {
          // This is a property access, parse as expression statement
          const expr = this.parseExpression();
          statements.push({ type: 'ExpressionStatement', expression: expr });
          continue;
        }
      }

      // Generic expression statement
      const expr = this.parseExpression();
      statements.push({ type: 'ExpressionStatement', expression: expr });
    }

    if (this.isType(TokenType.Dedent)) {
      this.advance();
    }

    return statements;
  }
  private parseSingleStatement(): DMStatementNode {
    const token = this.peek();
    if (token.value === 'var') {
      this.advance();
      let varName = '';
      if (this.isType(TokenType.TypePath)) {
        const pathVal = this.advance().value;
        const lastSlash = pathVal.lastIndexOf('/');
        varName = lastSlash > 0 ? pathVal.substring(lastSlash + 1) : pathVal.replace(/^\//, '');
      } else if (this.isType(TokenType.Identifier)) {
        const next = this.peekNext();
        if (next && next.type === TokenType.Operator && next.value === '/') {
          this.advance();
          this.advance();
          if (this.isType(TokenType.Identifier) || this.isType(TokenType.Keyword)) {
            varName = this.advance().value;
          }
        } else {
          varName = this.advance().value;
        }
      } else if (this.isType(TokenType.Keyword)) {
        varName = this.advance().value;
      }
      let varInit: ExpressionNode | undefined;
      if (this.matchOperator('=')) {
        varInit = this.parseExpression();
      }
      return { type: 'VarDeclStatement', varName, varInit };
    }
    if (token.value === 'return') {
      this.advance();
      let returnValue: ExpressionNode | undefined;
      if (!this.isType(TokenType.Newline) && !this.isType(TokenType.Dedent)) {
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
    return { type: 'ExpressionStatement', expression: this.parseExpression() };
  }

  private parseIfStatement(): DMStatementNode {
    this.advance(); // consume 'if'
    const condition = this.parseExpression();
    this.skipNewlines();
    let thenBranch: DMStatementNode[] = [];
    if (this.isType(TokenType.Punctuation) && this.peek().value === '{') {
      this.advance();
      thenBranch = this.parseProcBody(true);
      this.matchPunctuation('}');
    } else if (this.isType(TokenType.Indent)) {
      this.advance();
      thenBranch = this.parseProcBody();
    }
    let elseBranch: DMStatementNode[] | undefined;
    this.skipNewlines();
    // Macro-expanded one-line chains produce `if(x) { ... }; else ...` — a
    // stray `;` between the body and `else` is a no-op and must not detach
    // the else from its if.
    if (this.isType(TokenType.Punctuation) && this.peek().value === ';') {
      this.advance();
      this.skipNewlines();
    }
    if (this.peek().value === 'else') {
      this.advance();
      this.skipNewlines();
      if (this.peek().value === 'if') {
        // else if chain: represent as nested if statement
        elseBranch = [this.parseIfStatement()];
      } else if (this.isType(TokenType.Punctuation) && this.peek().value === '{') {
        this.advance();
        elseBranch = this.parseProcBody(true);
        this.matchPunctuation('}');
      } else if (this.isType(TokenType.Indent)) {
        this.advance();
        elseBranch = this.parseProcBody();
      }
    }
    return { type: 'IfStatement', condition, thenBranch, elseBranch };
  }

  // Expression parser using Pratt parsing / precedence climbing
  public parseExpression(minPrec: number = 0, stopAtColon: boolean = false): ExpressionNode {
    let left = this.parsePrimary();

    while (true) {
      const token = this.peek();
      if (token.type === TokenType.EOF || token.type === TokenType.Newline || token.type === TokenType.Dedent) {
        break;
      }
      // Statement separators terminate an expression: `;` (inline { } bodies,
      // C-style for) and `}` (brace-form blocks). The postfix arg loop handles
      // `;` itself (weighted pick), so this only fires at top expression level.
      if (token.type === TokenType.Punctuation && (token.value === ';' || token.value === '}')) {
        break;
      }
      if (stopAtColon && token.value === ':') {
        // Inside a ternary true-branch, a `:` is the ternary colon — unless it
        // starts a dereference off a plain identifier AND the access target is
        // itself followed by another `:` (a ? b:c : d). The deref target
        // followed by an expression ender means the `:` was the ternary colon
        // (a ? b : c). A plain identifier base is required so `null`, calls and
        // chained derefs always fall back to the ternary colon.
        const target = this.peekNext();
        const after = this.tokens[this.pos + 2];
        const derefTarget =
          target &&
          (target.type === TokenType.Identifier ||
            (target.type === TokenType.Keyword && target.value === 'step'));
        if (!derefTarget || left.type !== 'variable') break;
        // b:c : d — fall through so the `:` is consumed as dynamic access
        // below; b : c — the `:` is the ternary colon, so break here.
        if (!(after && after.value === ':')) break;
      }

      const op = token.value;

      // x/type — a TypePath token directly after a complete expression is
      // division by a type constant (the lexer cannot distinguish these).
      if (token.type === TokenType.TypePath) {
        this.advance();
        const right: ExpressionNode = { type: 'literal', value: token.value, literalType: 'string' };
        left = { type: 'binary', operator: '/', left, right };
        continue;
      }

      // Postfix increment/decrement: x++ / x--
      if ((op === '++' || op === '--') && (left.type === 'variable' || left.type === 'property' || left.type === 'index')) {
        this.advance();
        const one: ExpressionNode = { type: 'literal', value: 1, literalType: 'number' };
        const baseOp = op === '++' ? '+' : '-';
        if (left.type === 'variable') {
          left = {
            type: 'assignment',
            target: left.name,
            value: { type: 'binary', operator: baseOp, left: { type: 'variable', name: left.name }, right: one }
          };
        } else if (left.type === 'property') {
          left = {
            type: 'property_assignment',
            target: left.target,
            property: left.property,
            value: { type: 'binary', operator: baseOp, left, right: one }
          };
        } else {
          left = {
            type: 'index_assignment',
            target: left.target,
            index: left.index,
            value: { type: 'binary', operator: baseOp, left, right: one }
          };
        }
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
        const value: ExpressionNode = { type: 'binary', operator: baseOp, left, right };
        if (left.type === 'variable') {
          left = { type: 'assignment', target: left.name, value };
        } else if (left.type === 'property') {
          left = { type: 'property_assignment', target: left.target, property: left.property, value };
        } else {
          left = { type: 'index_assignment', target: left.target, index: left.index, value };
        }
        continue;
      }

      const precedence = this.getOperatorPrecedence(op);
      if (precedence < minPrec) break;

      // DM range operator: 1..5, a..b (for(x in 1..5) etc.)
      if (op === '..') {
        this.advance();
        const end = this.parseExpression(precedence + (this.isRightAssociative(op) ? 0 : 1));
        left = { type: 'range', start: left, end };
        continue;
      }

      // Static access: sometype::abstract_type — treated as a property read.
      if (op === '::') {
        this.advance();
        const propToken = this.advance();
        left = { type: 'property', target: left, property: propToken.value } as any;
        continue;
      }

      // Dynamic access: found_turf:type — treated as a property read.
      if (op === ':') {
        this.advance();
        const propToken = this.advance();
        left = { type: 'property', target: left, property: propToken.value } as any;
        continue;
      }

      // Legacy DM null-conditional access: x?:prop — treated as a property read.
      if (op === '?' && this.peekNext()?.value === ':') {
        this.advance();
        this.advance();
        const propToken = this.advance();
        left = { type: 'property', target: left, property: propToken.value } as any;
        continue;
      }

      // Index: a::b[1] (parsePostfix handles plain a[1] already)
      if (op === '[') {
        this.advance(); // consume [
        const index = this.parseExpression();
        this.matchPunctuation(']');
        left = { type: 'index', target: left, index } as any;
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
        if (left.type === 'variable') {
          left = { type: 'assignment', target: left.name, value: right } as any;
        } else if (left.type === 'property') {
          left = { type: 'property_assignment', target: left.target, property: left.property, value: right } as any;
        } else if (left.type === 'index') {
          left = { type: 'index_assignment', target: left.target, index: left.index, value: right } as any;
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
          } as any;
          continue;
        } else if (left.type === 'property') {
          left = {
            type: 'property_assignment',
            target: left.target,
            property: left.property,
            value: { type: 'binary', operator: baseOp, left, right }
          } as any;
          continue;
        } else if (left.type === 'index') {
          left = {
            type: 'index_assignment',
            target: left.target,
            index: left.index,
            value: { type: 'binary', operator: baseOp, left, right }
          } as any;
          continue;
        }
      }

      left = { type: 'binary', operator: op, left, right };
    }

    return left;
  }

  private parsePrimary(): ExpressionNode {
    const token = this.peek();

    // Parenthesized expression
    if (this.matchPunctuation('(')) {
      const expr = this.parseExpression();
      this.matchPunctuation(')');
      return this.parsePostfix(expr);
    }

    // DM list literal: {1, 2, 3} (also covers {"multi\nline"} string lists)
    if (this.isType(TokenType.Punctuation) && this.peek().value === '{') {
      this.advance();
      const elements: ExpressionNode[] = [];
      let closed = false;
      while (!this.isType(TokenType.EOF) && !this.isType(TokenType.Newline) && !this.isType(TokenType.Dedent)) {
        if (this.isType(TokenType.Punctuation) && this.peek().value === '}') {
          this.advance();
          closed = true;
          break;
        }
        if (this.isType(TokenType.Punctuation) && this.peek().value === ',') {
          this.advance();
          continue;
        }
        elements.push(this.parseExpression());
      }
      if (!closed) {
        this.diagnostics.error("Expected '}' to close list literal", this.peek().line, this.peek().column);
      }
      return this.parsePostfix({ type: 'list', elements });
    }

    // String literal
    if (token.type === TokenType.StringLiteral) {
      this.advance();
      return { type: 'literal', value: token.value, literalType: 'string' };
    }

    // File literal
    if (token.type === TokenType.FileLiteral) {
      this.advance();
      return { type: 'literal', value: token.value, literalType: 'string' };
    }

    // Number literal
    if (token.type === TokenType.Number) {
      this.advance();
      return { type: 'literal', value: parseFloat(token.value), literalType: 'number' };
    }

    // TypePath (e.g., /obj/item/sword)
    if (token.type === TokenType.TypePath) {
      this.advance();
      return { type: 'literal', value: token.value, literalType: 'string' };
    }

    // Keywords: null, TRUE, FALSE
    if (token.type === TokenType.Keyword) {
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
        if (this.isType(TokenType.TypePath)) {
          typePath = this.advance().value;
        } else if (this.isType(TokenType.Operator) && this.peek().value === '/') {
          this.advance();
          if (this.isType(TokenType.TypePath)) {
            typePath = this.advance().value;
          }
        } else if (this.isType(TokenType.Identifier)) {
          typePath = '/' + this.advance().value;
        }
        const args: ExpressionNode[] = [];
        if (this.matchPunctuation('(')) {
          let parenIndents = 0;
          while (!this.matchPunctuation(')') && !this.isType(TokenType.EOF)) {
            while (this.isType(TokenType.Newline) || this.isType(TokenType.Indent) || this.isType(TokenType.Dedent)) {
              if (this.isType(TokenType.Indent)) parenIndents += 1;
              else if (this.isType(TokenType.Dedent)) parenIndents -= 1;
              this.advance();
            }
            if (this.matchPunctuation(')')) break;
            args.push(this.parseExpression());
            if (this.matchPunctuation(',')) continue;
          }
          while (parenIndents > 0) {
            this.skipNewlines();
            if (!this.isType(TokenType.Dedent)) break;
            this.advance();
            parenIndents -= 1;
          }
        }
        return this.parsePostfix({ type: 'new', typePath, arguments: args });
      }
    }

    // Identifier or proc call
    if (token.type === TokenType.Identifier) {
      const name = this.advance().value;
      return this.parsePostfix({ type: 'variable', name });
    }

    // Unary operators (and prefix ++/--, rewritten as assignment)
    if (token.type === TokenType.Operator && ['!', '-', '+', '~', '++', '--'].includes(token.value)) {
      const op = this.advance().value;
      const operand = this.parsePrimary();
      if (op === '++' || op === '--') {
        const one: ExpressionNode = { type: 'literal', value: 1, literalType: 'number' };
        const baseOp = op === '++' ? '+' : '-';
        const value: ExpressionNode = { type: 'binary', operator: baseOp, left: operand, right: one };
        if (operand.type === 'variable') {
          return { type: 'assignment', target: operand.name, value } as any;
        }
        if (operand.type === 'property') {
          return { type: 'property_assignment', target: operand.target, property: operand.property, value } as any;
        }
      }
      return { type: 'unary', operator: op, operand };
    }

    // Implicit return value: '.' is DM's per-proc return variable
    if (token.type === TokenType.Operator && token.value === '.') {
      this.advance();
      // .proc/name — path-dot proc reference used by nameof() and PROC_REF()
      if (this.peek().value === 'proc' || this.peek().value === 'verb') {
        const kind = this.advance().value;
        let path = '';
        if (this.isType(TokenType.TypePath)) {
          path = this.advance().value;
        }
        return this.parsePostfix({ type: 'literal', value: `.${kind}${path}`, literalType: 'string' });
      }
      return this.parsePostfix({ type: 'variable', name: '.' });
    }

    // Parent call: ..() / ..(args) dispatches to the parent proc
    if (token.type === TokenType.Operator && token.value === '..') {
      this.advance();
      const args: ExpressionNode[] = [];
      if (this.matchPunctuation('(')) {
        while (!this.matchPunctuation(')') && !this.isType(TokenType.EOF)) {
          args.push(this.parseExpression());
          if (this.matchPunctuation(',')) continue;
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
  private parsePostfix(node: ExpressionNode): ExpressionNode {
    while (true) {
      // '.' is tokenized as an Operator (not Punctuation), so match by value.
      // '?.' is DM's null-conditional access; treated as plain access (the
      // runtime already returns Null for missing properties).
      if (this.peek().value === '.' || this.peek().value === '?.') {
        this.advance();
        const propToken = this.peek();
        if (propToken.type === TokenType.Identifier || propToken.type === TokenType.Keyword) {
          this.advance();
          node = { type: 'property', target: node, property: propToken.value };
        } else {
          this.diagnostics.error("Expected identifier after '.'", propToken.line, propToken.column);
          return node;
        }
      } else if (this.matchPunctuation('(')) {
        const args: ExpressionNode[] = [];
        // Indents introduced by the argument lines; the matching Dedents are
        // drained after the ')' so enclosing scopes still see their own.
        let parenIndents = 0;
        while (!this.matchPunctuation(')') && !this.isType(TokenType.EOF)) {
          // DM allows the argument list to span lines (a trailing comma
          // before the closing paren is also legal); inside parens the
          // line structure is purely cosmetic.
          while (this.isType(TokenType.Newline) || this.isType(TokenType.Indent) || this.isType(TokenType.Dedent)) {
            if (this.isType(TokenType.Indent)) parenIndents += 1;
            else if (this.isType(TokenType.Dedent)) parenIndents -= 1;
            this.advance();
          }
          if (this.matchPunctuation(')')) break;
          args.push(this.parseExpression());
          // Weighted pick: pick(20;"brown", 30;"grey") — parse weight;value pairs.
          if (this.peek().value === ';') {
            this.advance();
            args.push(this.parseExpression());
          }
          if (this.matchPunctuation(',')) continue;
        }
        while (parenIndents > 0) {
          this.skipNewlines();
          if (!this.isType(TokenType.Dedent)) break;
          this.advance();
          parenIndents -= 1;
        }
        if (node.type === 'variable') {
          node = { type: 'call', name: node.name, arguments: args };
        } else if (node.type === 'property') {
          // obj.method(x) — the method name is the last property segment and
          // the receiver is the chain before it. Previously this emitted a
          // call with an empty name targeting the property lookup itself.
          node = { type: 'call', name: node.property, target: node.target, arguments: args };
        } else {
          node = { type: 'call', name: '', target: node, arguments: args };
        }
      } else if (this.matchPunctuation('[')) {
        const index = this.parseExpression();
        this.matchPunctuation(']');
        node = { type: 'index', target: node, index };
      } else if (this.peek().value === '?' && this.peekNext()?.value === '[') {
        // Null-conditional index: x?[key] — treated as plain indexing.
        this.advance();
        this.advance();
        const index = this.parseExpression();
        this.matchPunctuation(']');
        node = { type: 'index', target: node, index };
      } else {
        break;
      }
    }
    return node;
  }

  private getOperatorPrecedence(op: string): number {
    switch (op) {
      case '||': case 'as': return 1;
      case '<<': case '>>': return 1;
      case '&&': return 2;
      case 'in': case 'to': return 2;
      case '==': case '!=': case '~=': case '~!': return 3;
      case '<': case '<=': case '>': case '>=': return 4;
      case '&': case '|': case '^': return 4;
      case '+': case '-': return 5;
      case '..': return 5; // range literal (1..5)
      case '*': case '/': case '%': case '%%': case '**': return 6;
      case '::': case ':': case '[': return 12; // static / dynamic member access, index
      case '?': return 7; // ternary
      case '=': case '+=': case '-=': case '*=': case '/=': case '%=': case '<<=': case '>>=': case '&=': case '|=': case '^=': case '||=': case '&&=': return 0; // lowest (right-associative)
      default: return -1;
    }
  }

  private isRightAssociative(op: string): boolean {
    return ['=', '?', '+=', '-=', '*=', '/=', '%=', '<<=', '>>=', '&=', '|=', '^=', '||=', '&&='].includes(op);
  }

  private getOrCreateTypeNode(path: string, map: Map<string, DMTypeDeclNode>): DMTypeDeclNode {
    if (!map.has(path)) {
      map.set(path, {
        type: 'DMTypeDecl',
        path,
        vars: [],
        procs: []
      });
    }
    return map.get(path)!;
  }

  private peek(): Token {
    return this.pos < this.tokens.length ? this.tokens[this.pos] : { type: TokenType.EOF, value: '', line: 0, column: 0 };
  }

  private peekNext(): Token | null {
    return this.pos + 1 < this.tokens.length ? this.tokens[this.pos + 1] : null;
  }

  // Lookahead: is the current for-head the multi-var form? True when a
  // top-level 'in' keyword appears before the closing ')' of the head
  // (e.g. for(var/gas_path, amount in gasmix.moles) is multi-var, while
  // for(words, words > 0, words--) is a C-style loop with a bare init).
  private isMultiVarLoopHead(): boolean {
    let depth = 0;
    for (let i = this.pos; i < this.tokens.length; i++) {
      const t = this.tokens[i];
      if (t.type === TokenType.Punctuation) {
        if (t.value === '(') depth++;
        else if (t.value === ')') {
          if (depth === 0) return false;
          depth--;
        }
      } else if (t.type === TokenType.Keyword && t.value === 'in' && depth === 0) {
        return true;
      }
    }
    return false;
  }

  private advance(): Token {
    return this.tokens[this.pos++];
  }

  private isType(type: TokenType): boolean {
    return this.peek().type === type;
  }

  private matchOperator(op: string): boolean {
    if (this.peek().type === TokenType.Operator && this.peek().value === op) {
      this.advance();
      return true;
    }
    return false;
  }

  private matchPunctuation(p: string): boolean {
    if (this.peek().type === TokenType.Punctuation && this.peek().value === p) {
      this.advance();
      return true;
    }
    return false;
  }

  private skipNewlines(): void {
    while (this.isType(TokenType.Newline)) {
      this.advance();
    }
  }
}
