import PDFName from '../../core/objects/PDFName.js';
import PDFRawStream from '../../core/objects/PDFRawStream.js';
import { decodePDFRawStream } from '../../core/streams/decode.js';
import { parsePDFAConformanceFromXmp } from './xmp.js';
/**
 * Decode the catalog `/Metadata` stream as UTF-8 XML, if present and readable.
 */
export const readCatalogMetadataXml = (catalog) => {
    try {
        const meta = catalog.lookup(PDFName.of('Metadata'));
        if (!(meta instanceof PDFRawStream))
            return undefined;
        const bytes = decodePDFRawStream(meta).decode();
        return new TextDecoder('utf-8').decode(bytes);
    }
    catch (_a) {
        return undefined;
    }
};
/**
 * Read `pdfaid` part/level from catalog XMP, if declared and supported.
 */
export const readCatalogPDFAConformance = (catalog) => {
    const xml = readCatalogMetadataXml(catalog);
    return xml ? parsePDFAConformanceFromXmp(xml) : undefined;
};
//# sourceMappingURL=catalogMetadata.js.map