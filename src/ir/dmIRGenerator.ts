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

    // 2. Index nodes by path (normalized: the lexer can leave a trailing
    // slash on TypePath tokens, e.g. "/obj/item/"). A type split across
    // files declares the same path twice — MERGE the declarations instead
    // of last-wins, or the earlier file's vars/procs silently vanish.
    const nodeMap = new Map<string, DMTypeDeclNode>();
    for (const node of allNodes) {
      const p = this.normalizePath(node.path);
      const existing = nodeMap.get(p);
      if (existing) {
        existing.vars.push(...node.vars);
        existing.procs.push(...node.procs);
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
      const parentPath = this.computeParentPath(path);
      if (parentPath && !irMap.has(parentPath)) {
        processType(parentPath);
      }
      const node = nodeMap.get(path);
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
              irType.density = Boolean(Number(val));
              break;
            case 'anchored':
              irType.anchored = Boolean(Number(val));
              break;
            case 'opacity':
              irType.opacity = Boolean(Number(val));
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
    return path.replace(/\/+$/, '');
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
}
