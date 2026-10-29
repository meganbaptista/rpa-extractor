"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Encodings = void 0;
const tslib_1 = require("tslib");
/* tslint:disable max-classes-per-file */
const utils_1 = require("./utils");
const all_encodings_compressed_json_1 = tslib_1.__importDefault(require("./all-encodings.compressed.json"));
const decompressedEncodings = (0, utils_1.decompressJson)(all_encodings_compressed_json_1.default);
const allUnicodeMappings = JSON.parse(decompressedEncodings);
class Encoding {
    constructor(name, unicodeMappings) {
        this.canEncodeUnicodeCodePoint = (codePoint) => codePoint in this.unicodeMappings;
        this.encodeUnicodeCodePoint = (codePoint) => {
            const mapped = this.unicodeMappings[codePoint];
            if (!mapped) {
                const str = String.fromCharCode(codePoint);
                const hexCode = `0x${(0, utils_1.padStart)(codePoint.toString(16), 4, '0')}`;
                const msg = `${this.name} cannot encode "${str}" (${hexCode})`;
                throw new Error(msg);
            }
            return { code: mapped[0], name: mapped[1] };
        };
        this.name = name;
        this.supportedCodePoints = Object.keys(unicodeMappings)
            .map(Number)
            .sort((a, b) => a - b);
        this.unicodeMappings = unicodeMappings;
    }
}
exports.Encodings = {
    Symbol: new Encoding('Symbol', allUnicodeMappings.symbol),
    ZapfDingbats: new Encoding('ZapfDingbats', allUnicodeMappings.zapfdingbats),
    WinAnsi: new Encoding('WinAnsi', allUnicodeMappings.win1252),
};
//# sourceMappingURL=Encoding.js.map