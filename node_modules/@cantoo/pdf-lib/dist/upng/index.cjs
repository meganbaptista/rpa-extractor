"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getOwnPropSymbols = Object.getOwnPropertySymbols;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __propIsEnum = Object.prototype.propertyIsEnumerable;
var __objRest = (source, exclude) => {
  var target = {};
  for (var prop in source)
    if (__hasOwnProp.call(source, prop) && exclude.indexOf(prop) < 0)
      target[prop] = source[prop];
  if (source != null && __getOwnPropSymbols)
    for (var prop of __getOwnPropSymbols(source)) {
      if (exclude.indexOf(prop) < 0 && __propIsEnum.call(source, prop))
        target[prop] = source[prop];
    }
  return target;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// index.ts
var index_exports = {};
__export(index_exports, {
  compress: () => compress,
  decode: () => decode,
  default: () => index_default,
  dither: () => dither,
  encode: () => encode,
  encodeLL: () => encodeLL,
  quantize: () => quantize,
  toRGBA8: () => toRGBA8
});
module.exports = __toCommonJS(index_exports);

// decode.ts
var import_fflate = require("fflate");

// binary.ts
function nextZero(data, p) {
  while (data[p] !== 0) p++;
  return p;
}
function readUshort(buff, p) {
  return buff[p] << 8 | buff[p + 1];
}
function writeUshort(buff, p, n) {
  buff[p] = n >> 8 & 255;
  buff[p + 1] = n & 255;
}
function readUint(buff, p) {
  return buff[p] * (256 * 256 * 256) + (buff[p + 1] << 16 | buff[p + 2] << 8 | buff[p + 3]);
}
function writeUint(buff, p, n) {
  buff[p] = n >> 24 & 255;
  buff[p + 1] = n >> 16 & 255;
  buff[p + 2] = n >> 8 & 255;
  buff[p + 3] = n & 255;
}
function readASCII(buff, p, l) {
  let s = "";
  for (let i = 0; i < l; i++) s += String.fromCharCode(buff[p + i]);
  return s;
}
function writeASCII(data, p, s) {
  for (let i = 0; i < s.length; i++) data[p + i] = s.charCodeAt(i);
}
function readBytes(buff, p, l) {
  const arr = [];
  for (let i = 0; i < l; i++) arr.push(buff[p + i]);
  return arr;
}
function padHex(n) {
  return n.length < 2 ? "0" + n : n;
}
function readUTF8(buff, p, l) {
  let s = "";
  for (let i = 0; i < l; i++) {
    s += "%" + padHex(buff[p + i].toString(16));
  }
  try {
    return decodeURIComponent(s);
  } catch (e) {
    return readASCII(buff, p, l);
  }
}
var CRC_TABLE = (() => {
  const tab = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
    }
    tab[n] = c;
  }
  return tab;
})();
function crcUpdate(c, buf, off, len) {
  for (let i = 0; i < len; i++) {
    c = CRC_TABLE[(c ^ buf[off + i]) & 255] ^ c >>> 8;
  }
  return c;
}
function crc(buf, off, len) {
  return crcUpdate(4294967295, buf, off, len) ^ 4294967295;
}

// filter.ts
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = p - a;
  const pb = p - b;
  const pc = p - c;
  if (pa * pa <= pb * pb && pa * pa <= pc * pc) return a;
  if (pb * pb <= pc * pc) return b;
  return c;
}
function getBPP(out) {
  const channels = [1, 0, 3, 1, 2, 0, 4][out.ctype];
  return channels * out.depth;
}
function filterZero(data, out, off, w, h) {
  let bpp = getBPP(out);
  const bpl = Math.ceil(w * bpp / 8);
  bpp = Math.ceil(bpp / 8);
  let type = data[off];
  let x = 0;
  if (type > 1) data[off] = [0, 0, 1][type - 2];
  if (type === 3) {
    for (x = bpp; x < bpl; x++) {
      data[x + 1] = data[x + 1] + (data[x + 1 - bpp] >>> 1) & 255;
    }
  }
  for (let y = 0; y < h; y++) {
    const i = off + y * bpl;
    const di = i + y + 1;
    type = data[di - 1];
    x = 0;
    if (type === 0) {
      for (; x < bpl; x++) data[i + x] = data[di + x];
    } else if (type === 1) {
      for (; x < bpp; x++) data[i + x] = data[di + x];
      for (; x < bpl; x++) data[i + x] = data[di + x] + data[i + x - bpp];
    } else if (type === 2) {
      for (; x < bpl; x++) data[i + x] = data[di + x] + data[i + x - bpl];
    } else if (type === 3) {
      for (; x < bpp; x++) {
        data[i + x] = data[di + x] + (data[i + x - bpl] >>> 1);
      }
      for (; x < bpl; x++) {
        data[i + x] = data[di + x] + (data[i + x - bpl] + data[i + x - bpp] >>> 1);
      }
    } else {
      for (; x < bpp; x++) {
        data[i + x] = data[di + x] + paeth(0, data[i + x - bpl], 0);
      }
      for (; x < bpl; x++) {
        data[i + x] = data[di + x] + paeth(data[i + x - bpp], data[i + x - bpl], data[i + x - bpp - bpl]);
      }
    }
  }
  return data;
}
function readInterlace(data, out) {
  const w = out.width;
  const h = out.height;
  const bpp = getBPP(out);
  const cbpp = bpp >> 3;
  const bpl = Math.ceil(w * bpp / 8);
  const img = new Uint8Array(h * bpl);
  let di = 0;
  const starting_row = [0, 0, 4, 0, 2, 0, 1];
  const starting_col = [0, 4, 0, 2, 0, 1, 0];
  const row_increment = [8, 8, 8, 4, 4, 2, 2];
  const col_increment = [8, 8, 4, 4, 2, 2, 1];
  for (let pass = 0; pass < 7; pass++) {
    const ri = row_increment[pass];
    const ci = col_increment[pass];
    let sw = 0;
    let sh = 0;
    let cr = starting_row[pass];
    while (cr < h) {
      cr += ri;
      sh++;
    }
    let cc = starting_col[pass];
    while (cc < w) {
      cc += ci;
      sw++;
    }
    const bpll = Math.ceil(sw * bpp / 8);
    filterZero(data, out, di, sw, sh);
    let y = 0;
    let row = starting_row[pass];
    while (row < h) {
      let col = starting_col[pass];
      let cdi = di + y * bpll << 3;
      while (col < w) {
        if (bpp === 1) {
          let val = data[cdi >> 3];
          val = val >> 7 - (cdi & 7) & 1;
          img[row * bpl + (col >> 3)] |= val << 7 - (col & 7);
        }
        if (bpp === 2) {
          let val = data[cdi >> 3];
          val = val >> 6 - (cdi & 7) & 3;
          img[row * bpl + (col >> 2)] |= val << 6 - ((col & 3) << 1);
        }
        if (bpp === 4) {
          let val = data[cdi >> 3];
          val = val >> 4 - (cdi & 7) & 15;
          img[row * bpl + (col >> 1)] |= val << 4 - ((col & 1) << 2);
        }
        if (bpp >= 8) {
          const ii = row * bpl + col * cbpp;
          for (let j = 0; j < cbpp; j++) img[ii + j] = data[(cdi >> 3) + j];
        }
        cdi += bpp;
        col += ci;
      }
      y++;
      row += ri;
    }
    if (sw * sh !== 0) di += sh * (1 + bpll);
  }
  return img;
}
function filterLine(data, img, y, bpl, bpp, type) {
  const i = y * bpl;
  let di = i + y;
  data[di] = type;
  di++;
  if (type === 0) {
    if (bpl < 500) {
      for (let x = 0; x < bpl; x++) data[di + x] = img[i + x];
    } else {
      data.set(img.subarray(i, i + bpl), di);
    }
  } else if (type === 1) {
    for (let x = 0; x < bpp; x++) data[di + x] = img[i + x];
    for (let x = bpp; x < bpl; x++) {
      data[di + x] = img[i + x] - img[i + x - bpp] + 256 & 255;
    }
  } else if (y === 0) {
    for (let x = 0; x < bpp; x++) data[di + x] = img[i + x];
    if (type === 2) {
      for (let x = bpp; x < bpl; x++) data[di + x] = img[i + x];
    }
    if (type === 3) {
      for (let x = bpp; x < bpl; x++) {
        data[di + x] = img[i + x] - (img[i + x - bpp] >> 1) + 256 & 255;
      }
    }
    if (type === 4) {
      for (let x = bpp; x < bpl; x++) {
        data[di + x] = img[i + x] - paeth(img[i + x - bpp], 0, 0) + 256 & 255;
      }
    }
  } else {
    if (type === 2) {
      for (let x = 0; x < bpl; x++) {
        data[di + x] = img[i + x] + 256 - img[i + x - bpl] & 255;
      }
    }
    if (type === 3) {
      for (let x = 0; x < bpp; x++) {
        data[di + x] = img[i + x] + 256 - (img[i + x - bpl] >> 1) & 255;
      }
      for (let x = bpp; x < bpl; x++) {
        data[di + x] = img[i + x] + 256 - (img[i + x - bpl] + img[i + x - bpp] >> 1) & 255;
      }
    }
    if (type === 4) {
      for (let x = 0; x < bpp; x++) {
        data[di + x] = img[i + x] + 256 - paeth(0, img[i + x - bpl], 0) & 255;
      }
      for (let x = bpp; x < bpl; x++) {
        data[di + x] = img[i + x] + 256 - paeth(img[i + x - bpp], img[i + x - bpl], img[i + x - bpp - bpl]) & 255;
      }
    }
  }
}

