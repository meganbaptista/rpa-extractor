import { ParsedConformance } from './PDFAConformance';
export interface XMPMetadataInfo {
    conformance: ParsedConformance;
    title?: string;
    author?: string;
    subject?: string;
    keywords?: string;
    creator?: string;
    producer?: string;
    creationDate?: Date;
    modificationDate?: Date;
    /**
     * Extra `rdf:Description` fragments appended after the owned PDF/A / Info
     * projection. Each entry should be a full
     * `<rdf:Description ...>...</rdf:Description>` element.
     */
    extensions?: string[];
}
/**
 * Extract `rdf:Description` elements from an XMP packet that are *not* owned
 * by pdf-lib (e.g. Factur-X `fx:`, `pdfaExtension` schemas). Owned and mixed
 * blocks are omitted so the owned Info/`pdfaid` slice can be rebuilt cleanly.
 */
export declare const extractForeignXmpDescriptions: (xml: string) => string[];
/**
 * Read `pdfaid:part` / `pdfaid:conformance` from an XMP packet, if present and
 * supported (`1B` / `2B` / `2U` / `3B` / `3U`).
 */
export declare const parsePDFAConformanceFromXmp: (xml: string) => ParsedConformance | undefined;
/**
 * Merge one-shot extension fragments with preserved foreign descriptions.
 * Fragments in `extras` win over preserved ones that declare the same
 * non-owned namespace URI, so repeated `convertToPDFA({ extensions })` calls
 * do not duplicate Factur-X / custom schemas.
 */
export declare const mergeXmpExtensionFragments: (extras: string[] | undefined, preserved: string[]) => string[];
/**
 * Build an XMP metadata packet describing a PDF/A document. Every Info-mirrored
 * field that is present is written into owned `rdf:Description` blocks so the
 * two metadata sources stay consistent, as required by the PDF/A standard.
 *
 * Additional `extensions` fragments are appended unchanged.
 */
export declare const buildPDFAMetadata: (info: XMPMetadataInfo) => string;
//# sourceMappingURL=xmp.d.ts.map