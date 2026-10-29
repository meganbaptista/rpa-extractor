import PDFDict from '../../core/objects/PDFDict';
import PDFContext from '../../core/PDFContext';
import { HexStringOperand, LiteralStringOperand } from './types';
type StringOperand = HexStringOperand | LiteralStringOperand;
export declare class FontDecoder {
    readonly fontFamily: string;
    private readonly toUnicode?;
    private readonly codeByteLength;
    private readonly simpleEncoding;
    private constructor();
    static forFontDict(font: PDFDict, context: PDFContext): FontDecoder;
    decode(operand: StringOperand): string;
}
export declare const isStringOperand: (value: unknown) => value is StringOperand;
export {};
//# sourceMappingURL=FontDecoder.d.ts.map