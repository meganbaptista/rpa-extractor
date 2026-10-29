"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseContentStream = void 0;
const tslib_1 = require("tslib");
const CharCodes_1 = tslib_1.__importDefault(require("../../core/syntax/CharCodes"));
const Numeric_1 = require("../../core/syntax/Numeric");
const Whitespace_1 = require("../../core/syntax/Whitespace");
const Delimiters_1 = require("../../core/syntax/Delimiters");
const utils_1 = require("../../utils");
/**
 * Tokenize a decoded PDF content stream into operator / operand sequences.
 * Inline images (`BI`…`ID`…`EI`) are skipped as a unit.
 */
const parseContentStream = (bytes) => {
    const parser = new ContentStreamParser(bytes);
    return parser.parse();
};
exports.parseContentStream = parseContentStream;
class ContentStreamParser {
    constructor(bytes) {
        this.idx = 0;
        this.bytes = bytes;
    }
    parse() {
        const operations = [];
        let args = [];
        while (!this.done()) {
            this.skipWhitespaceAndComments();
            if (this.done())
                break;
            const byte = this.peek();
            if (byte === CharCodes_1.default.ForwardSlash) {
                args.push(this.parseName());
                continue;
            }
            if (byte === CharCodes_1.default.LeftParen) {
                args.push(this.parseLiteralString());
                continue;
            }
            if (byte === CharCodes_1.default.LessThan &&
                this.peekAhead(1) === CharCodes_1.default.LessThan) {
                args.push(this.parseDict());
                continue;
            }
            if (byte === CharCodes_1.default.LessThan) {
                args.push(this.parseHexString());
                continue;
            }
            if (byte === CharCodes_1.default.LeftSquareBracket) {
                args.push(this.parseArray());
                continue;
            }
            if (byte === CharCodes_1.default.Plus ||
                byte === CharCodes_1.default.Minus ||
                byte === CharCodes_1.default.Period ||
                Numeric_1.IsDigit[byte]) {
                args.push(this.parseNumber());
                continue;
            }
            // Operator (or keyword true/false/null — treat as operand-like no-ops via skip)
            const op = this.parseOperator();
            if (op === 'true') {
                args.push(1);
                continue;
            }
            if (op === 'false') {
                args.push(0);
                continue;
            }
            if (op === 'null') {
                args.push(0);
                continue;
            }
            if (op === 'BI') {
                this.skipInlineImage();
                args = [];
                continue;
            }
            operations.push({ name: op, args });
            args = [];
        }
        return operations;
    }
    done() {
        return this.idx >= this.bytes.length;
    }
    peek() {
        return this.bytes[this.idx];
    }
    peekAhead(n) {
        return this.bytes[this.idx + n];
    }
    next() {
        return this.bytes[this.idx++];
    }
    skipWhitespaceAndComments() {
        while (!this.done()) {
            const byte = this.peek();
            if (Whitespace_1.IsWhitespace[byte]) {
                this.next();
                continue;
            }
            if (byte === CharCodes_1.default.Percent) {
                while (!this.done()) {
                    const b = this.next();
                    if (b === CharCodes_1.default.Newline || b === CharCodes_1.default.CarriageReturn)
                        break;
                }
                continue;
            }
            break;
        }
    }
    parseName() {
        this.next(); // /
        let value = '';
        while (!this.done()) {
            const byte = this.peek();
            if (Whitespace_1.IsWhitespace[byte] || Delimiters_1.IsDelimiter[byte])
                break;
            value += (0, utils_1.charFromCode)(this.next());
        }
        // Decode #HH escapes
        value = value.replace(/#([0-9A-Fa-f]{2})/g, (_, hex) => (0, utils_1.charFromCode)(parseInt(hex, 16)));
        return { type: 'name', value };
    }
    parseNumber() {
        let value = '';
        while (!this.done()) {
            const byte = this.peek();
            if (!Numeric_1.IsNumeric[byte])
                break;
            value += (0, utils_1.charFromCode)(this.next());
            if (byte === CharCodes_1.default.Period)
                break;
        }
        while (!this.done() && Numeric_1.IsDigit[this.peek()]) {
            value += (0, utils_1.charFromCode)(this.next());
        }
        return Number(value);
    }
    parseHexString() {
        this.next(); // <
        let hex = '';
        while (!this.done()) {
            const byte = this.peek();
            if (byte === CharCodes_1.default.GreaterThan) {
                this.next();
                break;
            }
            if (!Whitespace_1.IsWhitespace[byte])
                hex += (0, utils_1.charFromCode)(this.next());
            else
                this.next();
        }
        if (hex.length % 2 === 1)
            hex += '0';
        const bytes = new Uint8Array(hex.length / 2);
        for (let i = 0; i < bytes.length; i++) {
            bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
        }
        return { type: 'hexString', bytes };
    }
    parseLiteralString() {
        this.next(); // (
        const out = [];
        let depth = 1;
        while (!this.done() && depth > 0) {
            const byte = this.next();
            if (byte === CharCodes_1.default.BackSlash) {
                if (this.done())
                    break;
                const esc = this.next();
                if (esc === CharCodes_1.default.n)
                    out.push(CharCodes_1.default.Newline);
                else if (esc === CharCodes_1.default.r)
                    out.push(CharCodes_1.default.CarriageReturn);
                else if (esc === CharCodes_1.default.t)
                    out.push(CharCodes_1.default.Tab);
                else if (esc === CharCodes_1.default.b)
                    out.push(CharCodes_1.default.Backspace);
                else if (esc === CharCodes_1.default.f)
                    out.push(CharCodes_1.default.FormFeed);
                else if (esc === CharCodes_1.default.LeftParen)
                    out.push(CharCodes_1.default.LeftParen);
                else if (esc === CharCodes_1.default.RightParen)
                    out.push(CharCodes_1.default.RightParen);
                else if (esc === CharCodes_1.default.BackSlash)
                    out.push(CharCodes_1.default.BackSlash);
                else if (Numeric_1.IsDigit[esc]) {
                    let oct = (0, utils_1.charFromCode)(esc);
                    if (!this.done() && Numeric_1.IsDigit[this.peek()]) {
                        oct += (0, utils_1.charFromCode)(this.next());
                    }
                    if (!this.done() && Numeric_1.IsDigit[this.peek()]) {
                        oct += (0, utils_1.charFromCode)(this.next());
                    }
                    out.push(parseInt(oct, 8) & 0xff);
                }
                else if (esc === CharCodes_1.default.Newline ||
                    esc === CharCodes_1.default.CarriageReturn) {
                    // line continuation — skip
                    if (esc === CharCodes_1.default.CarriageReturn &&
                        !this.done() &&
                        this.peek() === CharCodes_1.default.Newline) {
                        this.next();
                    }
                }
                else {
                    out.push(esc);
                }
            }
            else if (byte === CharCodes_1.default.LeftParen) {
                depth++;
                out.push(byte);
            }
            else if (byte === CharCodes_1.default.RightParen) {
                depth--;
                if (depth > 0)
                    out.push(byte);
            }
            else {
                out.push(byte);
            }
        }
        return { type: 'string', bytes: Uint8Array.from(out) };
    }
    parseArray() {
        this.next(); // [
        const items = [];
        while (!this.done()) {
            this.skipWhitespaceAndComments();
            if (this.done())
                break;
            if (this.peek() === CharCodes_1.default.RightSquareBracket) {
                this.next();
                break;
            }
            // Reuse operand parsers; operators shouldn't appear in arrays, but TJ has nested strings/numbers
            const byte = this.peek();
            if (byte === CharCodes_1.default.ForwardSlash)
                items.push(this.parseName());
            else if (byte === CharCodes_1.default.LeftParen) {
                items.push(this.parseLiteralString());
            }
            else if (byte === CharCodes_1.default.LessThan &&
                this.peekAhead(1) === CharCodes_1.default.LessThan) {
                items.push(this.parseDict());
            }
            else if (byte === CharCodes_1.default.LessThan)
                items.push(this.parseHexString());
            else if (byte === CharCodes_1.default.LeftSquareBracket) {
                items.push(this.parseArray());
            }
            else if (byte === CharCodes_1.default.Plus ||
                byte === CharCodes_1.default.Minus ||
                byte === CharCodes_1.default.Period ||
                Numeric_1.IsDigit[byte]) {
                items.push(this.parseNumber());
            }
            else {
                // Unexpected operator-like token inside array — skip as name-ish
                this.parseOperator();
            }
        }
        return items;
    }
    parseDict() {
        this.next(); // <
        this.next(); // <
        const dict = {};
        while (!this.done()) {
            this.skipWhitespaceAndComments();
            if (this.peek() === CharCodes_1.default.GreaterThan &&
                this.peekAhead(1) === CharCodes_1.default.GreaterThan) {
                this.next();
                this.next();
                break;
            }
            const key = this.parseName();
            this.skipWhitespaceAndComments();
            const byte = this.peek();
            let value;
            if (byte === CharCodes_1.default.ForwardSlash)
                value = this.parseName();
            else if (byte === CharCodes_1.default.LeftParen)
                value = this.parseLiteralString();
            else if (byte === CharCodes_1.default.LessThan &&
                this.peekAhead(1) === CharCodes_1.default.LessThan) {
                value = this.parseDict();
            }
            else if (byte === CharCodes_1.default.LessThan)
                value = this.parseHexString();
            else if (byte === CharCodes_1.default.LeftSquareBracket)
                value = this.parseArray();
            else if (byte === CharCodes_1.default.Plus ||
                byte === CharCodes_1.default.Minus ||
                byte === CharCodes_1.default.Period ||
                Numeric_1.IsDigit[byte]) {
                value = this.parseNumber();
            }
            else {
                const op = this.parseOperator();
                value = op === 'true' ? 1 : op === 'false' ? 0 : op === 'null' ? 0 : op;
            }
            dict[key.value] = value;
        }
        return dict;
    }
    parseOperator() {
        const first = this.peek();
        // Single-char operators ' and "
        if (first === 39 /* ' */ || first === 34 /* " */) {
            return (0, utils_1.charFromCode)(this.next());
        }
        let value = '';
        while (!this.done()) {
            const byte = this.peek();
            if (Whitespace_1.IsWhitespace[byte] || Delimiters_1.IsDelimiter[byte])
                break;
            value += (0, utils_1.charFromCode)(this.next());
        }
        return value;
    }
    skipInlineImage() {
        // Skip until ID, then consume until EI after whitespace
        while (!this.done()) {
            this.skipWhitespaceAndComments();
            if (this.done())
                return;
            // Look for ID keyword
            if (this.peek() === 73 /* I */ &&
                this.peekAhead(1) === CharCodes_1.default.D &&
                (this.idx + 2 >= this.bytes.length ||
                    Whitespace_1.IsWhitespace[this.bytes[this.idx + 2]] ||
                    Delimiters_1.IsDelimiter[this.bytes[this.idx + 2]])) {
                this.next();
                this.next();
                // Skip one whitespace after ID
                if (!this.done() && Whitespace_1.IsWhitespace[this.peek()])
                    this.next();
                break;
            }
            // Skip a dict key/value or token
            if (this.peek() === CharCodes_1.default.ForwardSlash) {
                this.parseName();
                this.skipWhitespaceAndComments();
                // skip value crudely
                const b = this.peek();
                if (b === CharCodes_1.default.ForwardSlash)
                    this.parseName();
                else if (Numeric_1.IsNumeric[b] ||
                    b === CharCodes_1.default.Plus ||
                    b === CharCodes_1.default.Minus) {
                    this.parseNumber();
                }
                else if (b === CharCodes_1.default.LeftParen)
                    this.parseLiteralString();
                else if (b === CharCodes_1.default.LessThan) {
                    if (this.peekAhead(1) === CharCodes_1.default.LessThan)
                        this.parseDict();
                    else
                        this.parseHexString();
                }
                else
                    this.parseOperator();
            }
            else {
                this.parseOperator();
            }
        }
        // Scan for EI
        while (!this.done()) {
            if (this.peek() === CharCodes_1.default.E &&
                this.peekAhead(1) === 73 /* I */ &&
                (this.idx === 0 || Whitespace_1.IsWhitespace[this.bytes[this.idx - 1]] || true)) {
                // EI must be preceded by whitespace or start; check previous byte
                const prev = this.idx > 0 ? this.bytes[this.idx - 1] : CharCodes_1.default.Space;
                const next = this.bytes[this.idx + 2];
                if (Whitespace_1.IsWhitespace[prev] &&
                    (next === undefined || Whitespace_1.IsWhitespace[next] || Delimiters_1.IsDelimiter[next])) {
                    this.next();
                    this.next();
                    return;
                }
            }
            this.next();
        }
    }
}
//# sourceMappingURL=ContentStreamParser.js.map