/** PNG binary read/write helpers and CRC32. */
export declare function nextZero(data: Uint8Array, p: number): number;
export declare function readUshort(buff: Uint8Array, p: number): number;
export declare function writeUshort(buff: Uint8Array, p: number, n: number): void;
export declare function readUint(buff: Uint8Array, p: number): number;
export declare function writeUint(buff: Uint8Array, p: number, n: number): void;
export declare function readASCII(buff: Uint8Array, p: number, l: number): string;
export declare function writeASCII(data: Uint8Array, p: number, s: string): void;
export declare function readBytes(buff: Uint8Array, p: number, l: number): number[];
export declare function readUTF8(buff: Uint8Array, p: number, l: number): string;
/** PNG-style CRC32 over `buf[off .. off+len)`. */
export declare function crc(buf: Uint8Array, off: number, len: number): number;
//# sourceMappingURL=binary.d.ts.map