import * as fs from 'fs';
import * as path from 'path';
import { DMIRType } from '../ir/dmIRGenerator.js';
import { DMGlobalVarDeclNode, DMProcDeclNode, ExpressionNode } from '../parser/dmParser.js';
import { transpileBuiltinCall } from './builtinMappings.js';
import { SymbolTable, computeParentPath } from '../ir/symbolTable.js';

/** A proc-local variable: its C# name and declared DM type (for implicit `new` / istype). */
interface LocalVar {
  cs: string;
  varType?: string;
  /** var/static or var/global inside a proc: lives in the global store under this key. */
  staticKey?: string;
}

/** Per-proc emission state. Locals are real C# locals, never datum vars. */
interface ProcFrame {
  typePath: string | null; // null = global proc
  procName: string;
  defIndex: number;
  argNames: string[];
  scopes: Map<string, LocalVar>[];
  dotName: string;
  argsName: string;
  usesArgs: boolean;
}

export interface EmitOptions {
  /** C# namespace for the generated code (probes emit one namespace per probe). */
  namespace?: string;
}

const STATIC_LOCAL_MODIFIERS = ['static', 'global'];

export class CSharpEmitter {
  private tempCounter = 0;
  private symbols: SymbolTable | null = null;
  private warnedCalls = new Set<string>();
  private loopDepth = 0;
  private switchDepth = 0;
  private lambdaDepth = 0;
  private continueLabels: string[] = [];
  private frame: ProcFrame | null = null;
  /** Context-free emission (type var defaults, global initializers): no src, no locals. */
  private globalsMode = false;
  private globalNames = new Set<string>();
  /** Static locals discovered while emitting procs: key -> initializer C# (context-free). */
  private staticLocals: { key: string; init: string }[] = [];
  /** Type var initializers that need a per-instance init function. */
  private initFunctions: string[] = [];
  private namespace = 'Content.Server.DM';
  private pathClassNameMap = new Map<string, string>();
  private usedClassNames = new Set<string>();

  constructor(options: EmitOptions = {}) {
    if (options.namespace) this.namespace = options.namespace;
  }

  private nextTemp(): string {
    return `__dm_t${this.tempCounter++}`;
  }

  public emitCSharpSystems(irMap: Map<string, DMIRType>, outputServerDir: string, globals: DMGlobalVarDeclNode[] = [], symbols?: SymbolTable): void {
    fs.mkdirSync(outputServerDir, { recursive: true });
    this.symbols = symbols ?? null;
    fs.writeFileSync(path.join(outputServerDir, 'ConvertedDMProcs.cs'), this.generateProcsCS(irMap, globals), 'utf-8');
    fs.writeFileSync(path.join(outputServerDir, 'ConvertedDMSystem.cs'), this.generateSystemCS(), 'utf-8');
  }

  /** Corpus-scale variant: chunked proc files (see generateProcsCSFile). */
  public emitCSharpSystemsFile(irMap: Map<string, DMIRType>, outputServerDir: string, globals: DMGlobalVarDeclNode[] = [], symbols?: SymbolTable): void {
    fs.mkdirSync(outputServerDir, { recursive: true });
    this.symbols = symbols ?? null;
    this.generateProcsCSFile(irMap, globals, path.join(outputServerDir, 'ConvertedDMProcs.cs'));
    fs.writeFileSync(path.join(outputServerDir, 'ConvertedDMSystem.cs'), this.generateSystemCS(), 'utf-8');
  }

  /** Single-file form (tests, probes): head + every registration/member + tail. */
  public generateProcsCS(irMap: Map<string, DMIRType>, globals: DMGlobalVarDeclNode[] = [], symbols?: SymbolTable): string {
    if (symbols) this.symbols = symbols;
    const { head, units, tail } = this.emitAll(irMap, globals);
    const regs = units.map(u => u.reg).filter(Boolean).join('\n');
    const members = units.map(u => u.member).join('');
    return `${head}        public static void RegisterTypes()
        {
${regs}
        }
${members}    }

    public static class ConvertedDMInits
    {
${this.initFunctions.join('')}    }
${tail}`;
  }

  /**
   * Corpus-scale emission: ConvertedDMProcs.cs keeps Boot()/GlobalVars; the
   * registrations and members are chunked into ConvertedDMProcs_<n>.cs
   * classes. Two .NET limits force the split: Roslyn's superlinear per-file
   * cost, and the CLR's ~65,536 methods-per-type cap.
   */
  public generateProcsCSFile(irMap: Map<string, DMIRType>, globals: DMGlobalVarDeclNode[], filePath: string): void {
    const { head, units, tail } = this.emitAll(irMap, globals);
    const FLUSH_AT = 4 * 1024 * 1024;
    const parts: { regs: string[]; members: string }[] = [];
    let current = { regs: [] as string[], members: '' };
    for (const u of units) {
      if (current.members.length + u.member.length > FLUSH_AT && current.members.length > 0) {
        parts.push(current);
        current = { regs: [], members: '' };
      }
      if (u.reg) current.regs.push(u.reg);
      current.members += u.member;
    }
    // Init functions go in their own part (they are referenced by registrations
    // in any part through the ConvertedDMInits class).
    parts.push(current);
    const calls = parts.map((_, i) => `            ConvertedDMProcs_${i + 1}.RegisterTypes_${i + 1}();`).join('\n');
    fs.writeFileSync(filePath, `${head}        public static void RegisterTypes()
        {
${calls}
        }
    }
${tail}`);
    const prefix = this.fileHeader();
    parts.forEach((part, i) => {
      const n = i + 1;
      fs.writeFileSync(`${filePath.replace(/\.cs$/, '')}_${n}.cs`, `${prefix}    public static partial class ConvertedDMProcs_${n}
    {
        public static void RegisterTypes_${n}()
        {
${part.regs.join('\n')}
        }
${part.members}    }
}
`);
    });
    fs.writeFileSync(`${filePath.replace(/\.cs$/, '')}_Inits.cs`, `${prefix}    public static class ConvertedDMInits
    {
${this.initFunctions.join('')}    }
}
`);
  }

  private fileHeader(): string {
    return `using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using SS13.DM.Runtime;
using static SS13.DM.Runtime.DMRuntimeHelpers;

namespace ${this.namespace}
{
#pragma warning disable CS0162, CS0164, CS1998, CS8321
`;
  }

