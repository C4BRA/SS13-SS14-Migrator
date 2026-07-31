import { DMStatementNode, ExpressionNode } from '../parser/dmParser.js';
import { transpileBuiltinCall } from './builtinMappings.js';

export interface TranspiledExpression {
  csharp: string;
  type: 'value' | 'statement';
}

export class DMExpressionTranspiler {
  public transpileExpression(stmt: DMStatementNode): TranspiledExpression {
    // Handle structured expression AST if present
    if (stmt.expression && typeof stmt.expression === 'object' && 'type' in stmt.expression) {
      const csharp = this.emitExpression(stmt.expression as ExpressionNode);
      return { csharp, type: 'value' };
    }
    
    // Fallback for string-based expressions (backward compatibility)
    if (stmt.expression && typeof stmt.expression === 'string') {
      return this.transpileExpressionString(stmt.expression);
    }

    // Handle return value
    if (stmt.returnValue && typeof stmt.returnValue === 'object' && 'type' in stmt.returnValue) {
      const csharp = this.emitExpression(stmt.returnValue as ExpressionNode);
      return { csharp, type: 'value' };
    }

    // Handle assignment value
    if (stmt.assignmentValue && typeof stmt.assignmentValue === 'object' && 'type' in stmt.assignmentValue) {
      const csharp = this.emitExpression(stmt.assignmentValue as ExpressionNode);
      return { csharp, type: 'value' };
    }

    // Handle var init
    if (stmt.varInit && typeof stmt.varInit === 'object' && 'type' in stmt.varInit) {
      const csharp = this.emitExpression(stmt.varInit as ExpressionNode);
      return { csharp, type: 'value' };
    }

    // Handle time expr
    if (stmt.timeExpr && typeof stmt.timeExpr === 'object' && 'type' in stmt.timeExpr) {
      const csharp = this.emitExpression(stmt.timeExpr as ExpressionNode);
      return { csharp, type: 'value' };
    }

    return { csharp: 'DMValue.Null', type: 'value' };
  }

  public transpileExpressionString(expr: string): TranspiledExpression {
    // Parse and transpile DM expression to C# DMValue expression
    const trimmed = expr.trim();
    if (!trimmed) {
      return { csharp: 'DMValue.Null', type: 'value' };
    }
    const parsed = this.parseExpression(trimmed);
    const csharp = this.emitExpression(parsed);
    return { csharp, type: 'value' };
  }

  private parseExpression(expr: string): ExpressionNode {
    // Simplified parser - in production would be a proper recursive descent
    // For now, handle common DM expression patterns
    return this.parseTernary(expr);
  }

  private parseTernary(expr: string): ExpressionNode {
    // Handle ternary: condition ? trueExpr : falseExpr
    let depth = 0;
    for (let i = 0; i < expr.length; i++) {
      const ch = expr[i];
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      else if (ch === '?' && depth === 0) {
        const condition = expr.substring(0, i).trim();
        const rest = expr.substring(i + 1).trim();
        const colonIdx = this.findMatchingColon(rest);
        if (colonIdx !== -1) {
          const trueExpr = rest.substring(0, colonIdx).trim();
          const falseExpr = rest.substring(colonIdx + 1).trim();
          return {
            type: 'ternary',
            condition: this.parseExpression(condition),
            trueExpr: this.parseExpression(trueExpr),
            falseExpr: this.parseExpression(falseExpr)
          };
        }
      }
    }
    return this.parseLogicalOr(expr);
  }

  private findMatchingColon(str: string): number {
    let depth = 0;
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (ch === '?' || ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      else if (ch === ':' && depth === 0) return i;
    }
    return -1;
  }

  private parseLogicalOr(expr: string): ExpressionNode {
    let depth = 0;
    for (let i = 0; i < expr.length; i++) {
      const ch = expr[i];
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      else if (ch === '|' && i + 1 < expr.length && expr[i + 1] === '|' && depth === 0) {
        const left = expr.substring(0, i).trim();
        const right = expr.substring(i + 2).trim();
        return {
          type: 'binary',
          operator: '||',
          left: this.parseLogicalOr(left),
          right: this.parseLogicalAnd(right)
        };
      }
    }
    return this.parseLogicalAnd(expr);
  }

