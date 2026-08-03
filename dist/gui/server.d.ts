export declare class GUIServer {
    private port;
    private authToken;
    private convertInFlight;
    private server;
    constructor(port?: number);
    stop(): void;
    start(): void;
    private isAuthorized;
    static validateOutputPath(outputDirPath: string): string | null;
    private static readonly MAX_UPLOAD_BYTES;
    private static readonly MAX_ZIP_ENTRIES;
    private static readonly MAX_ZIP_UNCOMPRESSED;
    private handleConvertRequest;
    private processConvertBody;
    private parseMultipart;
    private getHTMLContent;
}