// decode.ts
var PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];
function readIHDR(data, offset, out) {
  out.width = readUint(data, offset);
  offset += 4;
  out.height = readUint(data, offset);
  offset += 4;
  out.depth = data[offset++];
  out.ctype = data[offset++];
  out.compress = data[offset++];
  out.filter = data[offset++];
  out.interlace = data[offset++];
}
function inflateZlib(data) {
  return (0, import_fflate.unzlibSync)(data);
}
function decompress(out, dd, w, h) {
  const inflated = out.tabs.CgBI ? (0, import_fflate.inflateSync)(dd) : inflateZlib(dd);
  if (out.interlace === 0) return filterZero(inflated, out, 0, w, h);
  if (out.interlace === 1) return readInterlace(inflated, out);
  return inflated;
}
function decode(buff) {
  const data = new Uint8Array(buff);
  let offset = 8;
  for (let i = 0; i < 8; i++) {
    if (data[i] !== PNG_SIG[i]) {
      throw new Error("The input is not a PNG file!");
    }
  }
  const out = {
    tabs: {},
    frames: []
  };
  const dd = new Uint8Array(data.length);
  let doff = 0;
  let fd;
  let foff = 0;
  while (offset < data.length) {
    const len = readUint(data, offset);
    offset += 4;
    const type = readASCII(data, offset, 4);
    offset += 4;
    if (type === "IHDR") {
      readIHDR(data, offset, out);
    } else if (type === "CgBI") {
      out.tabs.CgBI = data.slice(offset, offset + 4);
    } else if (type === "IDAT") {
      for (let i = 0; i < len; i++) dd[doff + i] = data[offset + i];
      doff += len;
    } else if (type === "acTL") {
      out.tabs.acTL = {
        num_frames: readUint(data, offset),
        num_plays: readUint(data, offset + 4)
      };
      fd = new Uint8Array(data.length);
    } else if (type === "fcTL") {
      if (foff !== 0 && fd) {
        const fr = out.frames[out.frames.length - 1];
        fr.data = decompress(
          out,
          fd.slice(0, foff),
          fr.rect.width,
          fr.rect.height
        );
        foff = 0;
      }
      const rct = {
        x: readUint(data, offset + 12),
        y: readUint(data, offset + 16),
        width: readUint(data, offset + 4),
        height: readUint(data, offset + 8)
      };
      let del = readUshort(data, offset + 22);
      del = readUshort(data, offset + 20) / (del === 0 ? 100 : del);
      out.frames.push({
        rect: rct,
        delay: Math.round(del * 1e3),
        dispose: data[offset + 24],
        blend: data[offset + 25]
      });
    } else if (type === "fdAT") {
      if (!fd) fd = new Uint8Array(data.length);
      for (let i = 0; i < len - 4; i++) fd[foff + i] = data[offset + i + 4];
      foff += len - 4;
    } else if (type === "pHYs") {
      out.tabs.pHYs = [
        readUint(data, offset),
        readUint(data, offset + 4),
        data[offset + 8]
      ];
    } else if (type === "cHRM") {
      out.tabs.cHRM = [];
      for (let i = 0; i < 8; i++) {
        out.tabs.cHRM.push(readUint(data, offset + i * 4));
      }
    } else if (type === "tEXt" || type === "zTXt") {
      const textTab = type === "tEXt" ? "tEXt" : "zTXt";
      if (out.tabs[textTab] === void 0) out.tabs[textTab] = {};
      const nz = nextZero(data, offset);
      const keyw = readASCII(data, offset, nz - offset);
      const tl = offset + len - nz - 1;
      let text;
      if (type === "tEXt") {
        text = readASCII(data, nz + 1, tl);
      } else {
        const bfr = inflateZlib(data.subarray(nz + 2, offset + len));
        text = readUTF8(bfr, 0, bfr.length);
      }
      out.tabs[textTab][keyw] = text;
    } else if (type === "iTXt") {
      if (out.tabs.iTXt === void 0) out.tabs.iTXt = {};
      let off = offset;
      let nz = nextZero(data, off);
      const keyw = readASCII(data, off, nz - off);
      off = nz + 1;
      const cflag = data[off];
      off += 2;
      nz = nextZero(data, off);
      off = nz + 1;
      nz = nextZero(data, off);
      off = nz + 1;
      const tl = len - (off - offset);
      let text;
      if (cflag === 0) text = readUTF8(data, off, tl);
      else {
        const bfr = inflateZlib(data.subarray(off, off + tl));
        text = readUTF8(bfr, 0, bfr.length);
      }
      out.tabs.iTXt[keyw] = text;
    } else if (type === "PLTE") {
      out.tabs.PLTE = readBytes(data, offset, len);
    } else if (type === "hIST") {
      const pl = out.tabs.PLTE.length / 3;
      out.tabs.hIST = [];
      for (let i = 0; i < pl; i++) {
        out.tabs.hIST.push(readUshort(data, offset + i * 2));
      }
    } else if (type === "tRNS") {
      if (out.ctype === 3) out.tabs.tRNS = readBytes(data, offset, len);
      else if (out.ctype === 0) out.tabs.tRNS = readUshort(data, offset);
      else if (out.ctype === 2) {
        out.tabs.tRNS = [
          readUshort(data, offset),
          readUshort(data, offset + 2),
          readUshort(data, offset + 4)
        ];
      }
    } else if (type === "gAMA") {
      out.tabs.gAMA = readUint(data, offset) / 1e5;
    } else if (type === "sRGB") {
      out.tabs.sRGB = data[offset];
    } else if (type === "bKGD") {
      if (out.ctype === 0 || out.ctype === 4) {
        out.tabs.bKGD = [readUshort(data, offset)];
      } else if (out.ctype === 2 || out.ctype === 6) {
        out.tabs.bKGD = [
          readUshort(data, offset),
          readUshort(data, offset + 2),
          readUshort(data, offset + 4)
        ];
      } else if (out.ctype === 3) {
        out.tabs.bKGD = data[offset];
      }
    } else if (type === "IEND") {
      break;
    }
    offset += len;
    offset += 4;
  }
  if (foff !== 0 && fd) {
    const fr = out.frames[out.frames.length - 1];
    fr.data = decompress(out, fd.slice(0, foff), fr.rect.width, fr.rect.height);
  }
  out.data = decompress(out, dd.subarray(0, doff), out.width, out.height);
  const _a = out, { compress: _c, filter: _f, interlace: _i } = _a, image = __objRest(_a, ["compress", "filter", "interlace"]);
  return image;
}

