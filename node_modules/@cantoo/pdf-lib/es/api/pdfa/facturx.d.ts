import PDFDocument from '../PDFDocument';
import { AFRelationship } from '../../core/embedders/FileEmbedder';
import { BinaryData } from '../../utils';
/**
 * Factur-X / ZUGFeRD 2.1+ profile advertised in `fx:ConformanceLevel`.
 * Must match the profile URN embedded in the invoice XML.
 *
 * `'BASIC_WL'` is accepted as an alias of `'BASIC WL'`, the value Factur-X
 * writes in XMP.
 */
export type FacturXConformanceLevel = 'MINIMUM' | 'BASIC WL' | 'BASIC_WL' | 'BASIC' | 'EN 16931' | 'EXTENDED' | 'XRECHNUNG';
/**
 * Options for [[embedFacturX]].
 */
export interface EmbedFacturXOptions {
    /**
     * Filename of the embedded XML invoice. Defaults to `'factur-x.xml'`.
     * Must match `fx:DocumentFileName` (set automatically from this value).
     */
    fileName?: string;
    /**
     * Factur-X XML schema version advertised in XMP. Defaults to `'1.0'`.
     */
    version?: string;
    /**
     * Hybrid document type in capital letters. Defaults to `'INVOICE'`.
     */
    documentType?: string;
    /**
     * Factur-X / ZUGFeRD profile. Defaults to `'EN 16931'`.
     * `'BASIC_WL'` is normalised to `'BASIC WL'` in XMP.
     */
    conformanceLevel?: FacturXConformanceLevel;
    /**
     * Human-readable description of the attached file.
     */
    description?: string;
    /**
     * Associated-file relationship. Defaults to [[AFRelationship.Alternative]],
     * which is what Factur-X / ZUGFeRD expect for the embedded invoice XML.
     */
    afRelationship?: AFRelationship;
    /**
     * Attachment creation / modification dates (forwarded to [[PDFDocument.attach]]).
     */
    creationDate?: Date;
    modificationDate?: Date;
}
/** Namespace URI for Factur-X / ZUGFeRD 2.1+ XMP properties (prefix `fx`). */
export declare const FACTUR_X_NAMESPACE_URI = "urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#";
/**
 * Fixed PDF/A extension schema description for the Factur-X `fx` properties.
 * Required so PDF/A validators accept the custom metadata.
 *
 * Based on the PDFlib / Factur-X sample extension schema.
 */
export declare const FACTUR_X_EXTENSION_SCHEMA: string;
/**
 * Build the `fx:` `rdf:Description` fragment for Factur-X / ZUGFeRD XMP.
 */
export declare const buildFacturXDescription: (options: {
    fileName: string;
    version: string;
    documentType: string;
    conformanceLevel: FacturXConformanceLevel;
}) => string;
/**
 * Embed a Factur-X / ZUGFeRD invoice XML into a PDF as a PDF/A-3 attachment
 * with the required XMP metadata.
 *
 * This helper:
 * 1. Ensures PDF/A-3 (converts to 3B if needed; keeps an existing 3U/3B level).
 * 2. Adds the Factur-X `fx:` properties and PDF/A extension schema to XMP.
 * 3. Attaches the invoice XML with an associated-file relationship.
 *
 * It does **not** generate or validate the Cross Industry Invoice XML — pass
 * a complete `factur-x.xml` (or equivalent) produced by your invoicing stack.
 * Drawn text must still use an **embedded** font for PDF/A compliance.
 *
 * For example:
 * ```js
 * import { PDFDocument, embedFacturX } from '@cantoo/pdf-lib'
 * import fontkit from '@cantoo/fontkit'
 *
 * const pdfDoc = await PDFDocument.create()
 * pdfDoc.registerFontkit(fontkit)
 * const font = await pdfDoc.embedFont(fontBytes)
 * // ... draw the human-readable invoice with `font` ...
 *
 * await embedFacturX(pdfDoc, invoiceXmlBytes, {
 *   conformanceLevel: 'EN 16931',
 * })
 *
 * const pdfBytes = await pdfDoc.save()
 * ```
 *
 * @param pdfDoc The document that will carry the hybrid invoice.
 * @param invoiceXml The Factur-X / ZUGFeRD XML bytes to embed.
 * @param options Embedding and XMP options.
 */
export declare const embedFacturX: (pdfDoc: PDFDocument, invoiceXml: BinaryData, options?: EmbedFacturXOptions) => Promise<void>;
//# sourceMappingURL=facturx.d.ts.map