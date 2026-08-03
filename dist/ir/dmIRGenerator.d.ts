import { DMTypeDeclNode, DMProcDeclNode } from '../parser/dmParser.js';
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
    isDynamic: boolean;
}
export declare class DMIRGenerator {
    generateIR(nodes: DMTypeDeclNode[]): Map<string, DMIRType>;
    private normalizePath;
    private ensureBaseTypes;
    private computeParentPath;
    private extractBasename;
    private normalizeValue;
    private coerceTruthy;
}
