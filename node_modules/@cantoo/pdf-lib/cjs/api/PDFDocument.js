"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tslib_1 = require("tslib");
const node_html_better_parser_1 = require("node-html-better-parser");
const errors_1 = require("./errors");
const PDFEmbeddedPage_1 = tslib_1.__importDefault(require("./PDFEmbeddedPage"));
const PDFFont_1 = tslib_1.__importDefault(require("./PDFFont"));
const PDFImage_1 = tslib_1.__importDefault(require("./PDFImage"));
const PDFPage_1 = tslib_1.__importDefault(require("./PDFPage"));
const PDFForm_1 = tslib_1.__importDefault(require("./form/PDFForm"));
const sizes_1 = require("./sizes");
const core_1 = require("../core");
const PDFDocumentOptions_1 = require("./PDFDocumentOptions");
const PDFRef_1 = tslib_1.__importDefault(require("../core/objects/PDFRef"));
const utils_1 = require("../utils");
const FileEmbedder_1 = tslib_1.__importStar(require("../core/embedders/FileEmbedder"));
const PDFEmbeddedFile_1 = tslib_1.__importDefault(require("./PDFEmbeddedFile"));
const PDFJavaScript_1 = tslib_1.__importDefault(require("./PDFJavaScript"));
const JavaScriptEmbedder_1 = tslib_1.__importDefault(require("../core/embedders/JavaScriptEmbedder"));
const PDFJavaScriptAction_1 = tslib_1.__importDefault(require("./PDFJavaScriptAction"));
const crypto_1 = require("../core/crypto");
const PDFSvg_1 = tslib_1.__importDefault(require("./PDFSvg"));
const PDFSecurity_1 = tslib_1.__importStar(require("../core/security/PDFSecurity"));
const snapshot_1 = require("./snapshot");
const pdfa_1 = require("./pdfa");
const catalogMetadata_1 = require("./pdfa/catalogMetadata");
/**
 * Represents a PDF document.
 */
