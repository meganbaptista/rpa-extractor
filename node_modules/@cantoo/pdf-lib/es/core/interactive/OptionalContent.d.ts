import PDFDict from '../objects/PDFDict';
import PDFRef from '../objects/PDFRef';
/** A document optional content group (OCG), commonly called a PDF "layer". */
export type PDFOptionalContentGroup = {
    /** Human-readable layer name (`/Name`). Empty when missing. */
    name: string;
    /** Whether the layer is on in the default configuration (`/OCProperties` `/D`). */
    visible: boolean;
    /** Indirect reference of the OCG dictionary. */
    ref: PDFRef;
};
/**
 * Visibility change for one or more optional content groups.
 * Provide `ref` and/or `name` (all groups with that name are updated).
 */
export type OptionalContentVisibilityUpdate = {
    name?: string;
    ref?: PDFRef;
    visible: boolean;
};
/**
 * High-level access to `/OCProperties` (optional content / layers). Visibility
 * updates rewrite the default configuration (`/D`) `/ON` and `/OFF` arrays.
 */
declare class OptionalContentProperties {
    static fromDict: (dict: PDFDict) => OptionalContentProperties;
    /** @ignore */
    readonly dict: PDFDict;
    private constructor();
    /** List `/OCGs` with default visibility from `/D`. */
    getGroups(): PDFOptionalContentGroup[];
    /** Set default visibility for the given groups (by `name` and/or `ref`). */
    setVisibility(updates: OptionalContentVisibilityUpdate[]): void;
}
export default OptionalContentProperties;
//# sourceMappingURL=OptionalContent.d.ts.map