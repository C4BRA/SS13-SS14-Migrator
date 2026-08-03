export interface PNGImage {
    width: number;
    height: number;
    rgba: Buffer;
}
export declare function crc32(buf: Buffer): number;
export declare function decodePNG(buffer: Buffer): PNGImage;
export declare function encodePNG(image: PNGImage): Buffer;