  /** Emits every type registration + proc member (as units) and the head/tail around them. */
  private emitAll(irMap: Map<string, DMIRType>, globals: DMGlobalVarDeclNode[]): { head: string; units: { reg: string; member: string }[]; tail: string } {
    this.pathClassNameMap.clear();
    this.usedClassNames.clear();
    this.warnedCalls.clear();
    this.staticLocals = [];
    this.initFunctions = [];
    this.globalNames = new Set(globals.map(g => g.name));
    const units: { reg: string; member: string }[] = [];

    for (const [pathKey, irType] of irMap.entries()) {
      const isGlobalProcs = pathKey === '/proc' || pathKey.startsWith('/proc/');
      if (!isGlobalProcs) units.push({ reg: this.emitTypeRegistration(pathKey, irType), member: '' });
      if (irType.procDefs.length === 0) continue;
      const className = this.pathToClassName(pathKey);
      const usedMembers = new Set<string>();
      for (const def of irType.procDefs) {
        const memberName = `P_${className}_${this.nextProcMemberName(def.name, usedMembers)}`;
        const { member, waitFor } = this.emitProc(isGlobalProcs ? null : pathKey, def.name, def.index, def.node, memberName);
        const params = def.node.args.length > 0
          ? `new[] { ${def.node.args.map(a => `"${this.escapeString(a.name)}"`).join(', ')} }`
          : 'null';
        const owner = isGlobalProcs ? '/proc' : pathKey;
        units.push({
          reg: `            ProcRegistry.Register("${this.escapeString(owner)}", "${this.escapeString(def.name)}", ${memberName}, ${params}, ${waitFor ? 'true' : 'false'});`,
          member,
        });
      }
    }

    const head = `${this.fileHeader()}    /// <summary>
    /// Transpiled DM code. Engine-free: operates on the SS13.DM.Runtime type
    /// table, datums and scheduler. Boot() registers the type tree, runs the
    /// global initializers, then the engine adapter runs world/New().
    /// </summary>
    public static partial class ConvertedDMProcs
    {
        public static void RegisterProcs()
        {
            RegisterTypes();
            DMTypes.Seal();
        }

        public static async Task Boot()
        {
            RegisterProcs();
            await GlobalVars.Init();
        }

`;
    return { head, units, tail: this.emitGlobalVars(globals) };
  }

  // ===== type registration =====

  /** Declares a type, its own var defaults (constants) and per-instance initializers. */
  private emitTypeRegistration(pathKey: string, irType: DMIRType): string {
    const p = this.escapeString(pathKey);
    const implicitParent = computeParentPath(pathKey);
    const lines: string[] = [];
    lines.push(irType.parentPath && irType.parentPath !== implicitParent
      ? `            DMTypes.Declare("${p}", "${this.escapeString(irType.parentPath)}");`
      : `            DMTypes.Declare("${p}");`);
    for (const v of irType.ownVars) {
      const name = this.escapeString(v.name);
      if (!v.expr) {
        lines.push(`            DMTypes.DefineVar("${p}", "${name}", DMValue.Null);`);
        continue;
      }
      if (this.isConstantExpr(v.expr)) {
        lines.push(`            DMTypes.DefineVar("${p}", "${name}", ${this.inGlobalsMode(() => this.transpileExpression(v.expr!))});`);
        continue;
      }
      // Non-constant initializer: runs per instance before New() (BYOND's
      // hidden init proc) with src bound.
      const fn = `I_${this.pathToClassName(pathKey)}_${this.sanitizeIdentifier(v.name)}_${this.tempCounter++}`;
      const body = this.withFrame({ typePath: pathKey, procName: '(init)', defIndex: 0, argNames: [] }, () => this.transpileExpression(v.expr!));
      this.initFunctions.push(`        public static async Task<DMValue> ${fn}(DMRuntime comp)\n        {\n            DMValue __dot = DMValue.Null;\n            return ${body};\n        }\n`);
      lines.push(`            DMTypes.DefineVarInit("${p}", "${name}", ConvertedDMInits.${fn});`);
    }
    return lines.join('\n');
  }

  /** Literal/operator trees with no names or calls: evaluated once at registration. */
  private isConstantExpr(e: any): boolean {
    if (!e) return true;
    switch (e.type) {
      case 'literal': return true;
      case 'unary': return this.isConstantExpr(e.operand);
      case 'binary': return e.operator !== 'in' && e.operator !== 'as' && this.isConstantExpr(e.left) && this.isConstantExpr(e.right);
      case 'ternary': return this.isConstantExpr(e.condition) && this.isConstantExpr(e.trueExpr) && this.isConstantExpr(e.falseExpr);
      case 'interp': return e.parts.every((x: any) => this.isConstantExpr(x));
      default: return false;
    }
  }

  private inGlobalsMode<T>(fn: () => T): T {
    const prevMode = this.globalsMode;
    const prevFrame = this.frame;
    this.globalsMode = true;
    this.frame = null;
    try {
      return fn();
    } finally {
      this.globalsMode = prevMode;
      this.frame = prevFrame;
    }
  }

  private withFrame<T>(f: { typePath: string | null; procName: string; defIndex: number; argNames: string[] }, fn: () => T): T {
    const prev = this.frame;
    const prevMode = this.globalsMode;
    this.globalsMode = false;
    this.frame = { ...f, scopes: [new Map()], dotName: '__dot', argsName: '__dmArgs', usesArgs: false };
    try {
      return fn();
    } finally {
      this.frame = prev;
      this.globalsMode = prevMode;
    }
  }

  // ===== procs =====

  private emitProc(typePath: string | null, procName: string, defIndex: number, node: DMProcDeclNode, memberName: string): { member: string; waitFor: boolean } {
    this.loopDepth = 0;
    this.switchDepth = 0;
    this.lambdaDepth = 0;
    this.continueLabels = [];
    let waitFor = true;
    for (const s of node.statements) {
      if (s.type === 'SetStatement' && s.setting === 'waitfor' && s.value) {
        waitFor = !(s.value.type === 'literal' && (s.value.value === 0 || s.value.value === '0' || s.value.value === false));
      }
    }
    return this.withFrame({ typePath, procName, defIndex, argNames: node.args.map(a => a.name) }, () => {
      const frame = this.frame!;
      let body = '';
      node.args.forEach((arg, idx) => {
        const local = this.declareLocal(arg.name, arg.typeHint ? '/' + arg.typeHint.replace(/^\/+/, '') : undefined);
        body += `            DMValue ${local.cs} = args.Length > ${idx} ? args[${idx}] : DMValue.Null;\n`;
        // BYOND applies the default when the argument is omitted or null.
        if (arg.defaultValue) body += `            if (${local.cs}.IsNull) ${local.cs} = ${this.transpileExpression(arg.defaultValue)};\n`;
      });
      let stmts = '';
      for (const stmt of node.statements) stmts += this.transpileStatement(stmt, 12);
      const lastStmt = node.statements[node.statements.length - 1];
      const tail = lastStmt && lastStmt.type === 'ReturnStatement' ? '' : `            return __dot;\n`;
      const argsDecl = frame.usesArgs ? `            var __dmArgs = DMList.FromArray(args);\n` : '';
      const member = `        public static async Task<DMValue> ${memberName}(DMRuntime comp, DMValue[] args)\n        {\n            DMValue __dot = DMValue.Null;\n${body}${argsDecl}${stmts}${tail}        }\n`;
      return { member, waitFor };
    });
  }

  private pushScope(): void {
    this.frame!.scopes.push(new Map());
  }

  private popScope(): void {
    this.frame!.scopes.pop();
  }

  private declareLocal(name: string, varType?: string, staticKey?: string): LocalVar {
    const local: LocalVar = { cs: `l_${this.sanitizeIdentifier(name)}_${this.tempCounter++}`, varType, staticKey };
    this.frame!.scopes[this.frame!.scopes.length - 1].set(name, local);
    return local;
  }

  private lookupLocal(name: string): LocalVar | undefined {
    if (!this.frame) return undefined;
    for (let i = this.frame.scopes.length - 1; i >= 0; i--) {
      const v = this.frame.scopes[i].get(name);
      if (v) return v;
    }
    return undefined;
  }

  // ===== names =====

