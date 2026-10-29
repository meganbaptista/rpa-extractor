import type { EncodeImage, ImageTabs } from './types';
/**
 * Compression parameters: `[onlyBlend, evenCrd, forbidPrev, minBits,
 * forbidPlte, dither]`.
 */
export type CompressParams = [
    boolean,
    boolean,
    boolean,
    number,
    boolean,
    boolean
];
/**
 * Build an `EncodeImage` from RGBA8 frame buffers.
 *
 * `ps` is the maximum palette size: 0 keeps the image lossless (an indexed
 * PNG is still produced when the frames hold ≤ 256 colors), anything else
 * quantizes the frames down to `ps` colors.
 */
export declare function compress(bufs: ArrayBuffer[], w: number, h: number, ps: number, prms: CompressParams): EncodeImage;
/**
 * Encode RGBA8 frame buffers as a PNG / APNG.
 *
 * `cnum` is the palette size: 0 (default) encodes losslessly, any other
 * value quantizes the image to at most `cnum` colors.
 */
export declare function encode(imgs: ArrayBuffer[], w: number, h: number, cnum?: number, dels?: number[], tabs?: ImageTabs, forbidPlte?: boolean): ArrayBuffer;
/**
 * Lossless encode of raw sample buffers (`cc` color + `ac` alpha channels).
 */
export declare function encodeLL(imgs: ArrayBuffer[], w: number, h: number, cc: number, ac: number, depth: number, dels?: number[], tabs?: ImageTabs): ArrayBuffer;
//# sourceMappingURL=encode.d.ts.map