// dither.ts
function clamp255(x) {
  return Math.max(0, Math.min(255, x));
}
function sqDist(a, b) {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  const da = a[3] - b[3];
  return dr * dr + dg * dg + db * db + da * da;
}
function addErr(er, tg, ti, f) {
  tg[ti] += er[0] * f >> 4;
  tg[ti + 1] += er[1] * f >> 4;
  tg[ti + 2] += er[2] * f >> 4;
  tg[ti + 3] += er[3] * f >> 4;
}
var BAYER_S = 4;
var BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(
  (v) => 255 * (-0.5 + (v + 0.5) / (BAYER_S * BAYER_S))
);
function dither(sb, w, h, plte, tb, oind, MTD = 1) {
  const pc = plte.length;
  const nplt = [];
  for (let i = 0; i < pc; i++) {
    const c = plte[i];
    nplt.push([c & 255, c >>> 8 & 255, c >>> 16 & 255, c >>> 24 & 255]);
  }
  const tb32 = new Uint32Array(tb.buffer, tb.byteOffset, tb.length >> 2);
  const err = new Int16Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let cc;
      if (MTD !== 2) {
        cc = [
          clamp255(sb[i] + err[i]),
          clamp255(sb[i + 1] + err[i + 1]),
          clamp255(sb[i + 2] + err[i + 2]),
          clamp255(sb[i + 3] + err[i + 3])
        ];
      } else {
        const ce = BAYER[(y & BAYER_S - 1) * BAYER_S + (x & BAYER_S - 1)];
        cc = [
          clamp255(sb[i] + ce),
          clamp255(sb[i + 1] + ce),
          clamp255(sb[i + 2] + ce),
          clamp255(sb[i + 3] + ce)
        ];
      }
      let ni = 0;
      let nd = 16777215;
      for (let j = 0; j < pc; j++) {
        const cd = sqDist(cc, nplt[j]);
        if (cd < nd) {
          nd = cd;
          ni = j;
        }
      }
      const nc = nplt[ni];
      if (MTD === 1) {
        const er = [cc[0] - nc[0], cc[1] - nc[1], cc[2] - nc[2], cc[3] - nc[3]];
        if (x !== w - 1) addErr(er, err, i + 4, 7);
        if (y !== h - 1) {
          if (x !== 0) addErr(er, err, i + 4 * w - 4, 3);
          addErr(er, err, i + 4 * w, 5);
          if (x !== w - 1) addErr(er, err, i + 4 * w + 4, 1);
        }
      }
      oind[i >> 2] = ni;
      tb32[i >> 2] = plte[ni];
    }
  }
}

// encode.ts
var import_fflate2 = require("fflate");