  private parseLogicalAnd(expr: string): ExpressionNode {
    let depth = 0;
    for (let i = 0; i < expr.length; i++) {
      const ch = expr[i];
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      else if (ch === '&' && i + 1 < expr.length && expr[i + 1] === '&' && depth === 0) {
        const left = expr.substring(0, i).trim();
        const right = expr.substring(i + 2).trim();
        return {
          type: 'binary',
          operator: '&&',
          left: this.parseLogicalAnd(left),
          right: this.parseEquality(right)
        };
      }
    }
    return this.parseEquality(expr);
  }

  private parseEquality(expr: string): ExpressionNode {
    let depth = 0;
    for (let i = 0; i < expr.length; i++) {
      const ch = expr[i];
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      else if (depth === 0) {
        if (ch === '=' && i + 1 < expr.length && expr[i + 1] === '=') {
          const left = expr.substring(0, i).trim();
          const right = expr.substring(i + 2).trim();
          return { type: 'binary', operator: '==', left: this.parseEquality(left), right: this.parseRelational(right) };
        }
        if (ch === '!' && i + 1 < expr.length && expr[i + 1] === '=') {
          const left = expr.substring(0, i).trim();
          const right = expr.substring(i + 2).trim();
          return { type: 'binary', operator: '!=', left: this.parseEquality(left), right: this.parseRelational(right) };
        }
      }
    }
    return this.parseRelational(expr);
  }

  private parseRelational(expr: string): ExpressionNode {
    let depth = 0;
    for (let i = 0; i < expr.length; i++) {
      const ch = expr[i];
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      else if (depth === 0) {
        if (ch === '<' && i + 1 < expr.length && expr[i + 1] === '=') {
          const left = expr.substring(0, i).trim();
          const right = expr.substring(i + 2).trim();
          return { type: 'binary', operator: '<=', left: this.parseRelational(left), right: this.parseAdditive(right) };
        }
        if (ch === '>' && i + 1 < expr.length && expr[i + 1] === '=') {
          const left = expr.substring(0, i).trim();
          const right = expr.substring(i + 2).trim();
          return { type: 'binary', operator: '>=', left: this.parseRelational(left), right: this.parseAdditive(right) };
        }
        if (ch === '<') {
          const left = expr.substring(0, i).trim();
          const right = expr.substring(i + 1).trim();
          return { type: 'binary', operator: '<', left: this.parseRelational(left), right: this.parseAdditive(right) };
        }
        if (ch === '>') {
          const left = expr.substring(0, i).trim();
          const right = expr.substring(i + 1).trim();
          return { type: 'binary', operator: '>', left: this.parseRelational(left), right: this.parseAdditive(right) };
        }
      }
    }
    return this.parseAdditive(expr);
  }

  private parseAdditive(expr: string): ExpressionNode {
    let depth = 0;
    for (let i = 0; i < expr.length; i++) {
      const ch = expr[i];
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      else if (depth === 0) {
        if (ch === '+') {
          const left = expr.substring(0, i).trim();
          const right = expr.substring(i + 1).trim();
          return { type: 'binary', operator: '+', left: this.parseAdditive(left), right: this.parseMultiplicative(right) };
        }
        if (ch === '-') {
          // Check if unary minus
          if (i === 0 || this.isOperatorOrParen(expr[i - 1])) continue;
          const left = expr.substring(0, i).trim();
          const right = expr.substring(i + 1).trim();
          return { type: 'binary', operator: '-', left: this.parseAdditive(left), right: this.parseMultiplicative(right) };
        }
      }
    }
    return this.parseMultiplicative(expr);
  }

