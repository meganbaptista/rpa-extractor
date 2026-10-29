/**
 * Minimal structural types for a fontkit-compatible engine registered via
 * `PDFDocument.registerFontkit`. Compatible with `@cantoo/fontkit` (preferred),
 * upstream `fontkit` v2+, and `@pdf-lib/fontkit`. Not a full mirror of any
 * package's typings — intentionally a structural subset so these engines
 * (and their typings) are assignable to `Fontkit`.
 */
export const isFontCollection = (font) => {
    if (!font || typeof font !== 'object')
        return false;
    const candidate = font;
    // fontkit collections expose `.fonts`; faces expose layout/glyph APIs instead.
    return (Array.isArray(candidate.fonts) &&
        typeof candidate.glyphForCodePoint !== 'function' &&
        typeof candidate.layout !== 'function');
};
/** Narrow `fontkit.create()` result to a single face (rejects TTC/DFont collections). */
export const asFont = (font) => {
    if (!font) {
        throw new Error('fontkit.create() returned null. Check the font bytes, or pass EmbedFontOptions.postscriptName to select a face from a collection.');
    }
    if (isFontCollection(font)) {
        throw new Error('fontkit.create() returned a font collection (e.g. .ttc/.dfont). Pass EmbedFontOptions.postscriptName to select a face, or embed a single-font file.');
    }
    return font;
};
//# sourceMappingURL=fontkit.js.map