// rgba.ts
function copyTile(sb, sw, sh, tb, tw, th, xoff, yoff, mode) {
  const w = Math.min(sw, tw);
  const h = Math.min(sh, th);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let si;
      let ti;
      if (xoff >= 0 && yoff >= 0) {
        si = y * sw + x << 2;
        ti = (yoff + y) * tw + xoff + x << 2;
      } else {
        si = (-yoff + y) * sw - xoff + x << 2;
        ti = y * tw + x << 2;
      }
      if (mode === 0) {
        tb[ti] = sb[si];
        tb[ti + 1] = sb[si + 1];
        tb[ti + 2] = sb[si + 2];
        tb[ti + 3] = sb[si + 3];
      } else if (mode === 1) {
        const fa = sb[si + 3] * (1 / 255);
        const fr = sb[si] * fa;
        const fg = sb[si + 1] * fa;
        const fb = sb[si + 2] * fa;
        const ba = tb[ti + 3] * (1 / 255);
        const br = tb[ti] * ba;
        const bg = tb[ti + 1] * ba;
        const bb = tb[ti + 2] * ba;
        const ifa = 1 - fa;
        const oa = fa + ba * ifa;
        const ioa = oa === 0 ? 0 : 1 / oa;
        tb[ti + 3] = 255 * oa;
        tb[ti] = (fr + br * ifa) * ioa;
        tb[ti + 1] = (fg + bg * ifa) * ioa;
        tb[ti + 2] = (fb + bb * ifa) * ioa;
      } else if (mode === 2) {
        const fa = sb[si + 3];
        const fr = sb[si];
        const fg = sb[si + 1];
        const fb = sb[si + 2];
        const ba = tb[ti + 3];
        const br = tb[ti];
        const bg = tb[ti + 1];
        const bb = tb[ti + 2];
        if (fa === ba && fr === br && fg === bg && fb === bb) {
          tb[ti] = 0;
          tb[ti + 1] = 0;
          tb[ti + 2] = 0;
          tb[ti + 3] = 0;
        } else {
          tb[ti] = fr;
          tb[ti + 1] = fg;
          tb[ti + 2] = fb;
          tb[ti + 3] = fa;
        }
      } else if (mode === 3) {
        const fa = sb[si + 3];
        const fr = sb[si];
        const fg = sb[si + 1];
        const fb = sb[si + 2];
        const ba = tb[ti + 3];
        const br = tb[ti];
        const bg = tb[ti + 1];
        const bb = tb[ti + 2];
        if (fa === ba && fr === br && fg === bg && fb === bb) continue;
        if (fa < 220 && ba > 20) return false;
      }
    }
  }
  return true;
}
function decodeImage(data, w, h, out) {
  const area = w * h;
  const bpp = getBPP(out);
  const bpl = Math.ceil(w * bpp / 8);
  const bf = new Uint8Array(area * 4);
  const bf32 = new Uint32Array(bf.buffer);
  const ctype = out.ctype;
  const depth = out.depth;
  if (ctype === 6) {
    const qarea = area << 2;
    if (depth === 8) {
      for (let i = 0; i < qarea; i += 4) {
        bf[i] = data[i];
        bf[i + 1] = data[i + 1];
        bf[i + 2] = data[i + 2];
        bf[i + 3] = data[i + 3];
      }
    }
    if (depth === 16) {
      for (let i = 0; i < qarea; i++) bf[i] = data[i << 1];
    }
  } else if (ctype === 2) {
    const ts = out.tabs.tRNS;
    if (ts === void 0) {
      if (depth === 8) {
        for (let i = 0; i < area; i++) {
          const ti = i * 3;
          bf32[i] = 255 << 24 | data[ti + 2] << 16 | data[ti + 1] << 8 | data[ti];
        }
      }
      if (depth === 16) {
        for (let i = 0; i < area; i++) {
          const ti = i * 6;
          bf32[i] = 255 << 24 | data[ti + 4] << 16 | data[ti + 2] << 8 | data[ti];
        }
      }
    } else {
      const tr = ts[0];
      const tg = ts[1];
      const tb = ts[2];
      if (depth === 8) {
        for (let i = 0; i < area; i++) {
          const qi = i << 2;
          const ti = i * 3;
          bf32[i] = 255 << 24 | data[ti + 2] << 16 | data[ti + 1] << 8 | data[ti];
          if (data[ti] === tr && data[ti + 1] === tg && data[ti + 2] === tb) {
            bf[qi + 3] = 0;
          }
        }
      }
      if (depth === 16) {
        for (let i = 0; i < area; i++) {
          const qi = i << 2;
          const ti = i * 6;
          bf32[i] = 255 << 24 | data[ti + 4] << 16 | data[ti + 2] << 8 | data[ti];
          if (readUshort(data, ti) === tr && readUshort(data, ti + 2) === tg && readUshort(data, ti + 4) === tb) {
            bf[qi + 3] = 0;
          }
        }
      }
    }
  } else if (ctype === 3) {
    const p = out.tabs.PLTE;
    const ap = out.tabs.tRNS;
    const tl = ap ? ap.length : 0;
    if (depth === 1) {
      for (let y = 0; y < h; y++) {
        const s0 = y * bpl;
        const t0 = y * w;
        for (let i = 0; i < w; i++) {
          const qi = t0 + i << 2;
          const j = data[s0 + (i >> 3)] >> 7 - (i & 7) & 1;
          const cj = 3 * j;
          bf[qi] = p[cj];
          bf[qi + 1] = p[cj + 1];
          bf[qi + 2] = p[cj + 2];
          bf[qi + 3] = j < tl ? ap[j] : 255;
        }
      }
    }
    if (depth === 2) {
      for (let y = 0; y < h; y++) {
        const s0 = y * bpl;
        const t0 = y * w;
        for (let i = 0; i < w; i++) {
          const qi = t0 + i << 2;
          const j = data[s0 + (i >> 2)] >> 6 - ((i & 3) << 1) & 3;
          const cj = 3 * j;
          bf[qi] = p[cj];
          bf[qi + 1] = p[cj + 1];
          bf[qi + 2] = p[cj + 2];
          bf[qi + 3] = j < tl ? ap[j] : 255;
        }
      }
    }
    if (depth === 4) {
      for (let y = 0; y < h; y++) {
        const s0 = y * bpl;
        const t0 = y * w;
        for (let i = 0; i < w; i++) {
          const qi = t0 + i << 2;
          const j = data[s0 + (i >> 1)] >> 4 - ((i & 1) << 2) & 15;
          const cj = 3 * j;
          bf[qi] = p[cj];
          bf[qi + 1] = p[cj + 1];
          bf[qi + 2] = p[cj + 2];
          bf[qi + 3] = j < tl ? ap[j] : 255;
        }
      }
    }
    if (depth === 8) {
      for (let i = 0; i < area; i++) {
        const qi = i << 2;
        const j = data[i];
        const cj = 3 * j;
        bf[qi] = p[cj];
        bf[qi + 1] = p[cj + 1];
        bf[qi + 2] = p[cj + 2];
        bf[qi + 3] = j < tl ? ap[j] : 255;
      }
    }
  } else if (ctype === 4) {
    if (depth === 8) {
      for (let i = 0; i < area; i++) {
        const qi = i << 2;
        const di = i << 1;
        const gr = data[di];
        bf[qi] = gr;
        bf[qi + 1] = gr;
        bf[qi + 2] = gr;
        bf[qi + 3] = data[di + 1];
      }
    }
    if (depth === 16) {
      for (let i = 0; i < area; i++) {
        const qi = i << 2;
        const di = i << 2;
        const gr = data[di];
        bf[qi] = gr;
        bf[qi + 1] = gr;
        bf[qi + 2] = gr;
        bf[qi + 3] = data[di + 2];
      }
    }
  } else if (ctype === 0) {
    const tr = out.tabs.tRNS !== void 0 ? out.tabs.tRNS : -1;
    for (let y = 0; y < h; y++) {
      const off = y * bpl;
      const to = y * w;
      if (depth === 1) {
        for (let x = 0; x < w; x++) {
          const gr = 255 * (data[off + (x >>> 3)] >>> 7 - (x & 7) & 1);
          const al = gr === tr * 255 ? 0 : 255;
          bf32[to + x] = al << 24 | gr << 16 | gr << 8 | gr;
        }
      } else if (depth === 2) {
        for (let x = 0; x < w; x++) {
          const gr = 85 * (data[off + (x >>> 2)] >>> 6 - ((x & 3) << 1) & 3);
          const al = gr === tr * 85 ? 0 : 255;
          bf32[to + x] = al << 24 | gr << 16 | gr << 8 | gr;
        }
      } else if (depth === 4) {
        for (let x = 0; x < w; x++) {
          const gr = 17 * (data[off + (x >>> 1)] >>> 4 - ((x & 1) << 2) & 15);
          const al = gr === tr * 17 ? 0 : 255;
          bf32[to + x] = al << 24 | gr << 16 | gr << 8 | gr;
        }
      } else if (depth === 8) {
        for (let x = 0; x < w; x++) {
          const gr = data[off + x];
          const al = gr === tr ? 0 : 255;
          bf32[to + x] = al << 24 | gr << 16 | gr << 8 | gr;
        }
      } else if (depth === 16) {
        for (let x = 0; x < w; x++) {
          const gr = data[off + (x << 1)];
          const al = readUshort(data, off + (x << 1)) === tr ? 0 : 255;
          bf32[to + x] = al << 24 | gr << 16 | gr << 8 | gr;
        }
      }
    }
  }
  return bf;
}
function toRGBA8(out) {
  const w = out.width;
  const h = out.height;
  if (out.tabs.acTL === void 0) {
    return [decodeImage(out.data, w, h, out).buffer];
  }
  const frms = [];
  if (out.frames[0].data === void 0) out.frames[0].data = out.data;
  const len = w * h * 4;
  const img = new Uint8Array(len);
  const empty = new Uint8Array(len);
  const prev = new Uint8Array(len);
  for (let i = 0; i < out.frames.length; i++) {
    const frm = out.frames[i];
    const fx = frm.rect.x;
    const fy = frm.rect.y;
    const fw = frm.rect.width;
    const fh = frm.rect.height;
    const fdata = decodeImage(frm.data, fw, fh, out);
    if (i !== 0) for (let j = 0; j < len; j++) prev[j] = img[j];
    if (frm.blend === 0) copyTile(fdata, fw, fh, img, w, h, fx, fy, 0);
    else if (frm.blend === 1) copyTile(fdata, fw, fh, img, w, h, fx, fy, 1);
    frms.push(img.buffer.slice(0));
    if (frm.dispose === 1) {
      copyTile(empty, fw, fh, img, w, h, fx, fy, 0);
    } else if (frm.dispose === 2) {
      for (let j = 0; j < len; j++) img[j] = prev[j];
    }
  }
  return frms;
}

