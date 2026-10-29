import PDFDocument from './PDFDocument';
import { PDFDict, PDFRef } from '../core';
/**
 * Represents a JavaScript action extracted from a PDF.
 * JavaScript actions can be attached to documents, pages, fields, and annotations.
 */
export default class PDFJavaScriptAction {
    /** The underlying dictionary for this JavaScript action. */
    readonly dict: PDFDict;
    /** The document to which this action belongs. */
    readonly doc: PDFDocument;
    /** The reference to this action (if any). */
    readonly ref?: PDFRef;
    private constructor();
    /**
     * Create a PDFJavaScriptAction from a dictionary.
     * @param dict The action dictionary
     * @param doc The document to which this action belongs
     * @param ref The reference to this action (if any)
     * @returns A PDFJavaScriptAction instance or undefined if not a JavaScript action
     */
    static of(dict: PDFDict, doc: PDFDocument, ref?: PDFRef): PDFJavaScriptAction | undefined;
    /**
     * Get the JavaScript code from this action.
     * @returns The JavaScript code as a string
     */
    getScript(): string | undefined;
    /**
     * Set the JavaScript code for this action.
     * @param script The JavaScript code to set
     */
    setScript(script: string): void;
}
export interface JavaScriptActionMap {
    /** Keystroke action (K) - executed when the user types in a field */
    keystroke?: PDFJavaScriptAction;
    /** Format action (F) - executed to format the field's value */
    format?: PDFJavaScriptAction;
    /** Validate action (V) - executed to validate the field's value */
    validate?: PDFJavaScriptAction;
    /** Calculate action (C) - executed to recalculate the field's value */
    calculate?: PDFJavaScriptAction;
    /** Mouse up action (U) - executed when mouse button is released */
    mouseUp?: PDFJavaScriptAction;
    /** Mouse down action (D) - executed when mouse button is pressed */
    mouseDown?: PDFJavaScriptAction;
    /** Mouse enter action (E) - executed when cursor enters annotation area */
    mouseEnter?: PDFJavaScriptAction;
    /** Mouse exit action (X) - executed when cursor exits annotation area */
    mouseExit?: PDFJavaScriptAction;
    /** Page open action (O) - executed when page is opened */
    pageOpen?: PDFJavaScriptAction;
    /** Page close action (C) - executed when page is closed */
    pageClose?: PDFJavaScriptAction;
    /** Focus action (Fo) - executed when annotation receives focus */
    focus?: PDFJavaScriptAction;
    /** Blur action (Bl) - executed when annotation loses focus */
    blur?: PDFJavaScriptAction;
}
/**
 * The `AA` (additional-actions) key `C` is context-sensitive in the PDF spec:
 * in a field dictionary it is the *calculate* action, while in a page
 * dictionary it is the *page close* action. Because a single `C` entry can
 * only mean one of these, the extractor must be told which context it is
 * reading so the same entry is not surfaced as both `calculate` and
 * `pageClose`.
 */
export type AdditionalActionsContext = 'field' | 'page';
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
export declare function extractAdditionalActions(aaDict: PDFDict, doc: PDFDocument, context?: AdditionalActionsContext): JavaScriptActionMap;
//# sourceMappingURL=PDFJavaScriptAction.d.ts.map