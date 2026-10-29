import { decode } from './decode';
import { dither } from './dither';
import { compress, encode, encodeLL } from './encode';
import { quantize } from './quantize';
import { toRGBA8 } from './rgba';
export type { Image, ImageFrame, ImageFrameRect, ImageTabACTL, ImageTabs, ImageTabText, QuantizeLeaf, QuantizeResult, } from './types';
export type { CompressParams } from './encode';
export type { FramizeFrame } from './framize';
export { compress, decode, dither, encode, encodeLL, quantize, toRGBA8 };
/**
 * Default export matching photopea / `@pdf-lib/upng`:
 * `import UPNG from '...'; UPNG.decode(...); UPNG.quantize(...);`
 *
 * The CommonJS build only exposes this object, so `compress` and `dither`
 * are members here as well as named exports.
 */
declare const UPNG: {
    decode: typeof decode;
    toRGBA8: typeof toRGBA8;
    encode: typeof encode;
    encodeLL: typeof encodeLL;
    quantize: typeof quantize;
    compress: typeof compress;
    dither: typeof dither;
};
export default UPNG;
//# sourceMappingURL=index.d.ts.map