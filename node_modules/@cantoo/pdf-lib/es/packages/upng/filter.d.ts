import type { DecodeState } from './types';
/** Paeth predictor (PNG filter type 4). */
export declare function paeth(a: number, b: number, c: number): number;
/** Bits per pixel for a PNG color type + bit depth. */
export declare function getBPP(out: {
    ctype: number;
    depth: number;
}): number;
/**
 * Unfilter scanlines in place (PNG filter method 0).
 *
 * Ported from UPNG.js including the first-row type remapping quirks:
 * type 2/3 → None, type 4 → Sub, plus the special Average first-row pass
 * that indexes from absolute offset 0 (only correct when `off === 0`).
 */
export declare function filterZero(data: Uint8Array, out: {
    ctype: number;
    depth: number;
}, off: number, w: number, h: number): Uint8Array;
/** Adam7 deinterlace → tightly packed unfiltered image bytes. */
export declare function readInterlace(data: Uint8Array, out: DecodeState): Uint8Array;
/** Apply PNG filter type to one scanline into `data` (encode path). */
export declare function filterLine(data: Uint8Array, img: Uint8Array, y: number, bpl: number, bpp: number, type: number): void;
//# sourceMappingURL=filter.d.ts.map