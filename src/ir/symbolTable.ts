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
      // DM type paths are case-insensitive; var names are not.
      const path = normalizeTypePath(decl.path).toLowerCase();
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
      for (const v of decl.vars || []) {
        // Keep the declaring node (it carries the type); overrides only set a value.
        const prev = sym.varNames.get(v.name);
        if (!prev || (!prev.varType && v.varType)) sym.varNames.set(v.name, v);
      }
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
    
    let current: string | null = normalizeTypePath(typePath).toLowerCase();
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
  
  /** A var reachable on `typePath` (declared on it, an ancestor, or a BYOND builtin var). */
  resolveTypeVar(typePath: string, name: string): boolean {
    return this.typeVarDecl(typePath, name) !== undefined || builtinVarOwner(typePath, name);
  }

  /** The declaration of a var on `typePath` or its nearest ancestor (for declared types). */
  typeVarDecl(typePath: string, name: string, requireType = false): DMVarDeclNode | undefined {
    let current: string | null = normalizeTypePath(typePath).toLowerCase();
    while (current) {
      const sym = this.types.get(current);
      const decl = sym?.varNames.get(name);
      if (decl && (!requireType || decl.varType)) return decl;
      current = sym ? sym.parentPath : computeParentPath(current);
    }
    return undefined;
  }

  /** Declared type of a var (e.g. /obj/item for `var/obj/item/held`), walking overrides to the declaration. */
  typeVarType(typePath: string, name: string): string | undefined {
    const t = this.typeVarDecl(typePath, name, true)?.varType;
    if (!t) return undefined;
    const segs = t.split('/').filter(s => s && !['global', 'static', 'tmp', 'const', 'final'].includes(s));
    return segs.length > 0 ? '/' + segs.join('/') : undefined;
  }

  /** Clear resolution caches when symbol table changes. */
  clearCaches(): void {
    this.bareProcCache.clear();
    this.typeProcCache.clear();
  }
}

// BYOND builtin vars by owning base type (mirrors runtime DMBuiltinTypes).
const BUILTIN_VARS: Record<string, string[]> = {
  '/datum': ['type', 'parent_type', 'tag', 'vars'],
  '/atom': ['name', 'desc', 'suffix', 'text', 'icon', 'icon_state', 'icon_w', 'icon_z', 'dir', 'loc', 'x', 'y', 'z',
    'density', 'opacity', 'invisibility', 'luminosity', 'infra_luminosity', 'layer', 'plane', 'alpha', 'color',
    'blend_mode', 'appearance_flags', 'mouse_opacity', 'mouse_over_pointer', 'mouse_drag_pointer',
    'mouse_drop_pointer', 'mouse_drop_zone', 'pixel_x', 'pixel_y', 'pixel_w', 'pixel_z', 'maptext',
    'maptext_width', 'maptext_height', 'maptext_x', 'maptext_y', 'transform', 'render_source', 'render_target',
    'vis_flags', 'filters', 'contents', 'overlays', 'underlays', 'verbs', 'vis_contents', 'vis_locs', 'appearance'],
  '/atom/movable': ['animate_movement', 'bound_x', 'bound_y', 'bound_width', 'bound_height', 'step_x', 'step_y',
    'step_size', 'glide_size', 'screen_loc', 'particles', 'locs'],
  '/mob': ['key', 'ckey', 'client', 'sight', 'see_invisible', 'see_in_dark', 'see_infrared', 'group'],
  '/client': ['mob', 'key', 'ckey', 'eye', 'view', 'statpanel', 'images', 'screen', 'address', 'computer_id',
    'byond_version', 'byond_build', 'perspective', 'pixel_x', 'pixel_y', 'color', 'verbs', 'inactivity',
    'connection', 'show_popup_menus', 'preload_rsc', 'script', 'gender', 'lazy_eye', 'dir', 'tick_lag', 'fps',
    'virtual_eye', 'bounds'],
};

function builtinVarOwner(typePath: string, name: string): boolean {
  let current: string | null = normalizeTypePath(typePath).toLowerCase();
  while (current) {
    if (BUILTIN_VARS[current]?.includes(name)) return true;
    current = computeParentPath(current);
  }
  return false;
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
