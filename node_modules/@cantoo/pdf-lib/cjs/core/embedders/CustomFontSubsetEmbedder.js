"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tslib_1 = require("tslib");
const fontkit_1 = require("../../types/fontkit");
const CustomFontEmbedder_1 = tslib_1.__importDefault(require("./CustomFontEmbedder"));
const PDFHexString_1 = tslib_1.__importDefault(require("../objects/PDFHexString"));
const utils_1 = require("../../utils");
/**
 * A note of thanks to the developers of https://github.com/foliojs/pdfkit, as
 * this class borrows from:
 *   https://github.com/devongovett/pdfkit/blob/e71edab0dd4657b5a767804ba86c94c58d01fbca/lib/image/jpeg.coffee
 */
class CustomFontSubsetEmbedder extends CustomFontEmbedder_1.default {
    static for(fontkit, fontData, customFontName, fontFeatures, postscriptName) {
        return tslib_1.__awaiter(this, void 0, void 0, function* () {
            const font = (0, fontkit_1.asFont)(yield fontkit.create(fontData, postscriptName));
            return new CustomFontSubsetEmbedder(font, fontData, customFontName, fontFeatures);
        });
    }
    constructor(font, fontData, customFontName, fontFeatures) {
        super(font, fontData, customFontName, fontFeatures);
        this.subset = this.font.createSubset();
        this.glyphs = [];
        this.glyphCache = utils_1.Cache.populatedBy(() => this.glyphs);
        this.glyphIdMap = new Map();
    }
    encodeText(text) {
        const { glyphs } = this.font.layout(text, this.fontFeatures);
        const hexCodes = new Array(glyphs.length);
        for (let idx = 0, len = glyphs.length; idx < len; idx++) {
            const glyph = glyphs[idx];
            const included = this.subset.includeGlyph(glyph);
            if (typeof included !== 'number') {
                throw new Error('fontkit subset.includeGlyph() must return a glyph id (number)');
            }
            const subsetGlyphId = included;
            this.glyphs[subsetGlyphId - 1] = glyph;
            this.glyphIdMap.set(glyph.id, subsetGlyphId);
            hexCodes[idx] = (0, utils_1.toHexStringOfMinLength)(subsetGlyphId, 4);
        }
        this.glyphCache.invalidate();
        return PDFHexString_1.default.of(hexCodes.join(''));
    }
    isCFF() {
        return this.subset.cff;
    }
    glyphId(glyph) {
        return glyph ? this.glyphIdMap.get(glyph.id) : -1;
    }
    serializeFont() {
        // `@cantoo/fontkit` / upstream fontkit v2+ expose sync `encode()`;
        // `@pdf-lib/fontkit` uses Node-style `encodeStream()`.
        if (typeof this.subset.encode === 'function') {
            return Promise.resolve(this.subset.encode());
        }
        return new Promise((resolve, reject) => {
            if (typeof this.subset.encodeStream !== 'function') {
                reject(new Error('Registered fontkit subsetter must provide encode() or encodeStream()'));
                return;
            }
            const parts = [];
            this.subset
                .encodeStream()
                .on('data', (bytes) => parts.push(bytes))
                .on('end', () => resolve((0, utils_1.mergeUint8Arrays)(parts)))
                .on('error', (err) => reject(err));
        });
    }
}
exports.default = CustomFontSubsetEmbedder;
//# sourceMappingURL=CustomFontSubsetEmbedder.js.map