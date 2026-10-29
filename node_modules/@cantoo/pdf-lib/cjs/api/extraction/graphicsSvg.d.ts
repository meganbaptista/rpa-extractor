import { TransformationMatrix } from '../../types/matrix';
export type PathPaintStyle = {
    fill?: string;
    stroke?: string;
    fillRule?: 'nonzero' | 'evenodd';
    lineWidth: number;
};
export type GraphicsSvgResult = {
    x: number;
    y: number;
    width: number;
    height: number;
    svg: string;
};
/** Accumulates a PDF path in current user space, then emits page-space SVG. */
export declare class PdfPathBuilder {
    private ops;
    private current;
    private subpathStart;
    private hasGeometry;
    get isEmpty(): boolean;
    clear(): void;
    moveTo(x: number, y: number): void;
    lineTo(x: number, y: number): void;
    curveTo(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): void;
    /** `v`: replicate first control point as current point */
    curveV(x2: number, y2: number, x3: number, y3: number): void;
    /** `y`: replicate final control point */
    curveY(x1: number, y1: number, x3: number, y3: number): void;
    closePath(): void;
    rectangle(x: number, y: number, w: number, h: number): void;
    /**
     * Build an SVG asset: path points are mapped through `ctm` into page space.
     * The SVG uses `scale(1,-1)` so it displays with a conventional y-down axis
     * while path data stays in PDF user-space numbers.
     */
    paint(ctm: TransformationMatrix, style: PathPaintStyle): GraphicsSvgResult | undefined;
}
export declare const rgbCss: (r: number, g: number, b: number) => string;
export declare const grayCss: (g: number) => string;
/** Rough CMYK→RGB for extraction display */
export declare const cmykCss: (c: number, m: number, y: number, k: number) => string;
//# sourceMappingURL=graphicsSvg.d.ts.map