import { DMTypeDeclNode, DMVarDeclNode, DMProcDeclNode } from '../parser/dmParser.js';
import { computeParentPath as computePathParent } from './symbolTable.js';

export interface DMIRType {
  path: string;
  parentPath: string | null;
  name: string;
  desc: string;
  icon?: string;
  iconState?: string;
  density: boolean;
  anchored: boolean;
  opacity: boolean;
  customVars: Map<string, any>;
  procs: Map<string, DMProcDeclNode>;
  isDynamic: boolean; // Needs DMRuntimeComponent
}

export class DMIRGenerator {
  public generateIR(nodes: DMTypeDeclNode[]): Map<string, DMIRType> {
    const irMap = new Map<string, DMIRType>();

    // 1. Initialize base types if not present (does not mutate caller array)
    const allNodes = this.ensureBaseTypes(nodes);

    // 2. Index nodes by path (normalized: trailing slashes stripped and the
    // path LOWERCASED — DM type paths are case-insensitive, so /OBJ/Item/Foo
    // and /obj/item/foo are the SAME type (WS4-1)). A type split across
    // files declares the same path twice — MERGE the declarations instead
    // of last-wins, or the earlier file's vars/procs silently vanish. The
    // merge copies into a fresh node: caller AST nodes are never mutated
    // (WS4-7).
    const nodeMap = new Map<string, DMTypeDeclNode>();
    for (const node of allNodes) {
      const p = this.normalizePath(node.path);
      const existing = nodeMap.get(p);
      if (existing) {
        nodeMap.set(p, {
          type: 'DMTypeDecl',
          path: p,
          vars: [...existing.vars, ...node.vars],
          procs: [...existing.procs, ...node.procs]
        });
      } else {
        nodeMap.set(p, node);
      }
    }

    // 3. Process in parent-before-child order via DFS. A plain sort by path
    // string length is WRONG for the special root parents (/obj and /mob
    // inherit /atom/movable, which is LONGER than /obj itself): the shorter
    // child would be built from an empty synthesized parent before the real
    // /atom/movable node is processed. DFS guarantees parents are fully
    // processed (real or synthesized) before their children.
    const processed = new Set<string>();
    const processType = (path: string) => {
      if (processed.has(path)) return;
      processed.add(path);
      const node = nodeMap.get(path);
      // An explicit `parent_type = /x` declaration overrides the
      // prefix-derived parent (WS4-3).
      let parentPath = this.computeParentPath(path);
      if (node) {
        const pt = node.vars.find(v => v.name === 'parent_type');
        if (pt && typeof pt.initialValue === 'string') {
          const overridden = this.normalizeValue(pt.initialValue);
          if (typeof overridden === 'string' && overridden.startsWith('/')) {
            parentPath = this.normalizePath(overridden);
          }
        }
      }
      if (parentPath && !irMap.has(parentPath)) {
        processType(parentPath);
      }
      const parentIR = parentPath ? irMap.get(parentPath) : null;

      const irType: DMIRType = {
        path,
        parentPath,
        name: this.extractBasename(path),
        desc: parentIR ? parentIR.desc : '',
        icon: parentIR?.icon,
        iconState: parentIR?.iconState,
        density: parentIR ? parentIR.density : false,
        anchored: parentIR ? parentIR.anchored : false,
        opacity: parentIR ? parentIR.opacity : false,
        customVars: new Map(parentIR ? parentIR.customVars : []),
        procs: new Map(parentIR ? parentIR.procs : []),
        isDynamic: parentIR ? parentIR.isDynamic : false
      };

      if (node) {
        // Process variables
        for (const varDecl of node.vars) {
          const val = this.normalizeValue(varDecl.initialValue);
          switch (varDecl.name) {
            case 'name':
              irType.name = String(val);
              break;
            case 'desc':
              irType.desc = String(val);
              break;
            case 'icon':
              irType.icon = String(val);
              break;
            case 'icon_state':
              irType.iconState = String(val);
              break;
            case 'density':
              irType.density = Boolean(Number(this.coerceTruthy(val)));
              break;
            case 'anchored':
              irType.anchored = Boolean(Number(this.coerceTruthy(val)));
              break;
            case 'opacity':
              irType.opacity = Boolean(Number(this.coerceTruthy(val)));
              break;
            default:
              irType.customVars.set(varDecl.name, val);
              irType.isDynamic = true; // Has custom DM dynamic variable
              break;
          }
        }

        // Process procs
        for (const procDecl of node.procs) {
          irType.procs.set(procDecl.name, procDecl);
          irType.isDynamic = true; // Has custom DM proc
        }

        // Inherit dynamic flag if parent was dynamic
        if (parentIR?.isDynamic) {
          irType.isDynamic = true;
        }
      }

      irMap.set(path, irType);
    };

    for (const path of nodeMap.keys()) {
      processType(path);
    }

    return irMap;
  }

  private normalizePath(path: string): string {
    // Trailing slashes stripped AND lowercased: DM type paths are
    // case-insensitive — /OBJ/Item/Foo IS /obj/item/foo (WS4-1). All IR
    // keys, emitted registrations, YAML ids and runtime datum paths share
    // this canonical form.
    return path.replace(/\/+$/, '').toLowerCase();
  }

  private ensureBaseTypes(nodes: DMTypeDeclNode[]): DMTypeDeclNode[] {
    const basePaths = ['/datum', '/atom', '/area', '/turf', '/obj', '/mob'];
    const result = [...nodes];
    for (const basePath of basePaths) {
      // Compare normalized: a declared "/obj/" must count as /obj, otherwise
      // the base type is appended and the duplicate path collides later.
      if (!result.some(n => this.normalizePath(n.path) === basePath)) {
        result.push({
          type: 'DMTypeDecl',
          path: basePath,
          vars: [],
          procs: []
        });
      }
    }
    return result;
  }

  private computeParentPath(path: string): string | null {
    return computePathParent(path);
  }

  private extractBasename(path: string): string {
    const parts = path.split('/').filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : 'Object';
  }

  private normalizeValue(val: any): any {
    if (val === undefined || val === null) return null;
    if (typeof val === 'string') {
      return val.replace(/^["']|["']$/g, '');
    }
    return val;
  }

  // DM's builtin truth literals (TRUE/FALSE/yes/no) coerce to 1/0 for the
  // structural bool vars — Number("TRUE") is NaN, which silently produced
  // `false` walls (WS4-2).
  private coerceTruthy(val: any): string {
    const s = String(val).trim().toLowerCase();
    if (s === 'true' || s === 'yes' || s === 'on') return '1';
    if (s === 'false' || s === 'no' || s === 'off' || s === '') return '0';
    return String(val);
  }
}
