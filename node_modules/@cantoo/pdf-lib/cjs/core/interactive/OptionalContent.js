"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tslib_1 = require("tslib");
const PDFArray_1 = tslib_1.__importDefault(require("../objects/PDFArray"));
const PDFDict_1 = tslib_1.__importDefault(require("../objects/PDFDict"));
const PDFHexString_1 = tslib_1.__importDefault(require("../objects/PDFHexString"));
const PDFName_1 = tslib_1.__importDefault(require("../objects/PDFName"));
const PDFRef_1 = tslib_1.__importDefault(require("../objects/PDFRef"));
const PDFString_1 = tslib_1.__importDefault(require("../objects/PDFString"));
const utils_1 = require("../../utils");
const decodeOcgName = (ocgDict) => {
    const name = ocgDict.lookup(PDFName_1.default.of('Name'));
    return name instanceof PDFString_1.default || name instanceof PDFHexString_1.default
        ? name.decodeText()
        : '';
};
const refsIn = (array) => {
    const refs = new Set();
    if (!array)
        return refs;
    for (let idx = 0, len = array.size(); idx < len; idx++) {
        const entry = array.get(idx);
        if (entry instanceof PDFRef_1.default)
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
        const ocgs = this.dict.lookupMaybe(PDFName_1.default.of('OCGs'), PDFArray_1.default);
        if (!ocgs)
            return [];
        const dDict = this.dict.lookupMaybe(PDFName_1.default.of('D'), PDFDict_1.default);
        const on = refsIn(dDict === null || dDict === void 0 ? void 0 : dDict.lookupMaybe(PDFName_1.default.of('ON'), PDFArray_1.default));
        const off = refsIn(dDict === null || dDict === void 0 ? void 0 : dDict.lookupMaybe(PDFName_1.default.of('OFF'), PDFArray_1.default));
        // Default BaseState is ON (ISO 32000). Unchanged → treat as ON for `/D`.
        const baseOn = (dDict === null || dDict === void 0 ? void 0 : dDict.lookupMaybe(PDFName_1.default.of('BaseState'), PDFName_1.default)) !==
            PDFName_1.default.of('OFF');
        const groups = [];
        for (let idx = 0, len = ocgs.size(); idx < len; idx++) {
            const ref = ocgs.get(idx);
            if (!(ref instanceof PDFRef_1.default))
                continue;
            const ocgDict = this.dict.context.lookupMaybe(ref, PDFDict_1.default);
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
        (0, utils_1.assertIs)(updates, 'updates', [Array]);
        const groups = this.getGroups();
        if (groups.length === 0) {
            throw new Error('This document has no optional content groups');
        }
        const visibility = new Map(groups.map((g) => [g.ref, g.visible]));
        let matched = 0;
        for (const update of updates) {
            (0, utils_1.assertIs)(update.visible, 'visible', ['boolean']);
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
        let dDict = this.dict.lookupMaybe(PDFName_1.default.of('D'), PDFDict_1.default);
        if (!dDict) {
            dDict = context.obj({});
            this.dict.set(PDFName_1.default.of('D'), dDict);
        }
        const onArray = context.obj([]);
        const offArray = context.obj([]);
        for (const group of groups) {
            (visibility.get(group.ref) ? onArray : offArray).push(group.ref);
        }
        dDict.set(PDFName_1.default.of('ON'), onArray);
        dDict.set(PDFName_1.default.of('OFF'), offArray);
        // All OCGs are listed explicitly; BaseState is irrelevant but ON is the
        // PDF default and keeps partial readers well-behaved.
        dDict.set(PDFName_1.default.of('BaseState'), PDFName_1.default.of('ON'));
    }
}
OptionalContentProperties.fromDict = (dict) => new OptionalContentProperties(dict);
exports.default = OptionalContentProperties;
//# sourceMappingURL=OptionalContent.js.map