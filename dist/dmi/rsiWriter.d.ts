import { DMIMetadata } from './dmiParser.js';
export declare class RSIWriter {
    private parser;
    convertDMIToRSI(dmiPath: string, outputRSIPath: string): DMIMetadata;
    private sanitizeStateName;
}
