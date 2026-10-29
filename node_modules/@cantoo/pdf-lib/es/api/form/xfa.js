import { parse as parseHtml, NodeType, } from 'node-html-better-parser';
import { PDFArray, PDFHexString, PDFRawStream, PDFRef, PDFString, decodePDFRawStream, PDFName, } from '../../core/index.js';
import { decodeXfaXml } from '../../utils/index.js';
/**
 * Locate the XFA `template` packet on an AcroForm dictionary and decode it.
 * Only the array form of `/XFA` (alternating name/stream pairs) is supported.
 */
export const readXfaTemplatePacket = (acroFormDict) => {
    const context = acroFormDict.context;
    const xfaObj = acroFormDict.get(PDFName.of('XFA'));
    if (!xfaObj)
        return null;
    const xfa = xfaObj instanceof PDFRef ? context.lookup(xfaObj) : xfaObj;
    if (!(xfa instanceof PDFArray))
        return null;
    for (let idx = 0; idx < xfa.size(); idx += 2) {
        const nameObj = xfa.get(idx);
        const streamObj = xfa.get(idx + 1);
        if (!nameObj || !streamObj)
            continue;
        let sectionName;
        if (nameObj instanceof PDFString) {
            sectionName = nameObj.asString();
        }
        else if (nameObj instanceof PDFHexString) {
            sectionName = nameObj.decodeText();
        }
        else {
            continue;
        }
        if (sectionName !== 'template')
            continue;
        const streamRef = streamObj instanceof PDFRef ? streamObj : null;
        const stream = streamRef ? context.lookup(streamRef) : streamObj;
        if (!(stream instanceof PDFRawStream))
            continue;
        return {
            xfa,
            templateIndex: idx + 1,
            streamRef,
            stream,
            xml: decodeXfaXml(decodePDFRawStream(stream).decode()),
        };
    }
    return null;
};
export const parseXfaTemplate = (xml) => parseHtml(xml, { script: true });
/**
 * Walk an XFA template tree. Tracks the enclosing `field` name and invokes
 * `visit` for every element so callers can collect scripts, signatures, etc.
 */
export const walkXfaTree = (node, visit, currentField) => {
    var _a, _b;
    const tag = (_a = node.tagName) === null || _a === void 0 ? void 0 : _a.toLowerCase();
    const fieldCtx = tag === 'field' ? ((_b = node.getAttribute('name')) !== null && _b !== void 0 ? _b : undefined) : currentField;
    visit(node, fieldCtx);
    for (const child of node.childNodes) {
        if (child.nodeType === NodeType.ELEMENT_NODE) {
            walkXfaTree(child, visit, fieldCtx);
        }
    }
};
export const collectXfaScripts = (root) => {
    const results = [];
    // Scripts also need the enclosing event name, so this walk tracks both
    // field and event (walkXfaTree only tracks field).
    const walk = (node, field, event) => {
        var _a, _b, _c;
        const tag = (_a = node.tagName) === null || _a === void 0 ? void 0 : _a.toLowerCase();
        let fieldCtx = field;
        let eventCtx = event;
        if (tag === 'field') {
            fieldCtx = (_b = node.getAttribute('name')) !== null && _b !== void 0 ? _b : undefined;
            eventCtx = undefined;
        }
        else if (tag === 'event') {
            eventCtx = (_c = node.getAttribute('name')) !== null && _c !== void 0 ? _c : undefined;
        }
        else if (tag === 'script' && fieldCtx && eventCtx) {
            results.push({ scriptNode: node, field: fieldCtx, event: eventCtx });
        }
        for (const child of node.childNodes) {
            if (child.nodeType === NodeType.ELEMENT_NODE) {
                walk(child, fieldCtx, eventCtx);
            }
        }
    };
    walk(root);
    return results;
};
const collectXfaRefs = (node) => {
    var _a, _b;
    const refs = [];
    for (const child of node.childNodes) {
        if (child.nodeType !== NodeType.ELEMENT_NODE)
            continue;
        const el = child;
        if (((_a = el.tagName) === null || _a === void 0 ? void 0 : _a.toLowerCase()) !== 'ref')
            continue;
        const text = (_b = el.text) === null || _b === void 0 ? void 0 : _b.trim();
        if (text)
            refs.push(text);
    }
    return refs;
};
export const collectXfaSignatures = (root) => {
    const signatures = [];
    const manifests = new Map();
    walkXfaTree(root, (node, fieldCtx) => {
        var _a, _b;
        const tag = (_a = node.tagName) === null || _a === void 0 ? void 0 : _a.toLowerCase();
        if (tag === 'manifest') {
            const id = node.getAttribute('id');
            if (id)
                manifests.set(id, collectXfaRefs(node));
            return;
        }
        if (tag !== 'signature' || !fieldCtx)
            return;
        let manifestUse;
        const inlineRefs = [];
        for (const child of node.childNodes) {
            if (child.nodeType !== NodeType.ELEMENT_NODE)
                continue;
            const el = child;
            if (((_b = el.tagName) === null || _b === void 0 ? void 0 : _b.toLowerCase()) !== 'manifest')
                continue;
            const use = el.getAttribute('use');
            if (use)
                manifestUse = use.replace(/^#/, '');
            const id = el.getAttribute('id');
            const refs = collectXfaRefs(el);
            if (id)
                manifests.set(id, refs);
            inlineRefs.push(...refs);
        }
        signatures.push({ field: fieldCtx, manifestUse, inlineRefs });
    });
    return { signatures, manifests };
};
//# sourceMappingURL=xfa.js.map