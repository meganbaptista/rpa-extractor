"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cmykCss = exports.grayCss = exports.rgbCss = exports.PdfPathBuilder = void 0;
/** Accumulates a PDF path in current user space, then emits page-space SVG. */
class PdfPathBuilder {
    constructor() {
        this.ops = [];
        this.hasGeometry = false;
    }
    get isEmpty() {
        return !this.hasGeometry;
    }
    clear() {
        this.ops = [];
        this.current = undefined;
        this.subpathStart = undefined;
        this.hasGeometry = false;
    }
    moveTo(x, y) {
        this.current = { x, y };
        this.subpathStart = { x, y };
        this.ops.push({ type: 'M', x, y });
        this.hasGeometry = true;
    }
    lineTo(x, y) {
        this.current = { x, y };
        this.ops.push({ type: 'L', x, y });
        this.hasGeometry = true;
    }
    curveTo(x1, y1, x2, y2, x3, y3) {
        this.current = { x: x3, y: y3 };
        this.ops.push({ type: 'C', x1, y1, x2, y2, x3, y3 });
        this.hasGeometry = true;
    }
    /** `v`: replicate first control point as current point */
    curveV(x2, y2, x3, y3) {
        var _a, _b, _c, _d;
        const x1 = (_b = (_a = this.current) === null || _a === void 0 ? void 0 : _a.x) !== null && _b !== void 0 ? _b : 0;
        const y1 = (_d = (_c = this.current) === null || _c === void 0 ? void 0 : _c.y) !== null && _d !== void 0 ? _d : 0;
        this.curveTo(x1, y1, x2, y2, x3, y3);
    }
    /** `y`: replicate final control point */
    curveY(x1, y1, x3, y3) {
        this.curveTo(x1, y1, x3, y3, x3, y3);
    }
    closePath() {
        if (this.subpathStart) {
            this.current = Object.assign({}, this.subpathStart);
        }
        this.ops.push({ type: 'Z' });
    }
    rectangle(x, y, w, h) {
        this.moveTo(x, y);
        this.lineTo(x + w, y);
        this.lineTo(x + w, y + h);
        this.lineTo(x, y + h);
        this.closePath();
    }
    /**
     * Build an SVG asset: path points are mapped through `ctm` into page space.
     * The SVG uses `scale(1,-1)` so it displays with a conventional y-down axis
     * while path data stays in PDF user-space numbers.
     */
    paint(ctm, style) {
        var _a, _b;
        if (!this.hasGeometry || this.ops.length === 0)
            return undefined;
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        const include = (p) => {
            if (p.x < minX)
                minX = p.x;
            if (p.y < minY)
                minY = p.y;
            if (p.x > maxX)
                maxX = p.x;
            if (p.y > maxY)
                maxY = p.y;
        };
        const dParts = [];
        for (const op of this.ops) {
            if (op.type === 'Z') {
                dParts.push('Z');
                continue;
            }
            if (op.type === 'M' || op.type === 'L') {
                const p = applyCtm(op.x, op.y, ctm);
                include(p);
                dParts.push(`${op.type} ${fmt(p.x)} ${fmt(p.y)}`);
                continue;
            }
            if (op.type === 'C') {
                const p1 = applyCtm(op.x1, op.y1, ctm);
                const p2 = applyCtm(op.x2, op.y2, ctm);
                const p3 = applyCtm(op.x3, op.y3, ctm);
                include(p1);
                include(p2);
                include(p3);
                dParts.push(`C ${fmt(p1.x)} ${fmt(p1.y)} ${fmt(p2.x)} ${fmt(p2.y)} ${fmt(p3.x)} ${fmt(p3.y)}`);
            }
        }
        if (!Number.isFinite(minX))
            return undefined;
        const width = maxX - minX || 1;
        const height = maxY - minY || 1;
        const scale = averageScale(ctm);
        const strokeWidth = style.lineWidth * scale;
        const fill = (_a = style.fill) !== null && _a !== void 0 ? _a : (style.stroke ? 'none' : '#000000');
        const stroke = (_b = style.stroke) !== null && _b !== void 0 ? _b : 'none';
        const fillRule = style.fillRule === 'evenodd' ? ' fill-rule="evenodd"' : '';
        const attrs = [
            `d="${dParts.join(' ')}"`,
            `fill="${fill}"`,
            `stroke="${stroke}"`,
            stroke !== 'none' ? `stroke-width="${fmt(strokeWidth)}"` : undefined,
            fillRule || undefined,
        ]
            .filter(Boolean)
            .join(' ');
        const vbX = minX;
        const vbY = -maxY;
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" ' +
            `viewBox="${fmt(vbX)} ${fmt(vbY)} ${fmt(width)} ${fmt(height)}">` +
            `<g transform="scale(1,-1)"><path ${attrs}/></g></svg>`;
        return { x: minX, y: minY, width, height, svg };
    }
}
exports.PdfPathBuilder = PdfPathBuilder;
const rgbCss = (r, g, b) => {
    const R = Math.round(clamp01(r) * 255);
    const G = Math.round(clamp01(g) * 255);
    const B = Math.round(clamp01(b) * 255);
    return `#${hex2(R)}${hex2(G)}${hex2(B)}`;
};
exports.rgbCss = rgbCss;
const grayCss = (g) => (0, exports.rgbCss)(g, g, g);
exports.grayCss = grayCss;
/** Rough CMYK→RGB for extraction display */
const cmykCss = (c, m, y, k) => {
    const C = clamp01(c);
    const M = clamp01(m);
    const Y = clamp01(y);
    const K = clamp01(k);
    return (0, exports.rgbCss)(1 - Math.min(1, C * (1 - K) + K), 1 - Math.min(1, M * (1 - K) + K), 1 - Math.min(1, Y * (1 - K) + K));
};
exports.cmykCss = cmykCss;
const clamp01 = (n) => Math.min(1, Math.max(0, n));
const hex2 = (n) => n.toString(16).padStart(2, '0');
const fmt = (n) => {
    if (!Number.isFinite(n))
        return '0';
    return String(Math.round(n * 1000) / 1000);
};
const applyCtm = (x, y, [a, b, c, d, e, f]) => ({
    x: a * x + c * y + e,
    y: b * x + d * y + f,
});
const averageScale = ([a, b, c, d]) => {
    const sx = Math.hypot(a, b);
    const sy = Math.hypot(c, d);
    return (sx + sy) / 2 || 1;
};
//# sourceMappingURL=graphicsSvg.js.map