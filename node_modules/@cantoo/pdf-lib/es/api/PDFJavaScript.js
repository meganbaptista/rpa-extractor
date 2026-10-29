import { __awaiter } from "tslib";
import { PDFName, PDFDict, PDFHexString } from '../core/index.js';
import { addNameTreeEntry } from './nameTree.js';
/**
 * Represents JavaScript that has been embedded in a [[PDFDocument]].
 */
class PDFJavaScript {
    constructor(ref, doc, embedder) {
        this.alreadyEmbedded = false;
        this.ref = ref;
        this.doc = doc;
        this.embedder = embedder;
    }
    /**
     * > **NOTE:** You probably don't need to call this method directly. The
     * > [[PDFDocument.save]] and [[PDFDocument.saveAsBase64]] methods will
     * > automatically ensure all JavaScripts get embedded.
     *
     * Embed this JavaScript in its document.
     *
     * @returns Resolves when the embedding is complete.
     */
    embed() {
        return __awaiter(this, void 0, void 0, function* () {
            if (!this.alreadyEmbedded) {
                const { catalog, context } = this.doc;
                const ref = yield this.embedder.embedIntoContext(this.doc.context, this.ref);
                if (!catalog.has(PDFName.of('Names'))) {
                    catalog.set(PDFName.of('Names'), context.obj({}));
                }
                const Names = catalog.lookup(PDFName.of('Names'), PDFDict);
                if (!Names.has(PDFName.of('JavaScript'))) {
                    Names.set(PDFName.of('JavaScript'), context.obj({}));
                }
                const Javascript = Names.lookup(PDFName.of('JavaScript'), PDFDict);
                // Flat `/Names` only — leave `/Kids` (and other incompatible) trees alone.
                addNameTreeEntry(Javascript, PDFHexString.fromText(this.embedder.scriptName), ref);
                this.alreadyEmbedded = true;
            }
        });
    }
}
/**
 * > **NOTE:** You probably don't want to call this method directly. Instead,
 * > consider using the [[PDFDocument.addJavaScript]] method, which will
 * create instances of [[PDFJavaScript]] for you.
 *
 * Create an instance of [[PDFJavaScript]] from an existing ref and script
 *
 * @param ref The unique reference for this script.
 * @param doc The document to which the script will belong.
 * @param embedder The embedder that will be used to embed the script.
 */
PDFJavaScript.of = (ref, doc, embedder) => new PDFJavaScript(ref, doc, embedder);
export default PDFJavaScript;
//# sourceMappingURL=PDFJavaScript.js.map