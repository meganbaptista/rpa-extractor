"use strict";
/** PNG binary read/write helpers and CRC32. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.nextZero = nextZero;
exports.readUshort = readUshort;
exports.writeUshort = writeUshort;
exports.readUint = readUint;
exports.writeUint = writeUint;
exports.readASCII = readASCII;
exports.writeASCII = writeASCII;
exports.readBytes = readBytes;
exports.readUTF8 = readUTF8;
exports.crc = crc;
function nextZero(data, p) {
    while (data[p] !== 0)
        p++;
    return p;
}
function readUshort(buff, p) {
    return (buff[p] << 8) | buff[p + 1];
}
function writeUshort(buff, p, n) {
    buff[p] = (n >> 8) & 255;
    buff[p + 1] = n & 255;
}
function readUint(buff, p) {
    return (buff[p] * (256 * 256 * 256) +
        ((buff[p + 1] << 16) | (buff[p + 2] << 8) | buff[p + 3]));
}
function writeUint(buff, p, n) {
    buff[p] = (n >> 24) & 255;
    buff[p + 1] = (n >> 16) & 255;
    buff[p + 2] = (n >> 8) & 255;
    buff[p + 3] = n & 255;
}
function readASCII(buff, p, l) {
    let s = '';
    for (let i = 0; i < l; i++)
        s += String.fromCharCode(buff[p + i]);
    return s;
}
function writeASCII(data, p, s) {
    for (let i = 0; i < s.length; i++)
        data[p + i] = s.charCodeAt(i);
}
function readBytes(buff, p, l) {
    const arr = [];
    for (let i = 0; i < l; i++)
        arr.push(buff[p + i]);
    return arr;
}
function padHex(n) {
    return n.length < 2 ? '0' + n : n;
}
function readUTF8(buff, p, l) {
    let s = '';
    for (let i = 0; i < l; i++) {
        s += '%' + padHex(buff[p + i].toString(16));
    }
    try {
        return decodeURIComponent(s);
    }
    catch (_a) {
        return readASCII(buff, p, l);
    }
}
const CRC_TABLE = (() => {
    const tab = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        tab[n] = c;
    }
    return tab;
})();
function crcUpdate(c, buf, off, len) {
    for (let i = 0; i < len; i++) {
        c = CRC_TABLE[(c ^ buf[off + i]) & 0xff] ^ (c >>> 8);
    }
    return c;
}
/** PNG-style CRC32 over `buf[off .. off+len)`. */
function crc(buf, off, len) {
    return crcUpdate(0xffffffff, buf, off, len) ^ 0xffffffff;
}
//# sourceMappingURL=binary.js.map