"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.embedFacturX = exports.buildFacturXDescription = exports.FACTUR_X_EXTENSION_SCHEMA = exports.FACTUR_X_NAMESPACE_URI = void 0;
const tslib_1 = require("tslib");
const html_entities_1 = require("html-entities");
const PDFDocument_1 = tslib_1.__importDefault(require("../PDFDocument"));
const FileEmbedder_1 = require("../../core/embedders/FileEmbedder");
const utils_1 = require("../../utils");
const catalogMetadata_1 = require("./catalogMetadata");
const FACTUR_X_CONFORMANCE_LEVELS = [
    'MINIMUM',
    'BASIC WL',
    'BASIC_WL',
    'BASIC',
    'EN 16931',
    'EXTENDED',
    'XRECHNUNG',
];
/** Map API aliases to the `fx:ConformanceLevel` value Factur-X expects. */
const canonicalizeFacturXConformanceLevel = (level) => (level === 'BASIC_WL' ? 'BASIC WL' : level);
/** Namespace URI for Factur-X / ZUGFeRD 2.1+ XMP properties (prefix `fx`). */
exports.FACTUR_X_NAMESPACE_URI = 'urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#';
/**
 * Fixed PDF/A extension schema description for the Factur-X `fx` properties.
 * Required so PDF/A validators accept the custom metadata.
 *
 * Based on the PDFlib / Factur-X sample extension schema.
 */
exports.FACTUR_X_EXTENSION_SCHEMA = '<rdf:Description rdf:about="" ' +
    'xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/" ' +
    'xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#" ' +
    'xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#">' +
    '<pdfaExtension:schemas><rdf:Bag><rdf:li rdf:parseType="Resource">' +
    '<pdfaSchema:schema>Factur-X PDFA Extension Schema</pdfaSchema:schema>' +
    `<pdfaSchema:namespaceURI>${exports.FACTUR_X_NAMESPACE_URI}</pdfaSchema:namespaceURI>` +
    '<pdfaSchema:prefix>fx</pdfaSchema:prefix>' +
    '<pdfaSchema:property><rdf:Seq>' +
    '<rdf:li rdf:parseType="Resource">' +
    '<pdfaProperty:name>DocumentFileName</pdfaProperty:name>' +
    '<pdfaProperty:valueType>Text</pdfaProperty:valueType>' +
    '<pdfaProperty:category>external</pdfaProperty:category>' +
    '<pdfaProperty:description>name of the embedded XML invoice file</pdfaProperty:description>' +
    '</rdf:li>' +
    '<rdf:li rdf:parseType="Resource">' +
    '<pdfaProperty:name>DocumentType</pdfaProperty:name>' +
    '<pdfaProperty:valueType>Text</pdfaProperty:valueType>' +
    '<pdfaProperty:category>external</pdfaProperty:category>' +
    '<pdfaProperty:description>INVOICE</pdfaProperty:description>' +
    '</rdf:li>' +
    '<rdf:li rdf:parseType="Resource">' +
    '<pdfaProperty:name>Version</pdfaProperty:name>' +
    '<pdfaProperty:valueType>Text</pdfaProperty:valueType>' +
    '<pdfaProperty:category>external</pdfaProperty:category>' +
    '<pdfaProperty:description>The actual version of the Factur-X XML schema</pdfaProperty:description>' +
    '</rdf:li>' +
    '<rdf:li rdf:parseType="Resource">' +
    '<pdfaProperty:name>ConformanceLevel</pdfaProperty:name>' +
    '<pdfaProperty:valueType>Text</pdfaProperty:valueType>' +
    '<pdfaProperty:category>external</pdfaProperty:category>' +
    '<pdfaProperty:description>The conformance level of the embedded Factur-X data</pdfaProperty:description>' +
    '</rdf:li>' +
    '</rdf:Seq></pdfaSchema:property>' +
    '</rdf:li></rdf:Bag></pdfaExtension:schemas>' +
    '</rdf:Description>';
/**
 * Build the `fx:` `rdf:Description` fragment for Factur-X / ZUGFeRD XMP.
 */
const buildFacturXDescription = (options) => `<rdf:Description rdf:about="" xmlns:fx="${exports.FACTUR_X_NAMESPACE_URI}">` +
    `<fx:DocumentType>${(0, html_entities_1.encode)(options.documentType)}</fx:DocumentType>` +
    `<fx:DocumentFileName>${(0, html_entities_1.encode)(options.fileName)}</fx:DocumentFileName>` +
    `<fx:Version>${(0, html_entities_1.encode)(options.version)}</fx:Version>` +
    `<fx:ConformanceLevel>${(0, html_entities_1.encode)(canonicalizeFacturXConformanceLevel(options.conformanceLevel))}</fx:ConformanceLevel>` +
    '</rdf:Description>';
exports.buildFacturXDescription = buildFacturXDescription;
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
const embedFacturX = (pdfDoc_1, invoiceXml_1, ...args_1) => tslib_1.__awaiter(void 0, [pdfDoc_1, invoiceXml_1, ...args_1], void 0, function* (pdfDoc, invoiceXml, options = {}) {
    (0, utils_1.assertIs)(pdfDoc, 'pdfDoc', [[PDFDocument_1.default, 'PDFDocument']]);
    (0, utils_1.assertIs)(invoiceXml, 'invoiceXml', [
        'string',
        ArrayBuffer,
        'ArrayBufferView',
    ]);
    (0, utils_1.assertOrUndefined)(options.fileName, 'options.fileName', ['string']);
    (0, utils_1.assertOrUndefined)(options.version, 'options.version', ['string']);
    (0, utils_1.assertOrUndefined)(options.documentType, 'options.documentType', ['string']);
    (0, utils_1.assertIsOneOfOrUndefined)(options.conformanceLevel, 'options.conformanceLevel', FACTUR_X_CONFORMANCE_LEVELS);
    (0, utils_1.assertOrUndefined)(options.description, 'options.description', ['string']);
    (0, utils_1.assertIsOneOfOrUndefined)(options.afRelationship, 'options.afRelationship', FileEmbedder_1.AFRelationship);
    (0, utils_1.assertOrUndefined)(options.creationDate, 'options.creationDate', [Date]);
    (0, utils_1.assertOrUndefined)(options.modificationDate, 'options.modificationDate', [
        Date,
    ]);
    const { fileName = 'factur-x.xml', version = '1.0', documentType = 'INVOICE', conformanceLevel = 'EN 16931', description = 'Factur-X invoice data', afRelationship = FileEmbedder_1.AFRelationship.Alternative, creationDate, modificationDate, } = options;
    const extensions = [
        (0, exports.buildFacturXDescription)({
            fileName,
            version,
            documentType,
            conformanceLevel,
        }),
        exports.FACTUR_X_EXTENSION_SCHEMA,
    ];
    const existing = (0, catalogMetadata_1.readCatalogPDFAConformance)(pdfDoc.catalog);
    pdfDoc.convertToPDFA({
        conformance: (existing === null || existing === void 0 ? void 0 : existing.part) === 3 ? (existing.level === 'U' ? '3U' : '3B') : '3B',
        extensions,
    });
    // Replace any prior attachment with the same name (e.g. re-running the helper).
    pdfDoc.detach(fileName);
    const attachOptions = {
        mimeType: 'text/xml',
        description,
        afRelationship,
        creationDate,
        modificationDate,
    };
    yield pdfDoc.attach((0, utils_1.toUint8Array)(invoiceXml), fileName, attachOptions);
});
exports.embedFacturX = embedFacturX;
//# sourceMappingURL=facturx.js.map