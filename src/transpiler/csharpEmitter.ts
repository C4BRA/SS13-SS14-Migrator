import * as fs from 'fs';
import * as path from 'path';
import { DMIRType } from '../ir/dmIRGenerator.js';
import { DMGlobalVarDeclNode, DMParser, ExpressionNode } from '../parser/dmParser.js';
import { DMLexer } from '../parser/dmLexer.js';
import { DiagnosticCollector } from '../diagnostics.js';
import { transpileBuiltinCall } from './builtinMappings.js';
import { SymbolTable } from '../ir/symbolTable.js';

export class CSharpEmitter {
  private tempCounter = 0;
  private currentProcName = '';
  /** Corpus-wide symbol table (item 64): bare/method calls are resolved
   *  against declared procs and unknowns warn once. Runtime registry stays
   *  the fallback. */
  private symbols: SymbolTable | null = null;
  private warnedCalls = new Set<string>();
  private currentTypePath = '';
  // W-A parent-call (item 22): declared parameter names of the proc body
  // being emitted — a no-arg ..() forwards their CURRENT values to the
  // parent implementation (BYOND arg pass-through).
  private currentProcArgs: string[] = [];
  private loopDepth = 0;
  private switchDepth = 0;
  private lambdaDepth = 0;
  /** Per-loop continue labels (C# label or '' for loops where a plain
   *  `continue;` already reaches the correct point). Top of stack = the
   *  innermost loop; jumped to when a `continue` must cross a switch's
   *  while(true) wrapper or land on a C-for increment. */
  private continueLabels: string[] = [];

  /** Per-method DM label scope (item 59): the same DM label name can repeat
   *  in one proc body — each labeled block gets a unique C# label pair and
   *  gotos resolve to the innermost enclosing block with that DM name
   *  (corpus: baystation CS0140 on repeated `mymob:`). */
  private labelStack: { dm: string; enter: string; exit: string }[] = [];
  private labelNameCounts = new Map<string, number>();

  private findLabelScope(dmLabel: string): { enter: string; exit: string } {
    for (let i = this.labelStack.length - 1; i >= 0; i--) {
      if (this.labelStack[i].dm === dmLabel) return this.labelStack[i];
    }
    // Label not in scope (unusual DM): fall back to the first-use name.
    return { enter: `__dmLabel_${dmLabel}`, exit: `__dmBreak_${dmLabel}` };
  }

  /** Datum vars with move/containment semantics — bare writes route through
   *  DMSetProperty so loc moves fire Enter/Exit hooks and x/y/z sync the
   *  bound entity's transform (item 69, B-1). */
  private static readonly MOVE_VARS = new Set(['loc', 'x', 'y', 'z']);

  /** While true, expressions are emitted in the GlobalVars initializer
   *  context (no `comp`, no current datum): src is Null, bare calls go
   *  through GlobalVars.CallGlobal, and new() uses a null datum. */
  private globalsMode = false;

  private nextTemp(): string {
    return `__dm_t${this.tempCounter++}`;
  }
  public emitCSharpSystems(irMap: Map<string, DMIRType>, outputServerDir: string, globals: DMGlobalVarDeclNode[] = [], symbols?: SymbolTable): void {
    if (!fs.existsSync(outputServerDir)) {
      fs.mkdirSync(outputServerDir, { recursive: true });
    }
    this.symbols = symbols ?? null;
    this.warnedCalls.clear();
    const procsCode = this.generateProcsCS(irMap, globals);
    fs.writeFileSync(path.join(outputServerDir, 'ConvertedDMProcs.cs'), procsCode, 'utf-8');
    fs.writeFileSync(path.join(outputServerDir, 'ConvertedDMSystem.cs'), this.generateSystemCS(), 'utf-8');
    this.emitSharedTypesFile(outputServerDir); // B-3 (item 71)
  }

  /** Corpus-scale variant: streams the proc file instead of building it in
   *  memory (item 66). */
  public emitCSharpSystemsFile(irMap: Map<string, DMIRType>, outputServerDir: string, globals: DMGlobalVarDeclNode[] = [], symbols?: SymbolTable): void {
    if (!fs.existsSync(outputServerDir)) {
      fs.mkdirSync(outputServerDir, { recursive: true });
    }
    this.symbols = symbols ?? null;
    this.warnedCalls.clear();
    this.generateProcsCSFile(irMap, globals, path.join(outputServerDir, 'ConvertedDMProcs.cs'));
    fs.writeFileSync(path.join(outputServerDir, 'ConvertedDMSystem.cs'), this.generateSystemCS(), 'utf-8');
    this.emitSharedTypesFile(outputServerDir); // B-3 (item 71)
  }

  // B-3 (item 71): AppearanceComponent data keys must live in a CONTENT
  // assembly carrying [NetSerializable] — RobustSerializer only indexes
  // those, and a server-specific type throws on attribute scan
  // ("Type ... is server specific but has a NetSerializableAttribute").
  // Emitted beside Content.Server/DM into Content.Shared/DM so both the
  // server adapter and any future client visualizer resolve the same type.
  private emitSharedTypesFile(outputServerDir: string): void {
    const sharedDir = path.resolve(outputServerDir, '..', '..', 'Content.Shared', 'DM');
    if (!fs.existsSync(sharedDir)) fs.mkdirSync(sharedDir, { recursive: true });
    // The template's Content.Shared.csproj references no engine assembly;
    // the generated enum needs Robust.Shared (NetSerializable). Add the
    // official Shared.props import — direct Robust.* references are
    // rejected by Robust.ProjectReferences.targets.
    const sharedCsproj = path.resolve(sharedDir, '..', 'Content.Shared.csproj');
    if (fs.existsSync(sharedCsproj)) {
      const xml = fs.readFileSync(sharedCsproj, 'utf-8');
      const importLine = '<Import Project="..\\RobustToolbox\\Imports\\Shared.props" />';
      if (!xml.includes('Shared.props')) {
        fs.writeFileSync(sharedCsproj, xml.replace('</Project>', `  ${importLine}\n</Project>`), 'utf-8');
      }
    }
    fs.writeFileSync(path.join(sharedDir, 'DMAppearanceKey.cs'), `using Robust.Shared.Serialization;

namespace Content.Shared.DM
{
    /// <summary>
    /// Appearance data keys published through AppearanceComponent.SetData
    /// (PLAN item 71, B-3). Enum order is wire-stable — append only.
    /// </summary>
    [NetSerializable]
    public enum DMAppearanceKey
    {
        Icon,
        IconState,
        Dir,
        Color,
        Alpha,
        PixelX,
        PixelY,
        PixelZ,
        Layer,
        Plane,
        Invisibility,
        Opacity,
        MouseOpacity,
        Overlays,
        Underlays,
        Luminosity,
        LightColor,
        LightPower,
        LightRange
    }
}
`, 'utf-8');
  }

  /**
   * Pure C# (no RobustToolbox references): the static proc registry and one
   * static method per DM proc, operating on the engine-free DMRuntime datum.
   */
  public generateProcsCS(irMap: Map<string, DMIRType>, globals: DMGlobalVarDeclNode[] = []): string {
    const regs: string[] = [];
    const members: string[] = [];
    const head: string[] = [];
    const tail: string[] = [];
    this.emitProcsCS(irMap, globals, {
      head: (c) => head.push(c),
      pair: (reg, member) => {
        if (reg) regs.push(reg);
        if (member) members.push(member);
      },
      close: () => { /* the string variant closes RegisterProcs after the regs */ },
      tail: (c) => tail.push(c),
    });
    // Order: header + RegisterProcs open, registrations, RegisterProcs
    // close, proc members, class close + GlobalVars.
    return head.join('') + regs.join('\n') + '\n        }\n' + members.join('') + tail.join('');
  }

  /** Corpus-scale emission writes proc bodies to the FILE SYSTEM instead of
   *  one giant string, split into multiple SEPARATE classes:
   *  - ConvertedDMProcs.cs keeps RegisterProcs() (calling each part's
   *    registration method) + GlobalVars.
   *  - ConvertedDMProcs_<n>.cs holds a chunk of proc methods AND its own
   *    RegisterProcs_<n>() registration method.
   *  Two .NET limits make this necessary: Roslyn's superlinear per-file
   *  compile cost (a 118 MB single file hung the build), and the CLR's
   *  per-TYPE method cap (~65,536 — tgstation's 64,794 procs in one partial
   *  class failed at load with TypeLoadException 'contains more methods'). */
  public generateProcsCSFile(irMap: Map<string, DMIRType>, globals: DMGlobalVarDeclNode[], filePath: string): void {
    const PART_PREFIX = `using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using SS13.DM.Runtime;
using static SS13.DM.Runtime.DMRuntimeHelpers;

namespace Content.Server.DM
{
`;
    let headOut = '';
    let tailOut = '';
    const pairs: { reg: string | null; member: string | null }[] = [];
    this.emitProcsCS(irMap, globals, {
      head: (c) => { headOut += c; },
      pair: (reg, member) => { pairs.push({ reg, member }); },
      close: () => { /* file 1's RegisterProcs closes after the part calls */ },
      tail: (c) => { tailOut += c; },
    });

    // Chunk the pairs by member size (~4 MB per part keeps Roslyn linear and
    // every class far below the CLR's per-type method cap).
    const parts: { regs: string[]; members: string }[] = [];
    let current: { regs: string[]; members: string } = { regs: [], members: '' };
    const FLUSH_AT = 4 * 1024 * 1024;
    for (const { reg, member } of pairs) {
      if (member && current.members.length + member.length > FLUSH_AT && current.members.length > 0) {
        parts.push(current);
        current = { regs: [], members: '' };
      }
      if (reg) current.regs.push(reg);
      if (member) current.members += member;
    }
    if (current.members.length > 0 || current.regs.length > 0) parts.push(current);

    // File 1: RegisterProcs() delegates to each part's registration method.
    const partCalls = parts.map((_, i) => `            ConvertedDMProcs_${i + 1}.RegisterProcs_${i + 1}();`).join('\n');
    fs.writeFileSync(filePath, headOut + partCalls + '\n        }\n' + tailOut);

    // Part files: a separate class per chunk, with its own registration
    // method referencing the methods in the SAME class.
    parts.forEach((part, i) => {
      const n = i + 1;
      const content = `${PART_PREFIX}    public static class ConvertedDMProcs_${n}
    {
        public static void RegisterProcs_${n}()
        {
${part.regs.join('\n')}
        }
${part.members}    }
}
`;
      fs.writeFileSync(`${filePath.replace(/\.cs$/, '')}_${n}.cs`, content);
    });
  }

