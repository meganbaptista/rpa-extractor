"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.addNameTreeEntry = exports.sortNameTreeNames = exports.isWritableFlatNameTree = void 0;
const core_1 = require("../core");
const compareBytes = (left, right) => {
    const length = Math.min(left.length, right.length);
    for (let idx = 0; idx < length; idx++) {
        if (left[idx] !== right[idx])
            return left[idx] - right[idx];
    }
    return left.length - right.length;
};
const isNameTreeKey = (object) => object instanceof core_1.PDFString || object instanceof core_1.PDFHexString;
/**
 * True when `node` is a flat leaf name-tree node we can safely rewrite.
 * Returns false for `/Kids` trees (or nodes that already mix Kids + Names),
 * and for malformed `/Names` arrays — leave those PDFs untouched.
 */
const isWritableFlatNameTree = (node) => {
    if (node.has(core_1.PDFName.of('Kids')))
        return false;
    if (!node.has(core_1.PDFName.of('Names')))
        return true;
    const names = node.lookup(core_1.PDFName.of('Names'));
    if (!(names instanceof core_1.PDFArray) || names.size() % 2 !== 0)
        return false;
    for (let idx = 0, len = names.size(); idx < len; idx += 2) {
        if (!isNameTreeKey(names.get(idx)))
            return false;
    }
    return true;
};
exports.isWritableFlatNameTree = isWritableFlatNameTree;
/**
 * Sort a flat name-tree `/Names` array in place (PDF lexical / byte order).
 */
const sortNameTreeNames = (names) => {
    const pairCount = names.size() / 2;
    const pairs = [];
    for (let idx = 0; idx < pairCount; idx++) {
        const keyIdx = idx * 2;
        pairs.push({
            key: names.lookup(keyIdx, core_1.PDFString, core_1.PDFHexString),
            value: names.get(keyIdx + 1),
        });
    }
    pairs.sort((a, b) => compareBytes(a.key.asBytes(), b.key.asBytes()));
    for (let idx = 0; idx < pairs.length; idx++) {
        names.set(idx * 2, pairs[idx].key);
        names.set(idx * 2 + 1, pairs[idx].value);
    }
};
exports.sortNameTreeNames = sortNameTreeNames;
const syncLimitsIfPresent = (node, names) => {
    if (!node.has(core_1.PDFName.of('Limits')) || names.size() === 0)
        return;
    const limits = node.lookup(core_1.PDFName.of('Limits'));
    if (!(limits instanceof core_1.PDFArray) || limits.size() < 2)
        return;
    limits.set(0, names.get(0));
    limits.set(1, names.get(names.size() - 2));
};
/**
 * Append `key` / `value` to a flat name-tree node and re-sort `/Names`.
 *
 * @returns `true` if the entry was registered; `false` if the node uses
 * `/Kids` or another incompatible structure (left unchanged).
 */
const addNameTreeEntry = (node, key, value) => {
    if (!(0, exports.isWritableFlatNameTree)(node))
        return false;
    if (!node.has(core_1.PDFName.of('Names'))) {
        node.set(core_1.PDFName.of('Names'), node.context.obj([]));
    }
    const names = node.lookup(core_1.PDFName.of('Names'), core_1.PDFArray);
    names.push(key);
    names.push(value);
    (0, exports.sortNameTreeNames)(names);
    syncLimitsIfPresent(node, names);
    return true;
};
exports.addNameTreeEntry = addNameTreeEntry;
//# sourceMappingURL=nameTree.js.map