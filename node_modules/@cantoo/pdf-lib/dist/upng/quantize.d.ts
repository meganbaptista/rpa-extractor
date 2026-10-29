import type { QuantizeResult } from './types';
/** Raw second-moment accumulators for a set of RGBA samples. */
interface Stats {
    R: number[];
    m: number[];
    N: number;
}
/** Derived statistics: covariance, mean, principal axis and palette color. */
interface EStats {
    Cov: number[];
    q: number[];
    e: number[];
    L: number;
    eMq255: number;
    eMq: number;
    rgba: number;
}
/** Node of the color-space KD-tree; leaves become palette entries. */
export interface KDNode {
    i0: number;
    i1: number;
    bst: Stats;
    est: EStats;
    tdst: number;
    ind: number;
    left: KDNode | null;
    right: KDNode | null;
}
/**
 * Build a KD-tree over `nimg` (reordered in place) with up to `ps` leaves.
 * Returns the root and the leaves sorted by descending pixel count.
 */
export declare function getKDtree(nimg: Uint8Array, ps: number, err?: number): [KDNode, KDNode[]];
/** Exact nearest leaf lookup with plane-distance pruning. */
export declare function getNearest(nd: KDNode, r: number, g: number, b: number, a: number): KDNode;
/** Assign every sample to its nearest palette color; returns the mean error. */
export declare function findNearest(sb: Uint8Array, inds: Uint8Array, plte: Uint8Array): number;
/**
 * Reduce an RGBA8 buffer to at most `ps` colors using a KD-tree over the
 * color space, optionally refined with k-means.
 *
 * Returns the quantized RGBA buffer, the per-pixel palette indices and the
 * palette itself (leaf nodes, color in `est.rgba`).
 */
export declare function quantize(abuf: ArrayBuffer, ps: number, doKmeans?: boolean): QuantizeResult;
export {};
//# sourceMappingURL=quantize.d.ts.map