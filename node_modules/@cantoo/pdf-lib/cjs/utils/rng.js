"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getRandomBytes = exports.SimpleRNG = void 0;
/**
 * Generates a pseudo random number. Although it is not cryptographically secure
 * and uniformly distributed, it is not a concern for the intended use-case,
 * which is to generate distinct numbers.
 *
 * Credit: https://stackoverflow.com/a/19303725/10254049
 */
class SimpleRNG {
    constructor(seed) {
        this.seed = seed;
    }
    nextInt() {
        const x = Math.sin(this.seed++) * 10000;
        return x - Math.floor(x);
    }
}
exports.SimpleRNG = SimpleRNG;
SimpleRNG.withSeed = (seed) => new SimpleRNG(seed);
// getRandomValues rejects requests larger than this
const MAX_RANDOM_BYTES_PER_CALL = 65536;
const getWebCrypto = () => {
    const webCrypto = globalThis.crypto;
    if (!webCrypto || typeof webCrypto.getRandomValues !== 'function') {
        throw new Error('Web Crypto API is unavailable, so cryptographically secure random bytes ' +
            'cannot be generated. A `crypto.getRandomValues` polyfill is required ' +
            'to encrypt documents in this environment.');
    }
    return webCrypto;
};
/**
 * Generates cryptographically secure random bytes using the platform's Web
 * Crypto API (`crypto.getRandomValues`), which is available in modern browsers,
 * Node (>= 18), Deno, and Bun.
 *
 * Throws when `globalThis.crypto.getRandomValues` is missing — Node < 18, or
 * React Native without a polyfill such as `react-native-get-random-values`.
 * Only document encryption needs this; the rest of `pdf-lib` is unaffected.
 */
const getRandomBytes = (byteCount) => {
    const webCrypto = getWebCrypto();
    const bytes = new Uint8Array(byteCount);
    for (let offset = 0; offset < byteCount; offset += MAX_RANDOM_BYTES_PER_CALL) {
        const end = Math.min(offset + MAX_RANDOM_BYTES_PER_CALL, byteCount);
        webCrypto.getRandomValues(bytes.subarray(offset, end));
    }
    return bytes;
};
exports.getRandomBytes = getRandomBytes;
//# sourceMappingURL=rng.js.map