class PDFDocument {
    /**
     * Load an existing [[PDFDocument]]. The input data can be provided in
     * multiple formats:
     *
     * | Type               | Contents                                               |
     * | ------------------ | ------------------------------------------------------ |
     * | `string`           | A base64 encoded string (or data URI) containing a PDF |
     * | `Uint8Array`       | The raw bytes of a PDF                                 |
     * | `ArrayBuffer`      | The raw bytes of a PDF                                 |
     * | `ArrayBufferView`  | The raw bytes of a PDF (includes Node.js `Buffer`)     |
     *
     * For example:
     * ```js
     * import { PDFDocument } from 'pdf-lib'
     *
     * // pdf=string
     * const base64 =
     *  'JVBERi0xLjcKJYGBgYEKCjUgMCBvYmoKPDwKL0ZpbHRlciAvRmxhdGVEZWNvZGUKL0xlbm' +
     *  'd0aCAxMDQKPj4Kc3RyZWFtCniccwrhMlAAwaJ0Ln2P1Jyy1JLM5ERdc0MjCwUjE4WQNC4Q' +
     *  '6cNlCFZkqGCqYGSqEJLLZWNuYGZiZmbkYuZsZmlmZGRgZmluDCQNzc3NTM2NzdzMXMxMjQ' +
     *  'ztFEKyuEK0uFxDuAAOERdVCmVuZHN0cmVhbQplbmRvYmoKCjYgMCBvYmoKPDwKL0ZpbHRl' +
     *  'ciAvRmxhdGVEZWNvZGUKL1R5cGUgL09ialN0bQovTiA0Ci9GaXJzdCAyMAovTGVuZ3RoID' +
     *  'IxNQo+PgpzdHJlYW0KeJxVj9GqwjAMhu/zFHkBzTo3nCCCiiKIHPEICuJF3cKoSCu2E8/b' +
     *  '20wPIr1p8v9/8kVhgilmGfawX2CGaVrgcAi0/bsy0lrX7IGWpvJ4iJYEN3gEmrrGBlQwGs' +
     *  'HHO9VBX1wNrxAqMX87RBD5xpJuddqwd82tjAHxzV1U5LPgy52DKXWnr1Lheg+j/c/pzGVr' +
     *  'iqV0VlwZPXGPCJjElw/ybkwUmeoWgxesDXGhHJC/D/iikp1Av80ptKU0FdBEe25pPihAM1' +
     *  'u6ytgaaWfs2Hrz35CJT1+EWmAKZW5kc3RyZWFtCmVuZG9iagoKNyAwIG9iago8PAovU2l6' +
     *  'ZSA4Ci9Sb290IDIgMCBSCi9GaWx0ZXIgL0ZsYXRlRGVjb2RlCi9UeXBlIC9YUmVmCi9MZW' +
     *  '5ndGggMzgKL1cgWyAxIDIgMiBdCi9JbmRleCBbIDAgOCBdCj4+CnN0cmVhbQp4nBXEwREA' +
     *  'EBAEsCwz3vrvRmOOyyOoGhZdutHN2MT55fIAVocD+AplbmRzdHJlYW0KZW5kb2JqCgpzdG' +
     *  'FydHhyZWYKNTEwCiUlRU9G'
     *
     * const dataUri = 'data:application/pdf;base64,' + base64
     *
     * const pdfDoc1 = await PDFDocument.load(base64)
     * const pdfDoc2 = await PDFDocument.load(dataUri)
     *
     * // pdf=Uint8Array / Node Buffer
     * import fs from 'fs'
     * const bytes = fs.readFileSync('with_update_sections.pdf')
     * const pdfDoc3 = await PDFDocument.load(bytes)
     *
     * // pdf=ArrayBuffer
     * const url = 'https://pdf-lib.js.org/assets/with_update_sections.pdf'
     * const arrayBuffer = await fetch(url).then(res => res.arrayBuffer())
     * const pdfDoc4 = await PDFDocument.load(arrayBuffer)
     *
     * ```
     *
     * @param pdf The input data containing a PDF document.
     * @param options The options to be used when loading the document.
     * @returns Resolves with a document loaded from the input.
     */
    static load(pdf_1) {
        return tslib_1.__awaiter(this, arguments, void 0, function* (pdf, options = {}) {
            const { ignoreEncryption = false, parseSpeed = PDFDocumentOptions_1.ParseSpeeds.Slow, throwOnInvalidObject = false, warnOnInvalidObjects = false, updateMetadata = true, capNumbers = false, password, forIncrementalUpdate = false, preserveXFA = false, } = options;
            (0, utils_1.assertIs)(pdf, 'pdf', ['string', ArrayBuffer, 'ArrayBufferView']);
            (0, utils_1.assertIs)(ignoreEncryption, 'ignoreEncryption', ['boolean']);
            (0, utils_1.assertIs)(parseSpeed, 'parseSpeed', ['number']);
            (0, utils_1.assertIs)(throwOnInvalidObject, 'throwOnInvalidObject', ['boolean']);
            (0, utils_1.assertIs)(warnOnInvalidObjects, 'warnOnInvalidObjects', ['boolean']);
            (0, utils_1.assertIs)(password, 'password', ['string', 'undefined']);
            (0, utils_1.assertIs)(forIncrementalUpdate, 'forIncrementalUpdate', ['boolean']);
            const bytes = (0, utils_1.toUint8Array)(pdf);
            const context = yield core_1.PDFParser.forBytesWithOptions(bytes, parseSpeed, throwOnInvalidObject, undefined, capNumbers, undefined, forIncrementalUpdate).parseDocument();
            if (!!context.lookup(context.trailerInfo.Encrypt) &&
                password !== undefined) {
                // Decrypt
                const fileIds = context.lookup(context.trailerInfo.ID, core_1.PDFArray);
                const encryptDict = context.lookup(context.trailerInfo.Encrypt, core_1.PDFDict);
                const decryptedContext = yield core_1.PDFParser.forBytesWithOptions(bytes, parseSpeed, throwOnInvalidObject, warnOnInvalidObjects, capNumbers, new crypto_1.CipherTransformFactory(encryptDict, fileIds.get(0).asBytes(), password), forIncrementalUpdate).parseDocument();
                const pdfDoc = new PDFDocument(decryptedContext, true, updateMetadata, preserveXFA);
                if (forIncrementalUpdate)
                    pdfDoc.takeSnapshot();
                return pdfDoc;
            }
            else {
                const pdfDoc = new PDFDocument(context, ignoreEncryption, updateMetadata, preserveXFA);
                if (forIncrementalUpdate)
                    pdfDoc.takeSnapshot();
                return pdfDoc;
            }
        });
    }
    /**
     * Create a new [[PDFDocument]].
     * @returns Resolves with the newly created document.
     */
    static create() {
        return tslib_1.__awaiter(this, arguments, void 0, function* (options = {}) {
            const { updateMetadata = true } = options;
            const context = core_1.PDFContext.create();
            const pageTree = core_1.PDFPageTree.withContext(context);
            const pageTreeRef = context.register(pageTree);
            const catalog = core_1.PDFCatalog.withContextAndPages(context, pageTreeRef);
            context.trailerInfo.Root = context.register(catalog);
            return new PDFDocument(context, false, updateMetadata);
        });
    }
    constructor(context, ignoreEncryption, updateMetadata, preserveXFA = false) {
        /** The default word breaks used in PDFPage.drawText */
        this.defaultWordBreaks = [' '];
        /**
         * When true, [[prepareForSave]] regenerates owned Info/`pdfaid` XMP.
         * Set by [[convertToPDFA]]. Part/level itself lives only in catalog XMP.
         */
        this.managePDFAMetadata = false;
        this.computePages = () => {
            const pages = [];
            this.catalog.Pages().traverse((node, ref) => {
                if (node instanceof core_1.PDFPageLeaf) {
                    let page = this.pageMap.get(node);
                    if (!page) {
                        page = PDFPage_1.default.of(node, ref, this);
                        this.pageMap.set(node, page);
                    }
                    pages.push(page);
                }
            });
            return pages;
        };
        this.getOrCreateForm = () => {
            const acroForm = this.catalog.getOrCreateAcroForm();
            return PDFForm_1.default.of(acroForm, this);
        };
        (0, utils_1.assertIs)(context, 'context', [[core_1.PDFContext, 'PDFContext']]);
        (0, utils_1.assertIs)(ignoreEncryption, 'ignoreEncryption', ['boolean']);
        (0, utils_1.assertIs)(preserveXFA, 'preserveXFA', ['boolean']);
        this.context = context;
        this.catalog = context.lookup(context.trailerInfo.Root);
        if (!!context.lookup(context.trailerInfo.Encrypt) && context.isDecrypted) {
            // context.delete(context.trailerInfo.Encrypt);
            delete context.trailerInfo.Encrypt;
        }
        this.isEncrypted = !!context.lookup(context.trailerInfo.Encrypt);
        this.pageCache = utils_1.Cache.populatedBy(this.computePages);
        this.pageMap = new Map();
        this.formCache = utils_1.Cache.populatedBy(this.getOrCreateForm);
        this.fonts = [];
        this.images = [];
        this.embeddedPages = [];
        this.embeddedFiles = [];
        this.javaScripts = [];
        this.preserveXFA = preserveXFA;
        if (!ignoreEncryption && this.isEncrypted)
            throw new errors_1.EncryptedPDFError();
        if (updateMetadata)
            this.updateInfoDict();
    }
    /**
     * Register a fontkit instance. This must be done before custom fonts can
     * be embedded. See [here](https://github.com/Hopding/pdf-lib/tree/master#fontkit-installation)
     * for instructions on how to install and register a fontkit instance.
     *
     * > You do **not** need to call this method to embed standard fonts.
     *
     * For example:
     * ```js
     * import { PDFDocument } from 'pdf-lib'
     * import fontkit from '@cantoo/fontkit'
     *
     * const pdfDoc = await PDFDocument.create()
     * pdfDoc.registerFontkit(fontkit)
     * ```
     *
     * @param fontkit The fontkit instance to be registered.
     */
    registerFontkit(fontkit) {
        this.fontkit = fontkit;
    }
    /**
     * Get the [[PDFForm]] containing all interactive fields for this document.
     * For example:
     * ```js
     * const form = pdfDoc.getForm()
     * const fields = form.getFields()
     * fields.forEach(field => {
     *   const type = field.constructor.name
     *   const name = field.getName()
     *   console.log(`${type}: ${name}`)
     * })
     * ```
     *
     * **XFA caveat:** if the document contains XFA form data and it was **not**
     * loaded with `preserveXFA: true`, calling this method strips the XFA data
     * (pdf-lib cannot render or edit XFA and removes it to keep the AcroForm
     * consistent). Because the XFA read/write helpers ([[getXFAJavaScripts]],
     * [[setXFAJavaScript]]) operate on that same data, call them **before**
     * `getForm()` — or load with `preserveXFA: true`
     * otherwise the XFA will already be gone.
     *
     * @returns The form for this document.
     */
    getForm() {
        const form = this.formCache.access();
        if (form.hasXFA() && !this.preserveXFA) {
            console.warn('Removing XFA form data as pdf-lib does not support reading or writing XFA. Set preserveXFA: true in load options to keep XFA data.');
            form.deleteXFA();
        }
        return form;
    }
    /**
     * List this document's optional content groups (PDF "layers"), if any.
     * Visibility reflects the default configuration (`/OCProperties` `/D`).
     * Returns an empty array when the document has no `/OCProperties`.
     *
     * For example:
     * ```js
     * const layers = pdfDoc.getOptionalContentGroups()
     * layers.forEach((layer) => console.log(layer.name, layer.visible))
     * ```
     */
    getOptionalContentGroups() {
        var _a, _b;
        return (_b = (_a = this.catalog.getOCProperties()) === null || _a === void 0 ? void 0 : _a.getGroups()) !== null && _b !== void 0 ? _b : [];
    }
    setOptionalContentGroupVisibility(nameOrRefOrUpdates, visible) {
        const ocProperties = this.catalog.getOCProperties();
        if (!ocProperties) {
            throw new Error('This document has no optional content properties');
        }
        const updates = Array.isArray(nameOrRefOrUpdates)
            ? nameOrRefOrUpdates
            : [
                nameOrRefOrUpdates instanceof PDFRef_1.default
                    ? { ref: nameOrRefOrUpdates, visible: visible }
                    : { name: nameOrRefOrUpdates, visible: visible },
            ];
        ocProperties.setVisibility(updates);
    }
    /**
     * Get this document's title metadata. The title appears in the
     * "Document Properties" section of most PDF readers. For example:
     * ```js
     * const title = pdfDoc.getTitle()
     * ```
     * @returns A string containing the title of this document, if it has one.
     */
    getTitle() {
        const title = this.getInfoDict().lookup(core_1.PDFName.Title);
        if (!title)
            return undefined;
        assertIsLiteralOrHexString(title);
        return title.decodeText();
    }
    /**
     * Get this document's author metadata. The author appears in the
     * "Document Properties" section of most PDF readers. For example:
     * ```js
     * const author = pdfDoc.getAuthor()
     * ```
     * @returns A string containing the author of this document, if it has one.
     */
    getAuthor() {
        const author = this.getInfoDict().lookup(core_1.PDFName.Author);
        if (!author)
            return undefined;
        assertIsLiteralOrHexString(author);
        return author.decodeText();
    }
    /**
     * Get this document's subject metadata. The subject appears in the
     * "Document Properties" section of most PDF readers. For example:
     * ```js
     * const subject = pdfDoc.getSubject()
     * ```
     * @returns A string containing the subject of this document, if it has one.
     */
    getSubject() {
        const subject = this.getInfoDict().lookup(core_1.PDFName.Subject);
        if (!subject)
            return undefined;
        assertIsLiteralOrHexString(subject);
        return subject.decodeText();
    }
    /**
     * Get this document's keywords metadata. The keywords appear in the
     * "Document Properties" section of most PDF readers. For example:
     * ```js
     * const keywords = pdfDoc.getKeywords()
     * ```
     * @returns A string containing the keywords of this document, if it has any.
     */
    getKeywords() {
        const keywords = this.getInfoDict().lookup(core_1.PDFName.Keywords);
        if (!keywords)
            return undefined;
        assertIsLiteralOrHexString(keywords);
        return keywords.decodeText();
    }
    /**
     * Get this document's creator metadata. The creator appears in the
     * "Document Properties" section of most PDF readers. For example:
     * ```js
     * const creator = pdfDoc.getCreator()
     * ```
     * @returns A string containing the creator of this document, if it has one.
     */
    getCreator() {
        const creator = this.getInfoDict().lookup(core_1.PDFName.Creator);
        if (!creator)
            return undefined;
        assertIsLiteralOrHexString(creator);
        return creator.decodeText();
    }
    /**
     * Get this document's producer metadata. The producer appears in the
     * "Document Properties" section of most PDF readers. For example:
     * ```js
     * const producer = pdfDoc.getProducer()
     * ```
     * @returns A string containing the producer of this document, if it has one.
     */
    getProducer() {
        const producer = this.getInfoDict().lookup(core_1.PDFName.Producer);
        if (!producer)
            return undefined;
        assertIsLiteralOrHexString(producer);
        return producer.decodeText();
    }
    /**
     * Get this document's language metadata. The language appears in the
     * "Document Properties" section of most PDF readers. For example:
     * ```js
     * const language = pdfDoc.getLanguage()
     * ```
     * @returns A string containing the RFC 3066 _Language-Tag_ of this document,
     *          if it has one.
     */
    getLanguage() {
        const language = this.catalog.get(core_1.PDFName.of('Lang'));
        if (!language)
            return undefined;
        assertIsLiteralOrHexString(language);
        return language.decodeText();
    }
    /**
     * Get this document's creation date metadata. The creation date appears in
     * the "Document Properties" section of most PDF readers. For example:
     * ```js
     * const creationDate = pdfDoc.getCreationDate()
     * ```
     * @returns A Date containing the creation date of this document,
     *          if it has one.
     */
    getCreationDate() {
        const creationDate = this.getInfoDict().lookup(core_1.PDFName.CreationDate);
        if (!creationDate)
            return undefined;
        assertIsLiteralOrHexString(creationDate);
        return creationDate.decodeDate();
    }
    /**
     * Get this document's modification date metadata. The modification date
     * appears in the "Document Properties" section of most PDF readers.
     * For example:
     * ```js
     * const modification = pdfDoc.getModificationDate()
     * ```
     * @returns A Date containing the modification date of this document,
     *          if it has one.
     */
    getModificationDate() {
        const modificationDate = this.getInfoDict().lookup(core_1.PDFName.ModDate);
        if (!modificationDate)
            return undefined;
        assertIsLiteralOrHexString(modificationDate);
        return modificationDate.decodeDate();
    }
    /**
     * Set this document's title metadata. The title will appear in the
     * "Document Properties" section of most PDF readers. For example:
     * ```js
     * pdfDoc.setTitle('🥚 The Life of an Egg 🍳')
     * ```
     *
     * To display the title in the window's title bar, set the
     * `showInWindowTitleBar` option to `true` (works for _most_ PDF readers).
     * For example:
     * ```js
     * pdfDoc.setTitle('🥚 The Life of an Egg 🍳', { showInWindowTitleBar: true })
     * ```
     *
     * @param title The title of this document.
     * @param options The options to be used when setting the title.
     */
    setTitle(title, options) {
        (0, utils_1.assertIs)(title, 'title', ['string']);
        const key = core_1.PDFName.of('Title');
        this.getInfoDict().set(key, core_1.PDFHexString.fromText(title));
        // Indicate that readers should display the title rather than the filename
        if (options === null || options === void 0 ? void 0 : options.showInWindowTitleBar) {
            const prefs = this.catalog.getOrCreateViewerPreferences();
            prefs.setDisplayDocTitle(true);
        }
    }
    /**
     * Set this document's author metadata. The author will appear in the
     * "Document Properties" section of most PDF readers. For example:
     * ```js
     * pdfDoc.setAuthor('Humpty Dumpty')
     * ```
     * @param author The author of this document.
     */
    setAuthor(author) {
        (0, utils_1.assertIs)(author, 'author', ['string']);
        const key = core_1.PDFName.of('Author');
        this.getInfoDict().set(key, core_1.PDFHexString.fromText(author));
    }
    /**
     * Set this document's subject metadata. The subject will appear in the
     * "Document Properties" section of most PDF readers. For example:
     * ```js
     * pdfDoc.setSubject('📘 An Epic Tale of Woe 📖')
     * ```
     * @param subject The subject of this document.
     */
    setSubject(subject) {
        (0, utils_1.assertIs)(subject, 'author', ['string']);
        const key = core_1.PDFName.of('Subject');
        this.getInfoDict().set(key, core_1.PDFHexString.fromText(subject));
    }
    /**
     * Set this document's keyword metadata. These keywords will appear in the
     * "Document Properties" section of most PDF readers. For example:
     * ```js
     * pdfDoc.setKeywords(['eggs', 'wall', 'fall', 'king', 'horses', 'men'])
     * ```
     * @param keywords An array of keywords associated with this document.
     */
    setKeywords(keywords) {
        (0, utils_1.assertIs)(keywords, 'keywords', [Array]);
        const key = core_1.PDFName.of('Keywords');
        this.getInfoDict().set(key, core_1.PDFHexString.fromText(keywords.join(' ')));
    }
    /**
     * Set this document's creator metadata. The creator will appear in the
     * "Document Properties" section of most PDF readers. For example:
     * ```js
     * pdfDoc.setCreator('PDF App 9000 🤖')
     * ```
     * @param creator The creator of this document.
     */
    setCreator(creator) {
        (0, utils_1.assertIs)(creator, 'creator', ['string']);
        const key = core_1.PDFName.of('Creator');
        this.getInfoDict().set(key, core_1.PDFHexString.fromText(creator));
    }
    /**
     * Set this document's producer metadata. The producer will appear in the
     * "Document Properties" section of most PDF readers. For example:
     * ```js
     * pdfDoc.setProducer('PDF App 9000 🤖')
     * ```
     * @param producer The producer of this document.
     */
    setProducer(producer) {
        (0, utils_1.assertIs)(producer, 'creator', ['string']);
        const key = core_1.PDFName.of('Producer');
        this.getInfoDict().set(key, core_1.PDFHexString.fromText(producer));
    }
    /**
     * Set this document's language metadata. The language will appear in the
     * "Document Properties" section of some PDF readers. For example:
     * ```js
     * pdfDoc.setLanguage('en-us')
     * ```
     *
     * @param language An RFC 3066 _Language-Tag_ denoting the language of this
     *                 document, or an empty string if the language is unknown.
     */
    setLanguage(language) {
        (0, utils_1.assertIs)(language, 'language', ['string']);
        const key = core_1.PDFName.of('Lang');
        this.catalog.set(key, core_1.PDFString.of(language));
    }
    /**
     * Set this document's creation date metadata. The creation date will appear
     * in the "Document Properties" section of most PDF readers. For example:
     * ```js
     * pdfDoc.setCreationDate(new Date())
     * ```
     * @param creationDate The date this document was created.
     */
    setCreationDate(creationDate) {
        (0, utils_1.assertIs)(creationDate, 'creationDate', [[Date, 'Date']]);
        const key = core_1.PDFName.of('CreationDate');
        this.getInfoDict().set(key, core_1.PDFString.fromDate(creationDate));
    }
    /**
     * Set this document's modification date metadata. The modification date will
     * appear in the "Document Properties" section of most PDF readers. For
     * example:
     * ```js
     * pdfDoc.setModificationDate(new Date())
     * ```
     * @param modificationDate The date this document was last modified.
     */
    setModificationDate(modificationDate) {
        (0, utils_1.assertIs)(modificationDate, 'modificationDate', [[Date, 'Date']]);
        const key = core_1.PDFName.of('ModDate');
        this.getInfoDict().set(key, core_1.PDFString.fromDate(modificationDate));
    }
    /**
     * Convert this document into a PDF/A compliant document. PDF/A is an
     * ISO-standardized subset of PDF designed for the long-term archiving of
     * electronic documents. This method performs the structural changes that a
     * PDF/A file requires:
     *
     * * A unique document identifier (`/ID`) is added to the trailer.
     * * An `OutputIntent` referencing an embedded ICC color profile is added (the
     *   bundled sRGB profile is used by default).
     * * An XMP metadata packet identifying the PDF/A conformance level is added
     *   and kept consistent with the document information dictionary.
     * * The PDF header version is set appropriately for the targeted part.
     *
     * For example:
     * ```js
     * const pdfDoc = await PDFDocument.load(existingPdfBytes)
     * pdfDoc.convertToPDFA({ conformance: '3B' })
     * const pdfBytes = await pdfDoc.save()
     * ```
     *
     * > **This method does not, and cannot, guarantee full PDF/A compliance on
     * > its own.** PDF/A also forbids certain content (encryption, non-embedded
     * > fonts, transparency for part 1, JavaScript, external references, etc.).
     * > In particular, any text you draw must use an **embedded** font — the
     * > 14 standard fonts are not embedded and are therefore not PDF/A compliant.
     * > You are responsible for ensuring the document's content conforms. Validate
     * > the result with a tool such as [veraPDF](https://verapdf.org/).
     *
     * > **Unicode conformance (`'2U'` / `'3U'`) is not verified.** The `U` levels
     * > additionally require every glyph in the document to have a Unicode
     * > mapping (a `ToUnicode` CMap or equivalent). This method writes the
     * > requested conformance level into the metadata but does **not** inspect
     * > existing content to confirm the mappings are present — ensuring that is
     * > the caller's responsibility.
     *
     * > **XMP is refreshed on save.** After conversion, pdf-lib *manages* the
     * > catalog `/Metadata` stream. On [[save]] / [[saveIncremental]] /
     * > [[saveAsBase64]] it rebuilds the owned slice (Info-dict mirrors +
     * > `pdfaid`) so Info and XMP stay equivalent as required by PDF/A, while
     * > preserving foreign `rdf:Description` blocks (e.g. Factur-X / custom
     * > schemas). Pass one-shot extras via `options.extensions`; they are written
     * > into the initial packet and then preserved like any other foreign block.
     *
     * > **Ownership contract.** After this method runs, pdf-lib owns the `dc`,
     * > `xmp`, `pdf`, and `pdfaid` schemas. Add extra XMP with
     * > `options.extensions` or by merging foreign `rdf:Description` elements
     * > into the packet — those are preserved on sync. Hand-editing owned fields
     * > in the XMP (e.g. `dc:title`) without going through the Info setters will
     * > be overwritten.
     *
     * @param options The options to be used when converting the document.
     */
    convertToPDFA(options = {}) {
        (0, utils_1.assertOrUndefined)(options.conformance, 'options.conformance', ['string']);
        (0, utils_1.assertOrUndefined)(options.iccProfile, 'options.iccProfile', [Uint8Array]);
        (0, utils_1.assertOrUndefined)(options.outputConditionIdentifier, 'options.outputConditionIdentifier', ['string']);
        (0, utils_1.assertIsOneOfOrUndefined)(options.colorComponents, 'options.colorComponents', [1, 3, 4]);
        (0, utils_1.assertOrUndefined)(options.extensions, 'options.extensions', [Array]);
        const { conformance = '3B', iccProfile = (0, pdfa_1.getDefaultSRGBProfile)(), outputConditionIdentifier = 'sRGB IEC61966-2.1', colorComponents = 3, extensions, } = options;
        const parsed = (0, pdfa_1.parseConformance)(conformance);
        if (this.isEncrypted) {
            throw new Error('PDF/A documents must not be encrypted.');
        }
        const alreadyConverted = (0, catalogMetadata_1.readCatalogPDFAConformance)(this.catalog) !== undefined;
        // PDF/A-1 is based on PDF 1.4; parts 2 and 3 are based on PDF 1.7.
        this.context.header = core_1.PDFHeader.forVersion(1, parsed.part === 1 ? 4 : 7);
        // A file identifier (`/ID`) is required by PDF/A. Reuse an existing one if
        // present so incremental updates and encryption stay consistent with the
        // previously assigned identity.
        if (!this.context.lookup(this.context.trailerInfo.ID)) {
            const id = core_1.PDFHexString.fromBytes((0, PDFSecurity_1.generateRandomFileId)());
            this.context.trailerInfo.ID = this.context.obj([id, id]);
        }
        // Only (re)install the OutputIntent on first conversion, or when the caller
        // supplies a custom ICC profile / condition — avoids orphaning ICC streams
        // on repeated convertToPDFA / embedFacturX calls.
        const shouldUpdateOutputIntent = !alreadyConverted ||
            options.iccProfile !== undefined ||
            options.outputConditionIdentifier !== undefined ||
            options.colorComponents !== undefined;
        if (shouldUpdateOutputIntent) {
            // PDF/A permits FlateDecode on ICC streams; the XMP packet stays
            // unfiltered in writeCatalogMetadataXml.
            const iccStream = this.context.flateStream(iccProfile, {
                N: colorComponents,
            });
            const outputIntent = this.context.obj({
                Type: 'OutputIntent',
                S: 'GTS_PDFA1',
                OutputConditionIdentifier: core_1.PDFString.of(outputConditionIdentifier),
                DestOutputProfile: this.context.register(iccStream),
            });
            this.catalog.set(core_1.PDFName.of('OutputIntents'), this.context.obj([this.context.register(outputIntent)]));
        }
        // Opt into Info↔XMP sync on later saves; write `pdfaid` into catalog XMP
        // (the single source of truth for part/level).
        this.managePDFAMetadata = true;
        this.syncPDFAMetadata(extensions, parsed);
    }
    /**
     * Get the number of pages contained in this document. For example:
     * ```js
     * const totalPages = pdfDoc.getPageCount()
     * ```
     * @returns The number of pages in this document.
     */
    getPageCount() {
        if (this.pageCount === undefined)
            this.pageCount = this.getPages().length;
        return this.pageCount;
    }
    /**
     * Get an array of all the pages contained in this document. The pages are
     * stored in the array in the same order that they are rendered in the
     * document. For example:
     * ```js
     * const pages = pdfDoc.getPages()
     * pages[0]   // The first page of the document
     * pages[2]   // The third page of the document
     * pages[197] // The 198th page of the document
     * ```
     * @returns An array of all the pages contained in this document.
     */
    getPages() {
        return this.pageCache.access();
    }
    /**
     * Get the page rendered at a particular `index` of the document. For example:
     * ```js
     * pdfDoc.getPage(0)   // The first page of the document
     * pdfDoc.getPage(2)   // The third page of the document
     * pdfDoc.getPage(197) // The 198th page of the document
     * ```
     * @returns The [[PDFPage]] rendered at the given `index` of the document.
     */
    getPage(index) {
        const pages = this.getPages();
        (0, utils_1.assertRange)(index, 'index', 0, pages.length - 1);
        return pages[index];
    }
    /**
     * Get an array of indices for all the pages contained in this document. The
     * array will contain a range of integers from
     * `0..pdfDoc.getPageCount() - 1`. For example:
     * ```js
     * const pdfDoc = await PDFDocument.create()
     * pdfDoc.addPage()
     * pdfDoc.addPage()
     * pdfDoc.addPage()
     *
     * const indices = pdfDoc.getPageIndices()
     * indices // => [0, 1, 2]
     * ```
     * @returns An array of indices for all pages contained in this document.
     */
    getPageIndices() {
        return (0, utils_1.range)(0, this.getPageCount());
    }
    /**
     * Remove the page at a given index from this document. For example:
     * ```js
     * pdfDoc.removePage(0)   // Remove the first page of the document
     * pdfDoc.removePage(2)   // Remove the third page of the document
     * pdfDoc.removePage(197) // Remove the 198th page of the document
     * ```
     * Once a page has been removed, it will no longer be rendered at that index
     * in the document.
     * @param index The index of the page to be removed.
     */
    removePage(index) {
        const pageCount = this.getPageCount();
        if (this.pageCount === 0)
            throw new errors_1.RemovePageFromEmptyDocumentError();
        (0, utils_1.assertRange)(index, 'index', 0, pageCount - 1);
        const page = this.getPage(index);
        this.catalog.removeLeafNode(index);
        this.pageCount = pageCount - 1;
        this.context.delete(page.ref);
        this.pageCache.invalidate();
    }
    /**
     * Add a page to the end of this document. This method accepts three
     * different value types for the `page` parameter:
     *
     * | Type               | Behavior                                                                            |
     * | ------------------ | ----------------------------------------------------------------------------------- |
     * | `undefined`        | Create a new page and add it to the end of this document                            |
     * | `[number, number]` | Create a new page with the given dimensions and add it to the end of this document  |
     * | `PDFPage`          | Add the existing page to the end of this document                                   |
     *
     * For example:
     * ```js
     * // page=undefined
     * const newPage = pdfDoc.addPage()
     *
     * // page=[number, number]
     * import { PageSizes } from 'pdf-lib'
     * const newPage1 = pdfDoc.addPage(PageSizes.A7)
     * const newPage2 = pdfDoc.addPage(PageSizes.Letter)
     * const newPage3 = pdfDoc.addPage([500, 750])
     *
     * // page=PDFPage
     * const pdfDoc1 = await PDFDocument.create()
     * const pdfDoc2 = await PDFDocument.load(...)
     * const [existingPage] = await pdfDoc1.copyPages(pdfDoc2, [0])
     * pdfDoc1.addPage(existingPage)
     * ```
     *
     * @param page Optionally, the desired dimensions or existing page.
     * @returns The newly created (or existing) page.
     */
    addPage(page) {
        (0, utils_1.assertIs)(page, 'page', ['undefined', [PDFPage_1.default, 'PDFPage'], Array]);
        return this.insertPage(this.getPageCount(), page);
    }
    /**
     * Insert a page at a given index within this document. This method accepts
     * three different value types for the `page` parameter:
     *
     * | Type               | Behavior                                                                       |
     * | ------------------ | ------------------------------------------------------------------------------ |
     * | `undefined`        | Create a new page and insert it into this document                             |
     * | `[number, number]` | Create a new page with the given dimensions and insert it into this document   |
     * | `PDFPage`          | Insert the existing page into this document                                    |
     *
     * For example:
     * ```js
     * // page=undefined
     * const newPage = pdfDoc.insertPage(2)
     *
     * // page=[number, number]
     * import { PageSizes } from 'pdf-lib'
     * const newPage1 = pdfDoc.insertPage(2, PageSizes.A7)
     * const newPage2 = pdfDoc.insertPage(0, PageSizes.Letter)
     * const newPage3 = pdfDoc.insertPage(198, [500, 750])
     *
     * // page=PDFPage
     * const pdfDoc1 = await PDFDocument.create()
     * const pdfDoc2 = await PDFDocument.load(...)
     * const [existingPage] = await pdfDoc1.copyPages(pdfDoc2, [0])
     * pdfDoc1.insertPage(0, existingPage)
     * ```
     *
     * @param index The index at which the page should be inserted (zero-based).
     * @param page Optionally, the desired dimensions or existing page.
     * @returns The newly created (or existing) page.
     */
    insertPage(index, page) {
        const pageCount = this.getPageCount();
        (0, utils_1.assertRange)(index, 'index', 0, pageCount);
        (0, utils_1.assertIs)(page, 'page', ['undefined', [PDFPage_1.default, 'PDFPage'], Array]);
        if (!page || Array.isArray(page)) {
            const dims = Array.isArray(page) ? page : sizes_1.PageSizes.A4;
            page = PDFPage_1.default.create(this);
            page.setSize(...dims);
        }
        else if (page.doc !== this) {
            throw new errors_1.ForeignPageError();
        }
        const parentRef = this.catalog.insertLeafNode(page.ref, index);
        page.node.setParent(parentRef);
        this.pageMap.set(page.node, page);
        this.pageCache.invalidate();
        this.pageCount = pageCount + 1;
        return page;
    }
    /**
     * Copy pages from a source document into this document. Allows pages to be
     * copied between different [[PDFDocument]] instances. For example:
     * ```js
     * const pdfDoc = await PDFDocument.create()
     * const srcDoc = await PDFDocument.load(...)
     *
     * const copiedPages = await pdfDoc.copyPages(srcDoc, [0, 3, 89])
     * const [firstPage, fourthPage, ninetiethPage] = copiedPages;
     *
     * pdfDoc.addPage(fourthPage)
     * pdfDoc.insertPage(0, ninetiethPage)
     * pdfDoc.addPage(firstPage)
     * ```
     * @param srcDoc The document from which pages should be copied.
     * @param indices The indices of the pages that should be copied.
     * @returns Resolves with an array of pages copied into this document.
     */
    copyPages(srcDoc, indices) {
        return tslib_1.__awaiter(this, void 0, void 0, function* () {
            (0, utils_1.assertIs)(srcDoc, 'srcDoc', [[PDFDocument, 'PDFDocument']]);
            (0, utils_1.assertIs)(indices, 'indices', [Array]);
            yield srcDoc.flush();
            const copier = core_1.PDFObjectCopier.for(srcDoc.context, this.context);
            const srcPages = srcDoc.getPages();
            // Copy each page in a separate thread
            const copiedPages = indices
                .map((i) => srcPages[i])
                .map((page) => tslib_1.__awaiter(this, void 0, void 0, function* () { return copier.copy(page.node); }))
                .map((p) => p.then((copy) => PDFPage_1.default.of(copy, this.context.register(copy), this)));
            return Promise.all(copiedPages);
        });
    }
    /**
     * Get a copy of this document.
     *
     * For example:
     * ```js
     * const srcDoc = await PDFDocument.load(...)
     * const pdfDoc = await srcDoc.copy()
     * ```
     *
     * > **NOTE:**  This method won't copy all information over to the new
     * > document (acroforms, outlines, etc...).
     *
     * @returns Resolves with a copy this document.
     */
    copy() {
        return tslib_1.__awaiter(this, void 0, void 0, function* () {
            const pdfCopy = yield PDFDocument.create();
            const contentPages = yield pdfCopy.copyPages(this, this.getPageIndices());
            for (let idx = 0, len = contentPages.length; idx < len; idx++) {
                pdfCopy.addPage(contentPages[idx]);
            }
            if (this.getAuthor() !== undefined) {
                pdfCopy.setAuthor(this.getAuthor());
            }
            if (this.getCreationDate() !== undefined) {
                pdfCopy.setCreationDate(this.getCreationDate());
            }
            if (this.getCreator() !== undefined) {
                pdfCopy.setCreator(this.getCreator());
            }
            if (this.getLanguage() !== undefined) {
                pdfCopy.setLanguage(this.getLanguage());
            }
            if (this.getModificationDate() !== undefined) {
                pdfCopy.setModificationDate(this.getModificationDate());
            }
            if (this.getProducer() !== undefined) {
                pdfCopy.setProducer(this.getProducer());
            }
            if (this.getSubject() !== undefined) {
                pdfCopy.setSubject(this.getSubject());
            }
            if (this.getTitle() !== undefined) {
                pdfCopy.setTitle(this.getTitle());
            }
            pdfCopy.defaultWordBreaks = this.defaultWordBreaks;
            return pdfCopy;
        });
    }
    /**
     * Add JavaScript to this document. The supplied `script` is executed when the
     * document is opened. The `script` can be used to perform some operation
     * when the document is opened (e.g. logging to the console), or it can be
     * used to define a function that can be referenced later in a JavaScript
     * action. For example:
     * ```js
     * // Show "Hello World!" in the console when the PDF is opened
     * pdfDoc.addJavaScript(
     *   'main',
     *   'console.show(); console.println("Hello World!");'
     * );
     *
     * // Define a function named "foo" that can be called in JavaScript Actions
     * pdfDoc.addJavaScript(
     *   'foo',
     *   'function foo() { return "foo"; }'
     * );
     * ```
     * See the [JavaScript for Acrobat API Reference](https://www.adobe.com/content/dam/acom/en/devnet/acrobat/pdfs/js_api_reference.pdf)
     * for details.
     * @param name The name of the script. Must be unique per document.
     * @param script The JavaScript to execute.
     */
    addJavaScript(name, script) {
        (0, utils_1.assertIs)(name, 'name', ['string']);
        (0, utils_1.assertIs)(script, 'script', ['string']);
        const embedder = JavaScriptEmbedder_1.default.for(script, name);
        const ref = this.context.nextRef();
        const javaScript = PDFJavaScript_1.default.of(ref, this, embedder);
        this.javaScripts.push(javaScript);
    }
    /**
     * Get all document-level JavaScript scripts from the document's Names dictionary.
     * These scripts are executed when the document is opened.
     * For example:
     * ```js
     * const scripts = pdfDoc.getDocumentJavaScripts()
     * scripts.forEach(({ name, script }) => {
     *   console.log(`Script "${name}":`, script)
     * })
     * ```
     * @returns An array of objects containing script names and their JavaScript code.
     */
    getDocumentJavaScripts() {
        var _a;
        const scripts = [];
        const namesDict = this.catalog.lookupMaybe(core_1.PDFName.of('Names'), core_1.PDFDict);
        const javascriptDict = namesDict === null || namesDict === void 0 ? void 0 : namesDict.lookupMaybe(core_1.PDFName.of('JavaScript'), core_1.PDFDict);
        const jsNames = javascriptDict === null || javascriptDict === void 0 ? void 0 : javascriptDict.lookupMaybe(core_1.PDFName.of('Names'), core_1.PDFArray);
        if (!jsNames)
            return scripts;
        // Names array is a flat array of [name1, dict1, name2, dict2, ...]
        for (let idx = 0; idx < jsNames.size(); idx += 2) {
            const nameObj = jsNames.get(idx);
            const actionObj = jsNames.get(idx + 1);
            if (!nameObj || !actionObj)
                continue;
            let name;
            if (nameObj instanceof core_1.PDFString) {
                name = nameObj.asString();
            }
            else if (nameObj instanceof core_1.PDFHexString) {
                name = nameObj.decodeText();
            }
            else {
                continue;
            }
            const actionDict = actionObj instanceof PDFRef_1.default
                ? this.context.lookupMaybe(actionObj, core_1.PDFDict)
                : actionObj instanceof core_1.PDFDict
                    ? actionObj
                    : undefined;
            if (!actionDict)
                continue;
            const script = (_a = PDFJavaScriptAction_1.default.of(actionDict, this, actionObj instanceof PDFRef_1.default ? actionObj : undefined)) === null || _a === void 0 ? void 0 : _a.getScript();
            if (!script)
                continue;
            scripts.push({ name, script });
        }
        return scripts;
    }
    /**
     * Get all JavaScript from XFA form template.
     * XFA forms can contain JavaScript in <script> elements within the template XML.
     * For example:
     * ```js
     * const xfaScripts = pdfDoc.getXFAJavaScripts()
     * xfaScripts.forEach(({ field, event, script }) => {
     *   console.log(`Field "${field}" on ${event}:`, script)
     * })
     * ```
     *
     * **Note:** load the document with `preserveXFA: true` and call this before
     * [[getForm]], which strips XFA data when `preserveXFA` is not set.
     *
     * @returns An array of objects containing field names, events, and JavaScript code.
     */
    getXFAJavaScripts() {
        var _a, _b;
        // Avoid [[getForm]] (strips XFA) and formCache.access() (creates AcroForm).
        return (_b = (_a = this.getExistingForm()) === null || _a === void 0 ? void 0 : _a.getXFAJavaScripts()) !== null && _b !== void 0 ? _b : [];
    }
    /**
     * Modify JavaScript in XFA form template for a specific field and event.
     * For example:
     * ```js
     * pdfDoc.setXFAJavaScript('import', 'event__click', 'console.println("Modified!");')
     * ```
     * @param fieldName The name of the field containing the script
     * @param eventName The name of the event (e.g., 'event__click', 'calculate')
     * @param newScript The new JavaScript code to set
     * @throws Error if the XFA form is not found, the script location is not found, or decoding fails
     *
     * **Note:** load the document with `preserveXFA: true` and call this before
     * [[getForm]], which strips XFA data when `preserveXFA` is not set.
     */
    setXFAJavaScript(fieldName, eventName, newScript) {
        const form = this.getExistingForm();
        if (!form) {
            throw new Error('XFA form not found in document. Ensure the document has XFA forms and was loaded with preserveXFA: true.');
        }
        form.setXFAJavaScript(fieldName, eventName, newScript);
    }
    /**
     * Add an attachment to this document. Attachments are visible in the
     * "Attachments" panel of Adobe Acrobat and some other PDF readers. Any
     * type of file can be added as an attachment. This includes, but is not
     * limited to, `.png`, `.jpg`, `.pdf`, `.csv`, `.docx`, and `.xlsx` files.
     *
     * The input data can be provided in multiple formats:
     *
     * | Type          | Contents                                                       |
     * | ------------- | -------------------------------------------------------------- |
     * | `string`      | A base64 encoded string (or data URI) containing an attachment |
     * | `Uint8Array`  | The raw bytes of an attachment                                 |
     * | `ArrayBuffer` | The raw bytes of an attachment                                 |
     *
     * For example:
     * ```js
     * // attachment=string
     * await pdfDoc.attach('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBD...', 'cat_riding_unicorn.jpg', {
     *   mimeType: 'image/jpeg',
     *   description: 'Cool cat riding a unicorn! 🦄🐈🕶️',
     *   creationDate: new Date('2019/12/01'),
     *   modificationDate: new Date('2020/04/19'),
     * })
     * await pdfDoc.attach('data:image/jpeg;base64,/9j/4AAQ...', 'cat_riding_unicorn.jpg', {
     *   mimeType: 'image/jpeg',
     *   description: 'Cool cat riding a unicorn! 🦄🐈🕶️',
     *   creationDate: new Date('2019/12/01'),
     *   modificationDate: new Date('2020/04/19'),
     * })
     *
     * // attachment=Uint8Array
     * import fs from 'fs'
     * const uint8Array = fs.readFileSync('cat_riding_unicorn.jpg')
     * await pdfDoc.attach(uint8Array, 'cat_riding_unicorn.jpg', {
     *   mimeType: 'image/jpeg',
     *   description: 'Cool cat riding a unicorn! 🦄🐈🕶️',
     *   creationDate: new Date('2019/12/01'),
     *   modificationDate: new Date('2020/04/19'),
     * })
     *
     * // attachment=ArrayBuffer
     * const url = 'https://pdf-lib.js.org/assets/cat_riding_unicorn.jpg'
     * const arrayBuffer = await fetch(url).then(res => res.arrayBuffer())
     * await pdfDoc.attach(arrayBuffer, 'cat_riding_unicorn.jpg', {
     *   mimeType: 'image/jpeg',
     *   description: 'Cool cat riding a unicorn! 🦄🐈🕶️',
     *   creationDate: new Date('2019/12/01'),
     *   modificationDate: new Date('2020/04/19'),
     * })
     * ```
     *
     * @param attachment The input data containing the file to be attached.
     * @param name The name of the file to be attached.
     * @returns Resolves when the attachment is complete.
     */
    attach(attachment_1, name_1) {
        return tslib_1.__awaiter(this, arguments, void 0, function* (attachment, name, options = {}) {
            (0, utils_1.assertIs)(attachment, 'attachment', [
                'string',
                ArrayBuffer,
                'ArrayBufferView',
            ]);
            (0, utils_1.assertIs)(name, 'name', ['string']);
            (0, utils_1.assertOrUndefined)(options.mimeType, 'mimeType', ['string']);
            (0, utils_1.assertOrUndefined)(options.description, 'description', ['string']);
            (0, utils_1.assertOrUndefined)(options.creationDate, 'options.creationDate', [Date]);
            (0, utils_1.assertOrUndefined)(options.modificationDate, 'options.modificationDate', [
                Date,
            ]);
            (0, utils_1.assertIsOneOfOrUndefined)(options.afRelationship, 'options.afRelationship', FileEmbedder_1.AFRelationship);
            const bytes = (0, utils_1.toUint8Array)(attachment);
            const embedder = FileEmbedder_1.default.for(bytes, name, options);
            const ref = this.context.nextRef();
            const embeddedFile = PDFEmbeddedFile_1.default.of(ref, this, embedder);
            this.embeddedFiles.push(embeddedFile);
        });
    }
    getRawAttachments() {
        if (!this.catalog.has(core_1.PDFName.of('Names')))
            return [];
        const Names = this.catalog.lookup(core_1.PDFName.of('Names'), core_1.PDFDict);
        if (!Names.has(core_1.PDFName.of('EmbeddedFiles')))
            return [];
        const EmbeddedFiles = Names.lookup(core_1.PDFName.of('EmbeddedFiles'), core_1.PDFDict);
        if (!EmbeddedFiles.has(core_1.PDFName.of('Names')))
            return [];
        const EFNames = EmbeddedFiles.lookup(core_1.PDFName.of('Names'), core_1.PDFArray);
        const rawAttachments = [];
        for (let idx = 0, len = EFNames.size(); idx < len; idx += 2) {
            const fileName = EFNames.lookup(idx);
            const fileSpec = EFNames.lookup(idx + 1, core_1.PDFDict);
            rawAttachments.push({
                fileName,
                fileSpec,
                specRef: EFNames.get(idx + 1),
            });
        }
        return rawAttachments;
    }
    getSavedAttachments() {
        const rawAttachments = this.getRawAttachments();
        return rawAttachments.flatMap(({ fileName, fileSpec, specRef }) => {
            const efDict = fileSpec.lookup(core_1.PDFName.of('EF'));
            if (!(efDict instanceof core_1.PDFDict))
                return [];
            const stream = efDict.lookup(core_1.PDFName.of('F'));
            if (!(stream instanceof core_1.PDFStream))
                return [];
            const afr = fileSpec.lookup(core_1.PDFName.of('AFRelationship'));
            const afRelationship = afr instanceof core_1.PDFName
                ? afr.toString().slice(1) // Remove leading slash
                : afr instanceof core_1.PDFString
                    ? afr.decodeText()
                    : undefined;
            const embeddedFileDict = stream.dict;
            const subtype = embeddedFileDict.lookup(core_1.PDFName.of('Subtype'));
            const mimeType = subtype instanceof core_1.PDFName
                ? subtype.toString().slice(1)
                : subtype instanceof core_1.PDFString
                    ? subtype.decodeText()
                    : undefined;
            const paramsDict = embeddedFileDict.lookup(core_1.PDFName.of('Params'), core_1.PDFDict);
            let creationDate;
            let modificationDate;
            if (paramsDict instanceof core_1.PDFDict) {
                const creationDateRaw = paramsDict.lookup(core_1.PDFName.of('CreationDate'));
                const modDateRaw = paramsDict.lookup(core_1.PDFName.of('ModDate'));
                if (creationDateRaw instanceof core_1.PDFString) {
                    creationDate = creationDateRaw.decodeDate();
                }
                if (modDateRaw instanceof core_1.PDFString) {
                    modificationDate = modDateRaw.decodeDate();
                }
            }
            const descRaw = fileSpec.lookup(core_1.PDFName.of('Desc'));
            let description;
            if (descRaw instanceof core_1.PDFHexString) {
                description = descRaw.decodeText();
            }
            return [
                {
                    name: fileName.decodeText(),
                    data: (0, core_1.decodePDFRawStream)(stream).decode(),
                    mimeType: mimeType === null || mimeType === void 0 ? void 0 : mimeType.replace(/#([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))),
                    afRelationship: afRelationship,
                    description,
                    creationDate,
                    modificationDate,
                    embeddedFileDict: efDict,
                    specRef,
                },
            ];
        });
    }
    getUnsavedAttachments() {
        const attachments = this.embeddedFiles.flatMap((file) => {
            if (file.getAlreadyEmbedded())
                return [];
            const embedder = file.getEmbedder();
            return {
                name: embedder.fileName,
                data: embedder.getFileData(),
                description: embedder.options.description,
                mimeType: embedder.options.mimeType,
                afRelationship: embedder.options.afRelationship,
                creationDate: embedder.options.creationDate,
                modificationDate: embedder.options.modificationDate,
                pdfEmbeddedFile: file,
            };
        });
        return attachments;
    }
    /**
     * Get all attachments that are embedded in this document.
     *
     * @returns Array of attachments with name and data
     */
    getAttachments() {
        const savedAttachments = this.getSavedAttachments();
        const unsavedAttachments = this.getUnsavedAttachments();
        return [...savedAttachments, ...unsavedAttachments];
    }
    detach(name) {
        const attachedFiles = this.getAttachments();
        attachedFiles.forEach((file) => {
            var _a, _b, _c;
            if (file.name !== name)
                return;
            // the file wasn't embedded into context yet
            if ('pdfEmbeddedFile' in file) {
                const i = this.embeddedFiles.findIndex((f) => file.pdfEmbeddedFile === f);
                if (i !== undefined)
                    this.embeddedFiles.splice(i, 1);
            }
            else {
                // remove references from catalog
                const namesArr = (_a = this.catalog
                    .Names()) === null || _a === void 0 ? void 0 : _a.lookup(core_1.PDFName.of('EmbeddedFiles'), core_1.PDFDict).lookup(core_1.PDFName.of('Names'), core_1.PDFArray);
                const iNames = namesArr === null || namesArr === void 0 ? void 0 : namesArr.indexOf(file.specRef);
                if (iNames !== undefined && iNames > 0) {
                    // attachment spec ref
                    namesArr === null || namesArr === void 0 ? void 0 : namesArr.remove(iNames);
                    // attachment name
                    namesArr === null || namesArr === void 0 ? void 0 : namesArr.remove(iNames - 1);
                }
                // AF-Tag for PDF-A3 compliance
                const AF = this.catalog.AttachedFiles();
                const afIndex = AF === null || AF === void 0 ? void 0 : AF.indexOf(file.specRef);
                if (afIndex !== undefined)
                    AF === null || AF === void 0 ? void 0 : AF.remove(afIndex);
                // remove references from context
                const streamRef = (_c = (_b = this.context
                    .lookupMaybe(file.specRef, core_1.PDFDict)) === null || _b === void 0 ? void 0 : _b.lookupMaybe(core_1.PDFName.of('EF'), core_1.PDFDict)) === null || _c === void 0 ? void 0 : _c.get(core_1.PDFName.of('F'));
                if (streamRef)
                    this.context.delete(streamRef);
                this.context.delete(file.specRef);
            }
        });
    }
    /**
     * Embed a font into this document. The input data can be provided in multiple
     * formats:
     *
     * | Type            | Contents                                                |
     * | --------------- | ------------------------------------------------------- |
     * | `StandardFonts` | One of the standard 14 fonts                            |
     * | `string`        | A base64 encoded string (or data URI) containing a font |
     * | `Uint8Array`    | The raw bytes of a font                                 |
     * | `ArrayBuffer`   | The raw bytes of a font                                 |
     *
     * For example:
     * ```js
     * // font=StandardFonts
     * import { StandardFonts } from 'pdf-lib'
     * const font1 = await pdfDoc.embedFont(StandardFonts.Helvetica)
     *
     * // font=string
     * const font2 = await pdfDoc.embedFont('AAEAAAAVAQAABABQRFNJRx/upe...')
     * const font3 = await pdfDoc.embedFont('data:font/opentype;base64,AAEAAA...')
     *
     * // font=Uint8Array
     * import fs from 'fs'
     * const font4 = await pdfDoc.embedFont(fs.readFileSync('Ubuntu-R.ttf'))
     *
     * // font=ArrayBuffer
     * const url = 'https://pdf-lib.js.org/assets/ubuntu/Ubuntu-R.ttf'
     * const ubuntuBytes = await fetch(url).then(res => res.arrayBuffer())
     * const font5 = await pdfDoc.embedFont(ubuntuBytes)
     * ```
     * See also: [[registerFontkit]]
     * @param font The input data for a font.
     * @param options The options to be used when embedding the font.
     *   For font collections (`.ttc` / `.dfont`), set `options.postscriptName`
     *   to select a face.
     * @returns Resolves with the embedded font.
     */
    embedFont(font_1) {
        return tslib_1.__awaiter(this, arguments, void 0, function* (font, options = {}) {
            const { subset = false, customName, features, postscriptName } = options;
            (0, utils_1.assertIs)(font, 'font', ['string', ArrayBuffer, 'ArrayBufferView']);
            (0, utils_1.assertIs)(subset, 'subset', ['boolean']);
            (0, utils_1.assertOrUndefined)(postscriptName, 'postscriptName', ['string']);
            let embedder;
            if ((0, utils_1.isStandardFont)(font)) {
                embedder = core_1.StandardFontEmbedder.for(font, customName);
            }
            else if ((0, utils_1.canBeConvertedToUint8Array)(font)) {
                const bytes = (0, utils_1.toUint8Array)(font);
                const fontkit = this.assertFontkit();
                embedder = subset
                    ? yield core_1.CustomFontSubsetEmbedder.for(fontkit, bytes, customName, features, postscriptName)
                    : yield core_1.CustomFontEmbedder.for(fontkit, bytes, customName, features, postscriptName);
            }
            else {
                throw new TypeError('`font` must be one of `StandardFonts | string | ArrayBuffer | ArrayBufferView`');
            }
            const ref = this.context.nextRef();
            const pdfFont = PDFFont_1.default.of(ref, this, embedder);
            this.fonts.push(pdfFont);
            return pdfFont;
        });
    }
    /**
     * Embed a standard font into this document.
     * For example:
     * ```js
     * import { StandardFonts } from 'pdf-lib'
     * const helveticaFont = pdfDoc.embedFont(StandardFonts.Helvetica)
     * ```
     * @param font The standard font to be embedded.
     * @param customName The name to be used when embedding the font.
     * @returns The embedded font.
     */
    embedStandardFont(font, customName) {
        (0, utils_1.assertIs)(font, 'font', ['string']);
        if (!(0, utils_1.isStandardFont)(font)) {
            throw new TypeError('`font` must be one of type `StandardFonts`');
        }
        const embedder = core_1.StandardFontEmbedder.for(font, customName);
        const ref = this.context.nextRef();
        const pdfFont = PDFFont_1.default.of(ref, this, embedder);
        this.fonts.push(pdfFont);
        return pdfFont;
    }
    /**
     * Embed a JPEG image into this document. The input data can be provided in
     * multiple formats:
     *
     * | Type          | Contents                                                      |
     * | ------------- | ------------------------------------------------------------- |
     * | `string`      | A base64 encoded string (or data URI) containing a JPEG image |
     * | `Uint8Array`  | The raw bytes of a JPEG image                                 |
     * | `ArrayBuffer` | The raw bytes of a JPEG image                                 |
     *
     * For example:
     * ```js
     * // jpg=string
     * const image1 = await pdfDoc.embedJpg('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBD...')
     * const image2 = await pdfDoc.embedJpg('data:image/jpeg;base64,/9j/4AAQ...')
     *
     * // jpg=Uint8Array
     * import fs from 'fs'
     * const uint8Array = fs.readFileSync('cat_riding_unicorn.jpg')
     * const image3 = await pdfDoc.embedJpg(uint8Array)
     *
     * // jpg=ArrayBuffer
     * const url = 'https://pdf-lib.js.org/assets/cat_riding_unicorn.jpg'
     * const arrayBuffer = await fetch(url).then(res => res.arrayBuffer())
     * const image4 = await pdfDoc.embedJpg(arrayBuffer)
     * ```
     *
     * @param jpg The input data for a JPEG image.
     * @returns Resolves with the embedded image.
     */
    embedJpg(jpg) {
        return tslib_1.__awaiter(this, void 0, void 0, function* () {
            (0, utils_1.assertIs)(jpg, 'jpg', ['string', ArrayBuffer, 'ArrayBufferView']);
            const bytes = (0, utils_1.toUint8Array)(jpg);
            const embedder = yield core_1.JpegEmbedder.for(bytes);
            const ref = this.context.nextRef();
            const pdfImage = PDFImage_1.default.of(ref, this, embedder);
            this.images.push(pdfImage);
            return pdfImage;
        });
    }
    /**
     * Embed a PNG image into this document. The input data can be provided in
     * multiple formats:
     *
     * | Type          | Contents                                                     |
     * | ------------- | ------------------------------------------------------------ |
     * | `string`      | A base64 encoded string (or data URI) containing a PNG image |
     * | `Uint8Array`  | The raw bytes of a PNG image                                 |
     * | `ArrayBuffer` | The raw bytes of a PNG image                                 |
     *
     * For example:
     * ```js
     * // png=string
     * const image1 = await pdfDoc.embedPng('iVBORw0KGgoAAAANSUhEUgAAAlgAAAF3...')
     * const image2 = await pdfDoc.embedPng('data:image/png;base64,iVBORw0KGg...')
     *
     * // png=Uint8Array
     * import fs from 'fs'
     * const uint8Array = fs.readFileSync('small_mario.png')
     * const image3 = await pdfDoc.embedPng(uint8Array)
     *
     * // png=ArrayBuffer
     * const url = 'https://pdf-lib.js.org/assets/small_mario.png'
     * const arrayBuffer = await fetch(url).then(res => res.arrayBuffer())
     * const image4 = await pdfDoc.embedPng(arrayBuffer)
     * ```
     *
     * @param png The input data for a PNG image.
     * @returns Resolves with the embedded image.
     */
    embedPng(png) {
        return tslib_1.__awaiter(this, void 0, void 0, function* () {
            (0, utils_1.assertIs)(png, 'png', ['string', ArrayBuffer, 'ArrayBufferView']);
            const bytes = (0, utils_1.toUint8Array)(png);
            const embedder = yield core_1.PngEmbedder.for(bytes);
            const ref = this.context.nextRef();
            const pdfImage = PDFImage_1.default.of(ref, this, embedder);
            this.images.push(pdfImage);
            return pdfImage;
        });
    }
    embedSvg(svg) {
        return tslib_1.__awaiter(this, void 0, void 0, function* () {
            if (!svg)
                return new PDFSvg_1.default(svg);
            const parsedSvg = (0, node_html_better_parser_1.parse)(svg);
            const findImages = (element) => {
                if (element.tagName === 'image')
                    return [element];
                else {
                    return element.childNodes
                        .map((child) => child.nodeType === node_html_better_parser_1.NodeType.ELEMENT_NODE ? findImages(child) : [])
                        .flat();
                }
            };
            const images = findImages(parsedSvg);
            const imagesDict = {};
            yield Promise.all(images.map((image) => tslib_1.__awaiter(this, void 0, void 0, function* () {
                var _a;
                const href = (_a = image.attributes.href) !== null && _a !== void 0 ? _a : image.attributes['xlink:href'];
                if (!href || imagesDict[href])
                    return;
                const isPng = href.match(/\.png(\?|$)|^data:image\/png;base64/gim);
                const pdfImage = isPng
                    ? yield this.embedPng(href)
                    : yield this.embedJpg(href);
                imagesDict[href] = pdfImage;
            })));
            return new PDFSvg_1.default(svg, imagesDict);
        });
    }
    /**
     * Embed one or more PDF pages into this document.
     *
     * For example:
     * ```js
     * const pdfDoc = await PDFDocument.create()
     *
     * const sourcePdfUrl = 'https://pdf-lib.js.org/assets/with_large_page_count.pdf'
     * const sourcePdf = await fetch(sourcePdfUrl).then((res) => res.arrayBuffer())
     *
     * // Embed page 74 of `sourcePdf` into `pdfDoc`
     * const [embeddedPage] = await pdfDoc.embedPdf(sourcePdf, [73])
     * ```
     *
     * See [[PDFDocument.load]] for examples of the allowed input data formats.
     *
     * @param pdf The input data containing a PDF document.
     * @param indices The indices of the pages that should be embedded.
     * @returns Resolves with an array of the embedded pages.
     */
    embedPdf(pdf_1) {
        return tslib_1.__awaiter(this, arguments, void 0, function* (pdf, indices = [0]) {
            (0, utils_1.assertIs)(pdf, 'pdf', [
                'string',
                ArrayBuffer,
                'ArrayBufferView',
                [PDFDocument, 'PDFDocument'],
            ]);
            (0, utils_1.assertIs)(indices, 'indices', [Array]);
            const srcDoc = pdf instanceof PDFDocument ? pdf : yield PDFDocument.load(pdf);
            const srcPages = (0, utils_1.pluckIndices)(srcDoc.getPages(), indices);
            return this.embedPages(srcPages);
        });
    }
    /**
     * Embed a single PDF page into this document.
     *
     * For example:
     * ```js
     * const pdfDoc = await PDFDocument.create()
     *
     * const sourcePdfUrl = 'https://pdf-lib.js.org/assets/with_large_page_count.pdf'
     * const sourceBuffer = await fetch(sourcePdfUrl).then((res) => res.arrayBuffer())
     * const sourcePdfDoc = await PDFDocument.load(sourceBuffer)
     * const sourcePdfPage = sourcePdfDoc.getPages()[73]
     *
     * const embeddedPage = await pdfDoc.embedPage(
     *   sourcePdfPage,
     *
     *   // Clip a section of the source page so that we only embed part of it
     *   { left: 100, right: 450, bottom: 330, top: 570 },
     *
     *   // Translate all drawings of the embedded page by (10, 200) units
     *   [1, 0, 0, 1, 10, 200],
     * )
     * ```
     *
     * @param page The page to be embedded.
     * @param boundingBox
     * Optionally, an area of the source page that should be embedded
     * (defaults to entire page).
     * @param transformationMatrix
     * Optionally, a transformation matrix that is always applied to the embedded
     * page anywhere it is drawn.
     * @returns Resolves with the embedded pdf page.
     */
    embedPage(page, boundingBox, transformationMatrix) {
        return tslib_1.__awaiter(this, void 0, void 0, function* () {
            (0, utils_1.assertIs)(page, 'page', [[PDFPage_1.default, 'PDFPage']]);
            const [embeddedPage] = yield this.embedPages([page], [boundingBox], [transformationMatrix]);
            return embeddedPage;
        });
    }
    /**
     * Embed one or more PDF pages into this document.
     *
     * For example:
     * ```js
     * const pdfDoc = await PDFDocument.create()
     *
     * const sourcePdfUrl = 'https://pdf-lib.js.org/assets/with_large_page_count.pdf'
     * const sourceBuffer = await fetch(sourcePdfUrl).then((res) => res.arrayBuffer())
     * const sourcePdfDoc = await PDFDocument.load(sourceBuffer)
     *
     * const page1 = sourcePdfDoc.getPages()[0]
     * const page2 = sourcePdfDoc.getPages()[52]
     * const page3 = sourcePdfDoc.getPages()[73]
     *
     * const embeddedPages = await pdfDoc.embedPages([page1, page2, page3])
     * ```
     *
     * @param page
     * The pages to be embedded (they must all share the same context).
     * @param boundingBoxes
     * Optionally, an array of clipping boundaries - one for each page
     * (defaults to entirety of each page).
     * @param transformationMatrices
     * Optionally, an array of transformation matrices - one for each page
     * (each page's transformation will apply anywhere it is drawn).
     * @returns Resolves with an array of the embedded pdf pages.
     */
    embedPages(pages_1) {
        return tslib_1.__awaiter(this, arguments, void 0, function* (pages, boundingBoxes = [], transformationMatrices = []) {
            if (pages.length === 0)
                return [];
            // Assert all pages have the same context
            for (let idx = 0, len = pages.length - 1; idx < len; idx++) {
                const currPage = pages[idx];
                const nextPage = pages[idx + 1];
                if (currPage.node.context !== nextPage.node.context) {
                    throw new core_1.PageEmbeddingMismatchedContextError();
                }
            }
            const context = pages[0].node.context;
            const maybeCopyPage = context === this.context
                ? (p) => p
                : core_1.PDFObjectCopier.for(context, this.context).copy;
            const embeddedPages = new Array(pages.length);
            for (let idx = 0, len = pages.length; idx < len; idx++) {
                const page = maybeCopyPage(pages[idx].node);
                const box = boundingBoxes[idx];
                const matrix = transformationMatrices[idx];
                const embedder = yield core_1.PDFPageEmbedder.for(page, box, matrix);
                const ref = this.context.nextRef();
                embeddedPages[idx] = PDFEmbeddedPage_1.default.of(ref, this, embedder);
            }
            this.embeddedPages.push(...embeddedPages);
            return embeddedPages;
        });
    }
    /**
     * Encrypt this document with the given passwords and permissions.
     *
     * Defaults to AES-256 (`/V 5`, `/R 6`), the only algorithm ISO 32000-2 still
     * recommends. The document's PDF version is not used to pick the cipher — an
     * old document is encrypted just as strongly as a recent one, and the header
     * is raised to the minimum version the chosen cipher requires. Pass
     * {@link SecurityOptions.algorithm} to target an older viewer. RC4 requires
     * {@link SecurityOptions.allowWeakCryptography}.
     *
     * > **NOTE:** This requires the Web Crypto API (`crypto.getRandomValues`) for
     * > secure randomness — present in modern browsers, Node (>= 18), Deno, and
     * > Bun. On Node < 18, or React Native without a polyfill such as
     * > `react-native-get-random-values`, this throws. Nothing else in `pdf-lib`
     * > needs it.
     *
     * @param options The options to be used when encrypting this document.
     */
    encrypt(options) {
        // PDF/A forbids encryption — refuse when the catalog already claims PDF/A.
        if ((0, catalogMetadata_1.readCatalogPDFAConformance)(this.catalog)) {
            throw new Error('Cannot encrypt a PDF/A document: PDF/A forbids encryption. A file ' +
                'cannot be both encrypted and PDF/A compliant.');
        }
        this.context.security = PDFSecurity_1.default.create(this.context, options).encrypt();
    }
    /**
     * > **NOTE:** You shouldn't need to call this method directly. The [[save]]
     * > and [[saveAsBase64]] methods will automatically ensure that all embedded
     * > assets are flushed before serializing the document.
     *
     * Flush all embedded fonts, PDF pages, and images to this document's
     * [[context]].
     *
     * @returns Resolves when the flush is complete.
     */
    flush() {
        return tslib_1.__awaiter(this, void 0, void 0, function* () {
            yield this.embedAll(this.fonts);
            yield this.embedAll(this.images);
            yield this.embedAll(this.embeddedPages);
            yield this.embedAll(this.embeddedFiles);
            yield this.embedAll(this.javaScripts);
        });
    }
    /**
     * Serialize this document to an array of bytes making up a PDF file.
     * For example:
     * ```js
     * const pdfBytes = await pdfDoc.save()
     * ```
     *
     * There are a number of things you can do with the serialized document,
     * depending on the JavaScript environment you're running in:
     * * Write it to a file in Node or React Native
     * * Download it as a Blob in the browser
     * * Render it in an `iframe`
     *
     * @param options The options to be used when saving the document.
     * @returns Resolves with the bytes of the serialized document.
     */
    save() {
        return tslib_1.__awaiter(this, arguments, void 0, function* (options = {}) {
            var _a;
            const vparts = this.context.header.getVersionString().split('.');
            const pdfaPart = (_a = (0, catalogMetadata_1.readCatalogPDFAConformance)(this.catalog)) === null || _a === void 0 ? void 0 : _a.part;
            const uOS = 
            // PDF/A-1 forbids object and cross-reference streams, so never enable
            // them by default when targeting that part.
            pdfaPart !== 1 &&
                (options.rewrite || Number(vparts[0]) > 1 || Number(vparts[1]) >= 5);
            const { useObjectStreams = uOS, addDefaultPage = true, objectsPerTick = 50, updateFieldAppearances = true, rewrite = false, } = options;
            (0, utils_1.assertIs)(useObjectStreams, 'useObjectStreams', ['boolean']);
            (0, utils_1.assertIs)(addDefaultPage, 'addDefaultPage', ['boolean']);
            (0, utils_1.assertIs)(objectsPerTick, 'objectsPerTick', ['number']);
            (0, utils_1.assertIs)(updateFieldAppearances, 'updateFieldAppearances', ['boolean']);
            (0, utils_1.assertIs)(rewrite, 'rewrite', ['boolean']);
            if (pdfaPart === 1 && useObjectStreams) {
                throw new Error('PDF/A-1 forbids object and cross-reference streams. ' +
                    'Save with useObjectStreams: false (the default for PDF/A-1).');
            }
            // Object streams require PDF >= 1.5. If a loaded document still advertises
            // an older header (e.g. 1.3/1.4) but we are about to emit ObjStm — typically
            // via `rewrite: true` — bump the header so the declared version matches the
            // features we write.
            if (useObjectStreams) {
                const [maj, min] = this.context.header
                    .getVersionString()
                    .split('.')
                    .map(Number);
                if (maj < 1 || (maj === 1 && min < 5)) {
                    this.context.header = core_1.PDFHeader.forVersion(1, 7);
                }
            }
            const incrementalUpdate = !rewrite &&
                this.context.pdfFileDetails.originalBytes &&
                this.context.snapshot;
            if (incrementalUpdate) {
                options.addDefaultPage = false;
                options.updateFieldAppearances = false;
            }
            yield this.prepareForSave(options);
            const Writer = useObjectStreams ? core_1.PDFStreamWriter : core_1.PDFWriter;
            if (incrementalUpdate) {
                const increment = yield Writer.forContextWithSnapshot(this.context, objectsPerTick, this.context.snapshot).serializeToBuffer();
                const result = new Uint8Array(this.context.pdfFileDetails.originalBytes.byteLength +
                    increment.byteLength);
                result.set(this.context.pdfFileDetails.originalBytes);
                result.set(increment, this.context.pdfFileDetails.originalBytes.byteLength);
                return result;
            }
            return Writer.forContext(this.context, objectsPerTick).serializeToBuffer();
        });
    }
    /**
     * Serialize only the changes to this document to an array of bytes making up a PDF file.
     * For example:
     * ```js
     * const snapshot = pdfDoc.takeSnapshot();
     * ...
     * const pdfBytes = await pdfDoc.saveIncremental(snapshot);
     * ```
     *
     * Similar to [[save]] function.
     * The changes are saved in an incremental way, the result buffer
     * will contain only the differences
     *
     * @param snapshot The snapshot to be used when saving the document.
     * @param options The options to be used when saving the document.
     * @returns Resolves with the bytes of the serialized document.
     */
    saveIncremental(snapshot_2) {
        return tslib_1.__awaiter(this, arguments, void 0, function* (snapshot, options = {}) {
            var _a;
            // check PDF version
            const vparts = this.context.header.getVersionString().split('.');
            const pdfaPart = (_a = (0, catalogMetadata_1.readCatalogPDFAConformance)(this.catalog)) === null || _a === void 0 ? void 0 : _a.part;
            const uOS = pdfaPart !== 1 && (Number(vparts[0]) > 1 || Number(vparts[1]) >= 5);
            const { objectsPerTick = 50 } = options;
            (0, utils_1.assertIs)(objectsPerTick, 'objectsPerTick', ['number']);
            if (pdfaPart === 1 && options.useObjectStreams === true) {
                throw new Error('PDF/A-1 forbids object and cross-reference streams. ' +
                    'Save with useObjectStreams: false (the default for PDF/A-1).');
            }
            const saveOptions = Object.assign(Object.assign({ useObjectStreams: uOS }, options), { addDefaultPage: false, updateFieldAppearances: false });
            yield this.prepareForSave(saveOptions);
            const Writer = saveOptions.useObjectStreams ? core_1.PDFStreamWriter : core_1.PDFWriter;
            return Writer.forContextWithSnapshot(this.context, objectsPerTick, snapshot).serializeToBuffer();
        });
    }
    /**
     * Serialize this document to a base64 encoded string or data URI making up a
     * PDF file. For example:
     * ```js
     * const base64String = await pdfDoc.saveAsBase64()
     * base64String // => 'JVBERi0xLjcKJYGBgYEKC...'
     *
     * const base64DataUri = await pdfDoc.saveAsBase64({ dataUri: true })
     * base64DataUri // => 'data:application/pdf;base64,JVBERi0xLjcKJYGBgYEKC...'
     * ```
     *
     * @param options The options to be used when saving the document.
     * @returns Resolves with a base64 encoded string or data URI of the
     *          serialized document.
     */
    saveAsBase64() {
        return tslib_1.__awaiter(this, arguments, void 0, function* (options = {}) {
            const { dataUri = false } = options, otherOptions = tslib_1.__rest(options, ["dataUri"]);
            (0, utils_1.assertIs)(dataUri, 'dataUri', ['boolean']);
            const bytes = yield this.save(otherOptions);
            const base64 = (0, utils_1.encodeToBase64)(bytes);
            return dataUri ? `data:application/pdf;base64,${base64}` : base64;
        });
    }
    findPageForAnnotationRef(ref) {
        const pages = this.getPages();
        for (let idx = 0, len = pages.length; idx < len; idx++) {
            const page = pages[idx];
            const annotations = page.node.Annots();
            if ((annotations === null || annotations === void 0 ? void 0 : annotations.indexOf(ref)) !== undefined) {
                return page;
            }
        }
        return undefined;
    }
    takeSnapshot() {
        const indirectObjects = new Set();
        const snapshot = new snapshot_1.IncrementalDocumentSnapshot(this.context.largestObjectNumber, indirectObjects, this.context.pdfFileDetails.pdfSize, this.context.pdfFileDetails.prevStartXRef, this.context);
        if (!this.context.snapshot && this.context.pdfFileDetails.originalBytes) {
            this.context.snapshot = snapshot;
            this.catalog.registerChange();
        }
        return snapshot;
    }
    /**
     * Commit the current changes to the document as an incremental update.
     * This allows you to save multiple incremental updates without reloading the PDF.
     *
     * For example:
     * ```js
     * const pdfDoc = await PDFDocument.load(pdfBytes, { forIncrementalUpdate: true })
     *
     * const page = pdfDoc.getPage(0)
     * page.drawText('First update')
     * const firstCommit = await pdfDoc.commit()
     *
     * page.drawText('Second update', { y: 100 })
     * const secondCommit = await pdfDoc.commit()
     * ```
     *
     * @param options The options to be used when committing changes.
     * @returns Resolves with the complete PDF bytes including all updates.
     */
    commit() {
        return tslib_1.__awaiter(this, arguments, void 0, function* (options = {}) {
            if (!this.context.snapshot || !this.context.pdfFileDetails.originalBytes) {
                throw new Error('commit() requires the document to be loaded with forIncrementalUpdate: true');
            }
            const incrementalBytes = yield this.saveIncremental(this.context.snapshot, options);
            const originalBytes = this.context.pdfFileDetails.originalBytes;
            const newPdfBytes = new Uint8Array(originalBytes.byteLength + incrementalBytes.byteLength);
            newPdfBytes.set(originalBytes);
            newPdfBytes.set(incrementalBytes, originalBytes.byteLength);
            this.context.pdfFileDetails.originalBytes = newPdfBytes;
            this.context.pdfFileDetails.pdfSize = newPdfBytes.byteLength;
            const incrementalStr = new TextDecoder('latin1').decode(incrementalBytes);
            const startxrefMatch = incrementalStr.match(/startxref\s+(\d+)/);
            if (startxrefMatch) {
                this.context.pdfFileDetails.prevStartXRef = parseInt(startxrefMatch[1], 10);
            }
            else {
                this.context.pdfFileDetails.prevStartXRef = originalBytes.byteLength;
            }
            this.context.snapshot = this.takeSnapshot();
            return newPdfBytes;
        });
    }
    prepareForSave(options) {
        return tslib_1.__awaiter(this, void 0, void 0, function* () {
            const { addDefaultPage = true, updateFieldAppearances = true } = options;
            (0, utils_1.assertIs)(addDefaultPage, 'addDefaultPage', ['boolean']);
            (0, utils_1.assertIs)(updateFieldAppearances, 'updateFieldAppearances', ['boolean']);
            if (addDefaultPage && this.getPageCount() === 0)
                this.addPage();
            if (updateFieldAppearances) {
                const form = this.formCache.getValue();
                if (form)
                    form.updateFieldAppearances();
            }
            // Keep Info dict and XMP Metadata equivalent, as required by PDF/A.
            this.syncPDFAMetadata();
            yield this.flush();
        });
    }
    embedAll(embeddables) {
        return tslib_1.__awaiter(this, void 0, void 0, function* () {
            for (let idx = 0, len = embeddables.length; idx < len; idx++) {
                yield embeddables[idx].embed();
            }
        });
    }
    updateInfoDict() {
        const pdfLib = 'pdf-lib (https://github.com/Hopding/pdf-lib)';
        const now = new Date();
        const info = this.getInfoDict();
        this.setProducer(pdfLib);
        this.setModificationDate(now);
        if (!info.get(core_1.PDFName.of('Creator')))
            this.setCreator(pdfLib);
        if (!info.get(core_1.PDFName.of('CreationDate')))
            this.setCreationDate(now);
    }
    /**
     * Rebuild the catalog `/Metadata` XMP packet when this document is under
     * PDF/A metadata management: owned Info/`pdfaid` projection, plus any foreign
     * `rdf:Description` blocks already present (and optional one-shot extras).
     *
     * @param conformance Explicit part/level when writing before catalog XMP
     * exists (or when changing it). Otherwise read from catalog.
     */
    syncPDFAMetadata(extraExtensions, conformance) {
        if (!this.managePDFAMetadata)
            return;
        const conf = conformance !== null && conformance !== void 0 ? conformance : (0, catalogMetadata_1.readCatalogPDFAConformance)(this.catalog);
        if (!conf)
            return;
        const existingXml = (0, catalogMetadata_1.readCatalogMetadataXml)(this.catalog);
        const preserved = existingXml
            ? (0, pdfa_1.extractForeignXmpDescriptions)(existingXml)
            : [];
        const extensions = (0, pdfa_1.mergeXmpExtensionFragments)(extraExtensions, preserved);
        const metadataXML = (0, pdfa_1.buildPDFAMetadata)({
            conformance: conf,
            title: this.getTitle(),
            author: this.getAuthor(),
            subject: this.getSubject(),
            keywords: this.getKeywords(),
            creator: this.getCreator(),
            producer: this.getProducer(),
            creationDate: this.getCreationDate(),
            modificationDate: this.getModificationDate(),
            extensions,
        });
        this.writeCatalogMetadataXml(metadataXML);
    }
    writeCatalogMetadataXml(metadataXML) {
        // Unfiltered UTF-8 stream so validators can read XMP without decompressing.
        const metadataStream = this.context.stream((0, utils_1.utf8Encode)(metadataXML, false), {
            Type: 'Metadata',
            Subtype: 'XML',
        });
        const metaKey = core_1.PDFName.of('Metadata');
        const existingRef = this.catalog.get(metaKey);
        if (existingRef instanceof PDFRef_1.default) {
            // Reuse the catalog ref so repeated saves do not orphan Metadata streams.
            this.context.assign(existingRef, metadataStream);
            if (this.context.snapshot) {
                this.context.snapshot.markRefForSave(existingRef);
            }
        }
        else {
            this.catalog.set(metaKey, this.context.register(metadataStream));
        }
    }
    getInfoDict() {
        const existingInfo = this.context.lookup(this.context.trailerInfo.Info);
        if (existingInfo instanceof core_1.PDFDict)
            return existingInfo;
        const newInfo = this.context.obj({});
        this.context.trailerInfo.Info = this.context.register(newInfo);
        return newInfo;
    }
    assertFontkit() {
        if (!this.fontkit)
            throw new errors_1.FontkitNotRegisteredError();
        return this.fontkit;
    }
    /**
     * Return an existing [[PDFForm]] without creating an AcroForm or stripping XFA.
     * Prefers the form cache when already populated; otherwise wraps a catalog
     * AcroForm if one is already present.
     */
    getExistingForm() {
        const cached = this.formCache.getValue();
        if (cached)
            return cached;
        const acroForm = this.catalog.getAcroForm();
        if (!acroForm)
            return undefined;
        return PDFForm_1.default.of(acroForm, this);
    }
}
exports.default = PDFDocument;
/* tslint:disable-next-line only-arrow-functions */
function assertIsLiteralOrHexString(pdfObject) {
    if (!(pdfObject instanceof core_1.PDFHexString) &&
        !(pdfObject instanceof core_1.PDFString)) {
        throw new core_1.UnexpectedObjectTypeError([core_1.PDFHexString, core_1.PDFString], pdfObject);
    }
}
//# sourceMappingURL=PDFDocument.js.map