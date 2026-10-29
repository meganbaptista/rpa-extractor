/**
 * Re-map `sb` onto `plte`, spreading the quantization error.
 * `MTD`: 0 = none, 1 = Floyd-Steinberg (default), 2 = Bayer.
 * Writes colors into `tb` and indices into `oind`.
 */
export declare function dither(sb: Uint8Array, w: number, h: number, plte: number[], tb: Uint8Array, oind: Uint8Array, MTD?: number): void;
//# sourceMappingURL=dither.d.ts.map