"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.readCatalogPDFAConformance = exports.readCatalogMetadataXml = void 0;
const tslib_1 = require("tslib");
const PDFName_1 = tslib_1.__importDefault(require("../../core/objects/PDFName"));
const PDFRawStream_1 = tslib_1.__importDefault(require("../../core/objects/PDFRawStream"));
const decode_1 = require("../../core/streams/decode");
const xmp_1 = require("./xmp");
/**
 * Decode the catalog `/Metadata` stream as UTF-8 XML, if present and readable.
 */
const readCatalogMetadataXml = (catalog) => {
    try {
        const meta = catalog.lookup(PDFName_1.default.of('Metadata'));
        if (!(meta instanceof PDFRawStream_1.default))
            return undefined;
        const bytes = (0, decode_1.decodePDFRawStream)(meta).decode();
        return new TextDecoder('utf-8').decode(bytes);
    }
    catch (_a) {
        return undefined;
    }
};
exports.readCatalogMetadataXml = readCatalogMetadataXml;
/**
 * Read `pdfaid` part/level from catalog XMP, if declared and supported.
 */
const readCatalogPDFAConformance = (catalog) => {
    const xml = (0, exports.readCatalogMetadataXml)(catalog);
    return xml ? (0, xmp_1.parsePDFAConformanceFromXmp)(xml) : undefined;
};
exports.readCatalogPDFAConformance = readCatalogPDFAConformance;
//# sourceMappingURL=catalogMetadata.js.map