import { DMIRType } from '../ir/dmIRGenerator.js';
export declare class YAMLGenerator {
    private static readonly BASE_PARENT_STUBS;
    generateYAMLPrototypes(irMap: Map<string, DMIRType>, outputDir: string): void;
    private parentIdFor;
    pathToId(dmPath: string): string;
    private serializeProps;
    private static readonly YAML_PLAIN_UNSAFE;
    private yamlScalar;
}
