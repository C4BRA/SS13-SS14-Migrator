import * as fs from 'fs';
import * as path from 'path';
import { DMIRType } from '../ir/dmIRGenerator.js';
import { DMGlobalVarDeclNode, ExpressionNode } from '../parser/dmParser.js';
import { transpileBuiltinCall } from './builtinMappings.js';

export class CSharpEmitter {
  private tempCounter = 0;
  private currentProcName = '';
  private loopDepth = 0;
  private switchDepth = 0;
  private lambdaDepth = 0;
  /** Per-loop continue labels (C# label or '' for loops where a plain
   *  `continue;` already reaches the correct point). Top of stack = the
   *  innermost loop; jumped to when a `continue` must cross a switch's
   *  while(true) wrapper or land on a C-for increment. */
  private continueLabels: string[] = [];

  /** While true, expressions are emitted in the GlobalVars initializer
   *  context (no `comp`, no current datum): src is Null, bare calls go
   *  through GlobalVars.CallGlobal, and new() uses a null datum. */
  private globalsMode = false;

  private nextTemp(): string {
    return `__dm_t${this.tempCounter++}`;
  }
  public emitCSharpSystems(irMap: Map<string, DMIRType>, outputServerDir: string, globals: DMGlobalVarDeclNode[] = []): void {
    if (!fs.existsSync(outputServerDir)) {
      fs.mkdirSync(outputServerDir, { recursive: true });
    }

    // ConvertedDMProcs.cs — engine-free: transpiled DM procs + proc registry
    // registration. Compiles against SS13.DM.Runtime alone (used by the
    // semantic-probe harness without any engine).
    const procsCode = this.generateProcsCS(irMap, globals);
    fs.writeFileSync(path.join(outputServerDir, 'ConvertedDMProcs.cs'), procsCode, 'utf-8');

    // ConvertedDMSystem.cs — engine adapter: an SS14 EntitySystem wired to the
    // real RobustToolbox API (compiles against Robust.Shared).
    fs.writeFileSync(path.join(outputServerDir, 'ConvertedDMSystem.cs'), this.generateSystemCS(), 'utf-8');
  }

