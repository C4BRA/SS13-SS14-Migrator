import * as fs from 'fs';
import * as path from 'path';
import { DMIRType } from '../ir/dmIRGenerator.js';
import { ExpressionNode } from '../parser/dmParser.js';
import { transpileBuiltinCall } from './builtinMappings.js';

export class CSharpEmitter {
  public emitCSharpSystems(irMap: Map<string, DMIRType>, outputServerDir: string): void {
    if (!fs.existsSync(outputServerDir)) {
      fs.mkdirSync(outputServerDir, { recursive: true });
    }

    const csCode = this.generateSystemCS(irMap);
    fs.writeFileSync(path.join(outputServerDir, 'ConvertedDMSystems.cs'), csCode, 'utf-8');
  }

  public generateSystemCS(irMap: Map<string, DMIRType>): string {
    let code = `using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Robust.Shared.GameObjects;
using SS13.DM.Runtime;
using static SS13.DM.Runtime.DMRuntimeHelpers;

namespace Content.Server.DM
{
    public class ConvertedDMSystem : EntitySystem
    {
        public override void Initialize()
        {
            base.Initialize();
            RegisterProcs();
            SubscribeLocalEvent<DMRuntimeComponent, ComponentInit>(OnDMComponentInit);
        }

        private void OnDMComponentInit(EntityUid uid, DMRuntimeComponent comp, ComponentInit args)
        {
            ExecuteNew(uid, comp);
        }

        public void ExecuteNew(EntityUid uid, DMRuntimeComponent comp)
        {
            _ = comp.CallProc("New");
        }

        public static void RegisterProcs()
        {
`;

    const registrations: string[] = [];
    const procMembers: string[] = [];

    for (const [pathKey, irType] of irMap.entries()) {
      if (irType.procs.size === 0) continue;

      const className = this.pathToClassName(pathKey);
      procMembers.push(`\n        // Procs for ${pathKey}\n`);

      for (const [procName, procNode] of irType.procs.entries()) {
        const csharpProcName = this.capitalize(procName);
        let member = `        public static async Task<DMValue> Proc_${className}_${csharpProcName}(DMRuntimeComponent comp, DMValue[] args)\n        {\n`;

        procNode.args.forEach((arg, idx) => {
          // Args are stored on the component so body references via
          // comp.GetVar(name) resolve them; this also sidesteps C# keyword
          // collisions (e.g. an arg named `event` or `object`).
          member += `            comp.SetVar("${arg.name}", args.Length > ${idx} ? args[${idx}] : DMValue.Null);\n`;
        });

        if (this.referencesIdentifier(procNode, 'args')) {
          member += `            var __dmArgs = DMList.FromArray(args);\n`;
        }

        for (const stmt of procNode.statements) {
          member += this.transpileStatement(stmt, 12); // 12 spaces indent
        }

        member += `            return comp.GetVar(".");\n        }\n`;
        procMembers.push(member);

        registrations.push(
          `            ProcRegistry.Register("${pathKey}", "${procName}", Proc_${className}_${csharpProcName});`
        );
      }
    }

    for (const reg of registrations) {
      code += `${reg}\n`;
    }
    code += `        }\n`;

    for (const member of procMembers) {
      code += member;
    }

    code += `    }\n}\n`;
    return code;
  }