  /** How a bare identifier reads: local > src var > global var (BYOND scoping). */
  private readName(name: string): string {
    if (name === '.') return this.frame ? this.frame.dotName : 'DMValue.Null';
    const local = this.lookupLocal(name);
    if (local) return local.staticKey ? `GlobalVars.Get("${this.escapeString(local.staticKey)}")` : local.cs;
    switch (name) {
      case 'src': return this.frame?.typePath ? 'DMValue.FromDatum(comp)' : 'DMValue.Null';
      case 'usr': return 'DMRuntimeHelpers.CurrentUsr';
      case 'world': return 'DMRuntimeHelpers.WorldValue';
      case 'args':
        if (!this.frame) return 'DMValue.Null';
        this.frame.usesArgs = true;
        return `DMValue.FromList(${this.frame.argsName})`;
      case 'null': return 'DMValue.Null';
    }
    if (this.isSrcVar(name)) return `comp.GetVar("${this.escapeString(name)}")`;
    return `GlobalVars.Get("${this.escapeString(name)}")`;
  }

  /** C# expression assigning `value` (C#) to a bare identifier; evaluates to the value. */
  private writeName(name: string, value: string): string {
    if (name === '.') return this.frame ? `(${this.frame.dotName} = ${value})` : value;
    const local = this.lookupLocal(name);
    if (local) return local.staticKey ? `GlobalVars.Set("${this.escapeString(local.staticKey)}", ${value})` : `(${local.cs} = ${value})`;
    // usr is assignable; the new value flows into callees (and spawns) of this proc.
    if (name === 'usr') return `(DMRuntimeHelpers.CurrentUsr = ${value})`;
    if (this.isSrcVar(name)) return `comp.SetVar("${this.escapeString(name)}", ${value})`;
    return `GlobalVars.Set("${this.escapeString(name)}", ${value})`;
  }

  private isSrcVar(name: string): boolean {
    const typePath = this.frame?.typePath;
    if (!typePath || this.globalsMode) return false;
    if (this.globalNames.has(name) && !(this.symbols?.resolveTypeVar(typePath, name))) return false;
    // Unknown names in a type proc fall back to src (most likely a var our
    // symbol pass could not see, e.g. a macro-generated declaration).
    return this.symbols ? this.symbols.resolveTypeVar(typePath, name) || !this.globalNames.has(name) : true;
  }

  /** Declared DM type of an expression when statically known (locals, src vars, src). */
  private declaredTypeOf(e: any): string | undefined {
    if (!e) return undefined;
    if (e.type === 'variable') {
      const local = this.lookupLocal(e.name);
      if (local) return local.varType;
      if (e.name === 'src') return this.frame?.typePath ?? undefined;
      if (this.frame?.typePath && this.symbols) return this.symbols.typeVarType(this.frame.typePath, e.name);
    }
    return undefined;
  }

  // ===== statements =====

  private transpileBlock(stmts: any[] | undefined, indent: number): string {
    this.pushScope();
    let out = '';
    for (const s of stmts || []) out += this.transpileStatement(s, indent);
    this.popScope();
    return out;
  }