  /**
   * Pure C# (no RobustToolbox references): the static proc registry and one
   * static method per DM proc, operating on the engine-free DMRuntime datum.
   */
  public generateProcsCS(irMap: Map<string, DMIRType>, globals: DMGlobalVarDeclNode[] = []): string {
    this.pathClassNameMap.clear();
    this.usedClassNames.clear();
    let code = `using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using SS13.DM.Runtime;
using static SS13.DM.Runtime.DMRuntimeHelpers;

namespace Content.Server.DM
{
    /// <summary>
    /// Transpiled DM procs. Engine-free: operates on the pure DMRuntime datum
    /// and the ProcRegistry, so it compiles and runs without RobustToolbox.
    /// The engine-facing ConvertedDMSystem calls RegisterProcs() at startup.
    /// </summary>
    public static class ConvertedDMProcs
    {
        public static void RegisterProcs()
        {
`;
    const registrations: string[] = [];
    const procMembers: string[] = [];

    for (const [pathKey, irType] of irMap.entries()) {
      if (irType.procs.size === 0) {
        // Var-only types still register their path so typesof() enumerates
        // them (WS9-4).
        registrations.push(`            ProcRegistry.RegisterPath("${pathKey}");`);
        continue;
      }

      const className = this.pathToClassName(pathKey);
      procMembers.push(`\n        // Procs for ${pathKey}\n`);
      const usedProcMembers = new Set<string>();

      for (const [procName, procNode] of irType.procs.entries()) {
        // C# member names must be unique and identifier-safe: sanitize the
        // proc name and case-fold it (DM procs are case-insensitive, so
        // `foo` and `Foo` on one type would otherwise collide — CS0111).
        let csharpProcName = this.sanitizeIdentifier(this.capitalize(procName));
        if (usedProcMembers.has(csharpProcName)) {
          let suffix = 2;
          while (usedProcMembers.has(`${csharpProcName}_${suffix}`)) suffix++;
          csharpProcName = `${csharpProcName}_${suffix}`;
        }
        usedProcMembers.add(csharpProcName);
        let member = `        public static async Task<DMValue> Proc_${className}_${csharpProcName}(DMRuntime comp, DMValue[] args)\n        {\n`;

        procNode.args.forEach((arg, idx) => {
          // Args are stored on the datum so body references via
          // comp.GetVar(name) resolve them; this also sidesteps C# keyword
          // collisions (e.g. an arg named `event` or `object`).
          member += `            comp.SetVar("${arg.name}", args.Length > ${idx} ? args[${idx}] : DMValue.Null);\n`;
        });

        this.currentProcName = procName;

        if (this.referencesIdentifier(procNode, 'args')) {
          member += `            var __dmArgs = DMList.FromArray(args);\n`;
        }

        for (const stmt of procNode.statements) {
          member += this.transpileStatement(stmt, 12); // 12 spaces indent
        }

        // Implicit `.` return. Skipped when the proc already ends in a
        // top-level return — the emitted `return` would be unreachable
        // (CS0162 warnings at corpus scale — WS5-18).
        const lastStmt = procNode.statements[procNode.statements.length - 1];
        if (!(lastStmt && lastStmt.type === 'ReturnStatement')) {
          member += `            return comp.GetVar(".");\n        }\n`;
        } else {
          member += `        }\n`;
        }
        procMembers.push(member);

        // Registration carries the parameter names so runtime arglist() can
        // bind associative named arguments (WS8-14). Names are escaped:
        // `operator""`-style proc names must not break the string literal.
        const paramNames = procNode.args && procNode.args.length > 0
          ? `, new[] { ${procNode.args.map((a: any) => `"${this.escapeString(a.name)}"`).join(', ')} }`
          : '';
        registrations.push(
          `            ProcRegistry.Register("${this.escapeString(pathKey)}", "${this.escapeString(procName)}", Proc_${className}_${csharpProcName}${paramNames});`
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

    code += `    }

`;

    // GlobalVars: materializes /global/var/ declarations. Initialized once,
    // lazily, in declaration order; GLOB.x reads/writes and bare calls in
    // initializers resolve here. Undeclared names read as Null (matching DM
    // before the global is assigned).
    code += `    public static class GlobalVars
    {
        private static readonly Dictionary<string, DMValue> Vars = new Dictionary<string, DMValue>();
        private static bool _initialized;

        public static async Task<DMValue> Get(string name)
        {
            await EnsureInit();
            return Vars.TryGetValue(name, out var v) ? v : DMValue.Null;
        }

        public static async Task<DMValue> Set(string name, DMValue value)
        {
            await EnsureInit();
            Vars[name] = value;
            return value;
        }

        public static async Task<DMValue> CallGlobal(string procName, params DMValue[] args)
        {
            await EnsureInit();
            return await new DMRuntime { DMTypePath = "/datum" }.CallProc(procName, args);
        }

        private static async Task EnsureInit()
        {
            if (_initialized) return;
            _initialized = true;
`;
    const prevMode = this.globalsMode;
    this.globalsMode = true;
    for (const g of globals) {
      // Round-trip: when the initializer re-parse fails (text macros, exotic
      // literals), keep the value as the raw text string instead of dropping
      // it to Null — the captured text is the source of truth.
      let expr = g.initialValueExpr ? this.transpileExpression(g.initialValueExpr) : null;
      if (expr === null && g.initialValue) {
        expr = `DMValue.FromString("${this.escapeString(g.initialValue.replace(/^["']|["']$/g, ''))}")`;
      }
      code += `            Vars["${g.name}"] = ${expr ?? 'DMValue.Null'};\n`;
    }
    this.globalsMode = prevMode;
    code += `        }
    }
}
`;
    return code;
  }

  /**
   * SS14 engine adapter against the real RobustToolbox API:
   *   - EntitySystem (abstract partial class) with a [Dependency] EntityManager field
   *   - SubscribeLocalEvent<DMRuntimeComponent, ComponentInit> with the
   *     ComponentEventRefHandler signature (EntityUid, TComp, ref TEvent)
   *   - ComponentInit : EntityEventArgs (class)
   *   - DMRuntimeComponent : Component (RegisterComponent) holding a DMRuntime datum
   * Verified against RobustToolbox commit 9cefa1167c9ac45f7258094129daf46b6c3516d3.
   */
  public generateSystemCS(): string {
    return `using Robust.Shared.GameObjects;
using SS13.DM.Runtime;

namespace Content.Server.DM
{
    /// <summary>
    /// Engine-facing wrapper: wires the transpiled DM proc registry into an
    /// SS14 EntitySystem and drives New() dispatch on component init.
    /// </summary>
    public sealed class ConvertedDMSystem : EntitySystem
    {
        public override void Initialize()
        {
            base.Initialize();
            ConvertedDMProcs.RegisterProcs();
            SubscribeLocalEvent<DMRuntimeComponent, ComponentInit>(OnDMComponentInit);
        }

        private void OnDMComponentInit(EntityUid uid, DMRuntimeComponent comp, ref ComponentInit args)
        {
            comp.Runtime.DMTypePath = comp.DMTypePath;
            foreach (var (k, v) in comp.InitialVars)
            {
                comp.Runtime.SetVar(k, DMValue.FromString(v));
            }
            ExecuteNew(uid, comp);
        }

        public void ExecuteNew(EntityUid uid, DMRuntimeComponent comp)
        {
            _ = comp.Runtime.CallProc("New");
        }
    }
}
`;
  }

  private transpileStatement(stmt: any, indent: number): string {
    const pad = ' '.repeat(indent);
    
    switch (stmt.type) {
      case 'ReturnStatement':
        // Inside a spawn() lambda (async () => {...}) a DM `return` exits the
        // block and the value is discarded; emitting `return <DMValue>;` would
        // be invalid C# in a non-generic Func<Task> lambda.
        if (this.lambdaDepth > 0) {
          return `${pad}return;\n`;
        }
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
        let switchCode = `${pad}// DM switch: emitted as if/else chain inside a while(true)\n${pad}// wrapper so that break/continue inside case bodies are valid C#\n`;
        switchCode += `${pad}while (true)\n${pad}{\n`;
        this.switchDepth++;
        const cases: { values: any[]; body: any[] }[] = stmt.cases || [];
        const switchCond = this.transpileExpression(stmt.switchValue);
        for (let i = 0; i < cases.length; i++) {
          const c = cases[i];
          const conds = c.values.map(v => `DMValue.In(${switchCond}, ${this.transpileExpression(v)}).IsTrue()`).join(' || ');
          switchCode += `${pad}    ${i === 0 ? 'if' : 'else if'} (${conds})\n${pad}    {\n`;
          for (const s of c.body || []) {
            switchCode += this.transpileStatement(s, indent + 8);
          }
          switchCode += `${pad}    }\n`;
        }
        if (stmt.defaultBody && stmt.defaultBody.length > 0) {
          // A default-only switch has no preceding if — emit `if (true)`
          // instead of a bare `else` (which is invalid C#, CS8641 — WS5-6).
          const defaultKeyword = cases.length === 0 ? 'if (true)' : 'else';
          switchCode += `${pad}    ${defaultKeyword}\n${pad}    {\n`;
          for (const s of stmt.defaultBody) {
            switchCode += this.transpileStatement(s, indent + 8);
          }
          switchCode += `${pad}    }\n`;
        }
        // Terminating break: after the last case (or default) body runs, the
        // switch is done — without this the while(true) wrapper loops forever.
        switchCode += `${pad}    break;\n`;
        this.switchDepth--;
        switchCode += `${pad}}\n`;
        return switchCode;

      case 'SpawnStatement':
        // spawn() becomes an async lambda: DM break/continue can never cross
        // the spawn boundary (DM forbids it), so loop/switch context does not
        // carry into the lambda body.
        {
          const savedLoop = this.loopDepth;
          const savedSwitch = this.switchDepth;
          const savedLambda = this.lambdaDepth;
          const savedLabels = this.continueLabels.length;
          this.loopDepth = 0;
          this.switchDepth = 0;
          this.lambdaDepth++;
          let spawnCode = `${pad}DMTickScheduler.Spawn(${stmt.timeExpr ? this.transpileExpression(stmt.timeExpr) : 'DMValue.FromNumber(0)'}, async () => {\n`;
          for (const s of stmt.body || []) {
            spawnCode += this.transpileStatement(s, indent + 4);
          }
          spawnCode += `${pad}});\n`;
          this.loopDepth = savedLoop;
          this.switchDepth = savedSwitch;
          this.lambdaDepth = savedLambda;
          this.continueLabels.length = savedLabels;
          return spawnCode;
        }

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

      case 'BreakStatement':
        // DM break exits the innermost loop, or the switch when not in a loop;
        // the switch's while(true) wrapper makes plain `break` correct in both.
        // Outside both, a raw `break` would be a C# compile error (CS0139) —
        // emit a comment instead (DM errors on this too — WS5-19).
        if (this.loopDepth === 0 && this.switchDepth === 0) {
          return `${pad}// break outside a loop\n`;
        }
        return `${pad}break;\n`;

      case 'ContinueStatement':
        // DM continue: next iteration of the innermost loop. Needs a goto
        // when (a) inside a switch — a plain `continue` would iterate the
        // switch's while(true) wrapper forever instead of the enclosing loop —
        // or (b) inside a C-style for, where the increment must still run.
        if (this.loopDepth === 0) {
          if (this.switchDepth > 0) {
            // Continue inside a switch with no enclosing loop exits the switch.
            return `${pad}break;\n`;
          }
          return `${pad}// continue outside a loop\n`;
        }
        {
          const label = this.continueLabels[this.continueLabels.length - 1];
          if (this.switchDepth > 0 || label.startsWith('__dmForCont')) {
            return `${pad}goto ${label};\n`;
          }
          return `${pad}continue;\n`;
        }

      case 'WhileStatement':
        {
          const contLabel = `__dmWhileCont${this.tempCounter++}`;
          let whileCode = `${pad}while (${this.transpileExpression(stmt.condition)}.IsTrue())\n${pad}{\n`;
          whileCode += `${pad}    {\n`;
          this.loopDepth++;
          this.continueLabels.push(contLabel);
          for (const s of stmt.loopBody || []) {
            whileCode += this.transpileStatement(s, indent + 8);
          }
          this.continueLabels.pop();
          this.loopDepth--;
          whileCode += `${pad}    }\n`;
          // Continue label for continues crossing a switch: jumping here is
          // equivalent to `continue;` (skip rest of body, re-check condition).
          whileCode += `${pad}    ${contLabel}: ;\n`;
          whileCode += `${pad}}\n`;
          return whileCode;
        }

      case 'DoWhileStatement':
        {
          const contLabel = `__dmDoCont${this.tempCounter++}`;
          let doCode = `${pad}do\n${pad}{\n`;
          doCode += `${pad}    {\n`;
          this.loopDepth++;
          this.continueLabels.push(contLabel);
          for (const s of stmt.loopBody || []) {
            doCode += this.transpileStatement(s, indent + 8);
          }
          this.continueLabels.pop();
          this.loopDepth--;
          doCode += `${pad}    }\n`;
          doCode += `${pad}    ${contLabel}: ;\n`;
          doCode += `${pad}} while (${stmt.condition ? this.transpileExpression(stmt.condition) : 'DMValue.FromNumber(1)'}.IsTrue());\n`;
          return doCode;
        }

      case 'CForStatement':
        {
          // DM for(init; cond; incr): a `continue` inside the body must still
          // execute the increment. A plain `continue` in `while (cond)` would
          // skip it (infinite loop), so the loop is `while (true)` with the
          // condition tested at the top and the increment behind a label that
          // the ContinueStatement jumps to (from a switch or the C-for body).
          // The body is wrapped in its own block so the label stays outside
          // the scope of the body's locals (C# forbids goto INTO a scope).
          const contLabel = `__dmForCont${this.tempCounter++}`;
          let cforCode = `${pad}{\n`;
          if (stmt.loopVariable) {
            cforCode += `${pad}    comp.SetVar("${stmt.loopVariable}", ${this.transpileExpression(stmt.init)});\n`;
            cforCode += `${pad}    while (true)\n${pad}    {\n`;
            cforCode += `${pad}        if (!(${this.transpileExpression(stmt.condition)}).IsTrue()) break;\n`;
            cforCode += `${pad}        {\n`;
            this.loopDepth++;
            this.continueLabels.push(contLabel);
            for (const s of stmt.loopBody || []) {
              cforCode += this.transpileStatement(s, indent + 12);
            }
            this.continueLabels.pop();
            this.loopDepth--;
            cforCode += `${pad}        }\n`;
            cforCode += `${pad}        ${contLabel}:\n`;
            cforCode += `${pad}        comp.SetVar("${stmt.loopVariable}", ${this.transpileExpression(stmt.increment)});\n`;
            cforCode += `${pad}    }\n`;
          } else if (stmt.condition) {
            // Bare-init C-style loop (for(words, words > 0, words--)): the
            // init was a plain expression; only the condition/increment apply.
            cforCode += `${pad}    while (true)\n${pad}    {\n`;
            cforCode += `${pad}        if (!(${this.transpileExpression(stmt.condition)}).IsTrue()) break;\n`;
            cforCode += `${pad}        {\n`;
            this.loopDepth++;
            this.continueLabels.push(contLabel);
            for (const s of stmt.loopBody || []) {
              cforCode += this.transpileStatement(s, indent + 12);
            }
            this.continueLabels.pop();
            this.loopDepth--;
            cforCode += `${pad}        }\n`;
            if (stmt.increment) {
              cforCode += `${pad}        ${contLabel}:\n`;
              cforCode += `${pad}        ${this.transpileExpression(stmt.increment)};\n`;
            } else {
              cforCode += `${pad}        ${contLabel}: ;\n`;
            }
            cforCode += `${pad}    }\n`;
          }
          cforCode += `${pad}}\n`;
          return cforCode;
        }

      case 'ForStatement':
        // DM for(x in list) -> real iteration over list elements. The iterator
        // local gets a unique name: nested loops would otherwise collide
        // (CS0136) when the outer iterator is used inside the inner loop.
        {
          const iter = `__dmIter${this.tempCounter++}`;
          let forCode = `${pad}{\n`;
          if (stmt.loopVariable && stmt.loopRange) {
            // DM for(x = start to end step n): index arithmetic with the
            // loop test depending on the step's sign. continue must run the
            // increment, so the label sits before it — and the label must use
            // the __dmForCont prefix the ContinueStatement recognizes (WS5-8:
            // a plain `continue` here would skip the increment forever).
            if (stmt.step && stmt.loopRange.type === 'range') {
              const contLabel = `__dmForCont${this.tempCounter++}`;
              const stepTmp = `__dmStep${this.tempCounter++}`;
              const startCode = this.transpileExpression(stmt.loopRange.start);
              const endCode = this.transpileExpression(stmt.loopRange.end);
              const stepCode = this.transpileExpression(stmt.step);
              forCode += `${pad}    var ${stepTmp} = ${stepCode};\n`;
              forCode += `${pad}    comp.SetVar("${stmt.loopVariable}", ${startCode});\n`;
              forCode += `${pad}    while (${stepTmp}.ToNumber() >= 0 ? DMValue.LessOrEqual(comp.GetVar("${stmt.loopVariable}"), ${endCode}).IsTrue() : DMValue.GreaterOrEqual(comp.GetVar("${stmt.loopVariable}"), ${endCode}).IsTrue())\n`;
              forCode += `${pad}    {\n`;
              forCode += `${pad}        {\n`;
              this.loopDepth++;
              this.continueLabels.push(contLabel);
              for (const s of stmt.loopBody || []) {
                forCode += this.transpileStatement(s, indent + 12);
              }
              this.continueLabels.pop();
              this.loopDepth--;
              forCode += `${pad}        }\n`;
              forCode += `${pad}        ${contLabel}: comp.SetVar("${stmt.loopVariable}", DMValue.Add(comp.GetVar("${stmt.loopVariable}"), ${stepTmp}));\n`;
              forCode += `${pad}    }\n`;
            } else {
              const contLabel = `__dmForInCont${this.tempCounter++}`;
              forCode += `${pad}    foreach (var ${iter} in DMListItems(${this.transpileExpression(stmt.loopRange)}))\n`;
              forCode += `${pad}    {\n`;
              forCode += `${pad}        {\n`;
              forCode += `${pad}            comp.SetVar("${stmt.loopVariable}", ${iter});\n`;
              // DM for(var/mob/M in list): elements that are not instances of
              // the declared type are skipped (continue hits the label below).
              if (stmt.loopVariableType) {
                forCode += `${pad}            if (!DMIsType(${iter}, DMValue.FromPath("${stmt.loopVariableType}")).IsTrue()) continue;\n`;
              }
              this.loopDepth++;
              this.continueLabels.push(contLabel);
              for (const s of stmt.loopBody || []) {
                forCode += this.transpileStatement(s, indent + 12);
              }
              this.continueLabels.pop();
              this.loopDepth--;
              forCode += `${pad}        }\n`;
              forCode += `${pad}        ${contLabel}: ;\n`;
              forCode += `${pad}    }\n`;
            }
          }
          forCode += `${pad}}\n`;
          return forCode;
        }

      case 'ExpressionStatement':
        if (stmt.expression) {
          const expr = this.transpileExpression(stmt.expression);
          // Calls are emitted parenthesized (so member access on the result
          // binds to the DMValue, not the Task) — but a parenthesized call is
          // not a valid C# expression-statement, so strip the outer parens.
          // Builtin calls (DMRuntimeHelpers.X(...)) are not parenthesized.
          if (stmt.expression.type === 'call') {
            const bare = expr.startsWith('(') && expr.endsWith(')') ? expr.slice(1, -1) : expr;
            return `${pad}${bare};\n`;
          }
          if (stmt.expression.type === 'assignment' || stmt.expression.type === 'index_assignment') {
            const ia = stmt.expression as any;
            // Datum-property index writes emit a parenthesized ternary
            // (`(x).AsDatum() is var t ? ... : Null`) which is not a valid
            // statement — discard the value explicitly.
            if (ia.type === 'index_assignment' && ia.target?.type === 'property' && ia.target?.target?.type !== 'variable') {
              return `${pad}_ = ${expr};\n`;
            }
            // Variable/GLOB writes may be parenthesized awaits
            // (`(await GlobalVars.Set(...))` — CS0201 in statement position,
            // WS13 root cause); strip the outer parens.
            const bare = expr.startsWith('(') && expr.endsWith(')') ? expr.slice(1, -1) : expr;
            return `${pad}${bare};\n`;
          }
          // property_assignment emits `(...).AsDatum()?.SetVar(...) ?? DMValue.Null`
          // — not a valid bare statement, so discard the value explicitly.
          if (stmt.expression.type === 'property_assignment') {
            return `${pad}_ = ${expr};\n`;
          }
          // Only calls are valid C# expression-statements; everything else
          // (ternaries, literals, binary ops, ranges, ...) is discarded via
          // the discard assignment, which keeps side effects intact.
          return `${pad}_ = ${expr};\n`;
        }
        return '';

      case 'TryStatement': {
        // DM try/catch: the catch var binds to the exception message (the
        // runtime has no DM exception datums — documented approximation).
        // Previously the whole statement silently dropped (WS5-9).
        let tryCode = `${pad}try\n${pad}{\n`;
        for (const s of stmt.tryBody || []) {
          tryCode += this.transpileStatement(s, indent + 4);
        }
        tryCode += `${pad}}\n`;
        if (stmt.catchBody && stmt.catchBody.length > 0) {
          tryCode += `${pad}catch (System.Exception __dmEx)\n${pad}{\n`;
          if (stmt.catchVar) {
            tryCode += `${pad}    comp.SetVar("${stmt.catchVar}", DMValue.FromString(__dmEx.Message));\n`;
          }
          for (const s of stmt.catchBody) {
            tryCode += this.transpileStatement(s, indent + 4);
          }
          tryCode += `${pad}}\n`;
        }
        return tryCode;
      }

      case 'LabeledBlockStatement': {
        // DM label: { ... } — the label is a no-op marker (no goto support);
        // the BODY must survive (previously dropped — WS5-9).
        let labelCode = `${pad}// label: ${stmt.label}\n`;
        for (const s of stmt.body || []) {
          labelCode += this.transpileStatement(s, indent);
        }
        return labelCode;
      }

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
        // Parenthesized: member access binds tighter than await, so callers
        // appending .IsTrue() etc. must bind to the DMValue, not the Task.
        // Global initializers have no comp; DMNew ignores the datum argument.
        return `(await DMNew(${this.globalsMode ? 'null' : 'comp'}, "${this.normalizeTypePath(node.typePath)}"${node.arguments.length > 0 ? ', ' + node.arguments.map((a: any) => this.transpileExpression(a)).join(', ') : ''}))`;
      case 'ternary':
        return this.transpileTernary(node);
      case 'property':
        return this.transpileProperty(node);
      case 'index':
        return this.transpileIndex(node);
      case 'assignment':
        // Variable assignment within expression. Global initializers have no
        // comp — write through the GlobalVars registry instead (CS0103 in
        // generated GlobalVars.EnsureInit otherwise).
        if (this.globalsMode) {
          return `(await GlobalVars.Set("${(node as any).target}", ${this.transpileExpression((node as any).value)}))`;
        }
        return `comp.SetVar("${(node as any).target}", ${this.transpileExpression((node as any).value)})`;
      case 'property_assignment': {
        // GLOB.x = v writes through the generated GlobalVars registry.
        const paTarget = (node as any).target;
        if (paTarget?.type === 'variable' && paTarget.name === 'GLOB') {
          return `(await GlobalVars.Set("${(node as any).property}", ${this.transpileExpression((node as any).value)}))`;
        }
        return `(${this.transpileExpression(paTarget)}).AsDatum()?.SetVar("${(node as any).property}", ${this.transpileExpression((node as any).value)}) ?? DMValue.Null`;
      }
      case 'index_assignment': {
        // DM list writes are copy-on-write when the list is shared; the
        // runtime returns the (possibly cloned) list, and the write-back
        // stores it in the variable so other references stay unchanged.
        const ia = node as any;
        const indexCode = this.transpileExpression(ia.index);
        const valueCode = this.transpileExpression(ia.value);
        if (ia.target?.type === 'variable') {
          if (this.globalsMode) {
            return `(await GlobalVars.Set("${ia.target.name}", DMListSet(await GlobalVars.Get("${ia.target.name}"), ${indexCode}, ${valueCode})))`;
          }
          return `comp.SetVar("${ia.target.name}", DMListSet(comp.GetVar("${ia.target.name}"), ${indexCode}, ${valueCode}))`;
        }
        // GLOB.registry["k"] = v writes through the generated GlobalVars registry.
        if (ia.target?.type === 'property' && ia.target.target?.type === 'variable' && ia.target.target.name === 'GLOB') {
          return `(await GlobalVars.Set("${ia.target.property}", DMListSet(await GlobalVars.Get("${ia.target.property}"), ${indexCode}, ${valueCode})))`;
        }
        if (ia.target?.type === 'property') {
          const t = this.nextTemp();
          const datumExpr = this.transpileExpression(ia.target.target);
          return `((${datumExpr}).AsDatum() is var ${t} ? ${t}.SetVar("${ia.target.property}", DMListSet(${t}.GetVar("${ia.target.property}"), ${indexCode}, ${valueCode})) : DMValue.Null)`;
        }
        return `DMListSet(${this.transpileExpression(ia.target)}, ${indexCode}, ${valueCode})`;
      }
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
        if (node.value === 'Infinity') return 'DMValue.FromNumber(double.PositiveInfinity)';
        if (node.value === '-Infinity') return 'DMValue.FromNumber(double.NegativeInfinity)';
        if (node.value === 'NaN') return 'DMValue.FromNumber(double.NaN)';
        // Float literals (7.0, 1e3) carry their float identity so the runtime
        // keeps DM's int-vs-float division rule (7/2=3, 7.0/2=3.5 — WS8-1).
        // The `d` suffix keeps huge literals (1e20) valid C# (WS8-16).
        return node.floatLiteral
          ? `DMValue.FromNumber(${node.value}d, true)`
          : `DMValue.FromNumber(${node.value})`;
      case 'bool':
        return node.value ? 'DMValue.FromNumber(1)' : 'DMValue.FromNumber(0)';
      case 'path':
        return `DMValue.FromPath("${this.escapeString(node.value)}")`;
      case 'null':
      default:
        return 'DMValue.Null';
    }
  }

  private transpileVariable(node: any): string {
    // Special DM variables: src = the current object, usr = the calling mob,
    // args = the current proc's argument list (DMList, 1-indexed), world = the
    // world datum.
    if (node.name === 'src') return this.globalsMode ? 'DMValue.Null' : 'DMValue.FromDatum(comp)';
    if (node.name === 'usr') return 'DMRuntimeHelpers.CurrentUsr';
    if (node.name === 'world') return 'DMRuntimeHelpers.WorldValue';
    if (node.name === 'args') return this.globalsMode ? 'DMValue.Null' : 'DMValue.FromList(__dmArgs)';
    // Global initializers have no proc scope: a bare identifier references
    // another global (there is no comp to read from).
    if (this.globalsMode) return `await GlobalVars.Get("${node.name}")`;
    return `comp.GetVar("${node.name}")`;
  }

  private normalizeTypePath(p: string): string {
    return (p || '').replace(/\/+$/, '');
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
      case '!=': return `DMValue.NotEquals(${left}, ${right})`;
      case '~!': return `DMValue.NotEquals(${left}, ${right})`; // ~! is fuzzy not-equal; approximated
      case '<': return `DMValue.LessThan(${left}, ${right})`;
      case '<=': return `DMValue.LessOrEqual(${left}, ${right})`;
      case '>': return `DMValue.GreaterThan(${left}, ${right})`;
      case '>=': return `DMValue.GreaterOrEqual(${left}, ${right})`;
      // DM && / || short-circuit AND return the deciding operand's value:
      //   a && b  ->  a if a is falsy, else b
      //   a || b  ->  a if a is truthy, else b
      // C# pattern var binds the left operand once so it is not re-evaluated.
      // Fully parenthesized: callers append members like .IsTrue() and must
      // bind to the whole ternary, not its last branch.
      case '&&': {
        const t = this.nextTemp();
        return `((${left}) is var ${t} && ${t}.IsTrue() ? (${right}) : (${t}))`;
      }
      case '||': {
        const t = this.nextTemp();
        return `((${left}) is var ${t} && !${t}.IsTrue() ? (${right}) : (${t}))`;
      }
      case '<<': {
        // DM `world << x` / `usr << x` is OUTPUT; a shift on anything else
        // is a bitwise shift. The distinction: output targets are world/usr
        // (or their properties); everything else shifts.
        const t = node.left as any;
        if ((t.type === 'variable' && (t.name === 'world' || t.name === 'usr')) ||
            (t.type === 'property' && (t.target as any)?.name === 'world')) {
          return `DMValue.Output(${left}, ${right})`;
        }
        return `DMValue.ShiftLeft(${left}, ${right})`;
      }
      case '>>': return `DMValue.ShiftRight(${left}, ${right})`;
      case '&': return `DMValue.BitwiseAnd(${left}, ${right})`;
      case '|': return `DMValue.BitwiseOr(${left}, ${right})`;
      case '^': return `DMValue.BitwiseXor(${left}, ${right})`;
      case 'in': return `DMValue.In(${left}, ${right})`;
      case 'as': return left; // DM cast on a dynamic value is a runtime no-op
      case 'to': return `DMRuntimeHelpers.MakeRange(${left}, ${right})`;
      case '**': return `DMValue.Power(${left}, ${right})`;
      case '%%': return `DMValue.IntModulo(${left}, ${right})`;
      default: return 'DMValue.Null';
    }
  }

  private transpileUnary(node: any): string {
    const operand = this.transpileExpression(node.operand);
    switch (node.operator) {
      case '!': return `DMValue.Not(${operand})`;
      case '-': return `DMValue.Negate(${operand})`;
      case '+': return operand;
      case '~': return `DMValue.BitwiseNot(${operand})`;
      default: return operand;
    }
  }

  private transpileCall(node: any): string {
    // DM f(x, arglist(L)) passes L's elements as the rest of the arguments.
    // C# params cannot spread an array inline, so any arglist() argument
    // flattens the whole argument list into a single DMArgsConcat array.
    const hasArglist = node.arguments.some((a: any) => a.type === 'call' && a.name === 'arglist');
    const args = hasArglist
      ? `DMRuntimeHelpers.DMArgsConcat(${node.arguments.map((a: any) =>
          a.type === 'call' && a.name === 'arglist'
            ? `DMRuntimeHelpers.DMArgList(${this.transpileExpression(a.arguments[0])})`
            : `DMRuntimeHelpers.DMArgList(${this.transpileExpression(a)})`
        ).join(', ')})`
      : node.arguments.map((a: any) => this.transpileExpression(a)).join(', ');

    // DM associative literal: list("a" = 1, "b" = 2) — arguments are
    // key/value pairs emitted through MakeListAssoc (plain args are values).
    if ((node.name === 'list' || node.name === 'alist') && node.arguments.some((a: any) => a.type === 'assoc_pair')) {
      const kv = node.arguments.map((a: any) =>
        a.type === 'assoc_pair'
          ? `${this.transpileExpression(a.key)}, ${this.transpileExpression(a.value)}`
          : this.transpileExpression(a)
      ).join(', ');
      return `DMRuntimeHelpers.MakeListAssoc(${kv})`;
    }

    // Invocation of a proc reference built with call(): f(...) where f is a
    // call(...) expression parses to a call node with an empty name and a
    // target. Must be handled before the generic target branch below.
    if (node.name === '' && node.target) {
      const refArgs = node.arguments.map((a: any) => this.transpileExpression(a)).join(', ');
      return `(await DMRuntimeHelpers.InvokeProcRef(${this.transpileExpression(node.target)}${refArgs ? ', ' + refArgs : ''}))`;
    }

    // Method call on a target: obj.method(x). Parenthesized so member access
    // on the result binds to the DMValue, not the awaited Task.
    if (node.target) {
      if (!args) {
        return `(await DMCallProc(${this.transpileExpression(node.target)}, "${node.name}"))`;
      }
      return `(await DMCallProc(${this.transpileExpression(node.target)}, "${node.name}", ${args}))`;
    }

    // DM initial(var): the compile-time value of a datum var. Pass the datum
    // and the var NAME (not the var's current value).
    if (node.name === 'initial' && node.arguments.length === 1) {
      const a = node.arguments[0];
      if (a.type === 'property') {
        return `DMRuntimeHelpers.DMInitial(${this.transpileExpression(a.target)}, "${a.property}")`;
      }
      if (a.type === 'variable') {
        return `DMRuntimeHelpers.DMInitial(comp, "${a.name}")`;
      }
    }
    // DM initial(x, "name"): initial(path_or_datum, var_name). The name is a
    // string literal — pass it through as a C# string (the DMValue overload
    // below would not match the runtime's (DMValue, string) signature).
    if (node.name === 'initial' && node.arguments.length === 2) {
      const nameArg = node.arguments[1];
      if (nameArg.type === 'literal' && nameArg.literalType === 'string') {
        return `DMRuntimeHelpers.DMInitial(${this.transpileExpression(node.arguments[0])}, "${this.escapeString(nameArg.value)}")`;
      }
    }

    // Built-in DM procs
    const builtin = transpileBuiltinCall(node.name, args);
    if (builtin !== null) {
      return builtin;
    }
    // DM "..()" — dispatch to the parent type's implementation of the
    // currently executing proc.
    if (node.name === '..') {
      if (!args) {
        return `(await comp.CallParentProc("${this.currentProcName}"))`;
      }
      return `(await comp.CallParentProc("${this.currentProcName}", ${args}))`;
    }
    // User-defined proc - call through runtime. In a global initializer there
    // is no current datum, so route through the GlobalVars bridge.
    if (this.globalsMode) {
      if (!args) {
        return `(await GlobalVars.CallGlobal("${node.name}"))`;
      }
      return `(await GlobalVars.CallGlobal("${node.name}", ${args}))`;
    }
    if (!args) {
      return `(await comp.CallProc("${node.name}"))`;
    }
    return `(await comp.CallProc("${node.name}", ${args}))`;
  }

  private transpileTernary(node: any): string {
    const cond = this.transpileExpression(node.condition);
    const trueExpr = this.transpileExpression(node.trueExpr);
    const falseExpr = this.transpileExpression(node.falseExpr);
    // Parenthesized: callers append members like .IsTrue() and must bind to
    // the whole ternary, not its last branch.
    return `(${cond}.IsTrue() ? ${trueExpr} : ${falseExpr})`;
  }

  private transpileProperty(node: any): string {
    // GLOB.x reads resolve through the generated GlobalVars registry.
    if (node.target?.type === 'variable' && node.target.name === 'GLOB') {
      return `(await GlobalVars.Get("${node.property}"))`;
    }
    const target = this.transpileExpression(node.target);
    return `DMRuntimeHelpers.DMGetProperty(${target}, "${node.property}")`;
  }

  private transpileIndex(node: any): string {
    const target = this.transpileExpression(node.target);
    const index = this.transpileExpression(node.index);
    return `DMListGet(${target}, ${index})`;
  }

  private escapeString(str: string): string {
    return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
  }

  /** Path -> deduped class name, and the class names already taken, for the
   *  current generateProcsCS run. Distinct paths can map to the same class
   *  name (/obj/item/foo vs /obj/ItemFoo both give ObjItemFoo); the second
   *  gets a numeric suffix so the generated static methods do not collide
   *  (CS0102). */
  private pathClassNameMap = new Map<string, string>();
  private usedClassNames = new Set<string>();

  private pathToClassName(dmPath: string): string {
    const existing = this.pathClassNameMap.get(dmPath);
    if (existing) return existing;
    const parts = dmPath.split('/').filter(Boolean);
    let name = parts.map(p => this.capitalize(this.sanitizeIdentifier(p))).join('');
    if (this.usedClassNames.has(name)) {
      let suffix = 2;
      while (this.usedClassNames.has(`${name}_${suffix}`)) suffix++;
      name = `${name}_${suffix}`;
    }
    this.usedClassNames.add(name);
    this.pathClassNameMap.set(dmPath, name);
    return name;
  }

  /** DM identifiers (operator"", foo.bar) are not valid C# identifier
   *  characters; strip everything outside [A-Za-z0-9_]. Applied to class
   *  names and proc member names so hostile-but-legal DM never emits a
   *  syntax error (WS5-1..3). */
  private sanitizeIdentifier(name: string): string {
    const cleaned = name.replace(/[^A-Za-z0-9_]/g, '');
    return cleaned.length > 0 ? cleaned : 'X';
  }

  private capitalize(str: string): string {
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1);
  }
}
