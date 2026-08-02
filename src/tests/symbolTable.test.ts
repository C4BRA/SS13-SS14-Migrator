import { DMLexer } from '../parser/dmLexer.js';
import { DMParser } from '../parser/dmParser.js';
import { DiagnosticCollector } from '../diagnostics.js';
import { SymbolTable, normalizeTypePath, computeParentPath } from '../ir/symbolTable.js';

function parseDm(body: string): ReturnType<DMParser['parse']> {
  const collector = new DiagnosticCollector();
  const parser = new DMParser(new DMLexer(body).tokenize(), collector);
  return parser.parse();
}

async function runSymbolTableTests() {
  console.log('=== Symbol Table Tests ===');

  const corpus = `
/proc/global_probe_helper()
    return 42

/datum/symbol_base
    var/base_var = 1
    proc/base_proc()
        return 1

/datum/symbol_base/symbol_child
    proc/child_proc()
        return 2
`;
  const table = new SymbolTable();
  table.addTypeDecls(parseDm(corpus));

  // Global procs (/proc/...)
  const check = (cond: boolean, msg: string) => {
    if (!cond) {
      console.error(`❌ TEST FAILED: ${msg}`);
      process.exit(1);
    }
    console.log(`✅ ${msg}`);
  };

  check(table.hasGlobalProc('global_probe_helper') === true, 'global proc declared under /proc is in globalProcs');
  check(table.hasGlobalProc('base_proc') === false, 'type-local proc is not a global proc');

  // Type hierarchy resolution
  check(table.resolveTypeProc('/datum/symbol_base', 'base_proc') === true, 'own proc resolves');
  check(table.resolveTypeProc('/datum/symbol_base/symbol_child', 'base_proc') === true, 'inherited proc resolves through ancestor');
  check(table.resolveTypeProc('/datum/symbol_base/symbol_child', 'child_proc') === true, 'own child proc resolves');
  check(table.resolveTypeProc('/datum/symbol_base', 'child_proc') === false, 'child proc not visible to parent');
  check(table.resolveTypeProc('/obj/unrelated', 'base_proc') === false, 'unrelated type does not see proc');
  check(table.resolveTypeProc('/datum/symbol_base/symbol_child', 'global_probe_helper') === false, 'global proc not in type hierarchy');

  // Bare-call resolution (type + ancestors + /proc)
  check(table.resolveBareProc('/datum/symbol_base/symbol_child', 'base_proc') === true, 'bare call resolves inherited proc');
  check(table.resolveBareProc('/datum/symbol_base', 'child_proc') === false, 'bare call does not resolve child-only proc');
  check(table.resolveBareProc('/obj/unrelated', 'global_probe_helper') === true, 'bare call resolves global proc from any type');
  check(table.resolveBareProc(undefined, 'base_proc') === false, 'no context: type-local proc unresolved');
  check(table.resolveBareProc(undefined, 'global_probe_helper') === true, 'no context: global proc resolves');

  // parentPath chain
  check(table.types.get('/datum/symbol_base')?.parentPath === '/datum', 'parentPath of /datum/symbol_base is /datum');
  check(table.types.get('/datum/symbol_base/symbol_child')?.parentPath === '/datum/symbol_base', 'parentPath chain one level deep');
  check(table.types.get('/datum')?.parentPath == null, '/datum has no parent');
  check(table.types.get('/proc')?.parentPath === '/datum', '/proc parent is /datum');

  // vars
  check(table.types.get('/datum/symbol_base')?.varNames.get('base_var')?.name === 'base_var', 'varNames indexed per type');

  // Cross-file merge: procs declared in a later file resolve for earlier call sites
  const table2 = new SymbolTable();
  table2.addTypeDecls(parseDm('/datum/a/proc/first()\n    return 1'));
  table2.addTypeDecls(parseDm('/proc/late_global()\n    return 2'));
  check(table2.hasGlobalProc('late_global') === true, 'merged global proc from second file');
  check(table2.resolveBareProc('/datum/a', 'late_global') === true, 'bare call resolves proc declared in later file');

  // Trailing-slash normalization (lexer can emit "/obj/item/")
  const table3 = new SymbolTable();
  table3.addTypeDecls(parseDm('/datum/trail/ \n    proc/x()\n        return 1\n/datum/trail\n    proc/y()\n        return 2'));
  check(normalizeTypePath('/datum/trail/') === '/datum/trail', 'normalizeTypePath strips trailing slash');
  check(table3.types.get('/datum/trail')?.procNames.has('x') === true, 'trailing-slash path merges into same symbol');
  check(table3.types.get('/datum/trail')?.procNames.has('y') === true, 'exact path merges into same symbol');

  // Root '/datum' missing from corpus: resolution still walks string parents
  const table4 = new SymbolTable();
  table4.addTypeDecls(parseDm('/datum/only/proc/gone()\n    return 1'));
  check(table4.resolveTypeProc('/datum/only/gone/child', 'gone') === true, 'ancestor walk proceeds through undeclared intermediate paths');

  // BYOND special root parents: /obj and /mob inherit /atom/movable -> /atom,
  // /turf and /area inherit /atom directly (e.g. /atom/proc/balloon_alert
  // must resolve from /obj/machinery and /mob/living call sites).
  const table5 = new SymbolTable();
  table5.addTypeDecls(parseDm('/atom/proc/balloon_alert(mob/viewer, text)\n    return 1\n/atom/movable/proc/forceMove(atom/dest)\n    return 1\n/atom/proc/set_light()\n    return 1'));
  check(computeParentPath('/obj') === '/atom/movable', '/obj parent is /atom/movable');
  check(computeParentPath('/mob') === '/atom/movable', '/mob parent is /atom/movable');
  check(computeParentPath('/turf') === '/atom', '/turf parent is /atom');
  check(computeParentPath('/area') === '/atom', '/area parent is /atom');
  check(table5.resolveBareProc('/obj/machinery/holopad', 'balloon_alert') === true, 'atom proc resolves from /obj call site');
  check(table5.resolveBareProc('/mob/living/carbon/human', 'balloon_alert') === true, 'atom proc resolves from /mob call site');
  check(table5.resolveBareProc('/turf/open/floor', 'set_light') === true, 'atom proc resolves from /turf call site');
  check(table5.resolveBareProc('/area/station', 'balloon_alert') === true, 'atom proc resolves from /area call site');
  check(table5.resolveBareProc('/obj/machinery/holopad', 'forceMove') === true, 'atom/movable proc resolves from /obj call site');
  check(table5.resolveBareProc('/datum/thing', 'balloon_alert') === false, 'datum does not see atom procs');

  console.log('\n✅ ALL SYMBOL TABLE TESTS PASSED!');
}

runSymbolTableTests().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
