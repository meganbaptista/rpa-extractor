"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseConformance = void 0;
const CONFORMANCE_LEVELS = [
    '1B',
    '2B',
    '2U',
    '3B',
    '3U',
];
/**
 * Parse a [[PDFAConformanceLevel]] string into its part and level components,
 * throwing a descriptive error for unsupported values.
 */
const parseConformance = (conformance) => {
    if (!CONFORMANCE_LEVELS.includes(conformance)) {
        throw new Error(`Unsupported PDF/A conformance "${conformance}". ` +
            `Supported values are: ${CONFORMANCE_LEVELS.join(', ')}. ` +
            'Level "A" (accessible/tagged) conformance is not supported.');
    }
    return {
        part: Number(conformance[0]),
        level: conformance[1],
    };
};
exports.parseConformance = parseConformance;
//# sourceMappingURL=PDFAConformance.js.map