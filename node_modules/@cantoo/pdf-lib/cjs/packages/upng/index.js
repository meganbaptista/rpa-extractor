"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toRGBA8 = exports.quantize = exports.encodeLL = exports.encode = exports.dither = exports.decode = exports.compress = void 0;
const decode_1 = require("./decode");
Object.defineProperty(exports, "decode", { enumerable: true, get: function () { return decode_1.decode; } });
const dither_1 = require("./dither");
Object.defineProperty(exports, "dither", { enumerable: true, get: function () { return dither_1.dither; } });
const encode_1 = require("./encode");
Object.defineProperty(exports, "compress", { enumerable: true, get: function () { return encode_1.compress; } });
Object.defineProperty(exports, "encode", { enumerable: true, get: function () { return encode_1.encode; } });
Object.defineProperty(exports, "encodeLL", { enumerable: true, get: function () { return encode_1.encodeLL; } });
const quantize_1 = require("./quantize");
Object.defineProperty(exports, "quantize", { enumerable: true, get: function () { return quantize_1.quantize; } });
const rgba_1 = require("./rgba");
Object.defineProperty(exports, "toRGBA8", { enumerable: true, get: function () { return rgba_1.toRGBA8; } });
/**
 * Default export matching photopea / `@pdf-lib/upng`:
 * `import UPNG from '...'; UPNG.decode(...); UPNG.quantize(...);`
 *
 * The CommonJS build only exposes this object, so `compress` and `dither`
 * are members here as well as named exports.
 */
const UPNG = {
    decode: decode_1.decode,
    toRGBA8: rgba_1.toRGBA8,
    encode: encode_1.encode,
    encodeLL: encode_1.encodeLL,
    quantize: quantize_1.quantize,
    compress: encode_1.compress,
    dither: dither_1.dither,
};
exports.default = UPNG;
//# sourceMappingURL=index.js.map