"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.padStart = exports.decompressJson = exports.decodeFromBase64 = void 0;
/*
 * The `chars`, `lookup`, and `decodeFromBase64` members of this file are
 * licensed under the following:
 *
 *     base64-arraybuffer
 *     https://github.com/niklasvh/base64-arraybuffer
 *
 *     Copyright (c) 2012 Niklas von Hertzen
 *     Licensed under the MIT license.
 *
 */
const fflate_1 = require("fflate");
const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
// Use a lookup table to find the index.
const lookup = new Uint8Array(256);
for (let i = 0; i < chars.length; i++) {
    lookup[chars.charCodeAt(i)] = i;
}
const decodeFromBase64 = (base64) => {
    let bufferLength = base64.length * 0.75;
    const len = base64.length;
    let i;
    let p = 0;
    let encoded1;
    let encoded2;
    let encoded3;
    let encoded4;
    if (base64[base64.length - 1] === '=') {
        bufferLength--;
        if (base64[base64.length - 2] === '=') {
            bufferLength--;
        }
    }
    const bytes = new Uint8Array(bufferLength);
    for (i = 0; i < len; i += 4) {
        encoded1 = lookup[base64.charCodeAt(i)];
        encoded2 = lookup[base64.charCodeAt(i + 1)];
        encoded3 = lookup[base64.charCodeAt(i + 2)];
        encoded4 = lookup[base64.charCodeAt(i + 3)];
        bytes[p++] = (encoded1 << 2) | (encoded2 >> 4);
        bytes[p++] = ((encoded2 & 15) << 4) | (encoded3 >> 2);
        bytes[p++] = ((encoded3 & 3) << 6) | (encoded4 & 63);
    }
    return bytes;
};
exports.decodeFromBase64 = decodeFromBase64;
const arrayToString = (array) => {
    let str = '';
    for (let i = 0; i < array.length; i++) {
        str += String.fromCharCode(array[i]);
    }
    return str;
};
const decompressJson = (compressedJson) => arrayToString((0, fflate_1.unzlibSync)((0, exports.decodeFromBase64)(compressedJson)));
exports.decompressJson = decompressJson;
const padStart = (value, length, padChar) => {
    let padding = '';
    for (let idx = 0, len = length - value.length; idx < len; idx++) {
        padding += padChar;
    }
    return padding + value;
};
exports.padStart = padStart;
//# sourceMappingURL=utils.js.map