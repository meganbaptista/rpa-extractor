"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractImageBytes = void 0;
const tslib_1 = require("tslib");
const fflate_1 = require("fflate");
const PDFArray_1 = tslib_1.__importDefault(require("../../core/objects/PDFArray"));
const PDFName_1 = tslib_1.__importDefault(require("../../core/objects/PDFName"));
const PDFNumber_1 = tslib_1.__importDefault(require("../../core/objects/PDFNumber"));
const PDFRawStream_1 = tslib_1.__importDefault(require("../../core/objects/PDFRawStream"));
const PDFStream_1 = tslib_1.__importDefault(require("../../core/objects/PDFStream"));
const decode_1 = require("../../core/streams/decode");
const PDFContentStream_1 = tslib_1.__importDefault(require("../../core/structures/PDFContentStream"));
/**
 * Convert an Image XObject stream into usable image file bytes.
 * - DCTDecode → JPEG bytes as stored
 * - DeviceRGB / DeviceGray 8-bit (typically Flate) → PNG
 * Returns undefined for unsupported color spaces / filters.
 */
const extractImageBytes = (stream) => {
    var _a, _b, _c;
    const dict = stream.dict;
    const width = dict.lookup(PDFName_1.default.of('Width'), PDFNumber_1.default).asNumber();
    const height = dict.lookup(PDFName_1.default.of('Height'), PDFNumber_1.default).asNumber();
    const bits = (_b = (_a = dict.lookupMaybe(PDFName_1.default.of('BitsPerComponent'), PDFNumber_1.default)) === null || _a === void 0 ? void 0 : _a.asNumber()) !== null && _b !== void 0 ? _b : 8;
    if (hasFilter(dict, 'DCTDecode')) {
        const bytes = getRawContents(stream);
        return { width, height, mimeType: 'image/jpeg', bytes };
    }
    if (hasFilter(dict, 'JPXDecode')) {
        return undefined;
    }
    const colorSpace = dict.lookup(PDFName_1.default.of('ColorSpace'));
    let csName;
    if (colorSpace instanceof PDFName_1.default) {
        csName = colorSpace.decodeText();
    }
    else if (colorSpace instanceof PDFArray_1.default) {
        csName = (_c = colorSpace.lookupMaybe(0, PDFName_1.default)) === null || _c === void 0 ? void 0 : _c.decodeText();
    }
    if (bits !== 8)
        return undefined;
    if (csName !== 'DeviceRGB' &&
        csName !== 'DeviceGray' &&
        csName !== 'CalRGB') {
        return undefined;
    }
    let pixels;
    try {
        pixels = getDecodedContents(stream);
    }
    catch (_d) {
        return undefined;
    }
    const channels = csName === 'DeviceGray' ? 1 : 3;
    const expected = width * height * channels;
    if (pixels.length < expected)
        return undefined;
    if (pixels.length > expected)
        pixels = pixels.subarray(0, expected);
    let smaskPixels;
    const smask = dict.lookup(PDFName_1.default.of('SMask'));
    if (smask instanceof PDFStream_1.default) {
        try {
            smaskPixels = getDecodedContents(smask);
            if (smaskPixels.length >= width * height) {
                smaskPixels = smaskPixels.subarray(0, width * height);
            }
            else {
                smaskPixels = undefined;
            }
        }
        catch (_e) {
            smaskPixels = undefined;
        }
    }
    const pngBytes = encodePng(pixels, width, height, channels, smaskPixels);
    return { width, height, mimeType: 'image/png', bytes: pngBytes };
};
exports.extractImageBytes = extractImageBytes;
const hasFilter = (dict, name) => {
    const filter = dict.lookup(PDFName_1.default.of('Filter'));
    const target = PDFName_1.default.of(name);
    if (filter === target)
        return true;
    if (filter instanceof PDFArray_1.default) {
        for (let i = 0, len = filter.size(); i < len; i++) {
            if (filter.lookup(i) === target)
                return true;
        }
    }
    return false;
};
const getRawContents = (stream) => {
    if (stream instanceof PDFRawStream_1.default) {
        return new Uint8Array(stream.contents);
    }
    if (stream instanceof PDFContentStream_1.default) {
        return new Uint8Array(stream.getContents());
    }
    return new Uint8Array(stream.getContents());
};
const getDecodedContents = (stream) => {
    if (stream instanceof PDFRawStream_1.default) {
        return (0, decode_1.decodePDFRawStream)(stream).decode();
    }
    if (stream instanceof PDFContentStream_1.default) {
        return stream.getUnencodedContents();
    }
    return stream.getContents();
};
/** Minimal PNG encoder (8-bit Gray / RGB / RGBA, filter none). */
const encodePng = (pixels, width, height, channels, alpha) => {
    const colorType = alpha ? 6 : channels === 1 ? 0 : 2; // Gray / RGB / RGBA
    const outChannels = alpha ? 4 : channels;
    const stride = width * outChannels;
    const raw = new Uint8Array((stride + 1) * height);
    for (let y = 0; y < height; y++) {
        const rowStart = y * (stride + 1);
        raw[rowStart] = 0; // filter: None
        if (alpha) {
            for (let x = 0; x < width; x++) {
                const dst = rowStart + 1 + x * 4;
                if (channels === 1) {
                    const g = pixels[y * width + x];
                    raw[dst] = g;
                    raw[dst + 1] = g;
                    raw[dst + 2] = g;
                }
                else {
                    const src = (y * width + x) * 3;
                    raw[dst] = pixels[src];
                    raw[dst + 1] = pixels[src + 1];
                    raw[dst + 2] = pixels[src + 2];
                }
                raw[dst + 3] = alpha[y * width + x];
            }
        }
        else {
            raw.set(pixels.subarray(y * stride, y * stride + stride), rowStart + 1);
        }
    }
    const compressed = (0, fflate_1.zlibSync)(raw);
    const signature = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    const ihdr = new Uint8Array(13);
    writeUint32(ihdr, 0, width);
    writeUint32(ihdr, 4, height);
    ihdr[8] = 8; // bit depth
    ihdr[9] = colorType;
    ihdr[10] = 0; // compression
    ihdr[11] = 0; // filter
    ihdr[12] = 0; // interlace
    const parts = [
        signature,
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', compressed),
        pngChunk('IEND', new Uint8Array(0)),
    ];
    let total = 0;
    for (let i = 0; i < parts.length; i++)
        total += parts[i].length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (let i = 0; i < parts.length; i++) {
        out.set(parts[i], offset);
        offset += parts[i].length;
    }
    return out;
};
const pngChunk = (type, data) => {
    const chunk = new Uint8Array(12 + data.length);
    writeUint32(chunk, 0, data.length);
    chunk[4] = type.charCodeAt(0);
    chunk[5] = type.charCodeAt(1);
    chunk[6] = type.charCodeAt(2);
    chunk[7] = type.charCodeAt(3);
    chunk.set(data, 8);
    const crc = crc32(chunk.subarray(4, 8 + data.length));
    writeUint32(chunk, 8 + data.length, crc);
    return chunk;
};
const writeUint32 = (bytes, offset, value) => {
    bytes[offset] = (value >>> 24) & 0xff;
    bytes[offset + 1] = (value >>> 16) & 0xff;
    bytes[offset + 2] = (value >>> 8) & 0xff;
    bytes[offset + 3] = value & 0xff;
};
const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c;
    }
    return table;
})();
const crc32 = (data) => {
    let c = 0xffffffff;
    for (let i = 0; i < data.length; i++) {
        c = crcTable[(c ^ data[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
};
//# sourceMappingURL=imageBytes.js.map