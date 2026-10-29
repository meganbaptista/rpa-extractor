import { decode } from './decode.js';
import { dither } from './dither.js';
import { compress, encode, encodeLL } from './encode.js';
import { quantize } from './quantize.js';
import { toRGBA8 } from './rgba.js';
export { compress, decode, dither, encode, encodeLL, quantize, toRGBA8 };
/**
 * Default export matching photopea / `@pdf-lib/upng`:
 * `import UPNG from '....js'; UPNG.decode(...); UPNG.quantize(...);`
 *
 * The CommonJS build only exposes this object, so `compress` and `dither`
 * are members here as well as named exports.
 */
const UPNG = {
    decode,
    toRGBA8,
    encode,
    encodeLL,
    quantize,
    compress,
    dither,
};
export default UPNG;
//# sourceMappingURL=index.js.map