// framize.ts
function prepareDiff(cimg, w, h, nimg, rec) {
  copyTile(cimg, w, h, nimg, rec.width, rec.height, -rec.x, -rec.y, 2);
}
function updateFrame(bufs, w, h, frms, i, r, evenCrd) {
  const pimg = new Uint8Array(bufs[i - 1]);
  const pimg32 = new Uint32Array(bufs[i - 1]);
  const nimg = i + 1 < bufs.length ? new Uint8Array(bufs[i + 1]) : null;
  const cimg = new Uint8Array(bufs[i]);
  const cimg32 = new Uint32Array(cimg.buffer);
  let mix = w;
  let miy = h;
  let max = -1;
  let may = -1;
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      const cx = r.x + x;
      const cy = r.y + y;
      const j = cy * w + cx;
      const cc = cimg32[j];
      const skip = cc === 0 || frms[i - 1].dispose === 0 && pimg32[j] === cc && (nimg === null || nimg[j * 4 + 3] !== 0);
      if (skip) continue;
      if (cx < mix) mix = cx;
      if (cx > max) max = cx;
      if (cy < miy) miy = cy;
      if (cy > may) may = cy;
    }
  }
  if (max === -1) mix = miy = max = may = 0;
  if (evenCrd) {
    if ((mix & 1) === 1) mix--;
    if ((miy & 1) === 1) miy--;
  }
  const nr = { x: mix, y: miy, width: max - mix + 1, height: may - miy + 1 };
  const fr = frms[i];
  fr.rect = nr;
  fr.blend = 1;
  fr.img = new Uint8Array(nr.width * nr.height * 4);
  if (frms[i - 1].dispose === 0) {
    copyTile(pimg, w, h, fr.img, nr.width, nr.height, -nr.x, -nr.y, 0);
    prepareDiff(cimg, w, h, fr.img, nr);
  } else {
    copyTile(cimg, w, h, fr.img, nr.width, nr.height, -nr.x, -nr.y, 0);
  }
}
function framize(bufs, w, h, alwaysBlend, evenCrd, forbidPrev) {
  const frms = [];
  for (let j = 0; j < bufs.length; j++) {
    const cimg = new Uint8Array(bufs[j]);
    const cimg32 = new Uint32Array(cimg.buffer);
    let nimg;
    let nx = 0;
    let ny = 0;
    let nw = w;
    let nh = h;
    let blend = alwaysBlend ? 1 : 0;
    if (j !== 0) {
      const tlim = forbidPrev || alwaysBlend || j === 1 || frms[j - 2].dispose !== 0 ? 1 : 2;
      let tstp = 0;
      let tarea = 1e9;
      for (let it = 0; it < tlim; it++) {
        const p32 = new Uint32Array(bufs[j - 1 - it]);
        let mix = w;
        let miy = h;
        let max = -1;
        let may = -1;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const i = y * w + x;
            if (cimg32[i] !== p32[i]) {
              if (x < mix) mix = x;
              if (x > max) max = x;
              if (y < miy) miy = y;
              if (y > may) may = y;
            }
          }
        }
        if (max === -1) mix = miy = max = may = 0;
        if (evenCrd) {
          if ((mix & 1) === 1) mix--;
          if ((miy & 1) === 1) miy--;
        }
        const sarea = (max - mix + 1) * (may - miy + 1);
        if (sarea < tarea) {
          tarea = sarea;
          tstp = it;
          nx = mix;
          ny = miy;
          nw = max - mix + 1;
          nh = may - miy + 1;
        }
      }
      const pimg = new Uint8Array(bufs[j - 1 - tstp]);
      if (tstp === 1) frms[j - 1].dispose = 2;
      nimg = new Uint8Array(nw * nh * 4);
      copyTile(pimg, w, h, nimg, nw, nh, -nx, -ny, 0);
      blend = copyTile(cimg, w, h, nimg, nw, nh, -nx, -ny, 3) ? 1 : 0;
      if (blend === 1) {
        prepareDiff(cimg, w, h, nimg, { x: nx, y: ny, width: nw, height: nh });
      } else {
        copyTile(cimg, w, h, nimg, nw, nh, -nx, -ny, 0);
      }
    } else {
      nimg = cimg.slice(0);
    }
    frms.push({
      rect: { x: nx, y: ny, width: nw, height: nh },
      img: nimg,
      blend,
      dispose: 0
    });
  }
  if (alwaysBlend) {
    for (let j = 0; j < frms.length; j++) {
      const frm = frms[j];
      if (frm.blend === 1) continue;
      const r0 = frm.rect;
      const r1 = frms[j - 1].rect;
      const miX = Math.min(r0.x, r1.x);
      const miY = Math.min(r0.y, r1.y);
      const maX = Math.max(r0.x + r0.width, r1.x + r1.width);
      const maY = Math.max(r0.y + r0.height, r1.y + r1.height);
      const r = { x: miX, y: miY, width: maX - miX, height: maY - miY };
      frms[j - 1].dispose = 1;
      if (j - 1 !== 0) updateFrame(bufs, w, h, frms, j - 1, r, evenCrd);
      updateFrame(bufs, w, h, frms, j, r, evenCrd);
    }
  }
  return frms;
}
function concatRGBA(bufs) {
  let tlen = 0;
  for (let i = 0; i < bufs.length; i++) tlen += bufs[i].byteLength;
  const nimg = new Uint8Array(tlen);
  let noff = 0;
  for (let i = 0; i < bufs.length; i++) {
    const img = new Uint8Array(bufs[i]);
    const il = img.length;
    for (let j = 0; j < il; j += 4) {
      let r = img[j];
      let g = img[j + 1];
      let b = img[j + 2];
      const a = img[j + 3];
      if (a === 0) r = g = b = 0;
      nimg[noff + j] = r;
      nimg[noff + j + 1] = g;
      nimg[noff + j + 2] = b;
      nimg[noff + j + 3] = a;
    }
    noff += il;
  }
  return nimg.buffer;
}