  private transpileStatement(stmt: any, indent: number): string {
    const pad = ' '.repeat(indent);

    switch (stmt.type) {
      case 'ReturnStatement':
        if (this.lambdaDepth > 0) return `${pad}return;\n`;
        if (stmt.returnValue) return `${pad}return ${this.transpileExpression(stmt.returnValue)};\n`;
        return `${pad}return ${this.frame!.dotName};\n`;

      case 'SleepStatement':
        return `${pad}await DMTickScheduler.Sleep(${stmt.timeExpr ? this.transpileExpression(stmt.timeExpr) : 'DMValue.FromNumber(0)'});\n`;

      case 'SetStatement':
        return '';

      case 'DeleteStatement':
        return stmt.target ? `${pad}DMDelete(${this.transpileExpression(stmt.target)});\n` : '';

      case 'SwitchStatement': {
        const switchTemp = this.nextTemp();
        let code = `${pad}var ${switchTemp} = ${this.transpileExpression(stmt.switchValue)};\n${pad}while (true)\n${pad}{\n`;
        this.switchDepth++;
        const cases: { values: any[]; body: any[] }[] = stmt.cases || [];
        cases.forEach((c, i) => {
          const conds = c.values.map(v => this.switchCaseCondition(switchTemp, v)).join(' || ') || 'false';
          code += `${pad}    ${i === 0 ? 'if' : 'else if'} (${conds})\n${pad}    {\n${this.transpileBlock(c.body, indent + 8)}${pad}    }\n`;
        });
        if (stmt.defaultBody && stmt.defaultBody.length > 0) {
          code += `${pad}    ${cases.length === 0 ? 'if (true)' : 'else'}\n${pad}    {\n${this.transpileBlock(stmt.defaultBody, indent + 8)}${pad}    }\n`;
        }
        code += `${pad}    break;\n`;
        this.switchDepth--;
        return code + `${pad}}\n`;
      }

      case 'SpawnStatement':
        return this.transpileSpawn(stmt, indent);

      case 'AssignmentStatement':
        return `${pad}${this.stripParens(this.writeName(stmt.assignmentTarget, this.transpileValueFor(stmt.assignmentTarget, stmt.assignmentValue)))};\n`;

      case 'VarDeclStatement': {
        const modifiers: string[] = stmt.modifiers || [];
        if (modifiers.some(m => STATIC_LOCAL_MODIFIERS.includes(m))) {
          // Proc statics are globals scoped to the proc: initialized once.
          const key = `${this.frame!.typePath ?? '/proc'}/proc/${this.frame!.procName}/${stmt.varName}`;
          this.declareLocal(stmt.varName, stmt.varType, key);
          const init = stmt.varInit ? this.inGlobalsMode(() => this.transpileExpression(stmt.varInit)) : 'DMValue.Null';
          this.staticLocals.push({ key, init });
          return '';
        }
        const init = stmt.varInit ? this.transpileNewWithType(stmt.varInit, stmt.varType) : 'DMValue.Null';
        const local = this.declareLocal(stmt.varName, stmt.varType);
        return `${pad}DMValue ${local.cs} = ${init};\n`;
      }

      case 'IfStatement': {
        let code = `${pad}if ((${this.transpileExpression(stmt.condition)}).IsTrue())\n${pad}{\n${this.transpileBlock(stmt.thenBranch, indent + 4)}${pad}}\n`;
        if (stmt.elseBranch && stmt.elseBranch.length > 0) {
          code += `${pad}else\n${pad}{\n${this.transpileBlock(stmt.elseBranch, indent + 4)}${pad}}\n`;
        }
        return code;
      }

      case 'BreakStatement':
        if (stmt.label) return `${pad}goto __dmBreak_${stmt.label};\n`;
        if (this.loopDepth === 0 && this.switchDepth === 0) return `${pad}// break outside a loop\n`;
        return `${pad}break;\n`;

      case 'ContinueStatement': {
        if (stmt.label) return `${pad}goto __dmLabel_${stmt.label};\n`;
        if (this.loopDepth === 0) return this.switchDepth > 0 ? `${pad}break;\n` : `${pad}// continue outside a loop\n`;
        const label = this.continueLabels[this.continueLabels.length - 1];
        if (this.switchDepth > 0 || label.startsWith('__dmForCont')) return `${pad}goto ${label};\n`;
        return `${pad}continue;\n`;
      }

      case 'WhileStatement': {
        const contLabel = `__dmWhileCont${this.tempCounter++}`;
        let code = `${pad}while ((${this.transpileExpression(stmt.condition)}).IsTrue())\n${pad}{\n${pad}    {\n`;
        code += this.loopBody(stmt.loopBody, indent + 8, contLabel);
        return code + `${pad}    }\n${pad}    ${contLabel}: ;\n${pad}}\n`;
      }

      case 'DoWhileStatement': {
        const contLabel = `__dmDoCont${this.tempCounter++}`;
        let code = `${pad}do\n${pad}{\n${pad}    {\n`;
        code += this.loopBody(stmt.loopBody, indent + 8, contLabel);
        const cond = stmt.condition ? this.transpileExpression(stmt.condition) : 'DMValue.FromNumber(1)';
        return code + `${pad}    }\n${pad}    ${contLabel}: ;\n${pad}} while ((${cond}).IsTrue());\n`;
      }

      case 'CForStatement':
        return this.transpileCFor(stmt, indent);

      case 'ForStatement':
        return this.transpileForIn(stmt, indent);

      case 'ExpressionStatement': {
        if (!stmt.expression) return '';
        const e = stmt.expression;
        const expr = this.transpileExpression(e);
        if (e.type === 'call' || e.type === 'new' || e.type === 'assignment' || e.type === 'property_assignment' || e.type === 'index_assignment') {
          const bare = this.stripParens(expr);
          if (/^(await |comp\.SetVar|GlobalVars\.Set|DMOps\.|DMRuntimeHelpers\.|DM[A-Z]\w*\(|l_\w+ = |__dot = |c_\w+ = )/.test(bare) && !bare.includes(' ? ')) {
            return `${pad}${bare};\n`;
          }
        }
        return `${pad}_ = ${expr};\n`;
      }

      case 'TryStatement': {
        let code = `${pad}try\n${pad}{\n${this.transpileBlock(stmt.tryBody, indent + 4)}${pad}}\n`;
        if (stmt.catchBody && stmt.catchBody.length > 0) {
          code += `${pad}catch (System.Exception __dmEx) when (__dmEx is not OperationCanceledException)\n${pad}{\n`;
          this.pushScope();
          if (stmt.catchVar) {
            const local = this.declareLocal(stmt.catchVar, '/exception');
            code += `${pad}    DMValue ${local.cs} = DMRuntimeHelpers.ExceptionValue(__dmEx);\n`;
          }
          for (const s of stmt.catchBody) code += this.transpileStatement(s, indent + 4);
          this.popScope();
          code += `${pad}}\n`;
        } else {
          code += `${pad}catch (System.Exception __dmEx) when (__dmEx is not OperationCanceledException) { _ = __dmEx; }\n`;
        }
        return code;
      }

      case 'LabeledBlockStatement':
        return `${pad}__dmLabel_${stmt.label}:\n${this.transpileBlock(stmt.body, indent)}${pad}__dmBreak_${stmt.label}: ;\n`;

      default:
        return `${pad}// Unknown statement: ${stmt.type}\n`;
    }
  }

  private loopBody(body: any[] | undefined, indent: number, contLabel: string): string {
    this.loopDepth++;
    this.continueLabels.push(contLabel);
    const code = this.transpileBlock(body, indent);
    this.continueLabels.pop();
    this.loopDepth--;
    return code;
  }

  private switchCaseCondition(temp: string, v: any): string {
    if (v.type === 'binary' && v.operator === 'to') {
      return `DMValue.InRange(${temp}, ${this.transpileExpression(v.left)}, ${this.transpileExpression(v.right)}).IsTrue()`;
    }
    if (v.type === 'range') {
      return `DMValue.InRange(${temp}, ${this.transpileExpression(v.start)}, ${this.transpileExpression(v.end)}).IsTrue()`;
    }
    return `${temp}.Equals(${this.transpileExpression(v)})`;
  }

  /** spawn: the new thread runs with a COPY of the current locals (BYOND semantics). */
  private transpileSpawn(stmt: any, indent: number): string {
    const pad = ' '.repeat(indent);
    const frame = this.frame!;
    const saved = { loop: this.loopDepth, sw: this.switchDepth, labels: this.continueLabels.length, dot: frame.dotName };
    let code = `${pad}{\n`;
    const copies = new Map<string, LocalVar>();
    for (const scope of frame.scopes) {
      for (const [name, local] of scope) {
        if (local.staticKey) {
          copies.set(name, local);
          continue;
        }
        const copy = `c_${this.sanitizeIdentifier(name)}_${this.tempCounter++}`;
        code += `${pad}    var ${copy} = ${local.cs};\n`;
        copies.set(name, { cs: copy, varType: local.varType });
      }
    }
    const dotCopy = `c_dot_${this.tempCounter++}`;
    code += `${pad}    var ${dotCopy} = ${frame.dotName};\n`;
    const delay = stmt.timeExpr ? this.transpileExpression(stmt.timeExpr) : 'DMValue.FromNumber(0)';
    this.loopDepth = 0;
    this.switchDepth = 0;
    this.lambdaDepth++;
    frame.scopes.push(copies);
    frame.dotName = dotCopy;
    code += `${pad}    DMTickScheduler.Spawn(${delay}, async () =>\n${pad}    {\n`;
    code += this.transpileBlock(stmt.body, indent + 8);
    code += `${pad}    });\n${pad}}\n`;
    frame.scopes.pop();
    frame.dotName = saved.dot;
    this.lambdaDepth--;
    this.loopDepth = saved.loop;
    this.switchDepth = saved.sw;
    this.continueLabels.length = saved.labels;
    return code;
  }

  /** Loop variable: reuse an existing local/var, else declare one in the loop scope. */
  private bindLoopVar(name: string, varType: string | undefined, pad: string): { decl: string; write: (v: string) => string; read: string } {
    const existing = this.lookupLocal(name);
    if (!existing && !(this.frame?.typePath && this.symbols?.resolveTypeVar(this.frame.typePath, name))) {
      const local = this.declareLocal(name, varType);
      return { decl: `${pad}DMValue ${local.cs} = DMValue.Null;\n`, write: v => `${local.cs} = ${v}`, read: local.cs };
    }
    return { decl: '', write: v => this.stripParens(this.writeName(name, v)), read: this.readName(name) };
  }

  private transpileCFor(stmt: any, indent: number): string {
    const pad = ' '.repeat(indent);
    const contLabel = `__dmForCont${this.tempCounter++}`;
    this.pushScope();
    let code = `${pad}{\n`;
    if (stmt.loopVariable) {
      const v = this.bindLoopVar(stmt.loopVariable, undefined, pad + '    ');
      code += v.decl;
      code += `${pad}    ${v.write(this.transpileExpression(stmt.init))};\n`;
    } else if (stmt.init) {
      code += `${pad}    _ = ${this.transpileExpression(stmt.init)};\n`;
    }
    code += `${pad}    while (true)\n${pad}    {\n`;
    if (stmt.condition) code += `${pad}        if (!(${this.transpileExpression(stmt.condition)}).IsTrue()) break;\n`;
    code += `${pad}        {\n${this.loopBody(stmt.loopBody, indent + 12, contLabel)}${pad}        }\n`;
    if (stmt.increment) {
      const inc = this.transpileExpression(stmt.increment);
      const bare = this.stripParens(inc);
      code += `${pad}        ${contLabel}:\n${pad}        ${/^(l_\w+ = |comp\.SetVar|GlobalVars\.Set|DMOps\.)/.test(bare) ? bare : '_ = ' + inc};\n`;
    } else {
      code += `${pad}        ${contLabel}: ;\n`;
    }
    code += `${pad}    }\n${pad}}\n`;
    this.popScope();
    return code;
  }

  private transpileForIn(stmt: any, indent: number): string {
    const pad = ' '.repeat(indent);
    if (!stmt.loopVariable) return '';
    this.pushScope();
    let code = `${pad}{\n`;
    const v = this.bindLoopVar(stmt.loopVariable, stmt.loopVariableType, pad + '    ');
    code += v.decl;
    const range = stmt.loopRange;
    if (range && stmt.step && range.type === 'range') {
      // for (x = a to b step n)
      const contLabel = `__dmForCont${this.tempCounter++}`;
      const stepTmp = `__dmStep${this.tempCounter++}`;
      const endTmp = `__dmEnd${this.tempCounter++}`;
      code += `${pad}    var ${stepTmp} = ${this.transpileExpression(stmt.step)};\n`;
      code += `${pad}    ${v.write(this.transpileExpression(range.start))};\n`;
      code += `${pad}    var ${endTmp} = ${this.transpileExpression(range.end)};\n`;
      code += `${pad}    while (${stepTmp}.ToNumber() >= 0 ? DMValue.LessOrEqual(${v.read}, ${endTmp}).IsTrue() : DMValue.GreaterOrEqual(${v.read}, ${endTmp}).IsTrue())\n${pad}    {\n`;
      code += `${pad}        {\n${this.loopBody(stmt.loopBody, indent + 12, contLabel)}${pad}        }\n`;
      code += `${pad}        ${contLabel}: ${v.write(`DMValue.Add(${v.read}, ${stepTmp})`)};\n${pad}    }\n`;
    } else if (range) {
      const iter = `__dmIter${this.tempCounter++}`;
      const contLabel = `__dmForInCont${this.tempCounter++}`;
      code += `${pad}    foreach (var ${iter} in DMListItems(${this.transpileExpression(range)}))\n${pad}    {\n${pad}        {\n`;
      // for (var/mob/M in L) only visits values of the declared type.
      if (stmt.loopVariableType) {
        code += `${pad}            if (!DMIsType(${iter}, DMValue.FromPath("${this.escapeString(this.normalizeTypePath(stmt.loopVariableType))}")).IsTrue()) continue;\n`;
      }
      code += `${pad}            ${v.write(iter)};\n`;
      code += this.loopBody(stmt.loopBody, indent + 12, contLabel);
      code += `${pad}        }\n${pad}        ${contLabel}: ;\n${pad}    }\n`;
    }
    code += `${pad}}\n`;
    this.popScope();
    return code;
  }

  // ===== expressions =====

  /** `x = new` / `var/T/x = new(...)`: an implicit new creates the target's declared type. */
  private transpileNewWithType(value: any, declaredType: string | undefined): string {
    if (value?.type === 'new' && !value.typePath && !value.typeExpr && declaredType) {
      return this.transpileNew({ ...value, typePath: declaredType });
    }
    return this.transpileExpression(value);
  }

  /** Value side of `name = value`, applying compound (in-place) semantics and implicit new types. */
  private transpileValueFor(name: string, value: any, compound?: string, read?: string): string {
    const op = compound;
    if (op && value?.type === 'binary') {
      const lhs = read ?? this.readName(name);
      const rhs = this.transpileExpression(value.right);
      switch (op) {
        case '+=': return `DMOps.AddAssign(${lhs}, ${rhs})`;
        case '-=': return `DMOps.RemoveAssign(${lhs}, ${rhs})`;
        case '|=': return `DMOps.CombineAssign(${lhs}, ${rhs})`;
        case '&=': return `DMOps.MaskAssign(${lhs}, ${rhs})`;
        case '||=': return `(${lhs}.IsTrue() ? ${lhs} : ${rhs})`;
        case '&&=': return `(${lhs}.IsTrue() ? ${rhs} : ${lhs})`;
      }
    }
    const declared = this.lookupLocal(name)?.varType ?? (this.frame?.typePath ? this.symbols?.typeVarType(this.frame.typePath, name) : undefined);
    return this.transpileNewWithType(value, declared);
  }

  private transpileExpression(node: ExpressionNode): string {
    const n = node as any;
    switch (n.type) {
      case 'literal':
        return this.transpileLiteral(n);
      case 'variable':
        return this.readName(n.name);
      case 'binary':
        return this.transpileBinary(n);
      case 'unary':
        return this.transpileUnary(n);
      case 'call':
        return this.transpileCall(n);
      case 'new':
        return this.transpileNew(n);
      case 'ternary':
        return `(${this.transpileExpression(n.condition)}.IsTrue() ? ${this.transpileExpression(n.trueExpr)} : ${this.transpileExpression(n.falseExpr)})`;
      case 'property':
        return this.transpileProperty(n);
      case 'index': {
        const t = this.transpileExpression(n.target);
        const i = this.transpileExpression(n.index);
        return n.safe ? `DMOps.SafeIndex(${t}, ${i})` : `DMListGet(${t}, ${i})`;
      }
      case 'assignment': {
        const value = this.transpileValueFor(n.target, n.value, n.compound);
        const write = this.writeName(n.target, value);
        return n.postfix ? `DMOps.Post(${this.readName(n.target)}, ${write})` : write;
      }
      case 'property_assignment':
        return this.transpilePropertyAssignment(n);
      case 'index_assignment':
        return this.transpileIndexAssignment(n);
      case 'list':
        return this.transpileListLiteral(n.elements);
      case 'range':
        return `DMRuntimeHelpers.MakeRange(${this.transpileExpression(n.start)}, ${this.transpileExpression(n.end)})`;
      case 'interp':
        return `DMText.Interp(${n.parts.map((p: any) => this.transpileExpression(p)).join(', ')})`;
      case 'assoc_pair':
        // Stray k = v outside a list literal: evaluate the value.
        return this.transpileExpression(n.value);
      default:
        return 'DMValue.Null';
    }
  }

  private transpileNew(n: any): string {
    const args = this.transpileArgs(n.arguments);
    const tail = args ? `, ${args}` : '';
    if (n.typeExpr) return `(await DMNewValue(${this.transpileExpression(n.typeExpr)}${tail}))`;
    const typePath = this.normalizeTypePath(n.typePath) || '/datum';
    return `(await DMNew(null, "${this.escapeString(typePath)}"${tail}))`;
  }

  private transpileProperty(n: any): string {
    const t = n.target;
    if (t?.type === 'variable' && t.name === 'src' && !this.lookupLocal('src') && this.frame?.typePath) {
      return `comp.GetVar("${this.escapeString(n.property)}")`;
    }
    if (t?.type === 'variable' && t.name === 'global' && !this.lookupLocal('global')) {
      return `GlobalVars.Get("${this.escapeString(n.property)}")`;
    }
    const target = this.transpileExpression(t);
    return n.safe
      ? `DMOps.SafeGet(${target}, "${this.escapeString(n.property)}")`
      : `DMRuntimeHelpers.DMGetProperty(${target}, "${this.escapeString(n.property)}")`;
  }

  private transpilePropertyAssignment(n: any): string {
    const t = n.target;
    const prop = this.escapeString(n.property);
    if (t?.type === 'variable' && t.name === 'src' && !this.lookupLocal('src') && this.frame?.typePath) {
      const read = `comp.GetVar("${prop}")`;
      const write = `comp.SetVar("${prop}", ${this.compoundValue(n, read) ?? this.transpileExpression(n.value)})`;
      return n.postfix ? `DMOps.Post(${read}, ${write})` : write;
    }
    if (t?.type === 'variable' && t.name === 'global' && !this.lookupLocal('global')) {
      const read = `GlobalVars.Get("${prop}")`;
      const write = `GlobalVars.Set("${prop}", ${this.compoundValue(n, read) ?? this.transpileExpression(n.value)})`;
      return n.postfix ? `DMOps.Post(${read}, ${write})` : write;
    }
    const target = this.transpileExpression(t);
    // Compound and postfix forms must evaluate the target exactly once —
    // emitting it in both the read and the write duplicates `is var` temps.
    if (n.postfix) return `DMOps.PropPostfix(${target}, "${prop}", ${n.postfix === '--' ? 'true' : 'false'})`;
    const op = this.compoundOp(n);
    if (op) return `DMOps.PropCompoundAssign(${target}, "${prop}", "${op}", ${this.transpileExpression(n.value.right)})`;
    return `DMRuntimeHelpers.DMSetProperty(${target}, "${prop}", ${this.transpileExpression(n.value)})`;
  }

  private transpileIndexAssignment(n: any): string {
    const target = this.transpileExpression(n.target);
    const index = this.transpileExpression(n.index);
    if (n.postfix) return `DMOps.IndexPostfix(${target}, ${index}, ${n.postfix === '--' ? 'true' : 'false'})`;
    const op = this.compoundOp(n);
    if (op) return `DMOps.IndexCompoundAssign(${target}, ${index}, "${op}", ${this.transpileExpression(n.value.right)})`;
    return `DMOps.IndexAssign(${target}, ${index}, ${this.transpileExpression(n.value)})`;
  }

  /** += -= |= &= on a non-variable target, when the parser desugared it to `t = t + v`. */
  private compoundOp(n: any): string | null {
    if (!n.compound || n.value?.type !== 'binary') return null;
    switch (n.compound) {
      case '+=': case '-=': case '|=': case '&=': return n.compound;
      default: return null;
    }
  }

  /** In-place compound ops on a non-variable target (L[i] += x, a.b |= y). */
  private compoundValue(n: any, read: string): string | null {
    if (!n.compound || n.value?.type !== 'binary') return null;
    const rhs = this.transpileExpression(n.value.right);
    switch (n.compound) {
      case '+=': return `DMOps.AddAssign(${read}, ${rhs})`;
      case '-=': return `DMOps.RemoveAssign(${read}, ${rhs})`;
      case '|=': return `DMOps.CombineAssign(${read}, ${rhs})`;
      case '&=': return `DMOps.MaskAssign(${read}, ${rhs})`;
      default: return null;
    }
  }

  private transpileListLiteral(elements: any[]): string {
    const hasAssoc = elements.some(e => e.type === 'assoc_pair');
    if (!hasAssoc) return `DMRuntimeHelpers.MakeList(${elements.map(e => this.transpileExpression(e)).join(', ')})`;
    if (elements.every(e => e.type === 'assoc_pair')) {
      return `DMRuntimeHelpers.MakeListAssoc(${elements.map(e => `${this.transpileExpression(e.key)}, ${this.transpileExpression(e.value)}`).join(', ')})`;
    }
    return `DMRuntimeHelpers.MakeListMixed(${elements.map(e => e.type === 'assoc_pair'
      ? `(${this.transpileExpression(e.key)}, ${this.transpileExpression(e.value)}, true)`
      : `(${this.transpileExpression(e)}, DMValue.Null, false)`).join(', ')})`;
  }

  private transpileLiteral(node: any): string {
    switch (node.literalType) {
      case 'string':
        return `DMValue.FromString("${this.escapeString(node.value)}")`;
      case 'file':
        return `DMValue.FromFile("${this.escapeString(node.value)}")`;
      case 'number': {
        const v = String(node.value);
        if (v === 'Infinity') return 'DMValue.FromNumber(double.PositiveInfinity)';
        if (v === '-Infinity') return 'DMValue.FromNumber(double.NegativeInfinity)';
        if (v === 'NaN') return 'DMValue.FromNumber(double.NaN)';
        return `DMValue.FromNumber(${v}d)`;
      }
      case 'bool':
        return node.value ? 'DMValue.True' : 'DMValue.False';
      case 'path': {
        const p = String(node.value);
        // .proc/name and /type/proc/name are proc references (call()/PROC_REF).
        if (/\/(proc|verb)\//.test(p) || p.startsWith('.proc/') || p.startsWith('.verb/')) {
          return `DMValue.FromPath("${this.escapeString(p)}")`;
        }
        return `DMValue.FromPath("${this.escapeString(this.normalizeTypePath(p))}")`;
      }
      case 'null':
      default:
        return 'DMValue.Null';
    }
  }

  private normalizeTypePath(p: string): string {
    return (p || '').replace(/\/+$/, '').toLowerCase();
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
      case '%%': return `DMValue.IntModulo(${left}, ${right})`;
      case '**': return `DMValue.Power(${left}, ${right})`;
      case '==': return `DMValue.Equals(${left}, ${right})`;
      case '!=': case '<>': return `DMValue.NotEquals(${left}, ${right})`;
      case '~=': return `DMValue.Equivalent(${left}, ${right})`;
      case '~!': return `DMValue.NotEquivalent(${left}, ${right})`;
      case '<': return `DMValue.LessThan(${left}, ${right})`;
      case '<=': return `DMValue.LessOrEqual(${left}, ${right})`;
      case '>': return `DMValue.GreaterThan(${left}, ${right})`;
      case '>=': return `DMValue.GreaterOrEqual(${left}, ${right})`;
      // && / || short-circuit and evaluate to the deciding operand.
      case '&&': {
        const t = this.nextTemp();
        return `((${left}) is var ${t} && ${t}.IsTrue() ? (${right}) : (${t}))`;
      }
      case '||': {
        const t = this.nextTemp();
        return `((${left}) is var ${t} && !${t}.IsTrue() ? (${right}) : (${t}))`;
      }
      case '<<': return `DMOps.ShiftOrOutput(${left}, ${right})`;
      case '>>': return `DMValue.ShiftRight(${left}, ${right})`;
      case '&': return `DMValue.BitwiseAnd(${left}, ${right})`;
      case '|': return `DMValue.BitwiseOr(${left}, ${right})`;
      case '^': return `DMValue.BitwiseXor(${left}, ${right})`;
      case 'in':
        if (node.right?.type === 'binary' && node.right.operator === 'to') {
          return `DMValue.InRange(${left}, ${this.transpileExpression(node.right.left)}, ${this.transpileExpression(node.right.right)})`;
        }
        return `DMValue.InList(${left}, ${right})`;
      case 'as': return left;
      case 'to': return `DMRuntimeHelpers.MakeRange(${left}, ${right})`;
      default: return `DMRuntimeHelpers.Unsupported("operator ${node.operator}")`;
    }
  }

