"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SymbolTable = void 0;
exports.normalizeTypePath = normalizeTypePath;
exports.computeParentPath = computeParentPath;
// Simple LRU cache for hot path resolution (avoids repeated hierarchy walks)
class LRUCache {
    max;
    cache;
    constructor(maxSize = 256) {
        this.max = maxSize;
        this.cache = new Map();
    }
    get(key) {
        const value = this.cache.get(key);
        if (value !== undefined) {
            // Move to end (most recently used)
            this.cache.delete(key);
            this.cache.set(key, value);
        }
        return value;
    }
    set(key, value) {
        if (this.cache.has(key)) {
            this.cache.delete(key);
        }
        else if (this.cache.size >= this.max) {
            // Remove oldest (first) entry
            const firstKey = this.cache.keys().next().value;
            if (firstKey !== undefined) {
                this.cache.delete(firstKey);
            }
        }
        this.cache.set(key, value);
    }
    clear() {
        this.cache.clear();
    }
}
class SymbolTable {
    types = new Map();
    globalProcs = new Set();
    rootPath = '/datum';
    // LRU caches for hot path resolution (item 8)
    bareProcCache = new LRUCache(256);
    typeProcCache = new LRUCache(256);
    /** Merge a file's parsed type declarations into the table. */
    addTypeDecls(typeDecls) {
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
            for (const proc of decl.procs || [])
                sym.procNames.add(proc.name.toLowerCase()); // DM names are case-insensitive
            for (const v of decl.vars || [])
                sym.varNames.set(v.name.toLowerCase(), v);
            if (path === '/proc' || path.startsWith('/proc/')) {
                for (const proc of decl.procs || [])
                    this.globalProcs.add(proc.name.toLowerCase());
            }
        }
    }
    hasGlobalProc(name) {
        return this.globalProcs.has(name.toLowerCase());
    }
    /** Proc reachable from a bare call inside a proc of `typePath`: the type's
     *  own hierarchy plus /proc globals (mirrors ProcRegistry.CallProc order:
     *  exact type -> ancestors -> /proc). */
    resolveBareProc(typePath, name) {
        if (!typePath)
            return this.hasGlobalProc(name);
        const cacheKey = `${typePath}|${name.toLowerCase()}`;
        const cached = this.bareProcCache.get(cacheKey);
        if (cached !== undefined)
            return cached;
        const result = this.resolveTypeProc(typePath, name) || this.hasGlobalProc(name);
        this.bareProcCache.set(cacheKey, result);
        return result;
    }
    /** Proc reachable through the type hierarchy of `typePath` only. */
    resolveTypeProc(typePath, name) {
        const cacheKey = `${typePath}|${name.toLowerCase()}`;
        const cached = this.typeProcCache.get(cacheKey);
        if (cached !== undefined)
            return cached;
        let current = normalizeTypePath(typePath);
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
    clearCaches() {
        this.bareProcCache.clear();
        this.typeProcCache.clear();
    }
}
exports.SymbolTable = SymbolTable;
function normalizeTypePath(path) {
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
const SPECIAL_PARENTS = {
    '/obj': '/atom/movable',
    '/mob': '/atom/movable',
    '/turf': '/atom',
    '/area': '/atom',
};
function computeParentPath(path) {
    if (path === '/datum' || path === '/')
        return null;
    const normalized = path.endsWith('/') ? path.slice(0, -1) : path;
    const special = SPECIAL_PARENTS[normalized];
    if (special)
        return special;
    const parts = normalized.split('/').filter(Boolean);
    if (parts.length <= 1)
        return '/datum';
    parts.pop();
    return '/' + parts.join('/');
}
