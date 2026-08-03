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

// Simple LRU cache for hot path resolution (avoids repeated hierarchy walks)
class LRUCache<V> {
  private max: number;
  private cache: Map<string, V>;
  
  constructor(maxSize: number = 256) {
    this.max = maxSize;
    this.cache = new Map();
  }
  
  get(key: string): V | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }
  
  set(key: string, value: V): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.max) {
      // Remove oldest (first) entry
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(key, value);
  }
  
  clear(): void {
    this.cache.clear();
  }
}

export class SymbolTable {
  types: Map<string, TypeSymbol> = new Map();
  globalProcs: Set<string> = new Set();
  rootPath = '/datum';
  
  // LRU caches for hot path resolution (item 8)
  private bareProcCache = new LRUCache<boolean>(256);
  private typeProcCache = new LRUCache<boolean>(256);

  /** Merge a file's parsed type declarations into the table. */
  addTypeDecls(typeDecls: DMTypeDeclNode[]): void {
    // The LRU resolution caches below would serve stale results if the
    // table grew after lookups — invalidate on every mutation.
    this.clearCaches();
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
      for (const proc of decl.procs || []) sym.procNames.add(proc.name.toLowerCase()); // DM names are case-insensitive
      for (const v of decl.vars || []) sym.varNames.set(v.name.toLowerCase(), v);
      if (path === '/proc' || path.startsWith('/proc/')) {
        for (const proc of decl.procs || []) this.globalProcs.add(proc.name.toLowerCase());
      }
    }
  }

  hasGlobalProc(name: string): boolean {
    return this.globalProcs.has(name.toLowerCase());
  }

  /** Proc reachable from a bare call inside a proc of `typePath`: the type's
   *  own hierarchy plus /proc globals (mirrors ProcRegistry.CallProc order:
   *  exact type -> ancestors -> /proc). */
  resolveBareProc(typePath: string | null | undefined, name: string): boolean {
    if (!typePath) return this.hasGlobalProc(name);
    const cacheKey = `${typePath}|${name.toLowerCase()}`;
    const cached = this.bareProcCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const result = this.resolveTypeProc(typePath, name) || this.hasGlobalProc(name);
    this.bareProcCache.set(cacheKey, result);
    return result;
  }

  /** Proc reachable through the type hierarchy of `typePath` only. */
  resolveTypeProc(typePath: string, name: string): boolean {
    const cacheKey = `${typePath}|${name.toLowerCase()}`;
    const cached = this.typeProcCache.get(cacheKey);
    if (cached !== undefined) return cached;
    
    let current: string | null = normalizeTypePath(typePath);
    while (current) {
      const sym = this.types.get(current);
      if (sym && sym.procNames.has(name.toLowerCase())) {
        this.typeProcCache.set(cacheKey, true);
        return true;
      }
      current = sym ? sym.parentPath : computeParentPath(current);
    }
    this.typeProcCache.set(cacheKey, false);
    return false;
  }
  
  /** Clear resolution caches when symbol table changes. */
  clearCaches(): void {
    this.bareProcCache.clear();
    this.typeProcCache.clear();
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
