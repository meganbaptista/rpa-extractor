import PDFStream from '../../core/objects/PDFStream';
export type ExtractedImageBytes = {
    width: number;
    height: number;
    mimeType: 'image/jpeg' | 'image/png';
    bytes: Uint8Array;
};
/**
 * Convert an Image XObject stream into usable image file bytes.
 * - DCTDecode → JPEG bytes as stored
 * - DeviceRGB / DeviceGray 8-bit (typically Flate) → PNG
 * Returns undefined for unsupported color spaces / filters.
 */
export declare const extractImageBytes: (stream: PDFStream) => ExtractedImageBytes | undefined;
//# sourceMappingURL=imageBytes.d.ts.map