  private transpileUnary(node: any): string {
    const operand = this.transpileExpression(node.operand);
    switch (node.operator) {
      case '!': return `DMValue.Not(${operand})`;
      case '-': return `DMValue.Negate(${operand})`;
      case '~': return `DMValue.BitwiseNot(${operand})`;
      default: return operand;
    }
  }

  /** Call arguments: `name = v` arguments are named (bound to parameter names at the callee). */
  private transpileArgs(args: any[]): string {
    const hasArglist = args.some(a => a.type === 'call' && a.name === 'arglist');
    if (hasArglist) {
      return `DMRuntimeHelpers.DMArgsConcat(${args.map(a =>
        a.type === 'call' && a.name === 'arglist'
          ? `DMRuntimeHelpers.DMArgList(${this.transpileExpression(a.arguments[0])})`
          : `new[] { ${this.transpileExpression(a)} }`).join(', ')})`;
    }
    const named = args.filter(a => a.type === 'assignment' && !a.compound && !a.postfix);
    if (named.length === 0) return args.map(a => this.transpileExpression(a)).join(', ');
    const positional = args.filter(a => !named.includes(a)).map(a => this.transpileExpression(a));
    return `DMOps.NamedArgs(new DMValue[] { ${positional.join(', ')} }${named.map(a => `, ("${this.escapeString(a.target)}", ${this.transpileExpression(a.value)})`).join('')})`;
  }

