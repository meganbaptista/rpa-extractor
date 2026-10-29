import { HTMLElement } from 'node-html-better-parser';
import { PDFArray, PDFDict, PDFRawStream, PDFRef } from '../../core';
export type XfaTemplatePacket = {
    xfa: PDFArray;
    templateIndex: number;
    streamRef: PDFRef | null;
    stream: PDFRawStream;
    xml: string;
};
export type XfaScriptEntry = {
    scriptNode: HTMLElement;
    field: string;
    event: string;
};
/**
 * Locate the XFA `template` packet on an AcroForm dictionary and decode it.
 * Only the array form of `/XFA` (alternating name/stream pairs) is supported.
 */
export declare const readXfaTemplatePacket: (acroFormDict: PDFDict) => XfaTemplatePacket | null;
export declare const parseXfaTemplate: (xml: string) => HTMLElement;
/**
 * Walk an XFA template tree. Tracks the enclosing `field` name and invokes
 * `visit` for every element so callers can collect scripts, signatures, etc.
 */
export declare const walkXfaTree: (node: HTMLElement, visit: (node: HTMLElement, field: string | undefined) => void, currentField?: string) => void;
export declare const collectXfaScripts: (root: HTMLElement) => XfaScriptEntry[];
export type XfaSignatureRaw = {
    field: string;
    manifestUse?: string;
    inlineRefs: string[];
};
export declare const collectXfaSignatures: (root: HTMLElement) => {
    signatures: XfaSignatureRaw[];
    manifests: Map<string, string[]>;
};
//# sourceMappingURL=xfa.d.ts.map