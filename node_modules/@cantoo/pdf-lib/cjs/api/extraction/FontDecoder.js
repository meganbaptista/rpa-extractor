"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isStringOperand = exports.FontDecoder = void 0;
const tslib_1 = require("tslib");
const standard_fonts_1 = require("../../packages/standard-fonts");
const PDFName_1 = tslib_1.__importDefault(require("../../core/objects/PDFName"));
const PDFRawStream_1 = tslib_1.__importDefault(require("../../core/objects/PDFRawStream"));
const PDFStream_1 = tslib_1.__importDefault(require("../../core/objects/PDFStream"));
const decode_1 = require("../../core/streams/decode");
const PDFContentStream_1 = tslib_1.__importDefault(require("../../core/structures/PDFContentStream"));
const utils_1 = require("../../utils");
const ToUnicode_1 = require("./ToUnicode");
const winAnsiReverse = (() => {
    const map = new Map();
    for (const cp of standard_fonts_1.Encodings.WinAnsi.supportedCodePoints) {
        const { code } = standard_fonts_1.Encodings.WinAnsi.encodeUnicodeCodePoint(cp);
        if (!map.has(code))
            map.set(code, cp);
    }
    return map;
})();
class FontDecoder {
    constructor(fontFamily, toUnicode, codeByteLength, simpleEncoding) {
        this.fontFamily = fontFamily;
        this.toUnicode = toUnicode;
        this.codeByteLength = codeByteLength;
        this.simpleEncoding = simpleEncoding;
    }
    static forFontDict(font, context) {
        const toUnicodeObj = font.lookup(PDFName_1.default.of('ToUnicode'));
        let toUnicode;
        let codeByteLength = 1;
        let cmapText = '';
        if (toUnicodeObj instanceof PDFStream_1.default) {
            const bytes = decodeStream(toUnicodeObj);
            cmapText = (0, utils_1.arrayAsString)(bytes);
            toUnicode = (0, ToUnicode_1.parseToUnicode)(cmapText);
            codeByteLength = (0, ToUnicode_1.inferCodeByteLength)(cmapText, toUnicode);
        }
        else {
            // Type0 Identity-H without parsed cmap still uses 2-byte codes typically
            const subtype = font.lookup(PDFName_1.default.of('Subtype'));
            const encoding = font.lookup(PDFName_1.default.of('Encoding'));
            if (subtype === PDFName_1.default.of('Type0') ||
                encoding === PDFName_1.default.of('Identity-H')) {
                codeByteLength = 2;
            }
        }
        const simpleEncoding = buildSimpleEncoding(font, context);
        const baseFont = font.lookup(PDFName_1.default.of('BaseFont'));
        const rawName = baseFont instanceof PDFName_1.default ? baseFont.decodeText() : 'Unknown';
        return new FontDecoder(stripSubsetPrefix(rawName), toUnicode, codeByteLength, simpleEncoding);
    }
    decode(operand) {
        const bytes = operand.bytes;
        let out = '';
        for (let i = 0; i + this.codeByteLength <= bytes.length; i += this.codeByteLength) {
            let code = 0;
            for (let b = 0; b < this.codeByteLength; b++) {
                code = (code << 8) | bytes[i + b];
            }
            if (this.toUnicode) {
                const mapped = this.toUnicode.get(code);
                if (mapped !== undefined) {
                    out += mapped;
                    continue;
                }
            }
            if (this.simpleEncoding) {
                const cp = this.simpleEncoding.get(code);
                if (cp !== undefined) {
                    out += String.fromCodePoint(cp);
                    continue;
                }
            }
            // ASCII fallback for single-byte codes
            if (this.codeByteLength === 1 && code >= 0x20 && code <= 0x7e) {
                out += String.fromCharCode(code);
            }
        }
        return out;
    }
}
exports.FontDecoder = FontDecoder;
const decodeStream = (stream) => {
    if (stream instanceof PDFRawStream_1.default) {
        return (0, decode_1.decodePDFRawStream)(stream).decode();
    }
    if (stream instanceof PDFContentStream_1.default) {
        return stream.getUnencodedContents();
    }
    return stream.getContents();
};
const buildSimpleEncoding = (font, _context) => {
    const encoding = font.lookup(PDFName_1.default.of('Encoding'));
    if (encoding === PDFName_1.default.of('WinAnsiEncoding') || encoding === undefined) {
        // Standard 14 fonts often omit Encoding and imply WinAnsi
        const subtype = font.lookup(PDFName_1.default.of('Subtype'));
        if (encoding === PDFName_1.default.of('WinAnsiEncoding') ||
            subtype === PDFName_1.default.of('Type1') ||
            subtype === PDFName_1.default.of('TrueType') ||
            subtype === PDFName_1.default.of('MMType1')) {
            return winAnsiReverse;
        }
    }
    if (encoding === PDFName_1.default.of('MacRomanEncoding')) {
        // Approximate with WinAnsi for v1 (close enough for common Latin)
        return winAnsiReverse;
    }
    return undefined;
};
const stripSubsetPrefix = (name) => {
    const plus = name.indexOf('+');
    return plus >= 0 ? name.slice(plus + 1) : name;
};
const isStringOperand = (value) => !!value &&
    typeof value === 'object' &&
    (value.type === 'hexString' ||
        value.type === 'string');
exports.isStringOperand = isStringOperand;
//# sourceMappingURL=FontDecoder.js.map