  /**
   * Args for builtin helpers (DMIsNull, ReplaceText, ...) — these take
   * DMValue params, not a NamedArgs arglist, so `name = v` degrades to v
   * in its argument position.
   */
  private transpileArgsPositional(args: any[]): string {
    return args.map(a => {
      if (a.type === 'call' && a.name === 'arglist')
        return `DMRuntimeHelpers.DMArgList(${this.transpileExpression(a.arguments[0])})`;
      if (a.type === 'assignment' && !a.compound && !a.postfix)
        return this.transpileExpression(a.value);
      return this.transpileExpression(a);
    }).join(', ');
  }

  private transpileCall(node: any): string {
    const lname = String(node.name).toLowerCase();

    if ((lname === 'list' || lname === 'alist') && !node.target) return this.transpileListLiteral(node.arguments);

    // call(...)(args): invoke a proc reference.
    if (node.name === '' && node.target) {
      const refArgs = this.transpileArgs(node.arguments);
      return `(await DMRuntimeHelpers.InvokeProcRef(${this.transpileExpression(node.target)}${refArgs ? ', ' + refArgs : ''}))`;
    }

    const args = this.transpileArgs(node.arguments);
    const tail = args ? `, ${args}` : '';

    if (node.target) {
      const t = node.target;
      if (t.type === 'variable' && t.name === 'src' && !this.lookupLocal('src') && this.frame?.typePath) {
        return `(await comp.CallProc("${this.escapeString(node.name)}"${tail}))`;
      }
      if (t.type === 'variable' && t.name === 'global' && !this.lookupLocal('global')) {
        return `(await DMCallGlobal("${this.escapeString(node.name)}"${tail}))`;
      }
      const target = this.transpileExpression(t);
      return node.safe
        ? `(await DMOps.SafeCall(${target}, "${this.escapeString(node.name)}"${tail}))`
        : `(await DMCallProc(${target}, "${this.escapeString(node.name)}"${tail}))`;
    }

    if (node.name === '..') {
      const frame = this.frame;
      if (!frame) return 'DMValue.Null';
      const passArgs = node.arguments.length > 0
        ? args
        : `DMOps.ParentArgs(args${frame.argNames.map(a => `, ${this.lookupLocal(a)?.cs ?? 'DMValue.Null'}`).join('')})`;
      if (!frame.typePath) return `(await DMProcs.CallGlobalParent("${this.escapeString(frame.procName)}", ${frame.defIndex}, ${passArgs}))`;
      return `(await comp.CallParentProc("${this.escapeString(frame.typePath)}", ${frame.defIndex}, "${this.escapeString(frame.procName)}", ${passArgs}))`;
    }

    // initial(x.var) / initial(var)
    if (lname === 'initial' && node.arguments.length === 1) {
      const a = node.arguments[0];
      if (a.type === 'property') return `DMRuntimeHelpers.DMInitial(${this.transpileExpression(a.target)}, "${this.escapeString(a.property)}")`;
      if (a.type === 'variable' && this.frame?.typePath && !this.lookupLocal(a.name)) return `DMRuntimeHelpers.DMInitial(comp, "${this.escapeString(a.name)}")`;
    }
    // istype(x) with one argument tests against x's declared type.
    if (lname === 'istype' && node.arguments.length === 1) {
      const declared = this.declaredTypeOf(node.arguments[0]);
      if (declared) return `DMIsType(${this.transpileExpression(node.arguments[0])}, DMValue.FromPath("${this.escapeString(this.normalizeTypePath(declared))}"))`;
    }

    // User procs shadow same-named entries in the builtin table (tg defines
    // stack_trace, __detect_rust_g, ... as ordinary procs).
    const userProc = this.symbols
      ? (this.frame?.typePath && this.symbols.resolveTypeProc(this.frame.typePath, node.name)) || this.symbols.hasGlobalProc(node.name)
      : false;
    if (!userProc) {
      const builtin = transpileBuiltinCall(lname, this.transpileArgsPositional(node.arguments));
      if (builtin !== null) return builtin;
    }

    this.resolveAndWarn(node.name);
    if (!this.frame?.typePath || this.globalsMode) return `(await DMCallGlobal("${this.escapeString(node.name)}"${tail}))`;
    if (this.symbols && !this.symbols.resolveTypeProc(this.frame.typePath, node.name) && this.symbols.hasGlobalProc(node.name)) {
      return `(await DMCallGlobal("${this.escapeString(node.name)}"${tail}))`;
    }
    return `(await comp.CallProcOrGlobal("${this.escapeString(node.name)}"${tail}))`;
  }

