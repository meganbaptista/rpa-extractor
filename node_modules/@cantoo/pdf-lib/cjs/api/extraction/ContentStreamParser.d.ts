import { ContentStreamOperation } from './types';
/**
 * Tokenize a decoded PDF content stream into operator / operand sequences.
 * Inline images (`BI`…`ID`…`EI`) are skipped as a unit.
 */
export declare const parseContentStream: (bytes: Uint8Array) => ContentStreamOperation[];
//# sourceMappingURL=ContentStreamParser.d.ts.map