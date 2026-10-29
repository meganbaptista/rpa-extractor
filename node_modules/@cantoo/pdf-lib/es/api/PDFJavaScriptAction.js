import { PDFDict, PDFName, PDFString, PDFHexString, PDFRef, PDFStream, PDFRawStream, decodePDFRawStream, } from '../core/index.js';
/**
 * Represents a JavaScript action extracted from a PDF.
 * JavaScript actions can be attached to documents, pages, fields, and annotations.
 */
export default class PDFJavaScriptAction {
    constructor(dict, doc, ref) {
        this.dict = dict;
        this.doc = doc;
        this.ref = ref;
    }
    /**
     * Create a PDFJavaScriptAction from a dictionary.
     * @param dict The action dictionary
     * @param doc The document to which this action belongs
     * @param ref The reference to this action (if any)
     * @returns A PDFJavaScriptAction instance or undefined if not a JavaScript action
     */
    static of(dict, doc, ref) {
        const s = dict.lookup(PDFName.of('S'));
        if (s instanceof PDFName && s.asString() === '/JavaScript') {
            return new PDFJavaScriptAction(dict, doc, ref);
        }
        return undefined;
    }
    /**
     * Get the JavaScript code from this action.
     * @returns The JavaScript code as a string
     */
    getScript() {
        const js = this.dict.lookup(PDFName.of('JS'));
        if (js instanceof PDFString)
            return js.asString();
        if (js instanceof PDFHexString)
            return js.decodeText();
        if (js instanceof PDFName)
            return js.decodeText();
        if (js instanceof PDFStream) {
            const bytes = js instanceof PDFRawStream
                ? decodePDFRawStream(js).decode()
                : js.getContents();
            return new TextDecoder('utf-8').decode(bytes);
        }
        return undefined;
    }
    /**
     * Set the JavaScript code for this action.
     * @param script The JavaScript code to set
     */
    setScript(script) {
        this.dict.set(PDFName.of('JS'), PDFHexString.fromText(script));
    }
}
/** Field-level additional actions (PDF spec table 197). */
const FIELD_ACTION_KEYS = [
    { key: 'K', prop: 'keystroke' },
    { key: 'F', prop: 'format' },
    { key: 'V', prop: 'validate' },
    { key: 'C', prop: 'calculate' },
    { key: 'U', prop: 'mouseUp' },
    { key: 'D', prop: 'mouseDown' },
    { key: 'E', prop: 'mouseEnter' },
    { key: 'X', prop: 'mouseExit' },
    { key: 'Fo', prop: 'focus' },
    { key: 'Bl', prop: 'blur' },
];
/** Page-level additional actions (PDF spec table 196). */
const PAGE_ACTION_KEYS = [
    { key: 'O', prop: 'pageOpen' },
    { key: 'C', prop: 'pageClose' },
];
/**
 * Extract JavaScript actions from an Additional Actions (AA) dictionary.
 *
 * The `context` argument disambiguates the shared `C` key: pass `'field'` when
 * reading a form field's `AA` dictionary (so `C` maps to `calculate`) and
 * `'page'` when reading a page's `AA` dictionary (so `C` maps to `pageClose`).
 * When omitted, field semantics are used together with the unambiguous page
 * `O` (pageOpen) key, preserving backwards-compatible behaviour without ever
 * mapping a single `C` entry to two different actions.
 *
 * @param aaDict The AA dictionary
 * @param doc The document
 * @param context Whether the dictionary belongs to a field or a page
 * @returns A map of JavaScript actions
 */
export function extractAdditionalActions(aaDict, doc, context) {
    const actions = {};
    let actionKeys;
    switch (context) {
        case 'page':
            actionKeys = PAGE_ACTION_KEYS;
            break;
        case 'field':
            actionKeys = FIELD_ACTION_KEYS;
            break;
        default:
            // field actions plus the unambiguous page-open key. `C` resolves to `calculate`
            actionKeys = [
                ...FIELD_ACTION_KEYS,
                { key: 'O', prop: 'pageOpen' },
            ];
    }
    for (const { key, prop } of actionKeys) {
        const name = PDFName.of(key);
        const actionDict = aaDict.lookupMaybe(name, PDFDict);
        if (!actionDict)
            continue;
        const actionObj = aaDict.get(name);
        const action = PDFJavaScriptAction.of(actionDict, doc, actionObj instanceof PDFRef ? actionObj : undefined);
        if (action)
            actions[prop] = action;
    }
    return actions;
}
//# sourceMappingURL=PDFJavaScriptAction.js.map