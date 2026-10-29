import type { Image } from './types';
/**
 * Copy / blend a tile of RGBA pixels.
 * mode 0: overwrite, 1: over blend, 2: keep diffs else zero, 3: blendability check.
 */
export declare function copyTile(sb: Uint8Array, sw: number, sh: number, tb: Uint8Array, tw: number, th: number, xoff: number, yoff: number, mode: number): boolean;
/** Expand raw decoded samples to RGBA8 (one frame / region). */
export declare function decodeImage(data: Uint8Array, w: number, h: number, out: Image): Uint8Array;
/**
 * Convert a decoded image to one RGBA8 `ArrayBuffer` per frame.
 * Static PNGs return a single-element array.
 */
export declare function toRGBA8(out: Image): ArrayBuffer[];
//# sourceMappingURL=rgba.d.ts.map