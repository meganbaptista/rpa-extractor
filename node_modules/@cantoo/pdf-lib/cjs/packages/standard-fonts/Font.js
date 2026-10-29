"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Font = exports.FontNames = void 0;
const tslib_1 = require("tslib");
const utils_1 = require("./utils");
const Courier_Bold_compressed_json_1 = tslib_1.__importDefault(require("./Courier-Bold.compressed.json"));
const Courier_BoldOblique_compressed_json_1 = tslib_1.__importDefault(require("./Courier-BoldOblique.compressed.json"));
const Courier_Oblique_compressed_json_1 = tslib_1.__importDefault(require("./Courier-Oblique.compressed.json"));
const Courier_compressed_json_1 = tslib_1.__importDefault(require("./Courier.compressed.json"));
const Helvetica_Bold_compressed_json_1 = tslib_1.__importDefault(require("./Helvetica-Bold.compressed.json"));
const Helvetica_BoldOblique_compressed_json_1 = tslib_1.__importDefault(require("./Helvetica-BoldOblique.compressed.json"));
const Helvetica_Oblique_compressed_json_1 = tslib_1.__importDefault(require("./Helvetica-Oblique.compressed.json"));
const Helvetica_compressed_json_1 = tslib_1.__importDefault(require("./Helvetica.compressed.json"));
const Times_Bold_compressed_json_1 = tslib_1.__importDefault(require("./Times-Bold.compressed.json"));
const Times_BoldItalic_compressed_json_1 = tslib_1.__importDefault(require("./Times-BoldItalic.compressed.json"));
const Times_Italic_compressed_json_1 = tslib_1.__importDefault(require("./Times-Italic.compressed.json"));
const Times_Roman_compressed_json_1 = tslib_1.__importDefault(require("./Times-Roman.compressed.json"));
const Symbol_compressed_json_1 = tslib_1.__importDefault(require("./Symbol.compressed.json"));
const ZapfDingbats_compressed_json_1 = tslib_1.__importDefault(require("./ZapfDingbats.compressed.json"));
// prettier-ignore
const compressedJsonForFontName = {
    'Courier': Courier_compressed_json_1.default,
    'Courier-Bold': Courier_Bold_compressed_json_1.default,
    'Courier-Oblique': Courier_Oblique_compressed_json_1.default,
    'Courier-BoldOblique': Courier_BoldOblique_compressed_json_1.default,
    'Helvetica': Helvetica_compressed_json_1.default,
    'Helvetica-Bold': Helvetica_Bold_compressed_json_1.default,
    'Helvetica-Oblique': Helvetica_Oblique_compressed_json_1.default,
    'Helvetica-BoldOblique': Helvetica_BoldOblique_compressed_json_1.default,
    'Times-Roman': Times_Roman_compressed_json_1.default,
    'Times-Bold': Times_Bold_compressed_json_1.default,
    'Times-Italic': Times_Italic_compressed_json_1.default,
    'Times-BoldItalic': Times_BoldItalic_compressed_json_1.default,
    'Symbol': Symbol_compressed_json_1.default,
    'ZapfDingbats': ZapfDingbats_compressed_json_1.default,
};
var FontNames;
(function (FontNames) {
    FontNames["Courier"] = "Courier";
    FontNames["CourierBold"] = "Courier-Bold";
    FontNames["CourierOblique"] = "Courier-Oblique";
    FontNames["CourierBoldOblique"] = "Courier-BoldOblique";
    FontNames["Helvetica"] = "Helvetica";
    FontNames["HelveticaBold"] = "Helvetica-Bold";
    FontNames["HelveticaOblique"] = "Helvetica-Oblique";
    FontNames["HelveticaBoldOblique"] = "Helvetica-BoldOblique";
    FontNames["TimesRoman"] = "Times-Roman";
    FontNames["TimesRomanBold"] = "Times-Bold";
    FontNames["TimesRomanItalic"] = "Times-Italic";
    FontNames["TimesRomanBoldItalic"] = "Times-BoldItalic";
    FontNames["Symbol"] = "Symbol";
    FontNames["ZapfDingbats"] = "ZapfDingbats";
})(FontNames || (exports.FontNames = FontNames = {}));
const fontCache = {};
class Font {
    constructor() {
        this.getWidthOfGlyph = (glyphName) => this.CharWidths[glyphName];
        this.getXAxisKerningForPair = (leftGlyphName, rightGlyphName) => (this.KernPairXAmounts[leftGlyphName] || {})[rightGlyphName];
    }
}
exports.Font = Font;
Font.load = (fontName) => {
    const cachedFont = fontCache[fontName];
    if (cachedFont)
        return cachedFont;
    const json = (0, utils_1.decompressJson)(compressedJsonForFontName[fontName]);
    const font = Object.assign(new Font(), JSON.parse(json));
    font.CharWidths = font.CharMetrics.reduce((acc, metric) => {
        acc[metric.N] = metric.WX;
        return acc;
    }, {});
    font.KernPairXAmounts = font.KernPairs.reduce((acc, [name1, name2, width]) => {
        if (!acc[name1])
            acc[name1] = {};
        acc[name1][name2] = width;
        return acc;
    }, {});
    fontCache[fontName] = font;
    return font;
};
//# sourceMappingURL=Font.js.map