  private transpileStatement(stmt: any, indent: number): string {
    const pad = ' '.repeat(indent);
    
    switch (stmt.type) {
      case 'ReturnStatement':
        if (stmt.returnValue) {
          return `${pad}return ${this.transpileExpression(stmt.returnValue)};\n`;
        }
        // Bare `return` returns the implicit '.' value in DM
        return `${pad}return comp.GetVar(".");\n`;

      case 'SleepStatement':
        if (stmt.timeExpr) {
          return `${pad}await DMTickScheduler.Sleep(${this.transpileExpression(stmt.timeExpr)});\n`;
        }
        return `${pad}await DMTickScheduler.Sleep(DMValue.FromNumber(1));\n`;

      case 'DeleteStatement':
        if (stmt.target) {
          return `${pad}DMDelete(${this.transpileExpression(stmt.target)});\n`;
        }
        return `${pad}// delete with no target\n`;

      case 'SwitchStatement':
        let switchCode = '';
        const cases: { values: any[]; body: any[] }[] = stmt.cases || [];
        const switchCond = this.transpileExpression(stmt.switchValue);
        for (let i = 0; i < cases.length; i++) {
          const c = cases[i];
          const conds = c.values.map(v => `DMValue.In(${switchCond}, ${this.transpileExpression(v)})`).join(' || ');
          switchCode += `${pad}${i === 0 ? 'if' : 'else if'} (${conds})\n${pad}{\n`;
          for (const s of c.body || []) {
            switchCode += this.transpileStatement(s, indent + 4);
          }
          switchCode += `${pad}}\n`;
        }
        if (stmt.defaultBody && stmt.defaultBody.length > 0) {
          switchCode += `${pad}else\n${pad}{\n`;
          for (const s of stmt.defaultBody) {
            switchCode += this.transpileStatement(s, indent + 4);
          }
          switchCode += `${pad}}\n`;
        }
        return switchCode;

      case 'SpawnStatement':
        let spawnCode = `${pad}DMTickScheduler.Spawn(${stmt.timeExpr ? this.transpileExpression(stmt.timeExpr) : 'DMValue.FromNumber(0)'}, async () => {\n`;
        for (const s of stmt.body || []) {
          spawnCode += this.transpileStatement(s, indent + 4);
        }
        spawnCode += `${pad}});\n`;
        return spawnCode;

      case 'AssignmentStatement':
        return `${pad}comp.SetVar("${stmt.assignmentTarget}", ${this.transpileExpression(stmt.assignmentValue)});\n`;

      case 'VarDeclStatement':
        if (stmt.varInit) {
          return `${pad}comp.SetVar("${stmt.varName}", ${this.transpileExpression(stmt.varInit)});\n`;
        }
        return `${pad}comp.SetVar("${stmt.varName}", DMValue.Null);\n`;

      case 'IfStatement':
        let ifCode = `${pad}if (${this.transpileExpression(stmt.condition)}.IsTrue())\n${pad}{\n`;
        for (const s of stmt.thenBranch || []) {
          ifCode += this.transpileStatement(s, indent + 4);
        }
        ifCode += `${pad}}\n`;
        if (stmt.elseBranch && stmt.elseBranch.length > 0) {
          ifCode += `${pad}else\n${pad}{\n`;
          for (const s of stmt.elseBranch) {
            ifCode += this.transpileStatement(s, indent + 4);
          }
          ifCode += `${pad}}\n`;
        }
        return ifCode;

      case 'WhileStatement':
        let whileCode = `${pad}while (${this.transpileExpression(stmt.condition)}.IsTrue())\n${pad}{\n`;
        for (const s of stmt.loopBody || []) {
          whileCode += this.transpileStatement(s, indent + 4);
        }
        whileCode += `${pad}}\n`;
        return whileCode;

      case 'DoWhileStatement':
        let doCode = `${pad}do\n${pad}{\n`;
        for (const s of stmt.loopBody || []) {
          doCode += this.transpileStatement(s, indent + 4);
        }
        doCode += `${pad}} while (${stmt.condition ? this.transpileExpression(stmt.condition) : 'DMValue.FromNumber(1)'}.IsTrue());\n`;
        return doCode;

      case 'CForStatement':
        let cforCode = `${pad}{\n`;
        if (stmt.loopVariable) {
          cforCode += `${pad}    comp.SetVar("${stmt.loopVariable}", ${this.transpileExpression(stmt.init)});\n`;
          cforCode += `${pad}    while (${this.transpileExpression(stmt.condition)}.IsTrue())\n${pad}    {\n`;
          for (const s of stmt.loopBody || []) {
            cforCode += this.transpileStatement(s, indent + 8);
          }
          cforCode += `${pad}        comp.SetVar("${stmt.loopVariable}", ${this.transpileExpression(stmt.increment)});\n`;
          cforCode += `${pad}    }\n`;
        }
        cforCode += `${pad}}\n`;
        return cforCode;

      case 'ForStatement':
        // DM for(x in list) -> real iteration over list elements
        let forCode = `${pad}{\n`;
        if (stmt.loopVariable && stmt.loopRange) {
          forCode += `${pad}    foreach (var __dmIter in DMListItems(${this.transpileExpression(stmt.loopRange)}))\n`;
          forCode += `${pad}    {\n`;
          forCode += `${pad}        comp.SetVar("${stmt.loopVariable}", __dmIter);\n`;
          for (const s of stmt.loopBody || []) {
            forCode += this.transpileStatement(s, indent + 8);
          }
          forCode += `${pad}    }\n`;
        }
        forCode += `${pad}}\n`;
        return forCode;

      case 'ExpressionStatement':
        if (stmt.expression) {
          const expr = this.transpileExpression(stmt.expression);
          if (stmt.expression.type === 'property_assignment' || stmt.expression.type === 'index_assignment') {
            return `${pad}_ = ${expr};\n`;
          }
          return `${pad}${expr};\n`;
        }
        return '';

      default:
        return `${pad}// Unknown statement: ${stmt.type}\n`;
    }
  }