  // ===== globals =====

  private emitGlobalVars(globals: DMGlobalVarDeclNode[]): string {
    let out = `    /// <summary>
    /// DM global vars (/var/global/x, GLOBAL_VAR-style declarations, proc
    /// statics). Initialized once at boot, in declaration order, before world/New().
    /// </summary>
    public static class GlobalVars
    {
        private static readonly Dictionary<string, DMValue> Vars = new Dictionary<string, DMValue>();

        public static DMValue Get(string name) => Vars.TryGetValue(name, out var v) ? v : DMValue.Null;

        public static DMValue Set(string name, DMValue value)
        {
            Vars[name] = value;
            return value;
        }

        public static async Task Init()
        {
            Vars.Clear();
            DMValue __dot = DMValue.Null;
`;
    this.inGlobalsMode(() => {
      for (const g of globals) {
        let expr = g.initialValueExpr ? this.transpileExpression(g.initialValueExpr) : null;
        if (expr === null && g.initialValue) {
          expr = `DMValue.FromString("${this.escapeString(String(g.initialValue).replace(/^["']|["']$/g, ''))}")`;
        }
        out += `            Vars["${this.escapeString(g.name)}"] = ${expr ?? 'DMValue.Null'};\n`;
      }
    });
    for (const s of this.staticLocals) {
      out += `            Vars["${this.escapeString(s.key)}"] = ${s.init};\n`;
    }
    return out + `            await Task.CompletedTask;
        }
    }
}
`;
  }

  // ===== engine adapter =====