// quantize.ts
var M4 = {
  multVec(m, v) {
    return [
      m[0] * v[0] + m[1] * v[1] + m[2] * v[2] + m[3] * v[3],
      m[4] * v[0] + m[5] * v[1] + m[6] * v[2] + m[7] * v[3],
      m[8] * v[0] + m[9] * v[1] + m[10] * v[2] + m[11] * v[3],
      m[12] * v[0] + m[13] * v[1] + m[14] * v[2] + m[15] * v[3]
    ];
  },
  dot(x, y) {
    return x[0] * y[0] + x[1] * y[1] + x[2] * y[2] + x[3] * y[3];
  },
  sml(a, y) {
    return [a * y[0], a * y[1], a * y[2], a * y[3]];
  }
};
function stats(nimg, i0, i1) {
  const R = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const m = [0, 0, 0, 0];
  const N = i1 - i0 >> 2;
  for (let i = i0; i < i1; i += 4) {
    const r = nimg[i] * (1 / 255);
    const g = nimg[i + 1] * (1 / 255);
    const b = nimg[i + 2] * (1 / 255);
    const a = nimg[i + 3] * (1 / 255);
    m[0] += r;
    m[1] += g;
    m[2] += b;
    m[3] += a;
    R[0] += r * r;
    R[1] += r * g;
    R[2] += r * b;
    R[3] += r * a;
    R[5] += g * g;
    R[6] += g * b;
    R[7] += g * a;
    R[10] += b * b;
    R[11] += b * a;
    R[15] += a * a;
  }
  R[4] = R[1];
  R[8] = R[2];
  R[9] = R[6];
  R[12] = R[3];
  R[13] = R[7];
  R[14] = R[11];
  return { R, m, N };
}
function estats(st) {
  const R = st.R;
  const m = st.m;
  const N = st.N;
  const m0 = m[0];
  const m1 = m[1];
  const m2 = m[2];
  const m3 = m[3];
  const iN = N === 0 ? 0 : 1 / N;
  const Rj = [
    R[0] - m0 * m0 * iN,
    R[1] - m0 * m1 * iN,
    R[2] - m0 * m2 * iN,
    R[3] - m0 * m3 * iN,
    R[4] - m1 * m0 * iN,
    R[5] - m1 * m1 * iN,
    R[6] - m1 * m2 * iN,
    R[7] - m1 * m3 * iN,
    R[8] - m2 * m0 * iN,
    R[9] - m2 * m1 * iN,
    R[10] - m2 * m2 * iN,
    R[11] - m2 * m3 * iN,
    R[12] - m3 * m0 * iN,
    R[13] - m3 * m1 * iN,
    R[14] - m3 * m2 * iN,
    R[15] - m3 * m3 * iN
  ];
  let b = [Math.random(), Math.random(), Math.random(), Math.random()];
  let mi = 0;
  let tmi = 0;
  if (N !== 0) {
    for (let i = 0; i < 16; i++) {
      b = M4.multVec(Rj, b);
      tmi = Math.sqrt(M4.dot(b, b));
      b = M4.sml(1 / tmi, b);
      if (i !== 0 && Math.abs(tmi - mi) < 1e-9) break;
      mi = tmi;
    }
  }
  const q = [m0 * iN, m1 * iN, m2 * iN, m3 * iN];
  const eMq255 = M4.dot(M4.sml(255, q), b);
  return {
    Cov: Rj,
    q,
    e: b,
    L: mi,
    eMq255,
    eMq: M4.dot(b, q),
    rgba: (Math.round(255 * q[3]) << 24 | Math.round(255 * q[2]) << 16 | Math.round(255 * q[1]) << 8 | Math.round(255 * q[0])) >>> 0
  };
}
function vecDot(nimg, i, e) {
  return nimg[i] * e[0] + nimg[i + 1] * e[1] + nimg[i + 2] * e[2] + nimg[i + 3] * e[3];
}
function splitPixels(nimg, nimg32, i0, i1, e, eMq) {
  i1 -= 4;
  while (i0 < i1) {
    while (vecDot(nimg, i0, e) <= eMq) i0 += 4;
    while (vecDot(nimg, i1, e) > eMq) i1 -= 4;
    if (i0 >= i1) break;
    const t = nimg32[i0 >> 2];
    nimg32[i0 >> 2] = nimg32[i1 >> 2];
    nimg32[i1 >> 2] = t;
    i0 += 4;
    i1 -= 4;
  }
  while (vecDot(nimg, i0, e) > eMq) i0 -= 4;
  return i0 + 4;
}
function planeDst(est, r, g, b, a) {
  const e = est.e;
  return e[0] * r + e[1] * g + e[2] * b + e[3] * a - est.eMq;
}
function dist(q, r, g, b, a) {
  const d0 = r - q[0];
  const d1 = g - q[1];
  const d2 = b - q[2];
  const d3 = a - q[3];
  return d0 * d0 + d1 * d1 + d2 * d2 + d3 * d3;
}
function makeNode(i0, i1, bst) {
  return {
    i0,
    i1,
    bst,
    est: estats(bst),
    tdst: 0,
    ind: 0,
    left: null,
    right: null
  };
}
function getKDtree(nimg, ps, err = 1e-4) {
  const nimg32 = new Uint32Array(nimg.buffer);
  const root = makeNode(0, nimg.length, stats(nimg, 0, nimg.length));
  const leafs = [root];
  while (leafs.length < ps) {
    let maxL = 0;
    let mi = 0;
    for (let i = 0; i < leafs.length; i++) {
      if (leafs[i].est.L > maxL) {
        maxL = leafs[i].est.L;
        mi = i;
      }
    }
    if (maxL < err) break;
    const node = leafs[mi];
    const s0 = splitPixels(
      nimg,
      nimg32,
      node.i0,
      node.i1,
      node.est.e,
      node.est.eMq255
    );
    if (node.i0 >= s0 || node.i1 <= s0) {
      node.est.L = 0;
      continue;
    }
    const ln = makeNode(node.i0, s0, stats(nimg, node.i0, s0));
    const rbst = { R: [], m: [], N: node.bst.N - ln.bst.N };
    for (let i = 0; i < 16; i++) rbst.R[i] = node.bst.R[i] - ln.bst.R[i];
    for (let i = 0; i < 4; i++) rbst.m[i] = node.bst.m[i] - ln.bst.m[i];
    const rn = makeNode(s0, node.i1, rbst);
    node.left = ln;
    node.right = rn;
    leafs[mi] = ln;
    leafs.push(rn);
  }
  leafs.sort((a, b) => b.bst.N - a.bst.N);
  for (let i = 0; i < leafs.length; i++) leafs[i].ind = i;
  return [root, leafs];
}
function getNearest(nd, r, g, b, a) {
  if (nd.left === null) {
    nd.tdst = dist(nd.est.q, r, g, b, a);
    return nd;
  }
  const pd = planeDst(nd.est, r, g, b, a);
  let node0 = nd.left;
  let node1 = nd.right;
  if (pd > 0) {
    node0 = nd.right;
    node1 = nd.left;
  }
  const ln = getNearest(node0, r, g, b, a);
  if (ln.tdst <= pd * pd) return ln;
  const rn = getNearest(node1, r, g, b, a);
  return rn.tdst < ln.tdst ? rn : ln;
}
function remap(inds, tb32, pl32) {
  for (let i = 0; i < inds.length; i++) tb32[i] = pl32[inds[i]];
}
function updatePalette(sb, inds, plte) {
  const K = plte.length >>> 2;
  const sums = new Uint32Array(K * 4);
  const cnts = new Uint32Array(K);
  for (let i = 0; i < sb.length; i += 4) {
    const ind = inds[i >>> 2];
    const qi = ind * 4;
    cnts[ind]++;
    sums[qi] += sb[i];
    sums[qi + 1] += sb[i + 1];
    sums[qi + 2] += sb[i + 2];
    sums[qi + 3] += sb[i + 3];
  }
  for (let i = 0; i < plte.length; i++) {
    plte[i] = Math.round(sums[i] / cnts[i >>> 2]);
  }
}
function findNearest(sb, inds, plte) {
  let terr = 0;
  const K = plte.length >>> 2;
  const nd = [];
  for (let i = 0; i < K; i++) {
    const qi = i * 4;
    const r = plte[qi];
    const g = plte[qi + 1];
    const b = plte[qi + 2];
    const a = plte[qi + 3];
    let te = 1e9;
    for (let j = 0; j < K; j++) {
      if (i === j) continue;
      const qj = j * 4;
      const dr = r - plte[qj];
      const dg = g - plte[qj + 1];
      const db = b - plte[qj + 2];
      const da = a - plte[qj + 3];
      const err = dr * dr + dg * dg + db * db + da * da;
      if (err < te) te = err;
    }
    const hd = Math.sqrt(te) * 0.5;
    nd[i] = hd * hd;
  }
  for (let i = 0; i < sb.length; i += 4) {
    const r = sb[i];
    const g = sb[i + 1];
    const b = sb[i + 2];
    const a = sb[i + 3];
    let ti = inds[i >>> 2];
    let qi = ti * 4;
    let dr = r - plte[qi];
    let dg = g - plte[qi + 1];
    let db = b - plte[qi + 2];
    let da = a - plte[qi + 3];
    let te = dr * dr + dg * dg + db * db + da * da;
    if (te > nd[ti]) {
      for (let j = 0; j < K; j++) {
        qi = j * 4;
        dr = r - plte[qi];
        dg = g - plte[qi + 1];
        db = b - plte[qi + 2];
        da = a - plte[qi + 3];
        const err = dr * dr + dg * dg + db * db + da * da;
        if (err < te) {
          te = err;
          ti = j;
          if (te < nd[j]) break;
        }
      }
    }
    inds[i >>> 2] = ti;
    terr += te;
  }
  return terr / (sb.length >>> 2);
}
function kmeans(sb, inds, plte) {
  updatePalette(sb, inds, plte);
  return findNearest(sb, inds, plte);
}
function quantize(abuf, ps, doKmeans) {
  const sb = new Uint8Array(abuf);
  const tb = sb.slice(0);
  const tb32 = new Uint32Array(tb.buffer);
  const [root, leafs] = getKDtree(tb, ps);
  const K = leafs.length;
  const cl32 = new Uint32Array(K);
  const clr8 = new Uint8Array(cl32.buffer);
  for (let i = 0; i < K; i++) cl32[i] = leafs[i].est.rgba;
  const len = sb.length;
  const inds = new Uint8Array(len >> 2);
  if (K <= 60) {
    findNearest(sb, inds, clr8);
    remap(inds, tb32, cl32);
  } else if (len < 32e6) {
    for (let i = 0; i < len; i += 4) {
      const nd = getNearest(
        root,
        sb[i] * (1 / 255),
        sb[i + 1] * (1 / 255),
        sb[i + 2] * (1 / 255),
        sb[i + 3] * (1 / 255)
      );
      inds[i >> 2] = nd.ind;
      tb32[i >> 2] = nd.est.rgba;
    }
  } else {
    for (let i = 0; i < len; i += 4) {
      const r = sb[i] * (1 / 255);
      const g = sb[i + 1] * (1 / 255);
      const b = sb[i + 2] * (1 / 255);
      const a = sb[i + 3] * (1 / 255);
      let nd = root;
      while (nd.left) {
        nd = planeDst(nd.est, r, g, b, a) <= 0 ? nd.left : nd.right;
      }
      inds[i >> 2] = nd.ind;
      tb32[i >> 2] = nd.est.rgba;
    }
  }
  if (doKmeans || len * K < 10 * 4e6) {
    let le = 1e9;
    for (let i = 0; i < 10; i++) {
      const ce = kmeans(sb, inds, clr8);
      if (ce / le > 0.997) break;
      le = ce;
    }
    for (let i = 0; i < K; i++) leafs[i].est.rgba = cl32[i];
    remap(inds, tb32, cl32);
  }
  return { abuf: tb.buffer, inds, plte: leafs };
}

