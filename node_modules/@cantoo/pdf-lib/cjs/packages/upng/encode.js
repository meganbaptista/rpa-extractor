"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.compress = compress;
exports.encode = encode;
exports.encodeLL = encodeLL;
const fflate_1 = require("fflate");
const binary_1 = require("./binary");
const dither_1 = require("./dither");
const filter_1 = require("./filter");
const framize_1 = require("./framize");
const quantize_1 = require("./quantize");
function filterAndCompress(img, h, bpp, bpl, filter, levelZero) {
    const data = new Uint8Array(h * bpl + h);
    let ftry = [0, 1, 2, 3, 4];
    if (filter !== -1)
        ftry = [filter];
    else if (h * bpl > 500000 || bpp === 1)
        ftry = [0];
    const opts = levelZero ? { level: 0 } : {};
    const fls = [];
    for (let i = 0; i < ftry.length; i++) {
        for (let y = 0; y < h; y++) {
            (0, filter_1.filterLine)(data, img, y, bpl, bpp, ftry[i]);
        }
        fls.push((0, fflate_1.zlibSync)(data, opts));
    }
    let ti = 0;
    let tsize = 1e9;
    for (let i = 0; i < fls.length; i++) {
        if (fls[i].length < tsize) {
            ti = i;
            tsize = fls[i].length;
        }
    }
    return fls[ti];
}
function compressPNG(nimg, filter, levelZero = false) {
    for (const frm of nimg.frames) {
        const nh = frm.rect.height;
        frm.cimg = filterAndCompress(frm.img, nh, frm.bpp, frm.bpl, filter, levelZero);
    }
}
function writePNG(nimg, w, h, dels, tabs) {
    var _a, _b;
    if (tabs === undefined)
        tabs = {};
    const anim = nimg.frames.length > 1;
    let pltAlpha = false;
    let leng = 8 + (16 + 5 + 4) + (anim ? 20 : 0);
    if (tabs.sRGB !== undefined)
        leng += 8 + 1 + 4;
    if (tabs.pHYs !== undefined)
        leng += 8 + 9 + 4;
    if (nimg.ctype === 3 && nimg.plte) {
        const dl = nimg.plte.length;
        for (let i = 0; i < dl; i++) {
            if (nimg.plte[i] >>> 24 !== 255)
                pltAlpha = true;
        }
        leng += 8 + dl * 3 + 4 + (pltAlpha ? 8 + dl * 1 + 4 : 0);
    }
    for (let j = 0; j < nimg.frames.length; j++) {
        const fr = nimg.frames[j];
        if (anim)
            leng += 38;
        leng += fr.cimg.length + 12;
        if (j !== 0)
            leng += 4;
    }
    leng += 12;
    const data = new Uint8Array(leng);
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    for (let i = 0; i < 8; i++)
        data[i] = sig[i];
    let offset = 8;
    (0, binary_1.writeUint)(data, offset, 13);
    offset += 4;
    (0, binary_1.writeASCII)(data, offset, 'IHDR');
    offset += 4;
    (0, binary_1.writeUint)(data, offset, w);
    offset += 4;
    (0, binary_1.writeUint)(data, offset, h);
    offset += 4;
    data[offset++] = nimg.depth;
    data[offset++] = nimg.ctype;
    data[offset++] = 0;
    data[offset++] = 0;
    data[offset++] = 0;
    (0, binary_1.writeUint)(data, offset, (0, binary_1.crc)(data, offset - 17, 17));
    offset += 4;
    if (tabs.sRGB !== undefined) {
        (0, binary_1.writeUint)(data, offset, 1);
        offset += 4;
        (0, binary_1.writeASCII)(data, offset, 'sRGB');
        offset += 4;
        data[offset++] = tabs.sRGB;
        (0, binary_1.writeUint)(data, offset, (0, binary_1.crc)(data, offset - 5, 5));
        offset += 4;
    }
    if (tabs.pHYs !== undefined) {
        (0, binary_1.writeUint)(data, offset, 9);
        offset += 4;
        (0, binary_1.writeASCII)(data, offset, 'pHYs');
        offset += 4;
        (0, binary_1.writeUint)(data, offset, tabs.pHYs[0]);
        offset += 4;
        (0, binary_1.writeUint)(data, offset, tabs.pHYs[1]);
        offset += 4;
        data[offset++] = tabs.pHYs[2];
        (0, binary_1.writeUint)(data, offset, (0, binary_1.crc)(data, offset - 13, 13));
        offset += 4;
    }
    if (anim) {
        (0, binary_1.writeUint)(data, offset, 8);
        offset += 4;
        (0, binary_1.writeASCII)(data, offset, 'acTL');
        offset += 4;
        (0, binary_1.writeUint)(data, offset, nimg.frames.length);
        offset += 4;
        (0, binary_1.writeUint)(data, offset, (_a = tabs.loop) !== null && _a !== void 0 ? _a : 0);
        offset += 4;
        (0, binary_1.writeUint)(data, offset, (0, binary_1.crc)(data, offset - 12, 12));
        offset += 4;
    }
    if (nimg.ctype === 3 && nimg.plte) {
        const dl = nimg.plte.length;
        (0, binary_1.writeUint)(data, offset, dl * 3);
        offset += 4;
        (0, binary_1.writeASCII)(data, offset, 'PLTE');
        offset += 4;
        for (let i = 0; i < dl; i++) {
            const ti = i * 3;
            const c = nimg.plte[i];
            data[offset + ti] = c & 255;
            data[offset + ti + 1] = (c >>> 8) & 255;
            data[offset + ti + 2] = (c >>> 16) & 255;
        }
        offset += dl * 3;
        (0, binary_1.writeUint)(data, offset, (0, binary_1.crc)(data, offset - dl * 3 - 4, dl * 3 + 4));
        offset += 4;
        if (pltAlpha) {
            (0, binary_1.writeUint)(data, offset, dl);
            offset += 4;
            (0, binary_1.writeASCII)(data, offset, 'tRNS');
            offset += 4;
            for (let i = 0; i < dl; i++) {
                data[offset + i] = (nimg.plte[i] >>> 24) & 255;
            }
            offset += dl;
            (0, binary_1.writeUint)(data, offset, (0, binary_1.crc)(data, offset - dl - 4, dl + 4));
            offset += 4;
        }
    }
    let fi = 0;
    for (let j = 0; j < nimg.frames.length; j++) {
        const fr = nimg.frames[j];
        if (anim) {
            (0, binary_1.writeUint)(data, offset, 26);
            offset += 4;
            (0, binary_1.writeASCII)(data, offset, 'fcTL');
            offset += 4;
            (0, binary_1.writeUint)(data, offset, fi++);
            offset += 4;
            (0, binary_1.writeUint)(data, offset, fr.rect.width);
            offset += 4;
            (0, binary_1.writeUint)(data, offset, fr.rect.height);
            offset += 4;
            (0, binary_1.writeUint)(data, offset, fr.rect.x);
            offset += 4;
            (0, binary_1.writeUint)(data, offset, fr.rect.y);
            offset += 4;
            (0, binary_1.writeUshort)(data, offset, (_b = dels === null || dels === void 0 ? void 0 : dels[j]) !== null && _b !== void 0 ? _b : 0);
            offset += 2;
            (0, binary_1.writeUshort)(data, offset, 1000);
            offset += 2;
            data[offset++] = fr.dispose;
            data[offset++] = fr.blend;
            (0, binary_1.writeUint)(data, offset, (0, binary_1.crc)(data, offset - 30, 30));
            offset += 4;
        }
        const imgd = fr.cimg;
        const dl = imgd.length;
        (0, binary_1.writeUint)(data, offset, dl + (j === 0 ? 0 : 4));
        offset += 4;
        const ioff = offset;
        (0, binary_1.writeASCII)(data, offset, j === 0 ? 'IDAT' : 'fdAT');
        offset += 4;
        if (j !== 0) {
            (0, binary_1.writeUint)(data, offset, fi++);
            offset += 4;
        }
        data.set(imgd, offset);
        offset += dl;
        (0, binary_1.writeUint)(data, offset, (0, binary_1.crc)(data, ioff, offset - ioff));
        offset += 4;
    }
    (0, binary_1.writeUint)(data, offset, 0);
    offset += 4;
    (0, binary_1.writeASCII)(data, offset, 'IEND');
    offset += 4;
    (0, binary_1.writeUint)(data, offset, (0, binary_1.crc)(data, offset - 4, 4));
    offset += 4;
    return data.buffer;
}
function packIndexed(inds, nw, nh, depth) {
    const bpl = Math.ceil((depth * nw) / 8);
    const nimg = new Uint8Array(bpl * nh);
    for (let y = 0; y < nh; y++) {
        const i = y * bpl;
        const ii = y * nw;
        if (depth === 8) {
            for (let x = 0; x < nw; x++)
                nimg[i + x] = inds[ii + x];
        }
        else if (depth === 4) {
            for (let x = 0; x < nw; x++) {
                nimg[i + (x >> 1)] |= inds[ii + x] << (4 - (x & 1) * 4);
            }
        }
        else if (depth === 2) {
            for (let x = 0; x < nw; x++) {
                nimg[i + (x >> 2)] |= inds[ii + x] << (6 - (x & 3) * 2);
            }
        }
        else if (depth === 1) {
            for (let x = 0; x < nw; x++) {
                nimg[i + (x >> 3)] |= inds[ii + x] << (7 - (x & 7));
            }
        }
    }
    return nimg;
}
/**
 * Build an `EncodeImage` from RGBA8 frame buffers.
 *
 * `ps` is the maximum palette size: 0 keeps the image lossless (an indexed
 * PNG is still produced when the frames hold ≤ 256 colors), anything else
 * quantizes the frames down to `ps` colors.
 */