  /**
   * SS14 engine adapter (RobustToolbox v289): boots the DM runtime, drives
   * the scheduler from the engine tick, and binds DM atoms to entities.
   */
  public generateSystemCS(): string {
    return `using System;
using System.Numerics;
using Robust.Shared.GameObjects;
using Robust.Shared.Log;
using Robust.Shared.Map;
using SS13.DM.Runtime;

namespace ${this.namespace}
{
    /// <summary>
    /// Engine-facing wrapper: boots the transpiled DM program, advances
    /// world.time from the engine tick (the DM scheduler runs on the engine
    /// thread), and materializes DM atoms as entities.
    /// </summary>
    public sealed class ConvertedDMSystem : EntitySystem
    {
        private EntityUid _defaultMap;
        private bool _worldInitialized;
        private float _elapsedDeciseconds;
        private DMRuntime? _pendingBind;

        public override void Initialize()
        {
            base.Initialize();
            DMTickScheduler.ErrorSink = (thread, ex) => Logger.ErrorS("dm", "runtime error in {Thread}: {Error}", thread, ex.Message);
            DMRuntimeHelpers.OutputSink = (target, msg) => Logger.InfoS("dm", "{Target} << {Message}", target.Stringify(), msg.Stringify());
            SubscribeLocalEvent<DMRuntimeComponent, ComponentInit>(OnDMComponentInit);

            // new on an atom type spawns an entity bound to the datum the
            // runtime already created (DMNew then runs New()).
            DMRuntimeHelpers.EntitySpawnBridge = (typePath, loc, datum) =>
            {
                try
                {
                    var protoId = ProtoIdFor(typePath);
                    _pendingBind = datum;
                    var uid = EntityManager.SpawnEntity(protoId, LocCoords(loc));
                    datum.EntityId = (ulong)uid.Id;
                    Logger.InfoS("dm", "Spawned {Proto} as entity {Uid}", protoId, uid);
                }
                catch (Exception ex)
                {
                    Logger.ErrorS("dm", "Entity spawn failed for {Type}: {Ex}", typePath, ex.Message);
                }
                finally
                {
                    _pendingBind = null;
                }
            };
            DMRuntimeHelpers.EntityDeleteBridge = datum =>
            {
                if (datum.EntityId == 0) return;
                var uid = new EntityUid((int)datum.EntityId);
                if (EntityManager.EntityExists(uid)) EntityManager.QueueDeleteEntity(uid);
            };
        }

        /// <summary>
        /// World bootstrap, called once by the content EntryPoint after the
        /// entity manager is up (PostInit): registers the type tree, runs the
        /// global initializers, creates the default map and runs world/New().
        /// </summary>
        public void StartWorld()
        {
            if (_worldInitialized) return;
            _worldInitialized = true;

            _defaultMap = EntityManager.System<SharedMapSystem>().CreateMap(out _);
            Logger.InfoS("dm", "World init: map {Map} created", _defaultMap);
            DMTickScheduler.Start(async () =>
            {
                await ConvertedDMProcs.Boot();
                await DMRuntimeHelpers.World.CallProc("New");
                Logger.InfoS("dm", "World init: DM world/New() complete");
            }, "world/New");
        }

        public override void Update(float frameTime)
        {
            base.Update(frameTime);
            if (!_worldInitialized) return;
            _elapsedDeciseconds += frameTime * 10f;
            DMTickScheduler.AdvanceTo(_elapsedDeciseconds);
        }

        /// <summary>DM type path -> generated prototype id (/obj/item/x -> obj_item_x).</summary>
        public static string ProtoIdFor(string typePath)
        {
            return typePath.Trim('/').Replace("/", "_").ToLowerInvariant();
        }

        private EntityCoordinates LocCoords(DMValue loc)
        {
            if (loc.AsDatum() is { EntityId: not 0 } datum)
            {
                var locUid = new EntityUid((int)datum.EntityId);
                return EntityManager.GetComponent<TransformComponent>(locUid).Coordinates;
            }
            return new EntityCoordinates(_defaultMap, Vector2.Zero);
        }

        private void OnDMComponentInit(EntityUid uid, DMRuntimeComponent comp, ref ComponentInit args)
        {
            if (_pendingBind != null)
            {
                // Spawned by DM new(): the datum exists and DMNew runs New().
                comp.Runtime = _pendingBind;
                comp.Runtime.EntityId = (ulong)uid.Id;
                return;
            }
            // Spawned by the engine (map load / prototype): create the datum,
            // apply map var overrides, run initializers and New().
            var datum = new DMRuntime(DMTypes.GetOrThrow(comp.DMTypePath)) { EntityId = (ulong)uid.Id };
            comp.Runtime = datum;
            foreach (var (k, v) in comp.InitialVars) datum.SetVar(k, DMRuntimeHelpers.ParseMapValue(v));
            DMTickScheduler.Start(async () =>
            {
                await datum.RunInitializers();
                await datum.CallProc("New");
            }, comp.DMTypePath + "/New");
        }
    }
}
`;
  }

  // ===== utilities =====

  private stripParens(expr: string): string {
    if (!(expr.startsWith('(') && expr.endsWith(')'))) return expr;
    // Only strip when the outer parens enclose the whole expression.
    // Parens inside string literals (" ) ", "\))") don't count.
    let depth = 0;
    let inString = false;
    let inChar = false;
    for (let i = 0; i < expr.length; i++) {
      const c = expr[i];
      if (c === '\\' && (inString || inChar)) { i++; continue; }
      if (c === '"' && !inChar) { inString = !inString; continue; }
      if (c === "'" && !inString) { inChar = !inChar; continue; }
      if (inString || inChar) continue;
      if (c === '(') depth++;
      else if (c === ')' && --depth === 0 && i < expr.length - 1) return expr;
    }
    return depth === 0 ? expr.slice(1, -1) : expr;
  }

  private escapeString(str: string): string {
    return String(str)
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t')
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, (c) => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0'));
  }

  private pathToClassName(dmPath: string): string {
    const existing = this.pathClassNameMap.get(dmPath);
    if (existing) return existing;
    const parts = dmPath.split('/').filter(Boolean);
    let name = parts.map(p => this.capitalize(this.sanitizeIdentifier(p))).join('') || 'Root';
    if (this.usedClassNames.has(name)) {
      let suffix = 2;
      while (this.usedClassNames.has(`${name}_${suffix}`)) suffix++;
      name = `${name}_${suffix}`;
    }
    this.usedClassNames.add(name);
    this.pathClassNameMap.set(dmPath, name);
    return name;
  }

  private sanitizeIdentifier(name: string): string {
    const cleaned = String(name).replace(/[^A-Za-z0-9_]/g, '');
    return cleaned.length > 0 ? cleaned : 'X';
  }

  private nextProcMemberName(procName: string, used: Set<string>): string {
    let name = this.sanitizeIdentifier(this.capitalize(procName));
    if (used.has(name)) {
      let suffix = 2;
      while (used.has(`${name}_${suffix}`)) suffix++;
      name = `${name}_${suffix}`;
    }
    used.add(name);
    return name;
  }

  /** Warn once per call name that no reachable type or global declares. */
  private resolveAndWarn(name: string): void {
    if (!this.symbols || name === '' || name === '..') return;
    const lname = name.toLowerCase();
    if (this.warnedCalls.has(lname)) return;
    const known = this.symbols.resolveBareProc(this.frame?.typePath ?? null, name);
    if (!known) {
      this.warnedCalls.add(lname);
      console.warn(`[dm2ss14] symbol: unresolved proc call '${name}' (runtime lookup) — declared on no reachable type`);
    }
  }

  private capitalize(str: string): string {
    return str ? str.charAt(0).toUpperCase() + str.slice(1) : '';
  }
}