  private parseMultiplicative(expr: string): ExpressionNode {
    let depth = 0;
    for (let i = 0; i < expr.length; i++) {
      const ch = expr[i];
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      else if (depth === 0) {
        if (ch === '*') {
          const left = expr.substring(0, i).trim();
          const right = expr.substring(i + 1).trim();
          return { type: 'binary', operator: '*', left: this.parseMultiplicative(left), right: this.parseUnary(right) };
        }
        if (ch === '/') {
          const left = expr.substring(0, i).trim();
          const right = expr.substring(i + 1).trim();
          return { type: 'binary', operator: '/', left: this.parseMultiplicative(left), right: this.parseUnary(right) };
        }
        if (ch === '%') {
          const left = expr.substring(0, i).trim();
          const right = expr.substring(i + 1).trim();
          return { type: 'binary', operator: '%', left: this.parseMultiplicative(left), right: this.parseUnary(right) };
        }
      }
    }
    return this.parseUnary(expr);
  }

  private parseUnary(expr: string): ExpressionNode {
    expr = expr.trim();
    if (expr.startsWith('!')) {
      return { type: 'unary', operator: '!', operand: this.parseUnary(expr.substring(1).trim()) };
    }
    if (expr.startsWith('-')) {
      return { type: 'unary', operator: '-', operand: this.parseUnary(expr.substring(1).trim()) };
    }
    if (expr.startsWith('+')) {
      return this.parseUnary(expr.substring(1).trim());
    }
    return this.parsePrimary(expr);
  }

  private parsePrimary(expr: string): ExpressionNode {
    expr = expr.trim();

    // Parenthesized
    if (expr.startsWith('(') && expr.endsWith(')')) {
      const inner = expr.substring(1, expr.length - 1).trim();
      return this.parseExpression(inner);
    }

    // String literal
    if ((expr.startsWith('"') && expr.endsWith('"')) || (expr.startsWith("'") && expr.endsWith("'"))) {
      const val = expr.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'");
      return { type: 'literal', value: val, literalType: 'string' };
    }

    // Number literal
    if (/^-?\d+(\.\d+)?$/.test(expr)) {
      return { type: 'literal', value: parseFloat(expr), literalType: 'number' };
    }

    // Boolean/null literals
    if (expr === 'TRUE' || expr === 'true') return { type: 'literal', value: true, literalType: 'bool' };
    if (expr === 'FALSE' || expr === 'false') return { type: 'literal', value: false, literalType: 'bool' };
    if (expr === 'NULL' || expr === 'null') return { type: 'literal', value: null, literalType: 'null' };

    // Proc call: procName(arg1, arg2)
    const procMatch = expr.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*\((.*)\)$/);
    if (procMatch) {
      const name = procMatch[1];
      const argsStr = procMatch[2].trim();
      const args = this.parseArguments(argsStr);
      return { type: 'call', name, arguments: args };
    }

