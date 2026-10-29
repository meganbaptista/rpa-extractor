"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.collectXfaSignatures = exports.collectXfaScripts = exports.walkXfaTree = exports.parseXfaTemplate = exports.readXfaTemplatePacket = void 0;
const node_html_better_parser_1 = require("node-html-better-parser");
const core_1 = require("../../core");
const utils_1 = require("../../utils");
/**
 * Locate the XFA `template` packet on an AcroForm dictionary and decode it.
 * Only the array form of `/XFA` (alternating name/stream pairs) is supported.
 */
const readXfaTemplatePacket = (acroFormDict) => {
    const context = acroFormDict.context;
    const xfaObj = acroFormDict.get(core_1.PDFName.of('XFA'));
    if (!xfaObj)
        return null;
    const xfa = xfaObj instanceof core_1.PDFRef ? context.lookup(xfaObj) : xfaObj;
    if (!(xfa instanceof core_1.PDFArray))
        return null;
    for (let idx = 0; idx < xfa.size(); idx += 2) {
        const nameObj = xfa.get(idx);
        const streamObj = xfa.get(idx + 1);
        if (!nameObj || !streamObj)
            continue;
        let sectionName;
        if (nameObj instanceof core_1.PDFString) {
            sectionName = nameObj.asString();
        }
        else if (nameObj instanceof core_1.PDFHexString) {
            sectionName = nameObj.decodeText();
        }
        else {
            continue;
        }
        if (sectionName !== 'template')
            continue;
        const streamRef = streamObj instanceof core_1.PDFRef ? streamObj : null;
        const stream = streamRef ? context.lookup(streamRef) : streamObj;
        if (!(stream instanceof core_1.PDFRawStream))
            continue;
        return {
            xfa,
            templateIndex: idx + 1,
            streamRef,
            stream,
            xml: (0, utils_1.decodeXfaXml)((0, core_1.decodePDFRawStream)(stream).decode()),
        };
    }
    return null;
};
exports.readXfaTemplatePacket = readXfaTemplatePacket;
const parseXfaTemplate = (xml) => (0, node_html_better_parser_1.parse)(xml, { script: true });
exports.parseXfaTemplate = parseXfaTemplate;
/**
 * Walk an XFA template tree. Tracks the enclosing `field` name and invokes
 * `visit` for every element so callers can collect scripts, signatures, etc.
 */
const walkXfaTree = (node, visit, currentField) => {
    var _a, _b;
    const tag = (_a = node.tagName) === null || _a === void 0 ? void 0 : _a.toLowerCase();
    const fieldCtx = tag === 'field' ? ((_b = node.getAttribute('name')) !== null && _b !== void 0 ? _b : undefined) : currentField;
    visit(node, fieldCtx);
    for (const child of node.childNodes) {
        if (child.nodeType === node_html_better_parser_1.NodeType.ELEMENT_NODE) {
            (0, exports.walkXfaTree)(child, visit, fieldCtx);
        }
    }
};
exports.walkXfaTree = walkXfaTree;
const collectXfaScripts = (root) => {
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
            if (child.nodeType === node_html_better_parser_1.NodeType.ELEMENT_NODE) {
                walk(child, fieldCtx, eventCtx);
            }
        }
    };
    walk(root);
    return results;
};
exports.collectXfaScripts = collectXfaScripts;
const collectXfaRefs = (node) => {
    var _a, _b;
    const refs = [];
    for (const child of node.childNodes) {
        if (child.nodeType !== node_html_better_parser_1.NodeType.ELEMENT_NODE)
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
const collectXfaSignatures = (root) => {
    const signatures = [];
    const manifests = new Map();
    (0, exports.walkXfaTree)(root, (node, fieldCtx) => {
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
            if (child.nodeType !== node_html_better_parser_1.NodeType.ELEMENT_NODE)
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
exports.collectXfaSignatures = collectXfaSignatures;
//# sourceMappingURL=xfa.js.map