  private emitProcsCS(irMap: Map<string, DMIRType>, globals: DMGlobalVarDeclNode[],
                      sinks: { head: (chunk: string) => void; pair: (reg: string | null, member: string | null) => void; close: () => void; tail: (chunk: string) => void }): void {
    this.pathClassNameMap.clear();
    this.usedClassNames.clear();
    sinks.head(`using System;
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
    /// The corpus-scale proc methods live in ConvertedDMProcs_<n> classes
    /// (each with its own RegisterProcs_<n>) — see generateProcsCSFile.
    /// </summary>
    public static partial class ConvertedDMProcs
    {
        public static void RegisterProcs()
        {
`);
    const pathRegs: string[] = [];
    const procRegs: string[] = [];

    // Pass 1: registrations (small) + the member names. Both passes use the
    // same deduped member names. Var-only types get a RegisterPath entry
    // (no proc member); proc registrations pair with their members in
    // pass 2's order.
    for (const [pathKey, irType] of irMap.entries()) {
      // ==== W-G input (docs/plans/28): datum type var defaults ====
      // Every type gets a TypeVarInits registration carrying its declared
      // var defaults (own vars + BYOND-inherited name/desc resolution);
      // DMRuntimeHelpers.ApplyTypeVarInits walks the path ancestors at
      // datum creation and applies them root-first.
      const typeInit = this.typeVarInitRegistration(irMap, pathKey, irType);
      if (typeInit) pathRegs.push(typeInit);

      if (irType.procs.size === 0) {
        // Var-only types still register their path so typesof() enumerates
        // them (WS9-4).
        pathRegs.push(`            ProcRegistry.RegisterPath("${pathKey}");`);
        continue;
      }

      const className = this.pathToClassName(pathKey);
      const usedProcMembers = new Set<string>();

      for (const [procName, procNode] of irType.procs.entries()) {
        const csharpProcName = this.nextProcMemberName(procName, usedProcMembers);
        const paramNames = procNode.args && procNode.args.length > 0
          ? `, new[] { ${procNode.args.map((a: any) => `"${this.escapeString(a.name)}"`).join(', ')} }`
          : '';
        procRegs.push(
          `            ProcRegistry.Register("${this.escapeString(pathKey)}", "${this.escapeString(procName)}", Proc_${className}_${csharpProcName}${paramNames});`
        );
      }
    }

    // Var-only path registrations: reg-only pairs (registration order is
    // irrelevant to the registry).
    for (const reg of pathRegs) {
      sinks.pair(reg, null);
    }

    // Pass 2: the proc bodies, each paired with its registration so the
    // file writer can chunk them into self-contained classes.
    // This was the loop that built the 17.9 GB single-file output at corpus
    // scale (10M inherited members for 23k declared procs — fixed in the IR).
    let regIndex = 0;
    for (const [pathKey, irType] of irMap.entries()) {
      if (irType.procs.size === 0) continue;

      const className = this.pathToClassName(pathKey);
      sinks.pair(null, `\n        // Procs for ${pathKey}\n`);
      const usedProcMembers = new Set<string>();
      this.currentTypePath = pathKey;

      for (const [procName, procNode] of irType.procs.entries()) {
        const csharpProcName = this.nextProcMemberName(procName, usedProcMembers);
        let member = `        public static async Task<DMValue> Proc_${className}_${csharpProcName}(DMRuntime comp, DMValue[] args)\n        {\n`;

        procNode.args.forEach((arg, idx) => {
          // Args are stored on the datum so body references via
          // comp.GetVar(name) resolve them; this also sidesteps C# keyword
          // collisions (e.g. an arg named `event` or `object`). Missing args
          // fall back to the declared default value (item 58: `f(a = 1)`).
          const fallback = arg.defaultValue
            ? this.transpileExpression(arg.defaultValue)
            : 'DMValue.Null';
          member += `            comp.SetVar("${arg.name}", args.Length > ${idx} ? args[${idx}] : ${fallback});\n`;
        });

        this.currentProcName = procName;
        this.currentProcArgs = procNode.args.map((a: any) => a.name as string); // W-A parent-call
        this.labelNameCounts.clear();
        this.labelStack.length = 0;

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
        sinks.pair(procRegs[regIndex++], member);
      }
    }

    // ==== W-F new ====
    // Field var initializers that are `new` expressions: a type-level
    // `var/x = new /path` reaches the IR only as raw text in customVars
    // (field inits carry no expression AST). Re-parsing the text recovers
    // the `new` node so DMNew can seed the field with a real datum before
    // New() runs — matching BYOND, where field initializers evaluate at
    // construction time. Types with no procs at all (the common case for
    // pure data/leaf types) emit one VarInit member + registration.
    // The declared var TYPE is dropped upstream of the IR, so bare
    // `= new`/`= new()` inits stay /datum — see docs/plans/27.
    for (const [pathKey, irType] of irMap.entries()) {
      const initStatements: string[] = [];
      this.currentTypePath = pathKey;
      this.currentProcName = '';
      this.currentProcArgs = [];
      for (const [varName, raw] of irType.customVars.entries()) {
        const expr = this.parseNewInitializer(raw);
        if (!expr) continue;
        initStatements.push(`            comp.SetVar("${this.escapeString(varName)}", ${this.transpileExpression(expr)});\n`);
      }
      if (initStatements.length === 0) continue;
      const className = this.pathToClassName(pathKey);
      const reg = `            ProcRegistry.RegisterVarInit("${this.escapeString(pathKey)}", VarInit_${className});`;
      const member = `        // W-F: field var/x = new initializers for ${pathKey}
        public static async Task<DMValue> VarInit_${className}(DMRuntime comp, DMValue[] args)
        {
${initStatements.join('')}            return DMValue.Null;
        }
`;
      sinks.pair(reg, member);
    }

    // Closes RegisterProcs(); the class close + GlobalVars follow (tail).
    sinks.close();
    sinks.tail(`    }

`);

    // GlobalVars: materializes /global/var/ declarations. Initialized once,
    // lazily, in declaration order; GLOB.x reads/writes and bare calls in
    // initializers resolve here. Undeclared names read as Null (matching DM
    // before the global is assigned).
    sinks.tail(`    public static class GlobalVars
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
`);
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
      sinks.tail(`            Vars["${g.name}"] = ${expr ?? 'DMValue.Null'};\n`);
    }
    this.globalsMode = prevMode;
    sinks.tail(`        }
    }
}
`);
  }

  // ==== W-G input (docs/plans/28): datum type var defaults ==============
  // BYOND semantics: a fresh datum's vars start at the type's declared
  // defaults — inherited from ancestors unless overridden — applied before
  // loc assignment and New() dispatch. This emits one TypeVarInits action
  // per type carrying that type's effective defaults; the runtime applies
  // the whole ancestor chain root->leaf at datum creation (DMNew, engine
  // component init, grid turf datums).
  //
  // Only unambiguous values are seeded: the identity vars (name/desc —
  // always text in DM), icon/icon_state, and custom vars whose IR-
  // normalized initializer is a scalar literal (number, bool literal,
  // /path, or identifier-safe text — gender is forced to text). Expression
  // initializers (list(), new, calls, arithmetic) are skipped: the IR's
  // normalized text can't distinguish a quoted string from an identifier
  // or expression, and a mis-seeded string is worse than an unseeded var.
  private typeVarInitRegistration(irMap: Map<string, DMIRType>, pathKey: string, irType: DMIRType): string | null {
    const sets: string[] = [];
    const basename = (p: string) => {
      const seg = p.split('/').filter(Boolean);
      return seg.length > 0 ? seg[seg.length - 1] : 'object';
    };
    // BYOND name resolution: an atom's effective name is its own declared
    // name, else the nearest ancestor's declared name, else the type
    // basename. IR's name field is declared-or-basename; a declared name
    // equal to the basename is indistinguishable from undeclared
    // (documented approximation — same emitted value either way).
    let effName = irType.name;
    if (effName === basename(pathKey)) {
      let p = irType.parentPath;
      while (p) {
        const par = irMap.get(p);
        if (!par) break;
        if (par.name !== basename(par.path)) { effName = par.name; break; }
        p = par.parentPath;
      }
    }
    if (effName && effName !== 'null' && effName !== '') {
      sets.push(`DMRuntimeHelpers.SeedVar(c, "name", DMValue.FromString("${this.escapeString(effName)}"));`);
    }
    if (irType.desc && irType.desc !== 'null') {
      sets.push(`DMRuntimeHelpers.SeedVar(c, "desc", DMValue.FromString("${this.escapeString(irType.desc)}"));`);
    }
    if (irType.icon && irType.icon !== 'null') {
      sets.push(`DMRuntimeHelpers.SeedVar(c, "icon", DMValue.FromString("${this.escapeString(irType.icon)}"));`);
    }
    if (irType.iconState && irType.iconState !== 'null') {
      sets.push(`DMRuntimeHelpers.SeedVar(c, "icon_state", DMValue.FromString("${this.escapeString(irType.iconState)}"));`);
    }
    // Structural bool vars are inherited in IR like custom vars; emit the
    // effective value so a datum's density/anchored/opacity reads back.
    if (irType.density) sets.push('DMRuntimeHelpers.SeedVar(c, "density", DMValue.FromNumber(1));');
    if (irType.anchored) sets.push('DMRuntimeHelpers.SeedVar(c, "anchored", DMValue.FromNumber(1));');
    if (irType.opacity) sets.push('DMRuntimeHelpers.SeedVar(c, "opacity", DMValue.FromNumber(1));');
    for (const [k, v] of irType.customVars) {
      const init = this.scalarVarInit(k, v);
      if (init) sets.push(`DMRuntimeHelpers.SeedVar(c, "${this.escapeString(k)}", ${init});`);
    }
    if (sets.length === 0) return null;
    return `            DMRuntimeHelpers.TypeVarInits["${this.escapeString(pathKey)}"] = c => { ${sets.join(' ')} };`;
  }

  /// W-G input: custom-var initializers we can seed without an expression
  /// evaluator — numeric, DM truth literals, and /type paths map 1:1 to
  /// DMValue factories; identifier-safe bare text seeds as a string (the
  /// overwhelmingly common case: quoted literals, which normalize to bare
  /// text). Returns the C# initializer expression, or null when the
  /// normalized text is an expression initializer (unseeded, documented).
  private scalarVarInit(name: string, v: any): string | null {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    if (s === '' || s.toLowerCase() === 'null') return null;
    if (name === 'gender') return `DMValue.FromString("${this.escapeString(s)}")`;
    if (/^[+-]?\d+$/.test(s)) return `DMValue.FromNumber(${s})`;
    if (/^[+-]?\d*\.\d+$/.test(s)) return `DMValue.FromNumber(${s}, true)`;
    if (/^(true|yes|on)$/i.test(s)) return 'DMValue.FromNumber(1)';
    if (/^(false|no|off)$/i.test(s)) return 'DMValue.FromNumber(0)';
    if (s.startsWith('/')) return `DMValue.FromPath("${this.escapeString(s)}")`;
    if (/^[A-Za-z_][A-Za-z0-9_ ]*$/.test(s)) return `DMValue.FromString("${this.escapeString(s)}")`;
    return null;
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
    return `using System;
using System.Collections.Generic;
using System.Linq;
using System.Numerics;
using System.Text.Json;
using System.Threading.Tasks;
using Content.Shared.DM;
using Robust.Server.GameObjects;
using Robust.Server.Console;
using Robust.Server.Player;
using Robust.Shared.Console;
using Robust.Shared.ContentPack;
using Robust.Shared.Enums;
using Robust.Shared.EntitySerialization.Systems;
using Robust.Shared.GameObjects;
using Robust.Shared.IoC;
using Robust.Shared.Log;
using Robust.Shared.Map;
using Robust.Shared.Map.Components;
using Robust.Shared.Maths;
using Robust.Shared.Network;
using Robust.Shared.Player;
using Robust.Shared.Prototypes;
using Robust.Shared.Serialization.Manager.Attributes;
using Robust.Shared.Toolshed;
using Robust.Shared.Toolshed.Errors;
using Robust.Shared.Utility;
using SS13.DM.Runtime;

namespace Content.Server.DM
{
    /// <summary>
    /// Engine-facing wrapper (item 69, B-1): wires the transpiled DM proc
    /// registry into an SS14 EntitySystem, drives New() dispatch on component
    /// init, materializes DM atoms as real entities via the spawn bridge,
    /// mirrors x/y/z + loc writes onto transforms, mints turf datums for
    /// loaded map tiles, and attaches joining players to a mob.
    /// </summary>
    public sealed class ConvertedDMSystem : EntitySystem
    {
        [Dependency] private readonly IPrototypeManager _protoMan = default!;
        [Dependency] private readonly ITileDefinitionManager _tileMan = default!;
        [Dependency] private readonly IPlayerManager _playerMan = default!;
        [Dependency] private readonly IResourceManager _resMan = default!;
        // B-3 (item 71): the pin's server ignores Sprite components; the
        // Appearance channel is how a datum's visuals reach the client.
        [Dependency] private readonly AppearanceSystem _appearance = default!;
        [Dependency] private readonly IServerConsoleHost _conHost = default!;

        private SharedTransformSystem _xform = default!;
        private SharedMapSystem _map = default!;
        private MapLoaderSystem _mapLoader = default!;

        private EntityUid _defaultMap;
        private bool _worldInitialized;

        /// <summary>grid uid Id -> DM z-level (from the grid's MetaData name
        /// "grid_z<N>" emitted by the map converter).</summary>
        private readonly Dictionary<int, int> _gridZ = new();
        /// <summary>DM z-level -> grid uid.</summary>
        private readonly Dictionary<int, EntityUid> _zGrid = new();

        public override void Initialize()
        {
            base.Initialize();
            ConvertedDMProcs.RegisterProcs();
            _xform = EntityManager.System<SharedTransformSystem>();
            _map = EntityManager.System<SharedMapSystem>();
            _mapLoader = EntityManager.System<MapLoaderSystem>();
            SubscribeLocalEvent<DMRuntimeComponent, ComponentInit>(OnDMComponentInit);
            // NB: ComponentInit on MapGridComponent is already owned by
            // SharedMapSystem — ComponentEvent lifecycle events allow ONE
            // subscriber per (comp, event) — so turf datums are minted in
            // StartWorld after the map load instead of via subscription.

            // Runtime -> engine bridge: a DM new() on an atom type spawns a
            // real entity carrying a DMRuntimeComponent (the datum itself was
            // already created by the runtime and bound to this entity).
            DMRuntimeHelpers.EntitySpawnBridge = (typePath, loc, datum) =>
            {
                try
                {
                    var protoId = ProtoIdFor(typePath);
                    var coords = LocCoords(loc);
                    var uid = EntityManager.SpawnEntity(protoId, coords);
                    datum.EntityId = (ulong)uid.Id;
                    SyncVarsFromTransform(uid, datum);
                    Logger.InfoS("dm", "Spawned {Proto} as entity {Uid}", protoId, uid);
                }
                catch (Exception ex)
                {
                    Logger.ErrorS("dm", "Entity spawn failed for {Type}: {Ex}", typePath, ex.Message);
                }
            };

            // x/y/z var writes -> transform move (item 69, B-1).
            DMRuntimeHelpers.EntityMoveBridge = (datum, x, y, z) =>
            {
                if (datum.EntityId == 0) return;
                try
                {
                    var uid = new EntityUid((int)datum.EntityId);
                    if (!EntityManager.EntityExists(uid)) return;
                    var zi = (int)Math.Round(z);
                    var parent = _zGrid.TryGetValue(zi, out var g) ? g
                        : EntityManager.GetComponent<TransformComponent>(uid).ParentUid;
                    _xform.SetCoordinates(uid, new EntityCoordinates(parent, new Vector2((float)(x - 0.5), (float)(y - 0.5))));
                }
                catch (Exception ex)
                {
                    Logger.ErrorS("dm", "Entity move failed: {Ex}", ex.Message);
                }
            };

            // Transform -> x/y/z var reads (item 69, B-1).
            DMRuntimeHelpers.EntityCoordBridge = (datum, axis) =>
            {
                if (datum.EntityId == 0) return null;
                var uid = new EntityUid((int)datum.EntityId);
                if (!EntityManager.TryGetComponent(uid, out TransformComponent? xf)) return null;
                if (axis == "z")
                    return _gridZ.TryGetValue(xf.ParentUid.Id, out var z) ? (double)z : 1;
                var pos = xf.LocalPosition;
                var v = axis == "x" ? Math.Floor(pos.X) + 1 : Math.Floor(pos.Y) + 1;
                return v;
            };

            // loc writes -> reparent (item 69, B-1).
            DMRuntimeHelpers.EntityAttachBridge = (datum, newLoc) =>
            {
                if (datum.EntityId == 0) return;
                try
                {
                    var uid = new EntityUid((int)datum.EntityId);
                    if (!EntityManager.EntityExists(uid)) return;
                    if (newLoc.Type == DMValueType.DatumRef && newLoc.DatumRef is DMRuntime container && container.EntityId != 0)
                    {
                        var parentUid = new EntityUid((int)container.EntityId);
                        _xform.SetParent(uid, parentUid);
                        _xform.SetLocalPosition(uid, Vector2.Zero);
                    }
                    else
                    {
                        // Turf loc or null: stay on the grid/map at the
                        // current position (loc var records the truth).
                        _xform.AttachToGridOrMap(uid);
                    }
                }
                catch (Exception ex)
                {
                    Logger.ErrorS("dm", "Entity attach failed: {Ex}", ex.Message);
                }
            };

            // Player attach: a session going InGame gets a converted mob.
            _playerMan.PlayerStatusChanged += OnPlayerStatusChanged;

            // B-2 (item 70): this system drives the DM world clock from the
            // engine tick — suppress the runtime's wall-clock fallback driver.
            DMTickScheduler.ExternalDriver = true;

            // B-3 (item 71): datum appearance-var writes republish the
            // entity's AppearanceComponent data; flick() durations resolve
            // from the converted RSI meta.json delay tables.
            DMRuntimeHelpers.EntityAppearanceBridge = PushAppearanceData;
            DMRuntimeHelpers.RsiStateDurationDs = LookupRsiStateDuration;

            // ==== B-4 verbs/input (item 72) ====
            // 'x << msg' on datum targets routes through the output bridge:
            // world broadcasts to every in-game client console, mob/client
            // datums reach the owning session's console, everything also
            // lands in the server log. Engine-free runs fall back to stdout.
            DMVerbRuntime.OutputBridge = DmOutput;
            // The engine's permission controller denies client-run commands
            // without a content implementation (ConGroupController.Implementation
            // is null -> CanCommand = false). Converted worlds have no admin
            // group setup; the shim allows only our dm* command names for
            // player sessions (the server console bypasses the check anyway).
            IoCManager.Resolve<IConGroupController>().Implementation = new DMPermissions();
        }

        /// <summary>
        /// World bootstrap, called once by the content EntryPoint after the
        /// entity manager is up (PostInit): registers converted tile defs,
        /// loads the first converted map (or creates a default map), then runs
        /// DM world/New() (item 69, B-1).
        /// </summary>
        public void StartWorld()
        {
            if (_worldInitialized) return;
            _worldInitialized = true;

            RegisterTileDefs();

            var loaded = false;
            try
            {
                foreach (var file in _resMan.ContentFindFiles("/Maps").OrderBy(f => f.ToString()))
                {
                    if (!file.Filename.EndsWith(".yml") && !file.Filename.EndsWith(".yaml")) continue;
                    if (_mapLoader.TryLoadMap(file, out var map, out var grids))
                    {
                        _defaultMap = map!.Value.Owner;
                        loaded = true;
                        Logger.InfoS("dm", "World init: loaded map {File} ({Map}, {Count} grids)", file, _defaultMap, grids?.Count ?? 0);
                        if (grids != null)
                        {
                            foreach (var gridEnt in grids)
                                RegisterGrid(gridEnt.Owner);
                        }
                        break;
                    }
                    Logger.ErrorS("dm", "World init: map {File} failed to load", file);
                }
            }
            catch (Exception ex)
            {
                Logger.ErrorS("dm", "World init: map load threw {Ex}", ex.Message);
            }
            if (!loaded)
            {
                _defaultMap = _map.CreateMap(out _);
                Logger.InfoS("dm", "World init: no converted map — created default map {Map}", _defaultMap);
            }

            SeedAmbientLight(); // W-B light (item 75)

            if (DMRuntimeHelpers.WorldValue.DatumRef is DMRuntime worldDatum)
            {
                // W-F new: world/New runs BYOND's full ancestor chain.
                _ = worldDatum.CallNewChain(System.Array.Empty<DMValue>());
            }
            Logger.InfoS("dm", "World init: DM world/New() complete");
            RegisterSubsystems();
        }

        // ==== B-2: world tick pump + subsystem cadence (item 70) ====

        /// <summary>
        /// Per-tick pump for the DM world clock. RobustToolbox's
        /// EntitySystemManager only calls Update on systems that declare an
        /// override themselves (NeedsUpdate checks that Update's DeclaringType
        /// is not the EntitySystem base) — that is why the generated system's
        /// Update never ran before: it had no override. frameTime is the
        /// simulated tick duration in seconds (the server game loop supplies
        /// IGameTiming.TickPeriod per tick and does not run this while paused),
        /// so the DM clock advances only while the simulation runs — matching
        /// DM's "world.time is game time, not real time".
        /// </summary>
        // B-3 (item 71): a session must be visible at SessionStatus.Connected
        // for at least one game-state send — calling JoinGame synchronously
        // inside the status event collapses Connecting->InGame in one hop and
        // the client never enters a viewport (verified against the scaffolded
        // RT client). Queue joins and drain them here, one tick later.
        private readonly Queue<ICommonSession> _pendingJoins = new();

        public override void Update(float frameTime)
        {
            DMTickScheduler.Pump(frameTime * 10.0); // seconds -> deciseconds
            while (_pendingJoins.Count > 0)
            {
                var session = _pendingJoins.Dequeue();
                if (session.Status == SessionStatus.Connected)
                    _playerMan.JoinGame(session);
            }
        }

        /// <summary>
        /// DM controllers conventionally run on a per-tick process loop
        /// (master controller, /datum/controller/subsystem, process
        /// schedulers). Every registered type under /datum/controller with a
        /// fire() or process() proc is instantiated once and invoked on the DM
        /// tick loop; the datum's own wait var (deciseconds, default
        /// tick_lag) is honored between invocations. Minimal cadence hook —
        /// the runtime registry is DMTickScheduler.RegisterTickCallback; this
        /// is not a port of SS13's MC.
        /// </summary>
        private void RegisterSubsystems()
        {
            var worldDatum = DMRuntimeHelpers.WorldValue.DatumRef as DMRuntime;
            if (worldDatum == null) return;
            // ==== W-E subsystem thread-safety ====
            // The whole registration runs on the CALLING thread. StartWorld
            // is invoked by the content EntryPoint on the server's main
            // (IoC) thread — where the engine's RobustSynchronizationContext
            // is installed — so every await inside RegisterSubsystemsAsync
            // (DMNew, the subsystem's own New(), any sleep/spawn inside it)
            // resumes on the main thread too, and the cadence callback's
            // fire/process CallProc later fires inside Pump from Update on
            // that same thread. The old Task.Run pushed DMNew + New() onto
            // a thread-pool thread: EntityManager's ThreadCheck and
            // IoCManager.Resolve's context assert threw ("IoC has no context
            // on this thread"), faulting the task — unobserved-exception
            // spam — BEFORE the tick callback was ever registered, so
            // subsystems went silently dead while shared datum state was
            // mutated off the IoC thread.
            _ = RegisterSubsystemsAsync(worldDatum);
        }

        /// <summary>
        /// Sequential subsystem construction (W-E): each /datum/controller
        /// type is DMNew'd one at a time on the IoC thread — matching
        /// BYOND's in-order boot — and a failing New() is logged and
        /// skipped instead of silently faulting a fire-and-forget task.
        /// </summary>
        private async Task RegisterSubsystemsAsync(DMRuntime worldDatum)
        {
            foreach (var typePath in new List<string>(ProcRegistry.RegisteredPaths))
            {
                if (!typePath.StartsWith("/datum/controller", StringComparison.OrdinalIgnoreCase)) continue;
                string procName;
                // TryGet first: a fire/process declared on the leaf type wins;
                // TryGetInherited only walks ancestors (the SS13
                // /datum/controller/subsystem shape) and missed leaf decls.
                if (ProcRegistry.TryGet(typePath, "fire", out _) || ProcRegistry.TryGetInherited(typePath, "fire", out _)) procName = "fire";
                else if (ProcRegistry.TryGet(typePath, "process", out _) || ProcRegistry.TryGetInherited(typePath, "process", out _)) procName = "process";
                else continue;
                try
                {
                    var datum = await DMRuntimeHelpers.DMNew(worldDatum, typePath);
                    if (datum.DatumRef is not DMRuntime subsystem) continue;
                    double nextFireDs = 0;
                    DMTickScheduler.RegisterTickCallback(async () =>
                    {
                        if (DMTickScheduler.NowDs < nextFireDs) return;
                        var wait = subsystem.GetVar("wait");
                        var waitDs = wait.Type == DMValueType.Number && wait.NumberValue > 0
                            ? wait.NumberValue : DMTickScheduler.TickLag;
                        nextFireDs = DMTickScheduler.NowDs + waitDs;
                        // Per-tick elapsed time in deciseconds (tick_lag) is
                        // passed as the conventional fire/process argument.
                        await subsystem.CallProc(procName, DMValue.FromNumber(DMTickScheduler.TickLag));
                    });
                    Logger.InfoS("dm", "DM subsystem {Type} on the tick loop ({Proc})", typePath, procName);
                }
                catch (Exception ex)
                {
                    Logger.ErrorS("dm", "DM subsystem {Type} init failed: {Ex}", typePath, ex.Message);
                }
            }
        }

        /// <summary>
        /// The converted /turf prototypes (type: dmTile) become real engine
        /// tile definitions so converted map YAML can reference them by name.
        /// </summary>
        private void RegisterTileDefs()
        {
            // W-C client tiles: registration now lives in the shared entry
            // point Content.Shared/DM/DMTileDefs.cs so the client registers
            // the identical defs (TileId is a raw int on the wire) and builds
            // its Clyde atlas at PostInit. Idempotent — kept here so map load
            // can never run ahead of registration regardless of entry order.
            DMTileDefs.EnsureRegistered();
        }

        /// <summary>
        /// Every loaded grid mints a DMRuntime datum per non-empty tile so
        /// turf.contents/loc/type work datum-side (item 69). Called from
        /// StartWorld for each loaded grid (the ComponentInit slot for
        /// MapGridComponent belongs to SharedMapSystem).
        /// </summary>
        private void RegisterGrid(EntityUid uid)
        {
            if (!EntityManager.TryGetComponent(uid, out MapGridComponent? grid)) return;
            var z = 1;
            if (EntityManager.TryGetComponent(uid, out MetaDataComponent? meta))
            {
                var name = meta.EntityName ?? "";
                if (name.StartsWith("grid_z") && int.TryParse(name.Substring(6), out var parsed))
                    z = parsed;
            }
            _gridZ[uid.Id] = z;
            _zGrid[z] = uid;

            foreach (var tileRef in _map.GetAllTiles(uid, grid, ignoreEmpty: true))
            {
                var dmPath = "/turf";
                if (_tileMan.TryGetDefinition((int)tileRef.Tile.TypeId, out var def)
                    && def is DMTilePrototype dmProto)
                    dmPath = dmProto.DMPath;
                var datum = new DMRuntime { DMTypePath = dmPath };
                // W-G input: turf datums get the same type-default seeding
                // (name/desc of the turf type) before positional vars.
                DMRuntimeHelpers.ApplyTypeVarInits(datum);
                datum.SetVar("x", DMValue.FromNumber(tileRef.GridIndices.X + 1));
                datum.SetVar("y", DMValue.FromNumber(tileRef.GridIndices.Y + 1));
                datum.SetVar("z", DMValue.FromNumber(z));
                DMRuntimeHelpers.LiveDatums.Add(datum);
                // W-F new: field new initializers + the full New() chain.
                if (ProcRegistry.TryGetVarInit(datum.DMTypePath, out var turfInit))
                    _ = turfInit(datum, System.Array.Empty<DMValue>());
                _ = datum.CallNewChain(System.Array.Empty<DMValue>());
            }
            Logger.InfoS("dm", "Grid {Uid} (z={Z}): minted turf datums", uid, z);
        }

        private void OnPlayerStatusChanged(object? sender, SessionStatusEventArgs args)
        {
            try
            {
                // No lobby in a converted world: connect joins straight into
                // the round, then InGame attaches the mob (item 69, B-1).
                if (args.NewStatus == SessionStatus.Connected)
                {
                    _pendingJoins.Enqueue(args.Session); // B-3: join next tick
                    return;
                }
                if (args.NewStatus != SessionStatus.InGame) return;
                SpawnPlayerMob(args.Session);
            }
            catch (Exception ex)
            {
                Logger.ErrorS("dm", "Player attach failed: {Ex}", ex.Message);
            }
        }

        /// <summary>
        /// Spawns the converted player mob on the default map and attaches the
        /// session to it (SetAttachedEntity adds ActorComponent server-side).
        /// </summary>
        private void SpawnPlayerMob(ICommonSession session)
        {
            if (session.AttachedEntity is { } existing && EntityManager.EntityExists(existing))
                return;
            var proto = PickPlayerProto();
            var coords = _zGrid.Count > 0
                ? new EntityCoordinates(_zGrid.Values.First(), Vector2.Zero)
                : new EntityCoordinates(_defaultMap, Vector2.Zero);
            var uid = EntityManager.SpawnEntity(proto, coords);
            _playerMan.SetAttachedEntity(session, uid);
            Logger.InfoS("dm", "Player {Name} attached to mob {Uid} (proto {Proto})", session.Name, uid, proto);

            // B-4 (item 72): bind a DM /client datum to the session so
            // mob.client / client.mob / 'client << x' resolve for corpus code.
            BindClientDatum(session, uid);
        }

        /// <summary>
        /// Player-mob prototype preference: a converted human mob when the DM
        /// codebase has one, else the emitted dm_player_mob fallback.
        /// </summary>
        private string PickPlayerProto()
        {
            if (_protoMan.HasIndex<EntityPrototype>("mob_living_carbon_human"))
                return "mob_living_carbon_human";
            if (_protoMan.HasIndex<EntityPrototype>("dm_player_mob"))
                return "dm_player_mob";
            if (_protoMan.HasIndex<EntityPrototype>("mob"))
                return "mob";
            return "dm_player_mob";
        }

        /// <summary>
        /// DM type path -> generated prototype id (pathToId scheme:
        /// /obj/item/x -> obj_item_x).
        /// </summary>
        public static string ProtoIdFor(string typePath)
        {
            return typePath.Trim('/').Replace("/", "_").ToLowerInvariant();
        }

        private EntityCoordinates LocCoords(DMValue loc)
        {
            if (loc.Type == DMValueType.DatumRef && loc.DatumRef is DMRuntime datum)
            {
                if (datum.EntityId != 0)
                {
                    var locUid = new EntityUid((int)datum.EntityId);
                    return EntityManager.GetComponent<TransformComponent>(locUid).Coordinates;
                }
                // A datum-side loc (e.g. a turf datum): resolve its coords on
                // the z-level's grid (item 69).
                var lx = datum.GetVar("x").ToNumber();
                var ly = datum.GetVar("y").ToNumber();
                var lz = (int)Math.Round(datum.GetVar("z").ToNumber());
                if (lx >= 1 && ly >= 1 && _zGrid.TryGetValue(lz == 0 ? 1 : lz, out var grid))
                    return new EntityCoordinates(grid, new Vector2((float)(lx - 0.5), (float)(ly - 0.5)));
            }
            return new EntityCoordinates(_defaultMap, Vector2.Zero);
        }

        private void OnDMComponentInit(EntityUid uid, DMRuntimeComponent comp, ref ComponentInit args)
        {
            comp.Runtime.DMTypePath = comp.DMTypePath;
            comp.Runtime.EntityId = (ulong)uid.Id;
            // W-G input: seed the type's declared var defaults (name/desc/
            // gender/scalars) BEFORE the prototype's initialVars so the
            // proto's explicit values still win, and before New().
            DMRuntimeHelpers.ApplyTypeVarInits(comp.Runtime);
            foreach (var (k, v) in comp.InitialVars)
            {
                comp.Runtime.SetVar(k, DMValue.FromString(v));
            }
            SyncVarsFromTransform(uid, comp.Runtime);
            DMRuntimeHelpers.LiveDatums.Add(comp.Runtime);
            ExecuteNew(uid, comp);
            // B-3 (item 71): publish the proto's declared appearance
            // (icon/state/dir/color/offsets/overlays) as appearance data.
            PushAppearanceData(comp.Runtime);
        }

        /// <summary>
        /// Mirror the entity's transform into the datum's x/y/z vars (DM tile
        /// coords: floor(localPos) + 1; z from the parent grid's z-level).
        /// </summary>
        private void SyncVarsFromTransform(EntityUid uid, DMRuntime datum)
        {
            if (!EntityManager.TryGetComponent(uid, out TransformComponent? xf)) return;
            var pos = xf.LocalPosition;
            datum.SetVar("x", DMValue.FromNumber(Math.Floor(pos.X) + 1));
            datum.SetVar("y", DMValue.FromNumber(Math.Floor(pos.Y) + 1));
            datum.SetVar("z", DMValue.FromNumber(_gridZ.TryGetValue(xf.ParentUid.Id, out var z) ? z : 1));
        }

        public void ExecuteNew(EntityUid uid, DMRuntimeComponent comp)
        {
            // W-F new: field var/x = new initializers seed real datums
            // (the InitialVars loop above stores them as strings), then
            // BYOND's full New() ancestor chain runs.
            if (ProcRegistry.TryGetVarInit(comp.DMTypePath, out var varInit))
                _ = varInit(comp.Runtime, System.Array.Empty<DMValue>());
            _ = comp.Runtime.CallNewChain(System.Array.Empty<DMValue>());
        }

        // ==== B-3 (item 71): appearance bridge + sprite helpers ====

        /// <summary>
        /// Publish a datum's whole appearance as AppearanceComponent data
        /// (server-visible; the pin ignores Sprite on the server). Every
        /// appearance-var write lands here via DMRuntime.SetVar ->
        /// DMRuntimeHelpers.OnDatumVarChanged -> EntityAppearanceBridge.
        /// Overlay/underlay entries serialize as
        /// "rsi|state|dir|layer|pixel_x|pixel_y|color|alpha" strings for a
        /// future client visualizer (B-5) to compose.
        /// </summary>
        private void PushAppearanceData(DMRuntime datum)
        {
            if (datum.EntityId == 0) return;
            var uid = new EntityUid((int)datum.EntityId);
            if (!EntityManager.EntityExists(uid)) return;
            var comp = EntityManager.EnsureComponent<AppearanceComponent>(uid);
            void Set(DMAppearanceKey key, object value) => _appearance.SetData(uid, key, value, comp);
            Set(DMAppearanceKey.Icon, DMRuntimeHelpers.IconPathToRsi(datum.GetVar("icon")) ?? "");
            Set(DMAppearanceKey.IconState, StrVar(datum, "icon_state"));
            Set(DMAppearanceKey.Dir, (int)NumVar(datum, "dir", 2));
            Set(DMAppearanceKey.Color, StrVar(datum, "color"));
            Set(DMAppearanceKey.Alpha, (int)NumVar(datum, "alpha", 255));
            Set(DMAppearanceKey.PixelX, (int)NumVar(datum, "pixel_x", 0));
            Set(DMAppearanceKey.PixelY, (int)NumVar(datum, "pixel_y", 0));
            Set(DMAppearanceKey.PixelZ, (int)NumVar(datum, "pixel_z", 0));
            Set(DMAppearanceKey.Layer, (float)NumVar(datum, "layer", 3));
            Set(DMAppearanceKey.Plane, (int)NumVar(datum, "plane", 0));
            Set(DMAppearanceKey.Invisibility, (int)NumVar(datum, "invisibility", 0));
            Set(DMAppearanceKey.Opacity, (int)NumVar(datum, "opacity", 0));
            Set(DMAppearanceKey.MouseOpacity, (int)NumVar(datum, "mouse_opacity", 1));
            Set(DMAppearanceKey.Overlays, DMRuntimeHelpers.SerializeOverlayList(datum, "overlays"));
            Set(DMAppearanceKey.Underlays, DMRuntimeHelpers.SerializeOverlayList(datum, "underlays"));
            Set(DMAppearanceKey.Luminosity, (int)NumVar(datum, "luminosity", 0));
            Set(DMAppearanceKey.LightRange, (int)NumVar(datum, "light_range", 0));
            Set(DMAppearanceKey.LightPower, (float)NumVar(datum, "light_power", 1));
            Set(DMAppearanceKey.LightColor, StrVar(datum, "light_color"));
        }

        private static string StrVar(DMRuntime d, string name)
        {
            var v = d.GetVar(name);
            return v.Type == DMValueType.Null ? "" : v.ToString();
        }

        private static double NumVar(DMRuntime d, string name, double fallback)
        {
            var v = d.GetVar(name);
            return v.Type == DMValueType.Number ? v.NumberValue : fallback;
        }

        /// <summary>
        /// flick() duration lookup: sum the dir-0 delays of the named state
        /// in the datum's converted RSI (meta.json is a build-time artifact
        /// under /Textures — read once per RSI, cached).
        /// </summary>
        private readonly Dictionary<string, Dictionary<string, double>> _rsiDelayCache = new();

        private double LookupRsiStateDuration(DMRuntime datum, string state)
        {
            var rsi = DMRuntimeHelpers.IconPathToRsi(datum.GetVar("icon"));
            if (rsi == null) return 0;
            if (!_rsiDelayCache.TryGetValue(rsi, out var table))
            {
                table = LoadRsiDelays(rsi);
                _rsiDelayCache[rsi] = table;
            }
            return table.TryGetValue(state, out var d) ? d : 0;
        }

        private Dictionary<string, double> LoadRsiDelays(string rsi)
        {
            var table = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase);
            try
            {
                var metaPath = new ResPath($"/Textures/{rsi}/meta.json");
                if (!_resMan.ContentFileExists(metaPath)) return table;
                using var stream = _resMan.ContentFileRead(metaPath);
                using var doc = JsonDocument.Parse(stream);
                if (!doc.RootElement.TryGetProperty("states", out var states)) return table;
                foreach (var st in states.EnumerateArray())
                {
                    var name = st.TryGetProperty("name", out var n) ? n.GetString() ?? "" : "";
                    double sum = 0;
                    if (st.TryGetProperty("delays", out var delays) && delays.GetArrayLength() > 0)
                    {
                        foreach (var v in delays[0].EnumerateArray())
                            sum += v.GetDouble();
                    }
                    table[name] = sum;
                }
            }
            catch (Exception ex)
            {
                Logger.WarningS("dm", "RSI delay table for {Rsi} failed: {Ex}", rsi, ex.Message);
            }
            return table;
        }

        // W-C client tiles: ValidateTileSprite moved to
        // Content.Shared/DM/DMTileDefs.cs — validation must run identically
        // on client and server so the effective def set stays the same.

        // ==== W-B light (item 75): ambient-light baseline ================
        /// <summary>
        /// Converted worlds have no ported lighting controller, so the
        /// pin's default ambient (MapLightComponent.AmbientLightColor =
        /// black) leaves every unlit region invisible — BYOND turf icons
        /// are drawn to be read fullbright. Seed a dim neutral ambient on
        /// the world map so unlit tiles still read; PointLight components
        /// (luminosity>0 protos) brighten on top of it via additive light.
        /// AmbientLightColor is a LINEAR-light DataField and the component
        /// is networked — SharedMapSystem.SetAmbientLight converts nothing
        /// itself, so pass Color.FromSrgb and let it dirty+replicate.
        /// sRGB 0xB0 keeps floors/walls clearly readable while leaving
        /// headroom for point lights to matter; tune here if a codebase
        /// wants a darker baseline.
        /// </summary>
        private static readonly Color DmAmbientSrgb = new Color(0xB0, 0xB0, 0xB0);

        private void SeedAmbientLight()
        {
            try
            {
                var mapId = EntityManager.GetComponent<MapComponent>(_defaultMap).MapId;
                var color = Color.FromSrgb(DmAmbientSrgb);
                _map.SetAmbientLight(mapId, color);
                Logger.InfoS("dm", "World init: ambient light {Color} (srgb {Srgb}) on map {Map}", color, DmAmbientSrgb, mapId);
            }
            catch (Exception ex)
            {
                Logger.ErrorS("dm", "Ambient light seed failed: {Ex}", ex.Message);
            }
        }

        // ==== B-4 verbs/input (item 72): output routing + client datum ====

        /// <summary>
        /// 'x << msg' on datum targets (DMValue.Output -> OutputBridge).
        /// world << broadcasts to every in-game client console plus the
        /// server log; a mob or /client datum reaches its owning session's
        /// console; unbound datums fall back to the server log.
        /// </summary>
        private void DmOutput(DMValue target, DMValue message)
        {
            var text = message.ToString();
            if (target.DatumRef is DMRuntime datum)
            {
                if (ReferenceEquals(datum, DMRuntimeHelpers.WorldValue.DatumRef))
                {
                    foreach (var session in _playerMan.Sessions)
                    {
                        if (session.Status == SessionStatus.InGame)
                            _conHost.WriteLine(session, text);
                    }
                }
                else
                {
                    var session = SessionForDatum(datum);
                    if (session != null)
                    {
                        _conHost.WriteLine(session, text);
                        return;
                    }
                }
            }
            Logger.InfoS("dm.out", "{Text}", text);
        }

        /// <summary>
        /// The session a datum's output should reach: a /client datum carries
        /// a __session var (NetUserId string) bound at attach; a mob resolves
        /// through its client var or its attached entity.
        /// </summary>
        private ICommonSession? SessionForDatum(DMRuntime datum)
        {
            var sid = datum.GetVar("__session");
            if (sid.Type == DMValueType.String && Guid.TryParse(sid.ToString(), out var guid)
                && _playerMan.TryGetSessionById(new NetUserId(guid), out var byId))
            {
                return byId;
            }
            if (datum.GetVar("client").DatumRef is DMRuntime client && !ReferenceEquals(client, datum))
                return SessionForDatum(client);
            if (datum.EntityId != 0
                && _playerMan.TryGetSessionByEntity(new EntityUid((int)datum.EntityId), out var byEntity))
            {
                return byEntity;
            }
            return null;
        }

        /// <summary>
        /// Mints a /client datum for the session's mob so DM 'mob.client'
        /// reads a real object: client.mob backref, key/ckey/login vars, and
        /// a __session tag the output bridge resolves (engine-free datums
        /// can't hold an ICommonSession).
        /// </summary>
        private void BindClientDatum(ICommonSession session, EntityUid uid)
        {
            try
            {
                if (!EntityManager.TryGetComponent(uid, out DMRuntimeComponent? comp)) return;
                var client = new DMRuntime { DMTypePath = "/client" };
                client.SetVar("mob", DMValue.FromDatum(comp.Runtime));
                client.SetVar("key", DMValue.FromString(session.Name));
                client.SetVar("ckey", DMRuntimeHelpers.CKey(DMValue.FromString(session.Name)));
                client.SetVar("address", DMValue.FromString(session.Channel?.RemoteEndPoint?.ToString() ?? ""));
                client.SetVar("__session", DMValue.FromString(session.UserId.ToString()));
                DMRuntimeHelpers.LiveDatums.Add(client);
                comp.Runtime.SetVar("client", DMValue.FromDatum(client));
            }
            catch (Exception ex)
            {
                Logger.ErrorS("dm", "Client datum bind failed: {Ex}", ex.Message);
            }
        }
    }

    // W-C client tiles: DMTilePrototype moved to Content.Shared/DM/
    // DMTileDefs.cs (emitted by ss14Template) — one type materializes on
    // both sides so client and server assign identical TileIds.

    // ==== B-4 (item 72): verb/interaction command bridge =================
    // These IConsoleCommand implementations are auto-registered by the
    // engine ConsoleHost reflection scan over the content assembly. They are
    // the M1 interaction path: a client types e.g. 'dmverb say hello' (or
    // presses a bound key / verb panel entry once B-5/B-6 wire the client)
    // and the server dispatches into the DM proc registry with BYOND verb
    // semantics — src = the verb's datum, usr = the caller's mob.
    //
    // Client boundary (B-5 owns the entry): everything below works for any
    // IConsoleShell; a real Robust.Client needs (a) chat/completions that
    // accept 'dm*'-prefixed input -> RemoteExecuteCommand, (b) click ->
    // 'dmclick' command arg or a proper interaction event -> this dispatch,
    // (c) keybind -> 'dmverb' mappings for hotkeys, (d) a verb panel fed by
    // 'dmverbs' output, (e) rendering of IServerConsoleHost.WriteLine text
    // as chat — that output already reaches the session console.

    /// <summary>Shared helpers for the dm* commands.</summary>
    internal static class DMCommands
    {
        /// <summary>The session's attached mob datum (null for the bare server console).</summary>
        public static DMRuntime? MobDatum(IEntityManager entMan, ICommonSession? session)
        {
            var uid = session?.AttachedEntity;
            if (uid is not { } u) return null;
            return entMan.TryGetComponent(u, out DMRuntimeComponent? comp) ? comp.Runtime : null;
        }

        /// <summary>
        /// Datum reference from a command token: "@&lt;uid&gt;"/digits = entity,
        /// "/type/path" = first live datum of that type, "x,y,z" = atom at
        /// DM tile coords.
        /// </summary>
        public static DMRuntime? ResolveTarget(IEntityManager entMan, string token)
        {
            var t = token.StartsWith("@") ? token.Substring(1) : token;
            if (long.TryParse(t, out var id))
            {
                if (entMan.TryGetComponent(new EntityUid((int)id), out DMRuntimeComponent? comp))
                    return comp.Runtime;
                return DMVerbRuntime.DatumForEntityId(id);
            }
            if (token.StartsWith("/"))
                return DMVerbRuntime.DatumForPath(token);
            var parts = token.Split(',');
            if (parts.Length == 3
                && double.TryParse(parts[0], System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var x)
                && double.TryParse(parts[1], System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var y)
                && double.TryParse(parts[2], System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var z))
            {
                return DMVerbRuntime.DatumAt(x, y, z);
            }
            return null;
        }

        /// <summary>Literal -> DMValue (numbers, @uid datum refs, /type/paths, else string).</summary>
        public static DMValue ParseArg(IEntityManager entMan, string token)
        {
            if (token.StartsWith("@") || token.StartsWith("/") || token.Contains(','))
            {
                if (ResolveTarget(entMan, token) is { } d) return DMValue.FromDatum(d);
            }
            if (double.TryParse(token, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var n))
                return DMValue.FromNumber(n, token.IndexOfAny(new[] { '.', 'e', 'E' }) >= 0);
            if (token.StartsWith("/")) return DMValue.FromPath(token);
            return DMValue.FromString(token);
        }

        /// <summary>
        /// Verb args: all-k=v tokens collapse into one assoc list so named
        /// args bind onto the callee's parameter names (BYOND arglist
        /// semantics); anything else binds positionally.
        /// </summary>
        public static DMValue[] ParseArgs(IEntityManager entMan, string[] tokens)
        {
            if (tokens.Length > 0 && tokens.All(t => t.Contains('=')))
            {
                var list = new DMList();
                foreach (var t in tokens)
                {
                    var i = t.IndexOf('=');
                    list.SetAssoc(t.Substring(0, i), ParseArg(entMan, t.Substring(i + 1)));
                }
                return new[] { DMValue.FromList(list) };
            }
            return tokens.Select(t => ParseArg(entMan, t)).ToArray();
        }

        /// <summary>Fire-and-forget a verb call, logging failures to the shell.</summary>
        public static void Fire(IConsoleShell shell, Task<DMValue> call, string what)
        {
            _ = call.ContinueWith(t =>
            {
                if (t.Exception != null)
                    shell.WriteError($"dmverb '{what}' threw: {t.Exception.GetBaseException().Message}");
            });
        }
    }

    /// <summary>
    /// dmverb &lt;proc&gt; [args...] — invoke a DM verb/proc on the player's
    /// mob. src = usr = the mob datum (the player's own verbs).
    /// </summary>
    public sealed class DMVerbCommand : IConsoleCommand
    {
        public string Command => "dmverb";
        public string Description => "Invoke a DM verb on your mob (converted world).";
        public string Help => "dmverb <proc> [args...] — args: numbers, text, @uid, /type/path, k=v named pairs. List verbs with dmverbs.";

        public void Execute(IConsoleShell shell, string argStr, string[] args)
        {
            var entMan = IoCManager.Resolve<IEntityManager>();
            if (args.Length == 0) { shell.WriteLine(Help); return; }
            var mob = DMCommands.MobDatum(entMan, shell.Player);
            if (mob == null) { shell.WriteError("dmverb: no DM mob attached — use dmverbon <target> <proc> from the server console"); return; }
            if (!DMVerbRuntime.HasProc(mob, args[0])) { shell.WriteError($"dmverb: {mob.DMTypePath} has no verb/proc '{args[0]}' — see dmverbs"); return; }
            DMCommands.Fire(shell, DMVerbRuntime.CallVerbAsUsr(mob, mob, args[0], DMCommands.ParseArgs(entMan, args.Skip(1).ToArray())), args[0]);
        }
    }

    /// <summary>
    /// dmverbon &lt;target&gt; &lt;proc&gt; [args...] — invoke a verb on an
    /// object with correct DM semantics: src = the target atom's datum,
    /// usr = the calling player's mob. This is the obj/turf verb path
    /// (e.g. a machine's verb the mob runs from its context).
    /// </summary>
    public sealed class DMVerbOnCommand : IConsoleCommand
    {
        public string Command => "dmverbon";
        public string Description => "Invoke a DM verb on an object (src=object, usr=your mob).";
        public string Help => "dmverbon <@uid|/type/path|x,y,z> <proc> [args...]";

        public void Execute(IConsoleShell shell, string argStr, string[] args)
        {
            var entMan = IoCManager.Resolve<IEntityManager>();
            if (args.Length < 2) { shell.WriteLine(Help); return; }
            var target = DMCommands.ResolveTarget(entMan, args[0]);
            if (target == null) { shell.WriteError($"dmverbon: no datum for '{args[0]}'"); return; }
            if (!DMVerbRuntime.HasProc(target, args[1])) { shell.WriteError($"dmverbon: {target.DMTypePath} has no verb/proc '{args[1]}'"); return; }
            var usr = DMCommands.MobDatum(entMan, shell.Player) ?? target;
            DMCommands.Fire(shell, DMVerbRuntime.CallVerbAsUsr(target, usr, args[1], DMCommands.ParseArgs(entMan, args.Skip(2).ToArray())), args[1]);
        }
    }

    /// <summary>
    /// dmclick &lt;target&gt; — click/interact routing: fires the atom's
    /// Click() proc with BYOND-style args (location=clicked atom,
    /// control=null, params=empty click list), src = clicked atom, usr =
    /// the player's mob. The server-side half of "interacts with one
    /// object" for M1; a real client's click plumbing is B-5's boundary.
    /// </summary>
    public sealed class DMClickCommand : IConsoleCommand
    {
        public string Command => "dmclick";
        public string Description => "Click/interact a DM atom (fires its Click() proc, usr=your mob).";
        public string Help => "dmclick <@uid|/type/path|x,y,z>";

        public void Execute(IConsoleShell shell, string argStr, string[] args)
        {
            var entMan = IoCManager.Resolve<IEntityManager>();
            if (args.Length < 1) { shell.WriteLine(Help); return; }
            var target = DMCommands.ResolveTarget(entMan, args[0]);
            if (target == null) { shell.WriteError($"dmclick: no datum for '{args[0]}'"); return; }
            var usr = DMCommands.MobDatum(entMan, shell.Player) ?? target;
            var clickParams = new DMList(); // BYOND Click(location, control, params)
            DMCommands.Fire(shell, DMVerbRuntime.CallVerbAsUsr(target, usr, "Click",
                DMValue.FromDatum(target), DMValue.Null, DMValue.FromList(clickParams)), "Click");
        }
    }

    /// <summary>
    /// dmsay &lt;text&gt; — speech: routes through the mob's 'say' verb/proc
    /// when the codebase defines one; falls back to a server-wide echo so
    /// the channel is observable either way.
    /// </summary>
    public sealed class DMSayCommand : IConsoleCommand
    {
        public string Command => "dmsay";
        public string Description => "Say text through your DM mob's say verb.";
        public string Help => "dmsay <text>";

        public void Execute(IConsoleShell shell, string argStr, string[] args)
        {
            var entMan = IoCManager.Resolve<IEntityManager>();
            var text = string.Join(" ", args);
            if (text.Length == 0) { shell.WriteLine(Help); return; }
            var mob = DMCommands.MobDatum(entMan, shell.Player);
            if (mob == null) { shell.WriteError("dmsay: no DM mob attached"); return; }
            if (DMVerbRuntime.HasProc(mob, "say"))
            {
                DMCommands.Fire(shell, DMVerbRuntime.CallVerbAsUsr(mob, mob, "say", DMValue.FromString(text)), "say");
                return;
            }
            var line = $"{shell.Player?.Name ?? "server"}: {text}";
            foreach (var s in IoCManager.Resolve<IPlayerManager>().Sessions)
            {
                if (s.Status == SessionStatus.InGame)
                    IoCManager.Resolve<IServerConsoleHost>().WriteLine(s, line);
            }
        }
    }

    /// <summary>
    /// dmooc &lt;text&gt; — out-of-character channel: broadcasts to all
    /// in-game consoles (OOC is a session chat, not a mob verb).
    /// </summary>
    public sealed class DMOocCommand : IConsoleCommand
    {
        public string Command => "dmooc";
        public string Description => "OOC chat to all connected players.";
        public string Help => "dmooc <text>";

        public void Execute(IConsoleShell shell, string argStr, string[] args)
        {
            var text = string.Join(" ", args);
            if (text.Length == 0) { shell.WriteLine(Help); return; }
            var line = $"OOC {shell.Player?.Name ?? "server"}: {text}";
            foreach (var s in IoCManager.Resolve<IPlayerManager>().Sessions)
            {
                if (s.Status == SessionStatus.InGame)
                    IoCManager.Resolve<IServerConsoleHost>().WriteLine(s, line);
            }
        }
    }

    /// <summary>
    /// dmtopic &lt;href&gt; — Browse/link equivalent: calls world.Topic(href)
    /// on the world datum. Browsers don't exist server-side, but a
    /// converted Topic() handler resolves here.
    /// </summary>
    public sealed class DMTopicCommand : IConsoleCommand
    {
        public string Command => "dmtopic";
        public string Description => "Route an href to world.Topic() (Browse/link equivalent).";
        public string Help => "dmtopic <href>";

        public void Execute(IConsoleShell shell, string argStr, string[] args)
        {
            var entMan = IoCManager.Resolve<IEntityManager>();
            var href = string.Join(" ", args);
            if (href.Length == 0) { shell.WriteLine(Help); return; }
            if (DMRuntimeHelpers.WorldValue.DatumRef is not DMRuntime world) { shell.WriteError("dmtopic: no world datum"); return; }
            var hasTopic = DMVerbRuntime.HasProc(world, "Topic");
            if (!hasTopic && !DMVerbRuntime.HasProc(world, "topic")) { shell.WriteError("dmtopic: world has no Topic() proc"); return; }
            var usr = DMCommands.MobDatum(entMan, shell.Player) ?? world;
            var linkData = new DMList();
            DMCommands.Fire(shell, DMVerbRuntime.CallVerbAsUsr(world, usr, hasTopic ? "Topic" : "topic",
                DMValue.FromString(href), DMValue.FromList(linkData), DMValue.Null), "Topic");
        }
    }

    /// <summary>dmverbs — list every proc invocable on your mob (verb panel).</summary>
    public sealed class DMVerbsCommand : IConsoleCommand
    {
        public string Command => "dmverbs";
        public string Description => "List the DM verbs/procs callable on your mob.";
        public string Help => "dmverbs";

        public void Execute(IConsoleShell shell, string argStr, string[] args)
        {
            var entMan = IoCManager.Resolve<IEntityManager>();
            var mob = DMCommands.MobDatum(entMan, shell.Player);
            if (mob == null) { shell.WriteError("dmverbs: no DM mob attached"); return; }
            var names = ProcRegistry.EnumerateProcs(mob.DMTypePath).OrderBy(n => n).ToList();
            shell.WriteLine($"{mob.DMTypePath} verbs ({names.Count}): {string.Join(", ", names)}");
        }
    }

    /// <summary>dmloc — print your mob's DM x,y,z coords (for dmclick x,y,z).</summary>
    public sealed class DMLocCommand : IConsoleCommand
    {
        public string Command => "dmloc";
        public string Description => "Print your mob's DM tile coords.";
        public string Help => "dmloc";

        public void Execute(IConsoleShell shell, string argStr, string[] args)
        {
            var entMan = IoCManager.Resolve<IEntityManager>();
            var mob = DMCommands.MobDatum(entMan, shell.Player);
            if (mob == null) { shell.WriteError("dmloc: no DM mob attached"); return; }
            shell.WriteLine($"x={mob.GetVar("x")}, y={mob.GetVar("y")}, z={mob.GetVar("z")}");
        }
    }

    /// <summary>
    /// Client command permission shim (B-4, item 72): without an
    /// implementation, ConGroupController.CanCommand returns false and every
    /// player-typed command lands "Unknown command". Converted worlds have
    /// no admin group setup, so we allow exactly the dm* interaction
    /// commands for player sessions — the server console bypasses this check
    /// entirely. Everything else stays denied.
    /// </summary>
    public sealed class DMPermissions : IConGroupControllerImplementation
    {
        private static readonly HashSet<string> Allowed = new(StringComparer.OrdinalIgnoreCase)
        {
            "dmverb", "dmverbon", "dmclick", "dmsay", "dmooc", "dmtopic", "dmverbs", "dmloc"
        };

        public bool CanCommand(ICommonSession session, string cmdName) => Allowed.Contains(cmdName);
        public bool CanAdminPlace(ICommonSession session) => false;
        public bool CanScript(ICommonSession session) => false;
        public bool CanAdminMenu(ICommonSession session) => false;
        public bool CanAdminReloadPrototypes(ICommonSession session) => false;
        public bool CheckInvokable(CommandSpec command, ICommonSession? user, out IConError? error)
        {
            error = null;
            return false;
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
        // The switch value is evaluated ONCE into a local: DM semantics (the
        // value must not be re-evaluated per case), and the emitted temp
        // (e.g. an `is var` pattern temp) must not be re-declared in every
        // case condition (CS0136 — corpus: tgmc).
        const switchTemp = this.nextTemp();
        switchCode += `${pad}var ${switchTemp} = ${this.transpileExpression(stmt.switchValue)};\n`;
        switchCode += `${pad}while (true)\n${pad}{\n`;
        this.switchDepth++;
        const cases: { values: any[]; body: any[] }[] = stmt.cases || [];
        for (let i = 0; i < cases.length; i++) {
          const c = cases[i];
          const conds = c.values.map(v => `DMValue.In(${switchTemp}, ${this.transpileExpression(v)}).IsTrue()`).join(' || ');
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
        if (CSharpEmitter.MOVE_VARS.has(stmt.assignmentTarget))
          return `${pad}await DMRuntimeHelpers.DMSetProperty(DMValue.FromDatum(comp), "${stmt.assignmentTarget}", ${this.transpileExpression(stmt.assignmentValue)});\n`;
        return `${pad}comp.SetVar("${stmt.assignmentTarget}", ${this.transpileExpression(stmt.assignmentValue)});\n`;

      case 'VarDeclStatement':
        if (stmt.varInit) {
          return `${pad}comp.SetVar("${stmt.varName}", ${this.transpileExpression(stmt.varInit)});\n`;
        }
        return `${pad}comp.SetVar("${stmt.varName}", DMValue.Null);\n`;

      case 'IfStatement':
        let ifCode = `${pad}if ((${this.transpileExpression(stmt.condition)}).IsTrue())\n${pad}{\n`;
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
        // Labeled break: DM `break name` exits the labeled block — jump to
        // the post-body label emitted by LabeledBlockStatement (item 59).
        if (stmt.label) {
          return `${pad}goto ${this.findLabelScope(stmt.label).exit};\n`;
        }
        // DM break exits the innermost loop, or the switch when not in a loop;
        // the switch's while(true) wrapper makes plain `break` correct in both.
        // Outside both, a raw `break` would be a C# compile error (CS0139) —
        // emit a comment instead (DM errors on this too — WS5-19).
        if (this.loopDepth === 0 && this.switchDepth === 0) {
          return `${pad}// break outside a loop\n`;
        }
        return `${pad}break;\n`;

      case 'ContinueStatement':
        // Labeled continue: DM `continue name` jumps back to the labeled
        // statement — the pre-body label from LabeledBlockStatement (item 59).
        if (stmt.label) {
          return `${pad}goto ${this.findLabelScope(stmt.label).enter};\n`;
        }
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
          let whileCode = `${pad}while ((${this.transpileExpression(stmt.condition)}).IsTrue())\n${pad}{\n`;
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
          doCode += `${pad}} while ((${stmt.condition ? this.transpileExpression(stmt.condition) : 'DMValue.FromNumber(1)'}).IsTrue());\n`;
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
            if (stmt.increment) {
              // The increment runs behind the continue label so a `continue`
              // still advances the loop.
              cforCode += `${pad}        ${contLabel}:\n`;
              cforCode += `${pad}        comp.SetVar("${stmt.loopVariable}", ${this.transpileExpression(stmt.increment)});\n`;
            } else {
              // 2-clause form (for(var/i = init, cond)): no increment — the
              // label still needs a statement for the goto (item 66).
              cforCode += `${pad}        ${contLabel}: ;\n`;
            }
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
            // Datum-property index writes emit a parenthesized ternary
            // (`(x).AsDatum() is var t ? ... : Null`) which is not a valid
            // statement — discard the value explicitly. This applies to ANY
            // `is var`-shaped set expression, whatever the target chain
            // (corpus build: tgmc CS0201 on variable-target index writes).
            if (expr.includes(' is var ')) {
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
          // B-4 (item 72): statement-level `x << y` is a compound op in DM —
          // `n << 2` shifts n, `L << x` appends to L. Plain locals write the
          // result back through SetVar (Output returns the shifted value or
          // the same list/datum). src/usr/world/args are runtime-bound (no
          // SetVar) and property/index LHS have no writeback — the send
          // side effect still runs.
          if (stmt.expression.type === 'binary' && stmt.expression.operator === '<<') {
            const lhs = stmt.expression.left as any;
            if (lhs?.type === 'variable' && !['src', 'usr', 'world', 'args', 'loc', 'contents'].includes(lhs.name)) {
              return `${pad}comp.SetVar("${lhs.name}", DMValue.Output(${this.transpileExpression(lhs)}, ${this.transpileExpression(stmt.expression.right)}));\n`;
            }
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
        } else {
          // DM allows a bare try without a catch — C# requires a catch or
          // finally after the block (item 66 corpus build: tgmc CS1524).
          tryCode += `${pad}finally { }\n`;
        }
        return tryCode;
      }

      case 'LabeledBlockStatement': {
        // DM label: { ... } — emit a REAL C# label so labeled break/continue
        // can goto it (item 59). A repeated DM label name in one method gets
        // a numeric suffix — C# labels must be unique per method (CS0140).
        const n = (this.labelNameCounts.get(stmt.label) ?? 0) + 1;
        this.labelNameCounts.set(stmt.label, n);
        const suffix = n === 1 ? '' : `_${n}`;
        const scope = { dm: stmt.label, enter: `__dmLabel_${stmt.label}${suffix}`, exit: `__dmBreak_${stmt.label}${suffix}` };
        this.labelStack.push(scope);
        let labelCode = `${pad}${scope.enter}:\n`;
        for (const s of stmt.body || []) {
          labelCode += this.transpileStatement(s, indent);
        }
        labelCode += `${pad}${scope.exit}: ;\n`;
        this.labelStack.pop();
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
      case 'new': {
        // ==== W-F new ====
        // Parenthesized: member access binds tighter than await, so callers
        // appending .IsTrue() etc. must bind to the DMValue, not the Task.
        // Global initializers have no comp; DMNew ignores the datum argument.
        const newTypePath = this.escapeString(this.normalizeTypePath(node.typePath));
        const compExpr = this.globalsMode ? 'null' : 'comp';
        const newArgs: any[] = node.arguments;
        let argTail = '';
        // W-F: `new T(arglist(L))` spreads L's elements; mixing arglist with
        // plain args concatenates the segments (same rule as call sites).
        if (newArgs.some((a: any) => a.type === 'call' && a.name === 'arglist')) {
          argTail = `, DMRuntimeHelpers.DMArgsConcat(${newArgs.map((a: any) =>
            a.type === 'call' && a.name === 'arglist'
              ? `DMRuntimeHelpers.DMArgList(${this.transpileExpression(a.arguments[0])})`
              : `DMRuntimeHelpers.DMArgList(${this.transpileExpression(a)})`
          ).join(', ')})`;
        } else if (newArgs.length > 0) {
          // W-F: `new T(k = v)` parses as an assignment node; emit a named-arg
          // marker so the runtime binds it to New()'s declared params instead
          // of writing the caller's `k` var.
          argTail = ', ' + newArgs.map((a: any) =>
            a.type === 'assignment' && typeof a.target === 'string'
              ? `DMRuntimeHelpers.DMNamedArg("${this.escapeString(a.target)}", ${this.transpileExpression(a.value)})`
              : this.transpileExpression(a)
          ).join(', ');
        }
        const segs = this.normalizeTypePath(node.typePath).split('/').filter(Boolean);
        if (segs.length === 1) {
          // W-F: `new x` — a single-segment path is ambiguous in DM: when a
          // var `x` in scope holds a typepath the var wins (new spawn_type(loc)
          // is the common corpus idiom); otherwise the literal one-segment
          // path stands. The AST loses the rooted/unrooted distinction, so the
          // runtime resolves it: DMNewPath reads the var, and a path-valued
          // result wins over the literal.
          const varRead = this.globalsMode
            ? `(await GlobalVars.Get("${this.escapeString(segs[0])}"))`
            : `comp.GetVar("${this.escapeString(segs[0])}")`;
          return `(await DMNewPath(${compExpr}, ${varRead}, "${newTypePath}"${argTail}))`;
        }
        return `(await DMNew(${compExpr}, "${newTypePath}"${argTail}))`;
      }
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
        if (CSharpEmitter.MOVE_VARS.has((node as any).target))
          return `(await DMRuntimeHelpers.DMSetProperty(DMValue.FromDatum(comp), "${(node as any).target}", ${this.transpileExpression((node as any).value)}))`;
        return `comp.SetVar("${(node as any).target}", ${this.transpileExpression((node as any).value)})`;
      case 'property_assignment': {
        // GLOB.x = v writes through the generated GlobalVars registry.
        const paTarget = (node as any).target;
        if (paTarget?.type === 'variable' && paTarget.name === 'GLOB') {
          return `(await GlobalVars.Set("${(node as any).property}", ${this.transpileExpression((node as any).value)}))`;
        }
        return `(await DMRuntimeHelpers.DMSetProperty(${this.transpileExpression(paTarget)}, "${(node as any).property}", ${this.transpileExpression((node as any).value)}))`;
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
        // {a = 1, "b" = 2} — brace-form associative keys (item 58).
        if (node.elements.some((e: any) => e.type === 'assoc_pair')) {
          const kv = node.elements.map((e: any) =>
            e.type === 'assoc_pair'
              ? `${this.transpileExpression(e.key)}, ${this.transpileExpression(e.value)}`
              : this.transpileExpression(e)
          ).join(', ');
          return `DMRuntimeHelpers.MakeListAssoc(${kv})`;
        }
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
    // Containment vars are computed on atoms: bare loc/contents reads go
    // through the property path so .loc resolves the container datum and
    // .contents yields live membership (item 69, B-1).
    if (node.name === 'loc' || node.name === 'contents')
      return `DMRuntimeHelpers.DMGetProperty(DMValue.FromDatum(comp), "${node.name}")`;
    return `comp.GetVar("${node.name}")`;
  }

  private normalizeTypePath(p: string): string {
    return (p || '').replace(/\/+$/, '');
  }

  // ==== W-F new ====
  /** Field var initializers arrive as raw text (`var/x = new /path` →
   *  customVars["x"] = "new /path"): re-lex/parse the text and return the
   *  expression AST when it is (or starts with) a `new`, else null. Any
   *  parse failure yields null so the initializer keeps its existing
   *  string-value fallback. */
  private parseNewInitializer(raw: any): ExpressionNode | null {
    if (typeof raw !== 'string' || !/^\s*new\b/.test(raw)) return null;
    try {
      const tokens = new DMLexer(raw).tokenize();
      const sub = new DMParser(tokens, new DiagnosticCollector());
      const expr = sub.parseExpression() as ExpressionNode | null;
      if (expr && expr.type === 'new') return expr;
      // Postfix forms (`new /path (...)`, `new /path {…}`) wrap the `new`
      // node — accept those as well.
      if (expr && this.containsNew(expr)) return expr;
      return null;
    } catch {
      return null;
    }
  }

  private containsNew(node: any): boolean {
    if (!node || typeof node !== 'object') return false;
    if (node.type === 'new') return true;
    for (const key of Object.keys(node)) {
      const v = node[key];
      if (Array.isArray(v) ? v.some(n => this.containsNew(n)) : this.containsNew(v)) return true;
    }
    return false;
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
      case '<<':
        // B-4 (item 72): DM `x << y` is output for client-capable targets
        // (client/mob/world/datums), append for lists, and a bitwise shift
        // otherwise — the LHS type is dynamic, so every << routes through
        // DMValue.Output which dispatches at runtime (`num << 2` still
        // shifts) and returns the target for `a << b << c` chaining.
        return `DMValue.Output(${left}, ${right})`;
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

    // B-3 (item 71): animate()/flick()/image() named appearance args
    // (alpha = 0, time = 5, icon_state = "x") parse as `assignment` nodes —
    // emitting them as assignments would write the CALLER's vars. Emit
    // name/value marker lists instead.
    if (!hasArglist && (node.name === 'animate' || node.name === 'flick' || node.name === 'image') &&
        node.arguments.some((a: any) => a.type === 'assignment' && typeof a.target === 'string')) {
      const helper = node.name === 'animate' ? 'Animate' : node.name === 'flick' ? 'Flick' : 'ImageNamed';
      const pairs = node.arguments.map((a: any) =>
        a.type === 'assignment' && typeof a.target === 'string'
          ? `DMRuntimeHelpers.DMNamedArg("${this.escapeString(a.target)}", ${this.transpileExpression(a.value)})`
          : this.transpileExpression(a)
      ).join(', ');
      return `DMRuntimeHelpers.${helper}(${pairs})`;
    }

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

    // Built-in DM procs (names are case-insensitive — fold before the lookup,
    // item 57: `Pick`/`crash`/`replacetextex` all resolve).
    const builtin = transpileBuiltinCall(node.name.toLowerCase(), args);
    if (builtin !== null) {
      return builtin;
    }
    // ==== W-A parent-call (item 22) ====
    // DM "..()" — invoke the DEFINING type's parent implementation of the
    // currently executing proc. The declaring type path is baked into the
    // call site: resolving from the concrete instance's DMTypePath re-found
    // the same body whenever a subtype overrode or inherited it, looping
    // the override back into itself until stack overflow (the old
    // single-argument CallParentProc's bug).
    // No-arg ..() forwards the CURRENT values of this proc's declared
    // parameters — BYOND passes the same arguments the current proc
    // received; explicit args (incl. named x = v, emitted as DMNamedArg
    // markers bound to the resolved ancestor's params) pass through as-is.
    if (node.name === '..') {
      if (this.globalsMode || !this.currentTypePath || this.currentTypePath.toLowerCase() === '/proc') {
        // Global procs and global initializers have no parent body: BYOND
        // has no ..() there at all. Await-wrapped so the 'call' emission is
        // still a valid expression-statement (a bare DMValue.Null is not).
        return '(await Task.FromResult(DMValue.Null))';
      }
      let argTail = '';
      if (hasArglist) {
        argTail = `, ${args}`; // a DMValue[] expression (DMArgsConcat)
      } else if (node.arguments.length === 0) {
        argTail = this.currentProcArgs.length > 0
          ? `, ${this.currentProcArgs.map((n) => `comp.GetVar("${this.escapeString(n)}")`).join(', ')}`
          : '';
      } else {
        const pargs = node.arguments.map((a: any) =>
          a.type === 'assignment' && typeof a.target === 'string'
            ? `DMRuntimeHelpers.DMNamedArg("${this.escapeString(a.target)}", ${this.transpileExpression(a.value)})`
            : this.transpileExpression(a)
        ).join(', ');
        argTail = `, ${pargs}`;
      }
      return `(await comp.CallParentProc("${this.escapeString(this.currentTypePath)}", "${this.escapeString(this.currentProcName)}"${argTail}))`;
    }
    // User-defined proc - call through runtime. In a global initializer there
    // is no current datum, so route through the GlobalVars bridge. The
    // corpus symbol table (item 64) resolves the target at emit time and
    // warns once per unknown name — the runtime registry stays the fallback.
    this.resolveAndWarn(node.name, !!node.target);
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
    // \\ " \n \r \t are the common escapes; \0 and other control characters
    // (BEL, NUL, etc. — DM strings can carry them from \x escapes) must not
    // be emitted raw into a C# string literal (item 59).
    return str
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t')
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, (c) => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0'));
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

  /** Deduped, identifier-safe C# member name for a proc (DM names are
   *  case-insensitive, so `foo` and `Foo` on one type collide — CS0111).
   *  Pass 1 (registrations) and pass 2 (members) must agree on the name. */
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

  /** Item 64: resolve a call target against the corpus symbol table and warn
   *  once per unknown name. The runtime registry remains the fallback, so a
   *  missed declaration is a diagnostic, not a crash. */
  private resolveAndWarn(name: string, isMethodCall: boolean): void {
    if (!this.symbols || name === '' || name === '..') return;
    const lname = name.toLowerCase();
    if (this.warnedCalls.has(lname)) return;
    const known = isMethodCall
      ? this.symbols.resolveTypeProc(this.currentTypePath, name)
      : this.symbols.resolveBareProc(this.currentTypePath, name);
    if (!known) {
      this.warnedCalls.add(lname);
      console.warn(`[dm2ss14] symbol: unresolved ${isMethodCall ? 'method' : 'proc'} call '${name}' (runtime fallback) — declared on no reachable type`);
    }
  }

  private capitalize(str: string): string {
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1);
  }
}