    // Variable/property access
    return { type: 'variable', name: expr };
  }

  private parseArguments(argsStr: string): ExpressionNode[] {
    if (!argsStr) return [];
    const args: ExpressionNode[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < argsStr.length; i++) {
      const ch = argsStr[i];
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      else if (ch === ',' && depth === 0) {
        args.push(this.parseExpression(argsStr.substring(start, i).trim()));
        start = i + 1;
      }
    }
    if (start < argsStr.length) {
      args.push(this.parseExpression(argsStr.substring(start).trim()));
    }
    return args;
  }

  private isOperatorOrParen(ch: string): boolean {
    return '+-*/%=!<>|&()[]'.includes(ch);
  }

  private emitExpression(node: ExpressionNode): string {
    switch (node.type) {
      case 'literal':
        return this.emitLiteral(node);
      case 'variable':
        return this.emitVariable(node.name);
      case 'binary':
        return this.emitBinary(node);
      case 'unary':
        return this.emitUnary(node);
      case 'call':
        return this.emitCall(node);
      case 'new':
        return `await DMNew(comp, "${node.typePath}"${node.arguments.length > 0 ? ', ' + node.arguments.map((a: any) => this.emitExpression(a)).join(', ') : ''})`;
      case 'ternary':
        return this.emitTernary(node);
      case 'property':
        return this.emitProperty(node);
      case 'index':
        return this.emitIndex(node);
      case 'assignment':
        return this.emitAssignment(node);
      case 'property_assignment':
        return this.emitPropertyAssignment(node);
      case 'index_assignment':
        return this.emitIndexAssignment(node);
      default:
        return 'DMValue.Null';
    }
  }

  private emitLiteral(node: any): string {
    switch (node.literalType) {
      case 'string':
        return `DMValue.FromString("${this.escapeString(node.value as string)}")`;
      case 'number':
        return `DMValue.FromNumber(${node.value})`;
      case 'bool':
        return (node.value as boolean) ? 'DMValue.FromNumber(1)' : 'DMValue.FromNumber(0)';
      case 'null':
        return 'DMValue.Null';
      default:
        return 'DMValue.Null';
    }
  }

  private escapeString(str: string): string {
    return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
  }

  private emitVariable(name: string): string {
    // DM special variables: src = current object, usr = calling mob
    if (name === 'src') return 'DMValue.FromComponent(comp)';
    if (name === 'usr') return 'DMRuntimeHelpers.CurrentUsr';
    return `comp.GetVar("${name}")`;
  }

  private emitBinary(node: any): string {
    const left = this.emitExpression(node.left);
    const right = this.emitExpression(node.right);

    switch (node.operator) {
      case '+': return `DMValue.Add(${left}, ${right})`;
      case '-': return `DMValue.Subtract(${left}, ${right})`;
      case '*': return `DMValue.Multiply(${left}, ${right})`;
      case '/': return `DMValue.Divide(${left}, ${right})`;
      case '%': return `DMValue.Modulo(${left}, ${right})`;
      case '==': return `DMValue.Equals(${left}, ${right})`;
      case '!=': return `!DMValue.Equals(${left}, ${right})`;
      case '<': return `DMValue.LessThan(${left}, ${right})`;
      case '<=': return `DMValue.LessOrEqual(${left}, ${right})`;
      case '>': return `DMValue.GreaterThan(${left}, ${right})`;
      case '>=': return `DMValue.GreaterOrEqual(${left}, ${right})`;
      case '&&': return `DMValue.And(${left}, ${right})`;
      case '||': return `DMValue.Or(${left}, ${right})`;
      case '<<': return `DMValue.Output(${left}, ${right})`;
      default: return 'DMValue.Null';
    }
  }

  private emitUnary(node: any): string {
    const operand = this.emitExpression(node.operand);
    switch (node.operator) {
      case '!': return `DMValue.Not(${operand})`;
      case '-': return `DMValue.Negate(${operand})`;
      default: return operand;
    }
  }

  private emitCall(node: any): string {
    const args = node.arguments.map((a: any) => this.emitExpression(a)).join(', ');

    // Method call on a target: obj.method(x)
    if (node.target) {
      return `await DMCallProc(${this.emitExpression(node.target)}, "${node.name}", ${args})`;
    }

    // Check for built-in DM procs
    const builtin = transpileBuiltinCall(node.name, args);
    if (builtin !== null) {
      return builtin;
    }
    // User-defined proc - call through runtime
    return `await comp.CallProc("${node.name}", ${args})`;
  }

  private emitTernary(node: any): string {
    const cond = this.emitExpression(node.condition);
    const trueExpr = this.emitExpression(node.trueExpr);
    const falseExpr = this.emitExpression(node.falseExpr);
    return `${cond}.IsTrue() ? ${trueExpr} : ${falseExpr}`;
  }

  private emitProperty(node: any): string {
    const target = this.emitExpression(node.target);
    return `(${target}).AsComponent()?.GetVar("${node.property}") ?? DMValue.Null`;
  }

  private emitIndex(node: any): string {
    const target = this.emitExpression(node.target);
    const index = this.emitExpression(node.index);
    // For list/index access, we'd need a runtime helper
    return `DMListGet(${target}, ${index})`;
  }

  private emitAssignment(node: any): string {
    const value = this.emitExpression(node.value);
    return `comp.SetVar("${node.target}", ${value})`;
  }

  private emitPropertyAssignment(node: any): string {
    const target = this.emitExpression(node.target);
    const value = this.emitExpression(node.value);
    return `(${target}).AsComponent()?.SetVar("${node.property}", ${value}) ?? DMValue.Null`;
  }

  private emitIndexAssignment(node: any): string {
    const target = this.emitExpression(node.target);
    const index = this.emitExpression(node.index);
    const value = this.emitExpression(node.value);
    return `DMListSet(${target}, ${index}, ${value})`;
  }
}