/**
 * Generates a pseudo random number. Although it is not cryptographically secure
 * and uniformly distributed, it is not a concern for the intended use-case,
 * which is to generate distinct numbers.
 *
 * Credit: https://stackoverflow.com/a/19303725/10254049
 */
export declare class SimpleRNG {
    static withSeed: (seed: number) => SimpleRNG;
    private seed;
    private constructor();
    nextInt(): number;
}
/**
 * Generates cryptographically secure random bytes using the platform's Web
 * Crypto API (`crypto.getRandomValues`), which is available in modern browsers,
 * Node (>= 18), Deno, and Bun.
 *
 * Throws when `globalThis.crypto.getRandomValues` is missing — Node < 18, or
 * React Native without a polyfill such as `react-native-get-random-values`.
 * Only document encryption needs this; the rest of `pdf-lib` is unaffected.
 */
export declare const getRandomBytes: (byteCount: number) => Uint8Array;
//# sourceMappingURL=rng.d.ts.map