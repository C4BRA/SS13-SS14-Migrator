import { DMTypeDeclNode, DMVarDeclNode } from '../parser/dmParser.js';

// Plan 02 — compile-time symbol verification. The parser's per-file type/proc
// inventory is accumulated into a corpus-wide table that both the audit and
// (later) the emitter use to resolve bare calls and type-proc calls without
// falling back to silent runtime resolution.

export interface TypeSymbol {
  path: string;
  parentPath: string | null;
  procNames: Set<string>;
  varNames: Map<string, DMVarDeclNode>;
}

export class SymbolTable {
  types: Map<string, TypeSymbol> = new Map();
  globalProcs: Set<string> = new Set();
  rootPath = '/datum';

  /** Merge a file's parsed type declarations into the table. */
  addTypeDecls(typeDecls: DMTypeDeclNode[]): void {
    for (const decl of typeDecls) {
      const path = normalizeTypePath(decl.path);
      let sym = this.types.get(path);
      if (!sym) {
        sym = {
          path,
          parentPath: computeParentPath(path),
          procNames: new Set(),
          varNames: new Map(),
        };
        this.types.set(path, sym);
      }
      for (const proc of decl.procs || []) sym.procNames.add(proc.name);
      for (const v of decl.vars || []) sym.varNames.set(v.name, v);
      if (path === '/proc' || path.startsWith('/proc/')) {
        for (const proc of decl.procs || []) this.globalProcs.add(proc.name);
      }
    }
  }

  hasGlobalProc(name: string): boolean {
    return this.globalProcs.has(name);
  }

  /** Proc reachable from a bare call inside a proc of `typePath`: the type's
   *  own hierarchy plus /proc globals (mirrors ProcRegistry.CallProc order:
   *  exact type -> ancestors -> /proc). */
  resolveBareProc(typePath: string | null | undefined, name: string): boolean {
    if (!typePath) return this.hasGlobalProc(name);
    return this.resolveTypeProc(typePath, name) || this.hasGlobalProc(name);
  }

  /** Proc reachable through the type hierarchy of `typePath` only. */
  resolveTypeProc(typePath: string, name: string): boolean {
    let current: string | null = normalizeTypePath(typePath);
    while (current) {
      const sym = this.types.get(current);
      if (sym && sym.procNames.has(name)) return true;
      current = sym ? sym.parentPath : computeParentPath(current);
    }
    return false;
  }
}

export function normalizeTypePath(path: string): string {
  // The lexer can leave a trailing slash on TypePath tokens, e.g. "/obj/item/".
  const p = path.endsWith('/') ? path.slice(0, -1) : path;
  return p === '' ? '/' : p;
}

// Mirrors DMIRGenerator.computeParentPath: DM types normally extend their
// string prefix, so the parent is the path with the last segment removed.
// Exception: the special root types declared at single-segment paths inherit
// from non-prefix parents in the BYOND type tree — /obj and /mob inherit
// /atom/movable, /turf and /area inherit /atom (all of which reach /atom, so
// e.g. /atom/proc/balloon_alert resolves from /obj and /mob call sites).
const SPECIAL_PARENTS: Record<string, string> = {
  '/obj': '/atom/movable',
  '/mob': '/atom/movable',
  '/turf': '/atom',
  '/area': '/atom',
};

export function computeParentPath(path: string): string | null {
  if (path === '/datum' || path === '/') return null;
  const normalized = path.endsWith('/') ? path.slice(0, -1) : path;
  const special = SPECIAL_PARENTS[normalized];
  if (special) return special;
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length <= 1) return '/datum';
  parts.pop();
  return '/' + parts.join('/');
}
