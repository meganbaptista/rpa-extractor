"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractPageContents = void 0;
const tslib_1 = require("tslib");
const PDFArray_1 = tslib_1.__importDefault(require("../../core/objects/PDFArray"));
const PDFDict_1 = tslib_1.__importDefault(require("../../core/objects/PDFDict"));
const PDFName_1 = tslib_1.__importDefault(require("../../core/objects/PDFName"));
const PDFNumber_1 = tslib_1.__importDefault(require("../../core/objects/PDFNumber"));
const PDFRawStream_1 = tslib_1.__importDefault(require("../../core/objects/PDFRawStream"));
const PDFRef_1 = tslib_1.__importDefault(require("../../core/objects/PDFRef"));
const PDFStream_1 = tslib_1.__importDefault(require("../../core/objects/PDFStream"));
const decode_1 = require("../../core/streams/decode");
const PDFContentStream_1 = tslib_1.__importDefault(require("../../core/structures/PDFContentStream"));
const CharCodes_1 = tslib_1.__importDefault(require("../../core/syntax/CharCodes"));
const matrix_1 = require("../../types/matrix");
const utils_1 = require("../../utils");
const ContentStreamParser_1 = require("./ContentStreamParser");
const FontDecoder_1 = require("./FontDecoder");
const graphicsSvg_1 = require("./graphicsSvg");
const imageBytes_1 = require("./imageBytes");
/** Same convention as `combineMatrix` in svg.ts: A × B */
const multiply = ([a, b, c, d, e, f], [a2, b2, c2, d2, e2, f2]) => [
    a * a2 + c * b2,
    b * a2 + d * b2,
    a * c2 + c * d2,
    b * c2 + d * d2,
    a * e2 + c * f2 + e,
    b * e2 + d * f2 + f,
];
const cloneMatrix = (m) => [
    m[0],
    m[1],
    m[2],
    m[3],
    m[4],
    m[5],
];
/**
 * Extract typed text, image, and vector graphics assets from a page's content streams.
 */
