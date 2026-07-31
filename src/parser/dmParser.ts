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
  | { type: 'index_assignment'; target: ExpressionNode; index: ExpressionNode; value: ExpressionNode };

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

      const token = this.peek();

      // Top level type declaration (e.g. /obj/item/weapon/sword or /obj/item/proc/swing)
      if (token.type === TokenType.TypePath) {
        let rawPath = token.value;
        this.advance();

        // Check if path represents a proc definition: e.g. /obj/item/proc/swing
        const procMatch = rawPath.match(/^(.+)\/(proc|verb)\/([^\/]+)$/);
        if (procMatch) {
          const ownerPath = procMatch[1];
          const procName = procMatch[3];
          const ownerNode = this.getOrCreateTypeNode(ownerPath, typeDecls);

          const args: { name: string; typeHint?: string }[] = [];
          if (this.matchPunctuation('(')) {
            while (!this.matchPunctuation(')') && !this.isType(TokenType.EOF)) {
              if (this.isType(TokenType.Identifier) || this.isType(TokenType.TypePath)) {
                const argName = this.advance().value.replace(/^\//, '');
                if (this.peek().value === 'as') {
                  this.advance();
                  if (this.isType(TokenType.Identifier) || this.isType(TokenType.TypePath) || this.isType(TokenType.Keyword)) {
                    this.advance();
                  }
                }
                args.push({ name: argName });
              } else {
                this.advance();
              }
              if (this.matchPunctuation(',')) continue;
            }
          }

          const procNode: DMProcDeclNode = {
            type: 'DMProcDecl',
            name: procName,
            args,
            statements: []
          };

          this.skipNewlines();
          if (this.isType(TokenType.Indent)) {
            this.advance();
            procNode.statements = this.parseProcBody();
          }

          ownerNode.procs.push(procNode);
          continue;
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
        if (this.isType(TokenType.Indent)) {
          this.advance();
          this.parseTypeBlock(currentTypeNode, typeDecls);
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
          const valToken = this.advance();
          const typeNode = this.getOrCreateTypeNode(currentTypePath, typeDecls);
          typeNode.vars.push({
            type: 'DMVarDecl',
            name: varName,
            initialValue: valToken.value
          });
        }
        continue;
      }

      // Top-level token we don't understand: report and recover
      const skip = this.advance();
      this.diagnostics.error(`Unexpected top-level token '${skip.value}'`, skip.line, skip.column);
    }

    return Array.from(typeDecls.values());
  }

  private parseTypeBlock(currentTypeNode: DMTypeDeclNode, typeDecls: Map<string, DMTypeDeclNode>): void {
    while (!this.isType(TokenType.Dedent) && !this.isType(TokenType.EOF)) {
      this.skipNewlines();
      if (this.isType(TokenType.Dedent) || this.isType(TokenType.EOF)) break;

      const token = this.peek();

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
          const valToken = this.advance();
          currentTypeNode.vars.push({
            type: 'DMVarDecl',
            name: varName,
            initialValue: valToken.value
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
      let initialVal: any = null;
      if (varName && this.matchOperator('=')) {
        initialVal = this.advance().value;
      }
      if (varName) {
        targetTypeNode.vars.push({
          type: 'DMVarDecl',
          name: varName,
          varType,
          initialValue: initialVal
        });
      }
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
        const args: { name: string; typeHint?: string }[] = [];

        if (this.matchPunctuation('(')) {
          while (!this.matchPunctuation(')') && !this.isType(TokenType.EOF)) {
            if (this.isType(TokenType.Identifier) || this.isType(TokenType.TypePath)) {
              const argName = this.advance().value.replace(/^\//, '');
              if (this.peek().value === 'as') {
                this.advance();
                if (this.isType(TokenType.Identifier) || this.isType(TokenType.TypePath) || this.isType(TokenType.Keyword)) {
                  this.advance();
                }
              }
              args.push({ name: argName });
            } else {
              this.advance();
            }
            if (this.matchPunctuation(',')) continue;
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
        if (this.isType(TokenType.Indent)) {
          this.advance();
          procNode.statements = this.parseProcBody();
        }

        targetTypeNode.procs.push(procNode);
      }
    }
  }

  private parseProcBody(): DMStatementNode[] {
    const statements: DMStatementNode[] = [];

    while (!this.isType(TokenType.Dedent) && !this.isType(TokenType.EOF)) {
      this.skipNewlines();
      if (this.isType(TokenType.Dedent) || this.isType(TokenType.EOF)) break;

      const token = this.peek();

      if (token.value === 'return') {
        this.advance();
        let returnValue: ExpressionNode | undefined;
        if (!this.isType(TokenType.Newline) && !this.isType(TokenType.Dedent)) {
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
          }
        }
        this.skipNewlines();
        if (this.peek().value === 'in') {
          this.advance();
          const loopRange = this.parseExpression();
          this.matchPunctuation(')');
          this.skipNewlines();
          let loopBody: DMStatementNode[] = [];
          if (this.isType(TokenType.Indent)) {
            this.advance();
            loopBody = this.parseProcBody();
          }
          statements.push({ type: 'ForStatement', loopVariable: loopVar, loopRange, loopBody });
          continue;
        }
      }

      if (token.value === 'while') {
        this.advance();
        const condition = this.parseExpression();
        this.skipNewlines();
        let loopBody: DMStatementNode[] = [];
        if (this.isType(TokenType.Indent)) {
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
          if (this.isType(TokenType.Indent)) {
            this.advance();
            body = this.parseProcBody();
          }
        }
        statements.push({ type: kind === 'sleep' ? 'SleepStatement' : 'SpawnStatement', timeExpr, body });
        continue;
      }

      // del x / qdel x
      if (token.value === 'del' || token.value === 'qdel') {
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
        if (this.isType(TokenType.Indent)) {
          this.advance();
          while (!this.isType(TokenType.Dedent) && !this.isType(TokenType.EOF)) {
            this.skipNewlines();
            if (this.isType(TokenType.Dedent) || this.isType(TokenType.EOF)) break;
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
                body = this.parseProcBody();
              }
              cases.push({ values, body });
            } else if (this.peek().value === 'else') {
              this.advance();
              this.skipNewlines();
              if (this.isType(TokenType.Indent)) {
                this.advance();
                defaultBody = this.parseProcBody();
              }
            } else {
              const bad = this.advance();
              this.diagnostics.error(`Unexpected token '${bad.value}' in switch block`, bad.line, bad.column);
            }
          }
          if (this.isType(TokenType.Dedent)) {
            this.advance();
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
          varName = this.advance().value;
        }
        let varInit: ExpressionNode | undefined;
        if (this.matchOperator('=')) {
          varInit = this.parseExpression();
        }
        statements.push({ type: 'VarDeclStatement', varName, varInit });
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

  private parseIfStatement(): DMStatementNode {
    this.advance(); // consume 'if'
    const condition = this.parseExpression();
    this.skipNewlines();
    let thenBranch: DMStatementNode[] = [];
    if (this.isType(TokenType.Indent)) {
      this.advance();
      thenBranch = this.parseProcBody();
    }
    let elseBranch: DMStatementNode[] | undefined;
    this.skipNewlines();
    if (this.peek().value === 'else') {
      this.advance();
      this.skipNewlines();
      if (this.peek().value === 'if') {
        // else if chain: represent as nested if statement
        elseBranch = [this.parseIfStatement()];
      } else if (this.isType(TokenType.Indent)) {
        this.advance();
        elseBranch = this.parseProcBody();
      }
    }
    return { type: 'IfStatement', condition, thenBranch, elseBranch };
  }

  // Expression parser using Pratt parsing / precedence climbing
  private parseExpression(minPrec: number = 0): ExpressionNode {
    let left = this.parsePrimary();

    while (true) {
      const token = this.peek();
      if (token.type === TokenType.EOF || token.type === TokenType.Newline || token.type === TokenType.Dedent) {
        break;
      }

      const op = token.value;

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

      const precedence = this.getOperatorPrecedence(op);
      if (precedence < minPrec) break;

      // Handle right-associative operators
      const nextMinPrec = precedence + (this.isRightAssociative(op) ? 0 : 1);

      this.advance(); // consume operator

      // Special handling for ternary
      if (op === '?') {
        const trueExpr = this.parseExpression();
        if (!this.matchOperator(':')) {
          const t = this.peek();
          this.diagnostics.error("Expected ':' in ternary expression", t.line, t.column);
        }
        const falseExpr = this.parseExpression();
        left = { type: 'ternary', condition: left, trueExpr, falseExpr };
        continue;
      }

      const right = this.parseExpression(nextMinPrec);

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
      if (['+=', '-=', '*=', '/=', '%=', '<<=', '>>='].includes(op)) {
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
      return expr;
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
      // usr, src, args
      if (['usr', 'src', 'args'].includes(token.value)) {
        this.advance();
        return { type: 'variable', name: token.value };
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
          while (!this.matchPunctuation(')') && !this.isType(TokenType.EOF)) {
            args.push(this.parseExpression());
            if (this.matchPunctuation(',')) continue;
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

    // Unary operators
    if (token.type === TokenType.Operator && ['!', '-', '+'].includes(token.value)) {
      const op = this.advance().value;
      const operand = this.parsePrimary();
      return { type: 'unary', operator: op, operand };
    }

    // Fallback: report and recover (treat as null literal)
    const bad = this.advance();
    this.diagnostics.error(`Unexpected token '${bad.value}' in expression`, bad.line, bad.column);
    return { type: 'literal', value: null, literalType: 'null' };
  }

  // Postfix chain: a.b.c, obj.method(x), arr[i].x, foo().bar
  private parsePostfix(node: ExpressionNode): ExpressionNode {
    while (true) {
      // '.' is tokenized as an Operator (not Punctuation), so match by value
      if (this.peek().value === '.') {
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
        while (!this.matchPunctuation(')') && !this.isType(TokenType.EOF)) {
          args.push(this.parseExpression());
          if (this.matchPunctuation(',')) continue;
        }
        if (node.type === 'variable') {
          node = { type: 'call', name: node.name, arguments: args };
        } else {
          node = { type: 'call', name: '', target: node, arguments: args };
        }
      } else if (this.matchPunctuation('[')) {
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
      case '||': return 1;
      case '<<': case '>>': return 1;
      case '&&': return 2;
      case '==': case '!=': return 3;
      case '<': case '<=': case '>': case '>=': return 4;
      case '+': case '-': return 5;
      case '*': case '/': case '%': return 6;
      case '?': return 7; // ternary
      case '=': case '+=': case '-=': case '*=': case '/=': case '%=': case '<<=': case '>>=': return 0; // lowest (right-associative)
      default: return -1;
    }
  }

  private isRightAssociative(op: string): boolean {
    return ['=', '?', '+=', '-=', '*=', '/=', '%=', '<<=', '>>='].includes(op);
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
