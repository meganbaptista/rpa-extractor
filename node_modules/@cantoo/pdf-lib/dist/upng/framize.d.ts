import type { ImageFrameRect } from './types';
/**
 * An APNG frame reduced to its changed region.
 *
 * `dispose`: 0 = no change, 1 = clear to transparent, 2 = restore previous.
 * `blend`: 0 = replace, 1 = blend over.
 */
export interface FramizeFrame {
    rect: ImageFrameRect;
    img: Uint8Array;
    blend: number;
    dispose: number;
}
/**
 * Split a sequence of full RGBA8 frames into minimal APNG frames, picking
 * the smallest changed rectangle and a blend / dispose strategy per frame.
 */
export declare function framize(bufs: ArrayBuffer[], w: number, h: number, alwaysBlend: boolean, evenCrd: boolean, forbidPrev: boolean): FramizeFrame[];
/** Concatenate RGBA8 buffers, zeroing the color of fully transparent pixels. */
export declare function concatRGBA(bufs: ArrayBuffer[]): ArrayBuffer;
//# sourceMappingURL=framize.d.ts.map