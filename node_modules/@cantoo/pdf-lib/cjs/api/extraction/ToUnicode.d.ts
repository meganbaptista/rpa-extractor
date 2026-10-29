/**
 * Parse a ToUnicode CMap (as decoded stream bytes / string) into a map from
 * character code (number) to Unicode string.
 *
 * Supports `beginbfchar` / `endbfchar` and `beginbfrange` / `endbfrange`
 * (both destination-offset and array forms).
 */
export declare const parseToUnicode: (data: Uint8Array | string) => Map<number, string>;
/**
 * Infer bytes-per-character-code from a ToUnicode CMap codespacersange, defaulting
 * to 1 (or 2 if any mapping key needs two bytes).
 */
export declare const inferCodeByteLength: (cmapText: string, mapping: Map<number, string>) => number;
//# sourceMappingURL=ToUnicode.d.ts.map