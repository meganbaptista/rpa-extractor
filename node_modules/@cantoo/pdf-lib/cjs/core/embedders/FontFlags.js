"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deriveFontFlags = void 0;
// prettier-ignore
const makeFontFlags = (options) => {
    let flags = 0;
    const flipBit = (bit) => { flags |= (1 << (bit - 1)); };
    if (options.fixedPitch)
        flipBit(1);
    if (options.serif)
        flipBit(2);
    if (options.symbolic)
        flipBit(3);
    if (options.script)
        flipBit(4);
    if (options.nonsymbolic)
        flipBit(6);
    if (options.italic)
        flipBit(7);
    if (options.allCap)
        flipBit(17);
    if (options.smallCap)
        flipBit(18);
    if (options.forceBold)
        flipBit(19);
    return flags;
};
// From: https://github.com/foliojs/pdfkit/blob/83f5f7243172a017adcf6a7faa5547c55982c57b/lib/font/embedded.js#L123-L129
const deriveFontFlags = (font) => {
    var _a, _b, _c;
    const familyClass = font['OS/2'] ? font['OS/2'].sFamilyClass : 0;
    const flags = makeFontFlags({
        fixedPitch: !!((_a = font.post) === null || _a === void 0 ? void 0 : _a.isFixedPitch),
        serif: 1 <= familyClass && familyClass <= 7,
        symbolic: true, // Assume the font uses non-latin characters
        script: familyClass === 10,
        italic: !!((_c = (_b = font.head) === null || _b === void 0 ? void 0 : _b.macStyle) === null || _c === void 0 ? void 0 : _c.italic),
    });
    return flags;
};
exports.deriveFontFlags = deriveFontFlags;
//# sourceMappingURL=FontFlags.js.map