  private transpileExpression(node: ExpressionNode): string {
    switch (node.type) {
      case 'literal':
        return this.transpileLiteral(node);
      case 'variable':
        return this.transpileVariable(node);
      case 'binary':
        return this.transpileBinary(node);
      case 'unary':
        return this.transpileUnary(node);
      case 'call':
        return this.transpileCall(node);
      case 'new':
        return `await DMNew(comp, "${node.typePath}"${node.arguments.length > 0 ? ', ' + node.arguments.map((a: any) => this.transpileExpression(a)).join(', ') : ''})`;
      case 'ternary':
        return this.transpileTernary(node);
      case 'property':
        return this.transpileProperty(node);
      case 'index':
        return this.transpileIndex(node);
      case 'assignment':
        // Variable assignment within expression
        return `comp.SetVar("${(node as any).target}", ${this.transpileExpression((node as any).value)})`;
      case 'property_assignment':
        return `(${this.transpileExpression((node as any).target)}).AsComponent()?.SetVar("${(node as any).property}", ${this.transpileExpression((node as any).value)}) ?? DMValue.Null`;
      case 'index_assignment':
        return `DMListSet(${this.transpileExpression((node as any).target)}, ${this.transpileExpression((node as any).index)}, ${this.transpileExpression((node as any).value)})`;
      case 'list':
        return `DMRuntimeHelpers.MakeList(${node.elements.map((e: any) => this.transpileExpression(e)).join(', ')})`;
      case 'range':
        return `DMRuntimeHelpers.MakeRange(${this.transpileExpression(node.start)}, ${this.transpileExpression(node.end)})`;
      default:
        return 'DMValue.Null';
    }
  }

  private transpileLiteral(node: any): string {
    switch (node.literalType) {
      case 'string':
        return `DMValue.FromString("${this.escapeString(node.value)}")`;
      case 'number':
        return `DMValue.FromNumber(${node.value})`;
      case 'bool':
        return node.value ? 'DMValue.FromNumber(1)' : 'DMValue.FromNumber(0)';
      case 'null':
      default:
        return 'DMValue.Null';
    }
  }

  private transpileVariable(node: any): string {
    // Special DM variables: src = the current object, usr = the calling mob,
    // args = the current proc's argument list (DMList, 1-indexed).
    if (node.name === 'src') return 'DMValue.FromComponent(comp)';
    if (node.name === 'usr') return 'DMRuntimeHelpers.CurrentUsr';
    if (node.name === 'args') return '__dmArgs';
    return `comp.GetVar("${node.name}")`;
  }

  private referencesIdentifier(node: any, name: string): boolean {
    if (!node || typeof node !== 'object') return false;
    if (node.type === 'variable' && node.name === name) return true;
    if (Array.isArray(node)) return node.some(n => this.referencesIdentifier(n, name));
    for (const key of Object.keys(node)) {
      if (this.referencesIdentifier(node[key], name)) return true;
    }
    return false;
  }

