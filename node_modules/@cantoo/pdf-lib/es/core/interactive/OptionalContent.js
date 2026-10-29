import PDFArray from '../objects/PDFArray.js';
import PDFDict from '../objects/PDFDict.js';
import PDFHexString from '../objects/PDFHexString.js';
import PDFName from '../objects/PDFName.js';
import PDFRef from '../objects/PDFRef.js';
import PDFString from '../objects/PDFString.js';
import { assertIs } from '../../utils/index.js';
const decodeOcgName = (ocgDict) => {
    const name = ocgDict.lookup(PDFName.of('Name'));
    return name instanceof PDFString || name instanceof PDFHexString
        ? name.decodeText()
        : '';
};
const refsIn = (array) => {
    const refs = new Set();
    if (!array)
        return refs;
    for (let idx = 0, len = array.size(); idx < len; idx++) {
        const entry = array.get(idx);
        if (entry instanceof PDFRef)
            refs.add(entry);
    }
    return refs;
};
/**
 * High-level access to `/OCProperties` (optional content / layers). Visibility
 * updates rewrite the default configuration (`/D`) `/ON` and `/OFF` arrays.
 */
class OptionalContentProperties {
    constructor(dict) {
        this.dict = dict;
    }
    /** List `/OCGs` with default visibility from `/D`. */
    getGroups() {
        const ocgs = this.dict.lookupMaybe(PDFName.of('OCGs'), PDFArray);
        if (!ocgs)
            return [];
        const dDict = this.dict.lookupMaybe(PDFName.of('D'), PDFDict);
        const on = refsIn(dDict === null || dDict === void 0 ? void 0 : dDict.lookupMaybe(PDFName.of('ON'), PDFArray));
        const off = refsIn(dDict === null || dDict === void 0 ? void 0 : dDict.lookupMaybe(PDFName.of('OFF'), PDFArray));
        // Default BaseState is ON (ISO 32000). Unchanged → treat as ON for `/D`.
        const baseOn = (dDict === null || dDict === void 0 ? void 0 : dDict.lookupMaybe(PDFName.of('BaseState'), PDFName)) !==
            PDFName.of('OFF');
        const groups = [];
        for (let idx = 0, len = ocgs.size(); idx < len; idx++) {
            const ref = ocgs.get(idx);
            if (!(ref instanceof PDFRef))
                continue;
            const ocgDict = this.dict.context.lookupMaybe(ref, PDFDict);
            if (!ocgDict)
                continue;
            groups.push({
                name: decodeOcgName(ocgDict),
                visible: on.has(ref) ? true : off.has(ref) ? false : baseOn,
                ref,
            });
        }
        return groups;
    }
    /** Set default visibility for the given groups (by `name` and/or `ref`). */
    setVisibility(updates) {
        assertIs(updates, 'updates', [Array]);
        const groups = this.getGroups();
        if (groups.length === 0) {
            throw new Error('This document has no optional content groups');
        }
        const visibility = new Map(groups.map((g) => [g.ref, g.visible]));
        let matched = 0;
        for (const update of updates) {
            assertIs(update.visible, 'visible', ['boolean']);
            if (update.ref === undefined && update.name === undefined) {
                throw new Error('Optional content visibility update must include a name and/or ref');
            }
            for (const group of groups) {
                if ((update.ref !== undefined && group.ref === update.ref) ||
                    (update.name !== undefined && group.name === update.name)) {
                    visibility.set(group.ref, update.visible);
                    matched += 1;
                }
            }
        }
        if (matched === 0) {
            throw new Error('No matching optional content group found');
        }
        const { context } = this.dict;
        let dDict = this.dict.lookupMaybe(PDFName.of('D'), PDFDict);
        if (!dDict) {
            dDict = context.obj({});
            this.dict.set(PDFName.of('D'), dDict);
        }
        const onArray = context.obj([]);
        const offArray = context.obj([]);
        for (const group of groups) {
            (visibility.get(group.ref) ? onArray : offArray).push(group.ref);
        }
        dDict.set(PDFName.of('ON'), onArray);
        dDict.set(PDFName.of('OFF'), offArray);
        // All OCGs are listed explicitly; BaseState is irrelevant but ON is the
        // PDF default and keeps partial readers well-behaved.
        dDict.set(PDFName.of('BaseState'), PDFName.of('ON'));
    }
}
OptionalContentProperties.fromDict = (dict) => new OptionalContentProperties(dict);
export default OptionalContentProperties;
//# sourceMappingURL=OptionalContent.js.map