const extractPageContents = (page) => {
    page.normalize();
    const { Contents, Resources } = page.normalizedEntries();
    if (!Contents)
        return [];
    const bytes = decodeContentsArray(Contents);
    const operations = (0, ContentStreamParser_1.parseContentStream)(bytes);
    return walkOperations(operations, Resources, page.context, new Set(), matrix_1.identityMatrix);
};
exports.extractPageContents = extractPageContents;
const decodeContentsArray = (contents) => {
    const newline = Uint8Array.of(CharCodes_1.default.Newline);
    const parts = [];
    for (let idx = 0, len = contents.size(); idx < len; idx++) {
        const stream = contents.lookup(idx, PDFStream_1.default);
        parts.push(decodeStreamBytes(stream), newline);
    }
    return (0, utils_1.mergeIntoTypedArray)(...parts);
};
const decodeStreamBytes = (stream) => {
    if (stream instanceof PDFRawStream_1.default) {
        return (0, decode_1.decodePDFRawStream)(stream).decode();
    }
    if (stream instanceof PDFContentStream_1.default) {
        return stream.getUnencodedContents();
    }
    return stream.getContents();
};
const walkOperations = (operations, resources, context, visitedForms, initialCtm) => {
    var _a;
    const assets = [];
    const fontCache = new Map();
    let gs = {
        ctm: cloneMatrix(initialCtm),
        lineWidth: 1,
    };
    const gsStack = [];
    const path = new graphicsSvg_1.PdfPathBuilder();
    let textMatrix = cloneMatrix(matrix_1.identityMatrix);
    let textLineMatrix = cloneMatrix(matrix_1.identityMatrix);
    let leading = 0;
    let currentFont;
    let fontSize = 0;
    let textBuffer = '';
    let textMeta;
    let inTextObject = false;
    const flushText = () => {
        if (textBuffer.length > 0 && textMeta) {
            const text = textBuffer;
            const meta = textMeta;
            assets.push({
                kind: 'text',
                getText: () => text,
                x: meta.x,
                y: meta.y,
                fontSize: meta.fontSize,
                fontFamily: meta.fontFamily,
            });
        }
        textBuffer = '';
        textMeta = undefined;
    };
    const textPosition = () => {
        const combined = multiply(textMatrix, gs.ctm);
        return { x: combined[4], y: combined[5] };
    };
    const captureTextMetaIfNeeded = () => {
        var _a;
        if (textMeta)
            return;
        const pos = textPosition();
        textMeta = {
            x: pos.x,
            y: pos.y,
            fontSize,
            fontFamily: (_a = currentFont === null || currentFont === void 0 ? void 0 : currentFont.fontFamily) !== null && _a !== void 0 ? _a : 'Unknown',
        };
    };
    const resolveFont = (name) => {
        const cached = fontCache.get(name);
        if (cached)
            return cached;
        const fontDict = lookupResource(resources, 'Font', name, context);
        if (!(fontDict instanceof PDFDict_1.default))
            return undefined;
        const decoder = FontDecoder_1.FontDecoder.forFontDict(fontDict, context);
        fontCache.set(name, decoder);
        return decoder;
    };
    const appendText = (value) => {
        if (!value)
            return;
        captureTextMetaIfNeeded();
        textBuffer += value;
    };
    const paintPath = (opts) => {
        var _a, _b;
        if (opts.close)
            path.closePath();
        if (path.isEmpty) {
            path.clear();
            return;
        }
        const result = path.paint(gs.ctm, {
            fill: opts.fill
                ? ((_a = gs.fill) !== null && _a !== void 0 ? _a : '#000000')
                : opts.stroke
                    ? 'none'
                    : undefined,
            stroke: opts.stroke ? ((_b = gs.stroke) !== null && _b !== void 0 ? _b : '#000000') : 'none',
            fillRule: opts.evenOdd ? 'evenodd' : undefined,
            lineWidth: gs.lineWidth,
        });
        path.clear();
        if (!result)
            return;
        const svg = result.svg;
        assets.push({
            kind: 'graphics',
            x: result.x,
            y: result.y,
            width: result.width,
            height: result.height,
            getSvg: () => svg,
        });
    };
    const num = (args, i) => typeof args[i] === 'number' ? args[i] : 0;
    for (const op of operations) {
        switch (op.name) {
            case 'q':
                gsStack.push({
                    ctm: cloneMatrix(gs.ctm),
                    fill: gs.fill,
                    stroke: gs.stroke,
                    lineWidth: gs.lineWidth,
                });
                break;
            case 'Q': {
                const restored = gsStack.pop();
                gs = restored
                    ? {
                        ctm: cloneMatrix(restored.ctm),
                        fill: restored.fill,
                        stroke: restored.stroke,
                        lineWidth: restored.lineWidth,
                    }
                    : { ctm: cloneMatrix(matrix_1.identityMatrix), lineWidth: 1 };
                break;
            }
            case 'cm': {
                const m = argsToMatrix(op.args);
                if (m)
                    gs.ctm = multiply(gs.ctm, m);
                break;
            }
            case 'w':
                gs.lineWidth = num(op.args, 0);
                break;
            case 'rg':
                gs.fill = (0, graphicsSvg_1.rgbCss)(num(op.args, 0), num(op.args, 1), num(op.args, 2));
                break;
            case 'RG':
                gs.stroke = (0, graphicsSvg_1.rgbCss)(num(op.args, 0), num(op.args, 1), num(op.args, 2));
                break;
            case 'g':
                gs.fill = (0, graphicsSvg_1.grayCss)(num(op.args, 0));
                break;
            case 'G':
                gs.stroke = (0, graphicsSvg_1.grayCss)(num(op.args, 0));
                break;
            case 'k':
                gs.fill = (0, graphicsSvg_1.cmykCss)(num(op.args, 0), num(op.args, 1), num(op.args, 2), num(op.args, 3));
                break;
            case 'K':
                gs.stroke = (0, graphicsSvg_1.cmykCss)(num(op.args, 0), num(op.args, 1), num(op.args, 2), num(op.args, 3));
                break;
            case 'm':
                path.moveTo(num(op.args, 0), num(op.args, 1));
                break;
            case 'l':
                path.lineTo(num(op.args, 0), num(op.args, 1));
                break;
            case 'c':
                path.curveTo(num(op.args, 0), num(op.args, 1), num(op.args, 2), num(op.args, 3), num(op.args, 4), num(op.args, 5));
                break;
            case 'v':
                path.curveV(num(op.args, 0), num(op.args, 1), num(op.args, 2), num(op.args, 3));
                break;
            case 'y':
                path.curveY(num(op.args, 0), num(op.args, 1), num(op.args, 2), num(op.args, 3));
                break;
            case 'h':
                path.closePath();
                break;
            case 're':
                path.rectangle(num(op.args, 0), num(op.args, 1), num(op.args, 2), num(op.args, 3));
                break;
            case 'W':
            case 'W*':
                // Clip path — discarded on following `n`
                break;
            case 'n':
                path.clear();
                break;
            case 'f':
            case 'F':
                paintPath({ fill: true });
                break;
            case 'f*':
                paintPath({ fill: true, evenOdd: true });
                break;
            case 'S':
                paintPath({ stroke: true });
                break;
            case 's':
                paintPath({ stroke: true, close: true });
                break;
            case 'B':
                paintPath({ fill: true, stroke: true });
                break;
            case 'B*':
                paintPath({ fill: true, stroke: true, evenOdd: true });
                break;
            case 'b':
                paintPath({ fill: true, stroke: true, close: true });
                break;
            case 'b*':
                paintPath({ fill: true, stroke: true, close: true, evenOdd: true });
                break;
            case 'BT':
                inTextObject = true;
                textBuffer = '';
                textMeta = undefined;
                textMatrix = cloneMatrix(matrix_1.identityMatrix);
                textLineMatrix = cloneMatrix(matrix_1.identityMatrix);
                break;
            case 'ET':
                flushText();
                inTextObject = false;
                break;
            case 'Tf': {
                const fontArg = op.args[0];
                const sizeArg = op.args[1];
                if (isName(fontArg)) {
                    currentFont = resolveFont(fontArg.value);
                }
                if (typeof sizeArg === 'number') {
                    fontSize = sizeArg;
                }
                break;
            }
            case 'TL': {
                if (typeof op.args[0] === 'number')
                    leading = op.args[0];
                break;
            }
            case 'Tm': {
                const m = argsToMatrix(op.args);
                if (m) {
                    textMatrix = m;
                    textLineMatrix = cloneMatrix(m);
                }
                break;
            }
            case 'Td': {
                const tx = typeof op.args[0] === 'number' ? op.args[0] : 0;
                const ty = typeof op.args[1] === 'number' ? op.args[1] : 0;
                textMatrix = multiply([1, 0, 0, 1, tx, ty], textLineMatrix);
                textLineMatrix = cloneMatrix(textMatrix);
                if (textBuffer.length > 0 && !textBuffer.endsWith('\n')) {
                    textBuffer += '\n';
                }
                break;
            }
            case 'TD': {
                const tx = typeof op.args[0] === 'number' ? op.args[0] : 0;
                const ty = typeof op.args[1] === 'number' ? op.args[1] : 0;
                leading = -ty;
                textMatrix = multiply([1, 0, 0, 1, tx, ty], textLineMatrix);
                textLineMatrix = cloneMatrix(textMatrix);
                if (textBuffer.length > 0 && !textBuffer.endsWith('\n')) {
                    textBuffer += '\n';
                }
                break;
            }
            case 'T*': {
                textMatrix = multiply([1, 0, 0, 1, 0, -leading], textLineMatrix);
                textLineMatrix = cloneMatrix(textMatrix);
                if (textBuffer.length > 0 && !textBuffer.endsWith('\n')) {
                    textBuffer += '\n';
                }
                break;
            }
            case 'Tj':
            case "'":
            case '"': {
                if (op.name === "'" || op.name === '"') {
                    textMatrix = multiply([1, 0, 0, 1, 0, -leading], textLineMatrix);
                    textLineMatrix = cloneMatrix(textMatrix);
                }
                const strArg = op.name === '"' ? op.args[2] : op.args[0];
                if ((0, FontDecoder_1.isStringOperand)(strArg) && currentFont) {
                    appendText(currentFont.decode(strArg));
                }
                break;
            }
            case 'TJ': {
                const arr = op.args[0];
                if (Array.isArray(arr) && currentFont) {
                    for (const item of arr) {
                        if ((0, FontDecoder_1.isStringOperand)(item)) {
                            appendText(currentFont.decode(item));
                        }
                    }
                }
                break;
            }
            case 'Do': {
                flushText();
                path.clear();
                const nameArg = op.args[0];
                if (!isName(nameArg))
                    break;
                const xObject = lookupResource(resources, 'XObject', nameArg.value, context);
                if (!(xObject instanceof PDFStream_1.default))
                    break;
                const subtype = xObject.dict.lookup(PDFName_1.default.of('Subtype'));
                if (subtype === PDFName_1.default.of('Image')) {
                    const image = (0, imageBytes_1.extractImageBytes)(xObject);
                    if (image) {
                        const { width, height, mimeType, bytes } = image;
                        assets.push({
                            kind: 'image',
                            x: gs.ctm[4],
                            y: gs.ctm[5],
                            width,
                            height,
                            drawWidth: Math.hypot(gs.ctm[0], gs.ctm[1]),
                            drawHeight: Math.hypot(gs.ctm[2], gs.ctm[3]),
                            mimeType,
                            getBytes: () => bytes.slice(),
                        });
                    }
                }
                else if (subtype === PDFName_1.default.of('Form')) {
                    const refKey = formVisitKey(xObject, context);
                    if (visitedForms.has(refKey))
                        break;
                    visitedForms.add(refKey);
                    const formResources = (_a = xObject.dict.lookupMaybe(PDFName_1.default.of('Resources'), PDFDict_1.default)) !== null && _a !== void 0 ? _a : resources;
                    const formMatrix = readFormMatrix(xObject.dict);
                    const formCtm = multiply(gs.ctm, formMatrix);
                    const formBytes = decodeStreamBytes(xObject);
                    const formOps = (0, ContentStreamParser_1.parseContentStream)(formBytes);
                    assets.push(...walkOperations(formOps, formResources, context, visitedForms, formCtm));
                }
                break;
            }
            default:
                break;
        }
    }
    if (inTextObject)
        flushText();
    return assets;
};
const argsToMatrix = (args) => {
    if (args.length >= 6 &&
        typeof args[0] === 'number' &&
        typeof args[1] === 'number' &&
        typeof args[2] === 'number' &&
        typeof args[3] === 'number' &&
        typeof args[4] === 'number' &&
        typeof args[5] === 'number') {
        return [args[0], args[1], args[2], args[3], args[4], args[5]];
    }
    return undefined;
};
const readFormMatrix = (dict) => {
    const matrix = dict.lookup(PDFName_1.default.of('Matrix'));
    if (!(matrix instanceof PDFArray_1.default) || matrix.size() < 6) {
        return cloneMatrix(matrix_1.identityMatrix);
    }
    const values = [];
    for (let i = 0; i < 6; i++) {
        const n = matrix.lookup(i);
        values.push(n instanceof PDFNumber_1.default ? n.asNumber() : 0);
    }
    return values;
};
const isName = (value) => !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    value.type === 'name';
const lookupResource = (resources, category, name, context) => {
    if (!resources)
        return undefined;
    const categoryDict = resources.lookup(PDFName_1.default.of(category));
    if (!(categoryDict instanceof PDFDict_1.default))
        return undefined;
    const value = categoryDict.get(PDFName_1.default.of(name));
    if (value instanceof PDFRef_1.default)
        return context.lookup(value);
    return value;
};
const formVisitKey = (stream, context) => {
    const entries = context.enumerateIndirectObjects();
    for (let i = 0; i < entries.length; i++) {
        const [ref, obj] = entries[i];
        if (obj === stream)
            return `${ref.objectNumber}R${ref.generationNumber}`;
    }
    return `direct:${assetsIdentity(stream)}`;
};
const streamIds = new WeakMap();
let nextStreamId = 1;
const assetsIdentity = (stream) => {
    let id = streamIds.get(stream);
    if (id === undefined) {
        id = nextStreamId++;
        streamIds.set(stream, id);
    }
    return id;
};
//# sourceMappingURL=extractPageContents.js.map