function compress(bufs, w, h, ps, prms) {
    const [onlyBlend, evenCrd, forbidPrev, minBits, forbidPlte, dith] = prms;
    let ctype = 6;
    let depth = 8;
    let alphaAnd = 255;
    for (let j = 0; j < bufs.length; j++) {
        const img = new Uint8Array(bufs[j]);
        for (let i = 0; i < img.length; i += 4)
            alphaAnd &= img[i + 3];
    }
    const gotAlpha = alphaAnd !== 255;
    const frms = (0, framize_1.framize)(bufs, w, h, onlyBlend, evenCrd, forbidPrev);
    const plte = [];
    const inds = [];
    if (ps !== 0) {
        const nbufs = [];
        for (let i = 0; i < frms.length; i++) {
            nbufs.push(frms[i].img.buffer);
        }
        const qres = (0, quantize_1.quantize)((0, framize_1.concatRGBA)(nbufs), ps);
        for (let i = 0; i < qres.plte.length; i++)
            plte.push(qres.plte[i].est.rgba);
        let cof = 0;
        for (let i = 0; i < frms.length; i++) {
            const frm = frms[i];
            const bln = frm.img.length;
            const ind = new Uint8Array(qres.inds.buffer, cof >> 2, bln >> 2);
            inds.push(ind);
            const bb = new Uint8Array(qres.abuf, cof, bln);
            if (dith) {
                (0, dither_1.dither)(frm.img, frm.rect.width, frm.rect.height, plte, bb, ind);
            }
            frm.img.set(bb);
            cof += bln;
        }
    }
    else {
        // Even without quantization the palette may still be usable; later frames
        // can hold colors that are missing from the first one.
        const cmap = new Map();
        for (let j = 0; j < frms.length; j++) {
            const frm = frms[j];
            const img32 = new Uint32Array(frm.img.buffer);
            const nw = frm.rect.width;
            const ilen = img32.length;
            const ind = new Uint8Array(ilen);
            inds.push(ind);
            for (let i = 0; i < ilen; i++) {
                const c = img32[i];
                if (i !== 0 && c === img32[i - 1])
                    ind[i] = ind[i - 1];
                else if (i > nw && c === img32[i - nw])
                    ind[i] = ind[i - nw];
                else {
                    let cmc = cmap.get(c);
                    if (cmc === undefined) {
                        cmc = plte.length;
                        cmap.set(c, cmc);
                        plte.push(c);
                        if (plte.length >= 300)
                            break;
                    }
                    ind[i] = cmc;
                }
            }
        }
    }
    const cc = plte.length;
    const usePlte = cc <= 256 && !forbidPlte;
    if (usePlte) {
        if (cc <= 2)
            depth = 1;
        else if (cc <= 4)
            depth = 2;
        else if (cc <= 16)
            depth = 4;
        else
            depth = 8;
        depth = Math.max(depth, minBits);
    }
    const frames = [];
    for (let j = 0; j < frms.length; j++) {
        const frm = frms[j];
        const nw = frm.rect.width;
        const nh = frm.rect.height;
        let cimg = frm.img;
        let bpl = 4 * nw;
        let bpp = 4;
        if (usePlte) {
            bpl = Math.ceil((depth * nw) / 8);
            cimg = packIndexed(inds[j], nw, nh, depth);
            ctype = 3;
            bpp = 1;
        }
        else if (!gotAlpha && frms.length === 1) {
            // Later "reduced" frames may still carry alpha for blending.
            const nimg = new Uint8Array(nw * nh * 3);
            const area = nw * nh;
            for (let i = 0; i < area; i++) {
                const ti = i * 3;
                const qi = i * 4;
                nimg[ti] = cimg[qi];
                nimg[ti + 1] = cimg[qi + 1];
                nimg[ti + 2] = cimg[qi + 2];
            }
            cimg = nimg;
            ctype = 2;
            bpp = 3;
            bpl = 3 * nw;
        }
        frames.push({
            rect: frm.rect,
            img: cimg,
            blend: frm.blend,
            dispose: frm.dispose,
            bpp,
            bpl,
        });
    }
    return { ctype, depth, plte, frames };
}
/**
 * Encode RGBA8 frame buffers as a PNG / APNG.
 *
 * `cnum` is the palette size: 0 (default) encodes losslessly, any other
 * value quantizes the image to at most `cnum` colors.
 */
function encode(imgs, w, h, cnum = 0, dels, tabs, forbidPlte = false) {
    const nimg = compress(imgs, w, h, cnum, [
        false,
        false,
        false,
        0,
        forbidPlte,
        false,
    ]);
    compressPNG(nimg, -1);
    return writePNG(nimg, w, h, dels, tabs);
}
/**
 * Lossless encode of raw sample buffers (`cc` color + `ac` alpha channels).
 */
function encodeLL(imgs, w, h, cc, ac, depth, dels, tabs) {
    const nimg = {
        ctype: 0 + (cc === 1 ? 0 : 2) + (ac === 0 ? 0 : 4),
        depth,
        frames: [],
    };
    const bipp = (cc + ac) * depth;
    const bipl = bipp * w;
    for (let i = 0; i < imgs.length; i++) {
        nimg.frames.push({
            rect: { x: 0, y: 0, width: w, height: h },
            img: new Uint8Array(imgs[i]),
            blend: 0,
            dispose: 1,
            bpp: Math.ceil(bipp / 8),
            bpl: Math.ceil(bipl / 8),
        });
    }
    compressPNG(nimg, 0, true);
    return writePNG(nimg, w, h, dels, tabs);
}
//# sourceMappingURL=encode.js.map