// encode.ts
function filterAndCompress(img, h, bpp, bpl, filter, levelZero) {
  const data = new Uint8Array(h * bpl + h);
  let ftry = [0, 1, 2, 3, 4];
  if (filter !== -1) ftry = [filter];
  else if (h * bpl > 5e5 || bpp === 1) ftry = [0];
  const opts = levelZero ? { level: 0 } : {};
  const fls = [];
  for (let i = 0; i < ftry.length; i++) {
    for (let y = 0; y < h; y++) {
      filterLine(data, img, y, bpl, bpp, ftry[i]);
    }
    fls.push((0, import_fflate2.zlibSync)(data, opts));
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
    frm.cimg = filterAndCompress(
      frm.img,
      nh,
      frm.bpp,
      frm.bpl,
      filter,
      levelZero
    );
  }
}
function writePNG(nimg, w, h, dels, tabs) {
  var _a, _b;
  if (tabs === void 0) tabs = {};
  const anim = nimg.frames.length > 1;
  let pltAlpha = false;
  let leng = 8 + (16 + 5 + 4) + (anim ? 20 : 0);
  if (tabs.sRGB !== void 0) leng += 8 + 1 + 4;
  if (tabs.pHYs !== void 0) leng += 8 + 9 + 4;
  if (nimg.ctype === 3 && nimg.plte) {
    const dl = nimg.plte.length;
    for (let i = 0; i < dl; i++) {
      if (nimg.plte[i] >>> 24 !== 255) pltAlpha = true;
    }
    leng += 8 + dl * 3 + 4 + (pltAlpha ? 8 + dl * 1 + 4 : 0);
  }
  for (let j = 0; j < nimg.frames.length; j++) {
    const fr = nimg.frames[j];
    if (anim) leng += 38;
    leng += fr.cimg.length + 12;
    if (j !== 0) leng += 4;
  }
  leng += 12;
  const data = new Uint8Array(leng);
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) data[i] = sig[i];
  let offset = 8;
  writeUint(data, offset, 13);
  offset += 4;
  writeASCII(data, offset, "IHDR");
  offset += 4;
  writeUint(data, offset, w);
  offset += 4;
  writeUint(data, offset, h);
  offset += 4;
  data[offset++] = nimg.depth;
  data[offset++] = nimg.ctype;
  data[offset++] = 0;
  data[offset++] = 0;
  data[offset++] = 0;
  writeUint(data, offset, crc(data, offset - 17, 17));
  offset += 4;
  if (tabs.sRGB !== void 0) {
    writeUint(data, offset, 1);
    offset += 4;
    writeASCII(data, offset, "sRGB");
    offset += 4;
    data[offset++] = tabs.sRGB;
    writeUint(data, offset, crc(data, offset - 5, 5));
    offset += 4;
  }
  if (tabs.pHYs !== void 0) {
    writeUint(data, offset, 9);
    offset += 4;
    writeASCII(data, offset, "pHYs");
    offset += 4;
    writeUint(data, offset, tabs.pHYs[0]);
    offset += 4;
    writeUint(data, offset, tabs.pHYs[1]);
    offset += 4;
    data[offset++] = tabs.pHYs[2];
    writeUint(data, offset, crc(data, offset - 13, 13));
    offset += 4;
  }
  if (anim) {
    writeUint(data, offset, 8);
    offset += 4;
    writeASCII(data, offset, "acTL");
    offset += 4;
    writeUint(data, offset, nimg.frames.length);
    offset += 4;
    writeUint(data, offset, (_a = tabs.loop) != null ? _a : 0);
    offset += 4;
    writeUint(data, offset, crc(data, offset - 12, 12));
    offset += 4;
  }
  if (nimg.ctype === 3 && nimg.plte) {
    const dl = nimg.plte.length;
    writeUint(data, offset, dl * 3);
    offset += 4;
    writeASCII(data, offset, "PLTE");
    offset += 4;
    for (let i = 0; i < dl; i++) {
      const ti = i * 3;
      const c = nimg.plte[i];
      data[offset + ti] = c & 255;
      data[offset + ti + 1] = c >>> 8 & 255;
      data[offset + ti + 2] = c >>> 16 & 255;
    }
    offset += dl * 3;
    writeUint(data, offset, crc(data, offset - dl * 3 - 4, dl * 3 + 4));
    offset += 4;
    if (pltAlpha) {
      writeUint(data, offset, dl);
      offset += 4;
      writeASCII(data, offset, "tRNS");
      offset += 4;
      for (let i = 0; i < dl; i++) {
        data[offset + i] = nimg.plte[i] >>> 24 & 255;
      }
      offset += dl;
      writeUint(data, offset, crc(data, offset - dl - 4, dl + 4));
      offset += 4;
    }
  }
  let fi = 0;
  for (let j = 0; j < nimg.frames.length; j++) {
    const fr = nimg.frames[j];
    if (anim) {
      writeUint(data, offset, 26);
      offset += 4;
      writeASCII(data, offset, "fcTL");
      offset += 4;
      writeUint(data, offset, fi++);
      offset += 4;
      writeUint(data, offset, fr.rect.width);
      offset += 4;
      writeUint(data, offset, fr.rect.height);
      offset += 4;
      writeUint(data, offset, fr.rect.x);
      offset += 4;
      writeUint(data, offset, fr.rect.y);
      offset += 4;
      writeUshort(data, offset, (_b = dels == null ? void 0 : dels[j]) != null ? _b : 0);
      offset += 2;
      writeUshort(data, offset, 1e3);
      offset += 2;
      data[offset++] = fr.dispose;
      data[offset++] = fr.blend;
      writeUint(data, offset, crc(data, offset - 30, 30));
      offset += 4;
    }
    const imgd = fr.cimg;
    const dl = imgd.length;
    writeUint(data, offset, dl + (j === 0 ? 0 : 4));
    offset += 4;
    const ioff = offset;
    writeASCII(data, offset, j === 0 ? "IDAT" : "fdAT");
    offset += 4;
    if (j !== 0) {
      writeUint(data, offset, fi++);
      offset += 4;
    }
    data.set(imgd, offset);
    offset += dl;
    writeUint(data, offset, crc(data, ioff, offset - ioff));
    offset += 4;
  }
  writeUint(data, offset, 0);
  offset += 4;
  writeASCII(data, offset, "IEND");
  offset += 4;
  writeUint(data, offset, crc(data, offset - 4, 4));
  offset += 4;
  return data.buffer;
}
function packIndexed(inds, nw, nh, depth) {
  const bpl = Math.ceil(depth * nw / 8);
  const nimg = new Uint8Array(bpl * nh);
  for (let y = 0; y < nh; y++) {
    const i = y * bpl;
    const ii = y * nw;
    if (depth === 8) {
      for (let x = 0; x < nw; x++) nimg[i + x] = inds[ii + x];
    } else if (depth === 4) {
      for (let x = 0; x < nw; x++) {
        nimg[i + (x >> 1)] |= inds[ii + x] << 4 - (x & 1) * 4;
      }
    } else if (depth === 2) {
      for (let x = 0; x < nw; x++) {
        nimg[i + (x >> 2)] |= inds[ii + x] << 6 - (x & 3) * 2;
      }
    } else if (depth === 1) {
      for (let x = 0; x < nw; x++) {
        nimg[i + (x >> 3)] |= inds[ii + x] << 7 - (x & 7);
      }
    }
  }
  return nimg;
}
function compress(bufs, w, h, ps, prms) {
  const [onlyBlend, evenCrd, forbidPrev, minBits, forbidPlte, dith] = prms;
  let ctype = 6;
  let depth = 8;
  let alphaAnd = 255;
  for (let j = 0; j < bufs.length; j++) {
    const img = new Uint8Array(bufs[j]);
    for (let i = 0; i < img.length; i += 4) alphaAnd &= img[i + 3];
  }
  const gotAlpha = alphaAnd !== 255;
  const frms = framize(bufs, w, h, onlyBlend, evenCrd, forbidPrev);
  const plte = [];
  const inds = [];
  if (ps !== 0) {
    const nbufs = [];
    for (let i = 0; i < frms.length; i++) {
      nbufs.push(frms[i].img.buffer);
    }
    const qres = quantize(concatRGBA(nbufs), ps);
    for (let i = 0; i < qres.plte.length; i++) plte.push(qres.plte[i].est.rgba);
    let cof = 0;
    for (let i = 0; i < frms.length; i++) {
      const frm = frms[i];
      const bln = frm.img.length;
      const ind = new Uint8Array(qres.inds.buffer, cof >> 2, bln >> 2);
      inds.push(ind);
      const bb = new Uint8Array(qres.abuf, cof, bln);
      if (dith) {
        dither(frm.img, frm.rect.width, frm.rect.height, plte, bb, ind);
      }
      frm.img.set(bb);
      cof += bln;
    }
  } else {
    const cmap = /* @__PURE__ */ new Map();
    for (let j = 0; j < frms.length; j++) {
      const frm = frms[j];
      const img32 = new Uint32Array(frm.img.buffer);
      const nw = frm.rect.width;
      const ilen = img32.length;
      const ind = new Uint8Array(ilen);
      inds.push(ind);
      for (let i = 0; i < ilen; i++) {
        const c = img32[i];
        if (i !== 0 && c === img32[i - 1]) ind[i] = ind[i - 1];
        else if (i > nw && c === img32[i - nw]) ind[i] = ind[i - nw];
        else {
          let cmc = cmap.get(c);
          if (cmc === void 0) {
            cmc = plte.length;
            cmap.set(c, cmc);
            plte.push(c);
            if (plte.length >= 300) break;
          }
          ind[i] = cmc;
        }
      }
    }
  }
  const cc = plte.length;
  const usePlte = cc <= 256 && !forbidPlte;
  if (usePlte) {
    if (cc <= 2) depth = 1;
    else if (cc <= 4) depth = 2;
    else if (cc <= 16) depth = 4;
    else depth = 8;
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
      bpl = Math.ceil(depth * nw / 8);
      cimg = packIndexed(inds[j], nw, nh, depth);
      ctype = 3;
      bpp = 1;
    } else if (!gotAlpha && frms.length === 1) {
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
      bpl
    });
  }
  return { ctype, depth, plte, frames };
}
function encode(imgs, w, h, cnum = 0, dels, tabs, forbidPlte = false) {
  const nimg = compress(imgs, w, h, cnum, [
    false,
    false,
    false,
    0,
    forbidPlte,
    false
  ]);
  compressPNG(nimg, -1);
  return writePNG(nimg, w, h, dels, tabs);
}
function encodeLL(imgs, w, h, cc, ac, depth, dels, tabs) {
  const nimg = {
    ctype: 0 + (cc === 1 ? 0 : 2) + (ac === 0 ? 0 : 4),
    depth,
    frames: []
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
      bpl: Math.ceil(bipl / 8)
    });
  }
  compressPNG(nimg, 0, true);
  return writePNG(nimg, w, h, dels, tabs);
}

// index.ts
var UPNG = {
  decode,
  toRGBA8,
  encode,
  encodeLL,
  quantize,
  compress,
  dither
};
var index_default = UPNG;
module.exports = module.exports.default ?? module.exports;
//# sourceMappingURL=index.cjs.map