  private transpileBinary(node: any): string {
    const left = this.transpileExpression(node.left);
    const right = this.transpileExpression(node.right);

    switch (node.operator) {
      case '+': return `DMValue.Add(${left}, ${right})`;
      case '-': return `DMValue.Subtract(${left}, ${right})`;
      case '*': return `DMValue.Multiply(${left}, ${right})`;
      case '/': return `DMValue.Divide(${left}, ${right})`;
      case '%': return `DMValue.Modulo(${left}, ${right})`;
      case '==': return `DMValue.Equals(${left}, ${right})`;
      case '~=': return `DMValue.Equals(${left}, ${right})`; // ~= is fuzzy compare; approximated
      case '!=': return `!DMValue.Equals(${left}, ${right})`;
      case '~!': return `!DMValue.Equals(${left}, ${right})`; // ~! is fuzzy not-equal; approximated
      case '<': return `DMValue.LessThan(${left}, ${right})`;
      case '<=': return `DMValue.LessOrEqual(${left}, ${right})`;
      case '>': return `DMValue.GreaterThan(${left}, ${right})`;
      case '>=': return `DMValue.GreaterOrEqual(${left}, ${right})`;
      case '&&': return `DMValue.And(${left}, ${right})`;
      case '||': return `DMValue.Or(${left}, ${right})`;
      case '<<': return `DMValue.Output(${left}, ${right})`;
      case 'in': return `DMValue.In(${left}, ${right})`;
      case 'to': return `DMRuntimeHelpers.MakeRange(${left}, ${right})`;
      case '**': return `DMValue.Power(${left}, ${right})`;
      case '%%': return `DMValue.Modulo(${left}, ${right})`;
      case '&': case '|': case '^': case '~': return 'DMValue.Null'; // bitwise ops unsupported by the runtime; parsed without data loss
      default: return 'DMValue.Null';
    }
  }

  private transpileUnary(node: any): string {
    const operand = this.transpileExpression(node.operand);
    switch (node.operator) {
      case '!': return `DMValue.Not(${operand})`;
      case '-': return `DMValue.Negate(${operand})`;
      case '+': return operand;
      case '~': return 'DMValue.Null'; // bitwise NOT unsupported by the runtime
      default: return operand;
    }
  }

  private transpileCall(node: any): string {
    const args = node.arguments.map((a: any) => this.transpileExpression(a)).join(', ');

    // Method call on a target: obj.method(x)
    if (node.target) {
      if (!args) {
        return `await DMCallProc(${this.transpileExpression(node.target)}, "${node.name}")`;
      }
      return `await DMCallProc(${this.transpileExpression(node.target)}, "${node.name}", ${args})`;
    }

    // Built-in DM procs
    const builtin = transpileBuiltinCall(node.name, args);
    if (builtin !== null) {
      return builtin;
    }
    // User-defined proc - call through runtime
    if (!args) {
      return `await comp.CallProc("${node.name}")`;
    }
    return `await comp.CallProc("${node.name}", ${args})`;
  }

  private transpileTernary(node: any): string {
    const cond = this.transpileExpression(node.condition);
    const trueExpr = this.transpileExpression(node.trueExpr);
    const falseExpr = this.transpileExpression(node.falseExpr);
    return `${cond}.IsTrue() ? ${trueExpr} : ${falseExpr}`;
  }

  private transpileProperty(node: any): string {
    const target = this.transpileExpression(node.target);
    return `(${target}).AsComponent()?.GetVar("${node.property}") ?? DMValue.Null`;
  }

  private transpileIndex(node: any): string {
    const target = this.transpileExpression(node.target);
    const index = this.transpileExpression(node.index);
    return `DMListGet(${target}, ${index})`;
  }

  private escapeString(str: string): string {
    return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
  }

  private pathToClassName(dmPath: string): string {
    const parts = dmPath.split('/').filter(Boolean);
    return parts.map(p => this.capitalize(p)).join('');
  }

  private capitalize(str: string): string {
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1);
  }
}