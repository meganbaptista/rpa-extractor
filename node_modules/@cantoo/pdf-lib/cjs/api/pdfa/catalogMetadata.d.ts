import PDFCatalog from '../../core/structures/PDFCatalog';
import { ParsedConformance } from './PDFAConformance';
/**
 * Decode the catalog `/Metadata` stream as UTF-8 XML, if present and readable.
 */
export declare const readCatalogMetadataXml: (catalog: PDFCatalog) => string | undefined;
/**
 * Read `pdfaid` part/level from catalog XMP, if declared and supported.
 */
export declare const readCatalogPDFAConformance: (catalog: PDFCatalog) => ParsedConformance | undefined;
//# sourceMappingURL=catalogMetadata.d.ts.map