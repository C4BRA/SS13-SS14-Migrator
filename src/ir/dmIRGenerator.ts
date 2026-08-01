import { DMTypeDeclNode, DMVarDeclNode, DMProcDeclNode } from '../parser/dmParser.js';

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
    // slash on TypePath tokens, e.g. "/obj/item/").
    const nodeMap = new Map<string, DMTypeDeclNode>();
    for (const node of allNodes) {
      nodeMap.set(this.normalizePath(node.path), node);
    }

    // 3. Sort paths hierarchically so parent types are processed before children
    const sortedPaths = Array.from(nodeMap.keys()).sort((a, b) => a.length - b.length);

    for (const path of sortedPaths) {
      const node = nodeMap.get(path)!;
      const parentPath = this.computeParentPath(path);

      // Ensure intermediate parent path exists in irMap
      if (parentPath && !irMap.has(parentPath)) {
        this.synthesizeMissingType(parentPath, irMap);
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
        isDynamic: false
      };

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

      irMap.set(path, irType);
    }

    return irMap;
  }

  private normalizePath(path: string): string {
    return path.replace(/\/+$/, '');
  }

  private synthesizeMissingType(path: string, irMap: Map<string, DMIRType>): void {
    const parentPath = this.computeParentPath(path);
    if (parentPath && !irMap.has(parentPath)) {
      this.synthesizeMissingType(parentPath, irMap);
    }
    const parentIR = parentPath ? irMap.get(parentPath) : null;
    irMap.set(path, {
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
    });
  }

  private ensureBaseTypes(nodes: DMTypeDeclNode[]): DMTypeDeclNode[] {
    const basePaths = ['/datum', '/atom', '/area', '/turf', '/obj', '/mob'];
    const result = [...nodes];
    for (const basePath of basePaths) {
      if (!result.some(n => n.path === basePath)) {
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
    if (path === '/datum') return null;
    const parts = path.split('/').filter(Boolean);
    if (parts.length <= 1) return '/datum';
    parts.pop();
    return '/' + parts.join('/');
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
