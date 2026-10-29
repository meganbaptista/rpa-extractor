type EncodingCharCode = number;
type EncodingCharName = string;
interface UnicodeMappings {
    [unicodeCodePoint: number]: [EncodingCharCode, EncodingCharName];
}
type EncodingNames = 'Symbol' | 'ZapfDingbats' | 'WinAnsi';
declare class Encoding {
    name: EncodingNames;
    supportedCodePoints: number[];
    private unicodeMappings;
    constructor(name: EncodingNames, unicodeMappings: UnicodeMappings);
    canEncodeUnicodeCodePoint: (codePoint: number) => boolean;
    encodeUnicodeCodePoint: (codePoint: number) => {
        code: number;
        name: string;
    };
}
export type EncodingType = Encoding;
export declare const Encodings: {
    Symbol: Encoding;
    ZapfDingbats: Encoding;
    WinAnsi: Encoding;
};
export {};
//# sourceMappingURL=Encoding.d.ts.map