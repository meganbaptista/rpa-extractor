import PDFContext from '../PDFContext';
/**
 * Interface representing user permissions.
 *
 * @interface UserPermissions
 */
interface UserPermissions {
    /**
     * Printing Permission
     * For Security handlers of revision <= 2 : Boolean
     * For Security handlers of revision >= 3 : 'lowResolution' or 'highResolution'
     */
    printing?: boolean | 'lowResolution' | 'highResolution';
    /**
     * Modify Content Permission (Other than 'annotating', 'fillingForms' and 'documentAssembly')
     */
    modifying?: boolean;
    /** Copy or otherwise extract text and graphics from document */
    copying?: boolean;
    /** Permission to add or modify text annotations */
    annotating?: boolean;
    /**
     * Security handlers of revision >= 3
     * Fill in existing interactive form fields (including signature fields)
     */
    fillingForms?: boolean;
    /**
     * Security handlers of revision >= 3
     * Extract text and graphics (in support of accessibility to users with disabilities or for other purposes)
     */
    contentAccessibility?: boolean;
    /**
     * Security handlers of revision >= 3
     * Assemble the document (insert, rotate or delete pages and create bookmarks or thumbnail images)
     */
    documentAssembly?: boolean;
}
export type EncryptFn = (buffer: Uint8Array) => Uint8Array;
/**
 * Cipher used to encrypt a document.
 *
 * `AES-256` is the default and the only one recommended by ISO 32000-2. The RC4
 * variants are broken and are kept only to interoperate with viewers predating
 * Acrobat 7; selecting one requires
 * {@link SecurityOptions.allowWeakCryptography}.
 */
export type EncryptionAlgorithm = 'AES-256' | 'AES-128' | 'RC4-128' | 'RC4-40';
/**
 * Interface options for security
 * @interface SecurityOptions
 */
export interface SecurityOptions {
    /**
     * Password that provides unlimited access to the encrypted document.
     *
     * Opening encrypted document with owner password allows full (owner) access to the document
     */
    ownerPassword?: string;
    /** Password that restricts reader according to the defined permissions.
     *
     * Opening encrypted document with user password will have limitations in accordance to the permission defined.
     */
    userPassword?: string;
    /** Object representing type of user permission enforced on the document
     * @link {@link UserPermissions}
     */
    permissions?: UserPermissions;
    /**
     * Cipher to encrypt the document with. Defaults to `'AES-256'`.
     *
     * The document's own PDF version is never used to pick the cipher: it
     * describes the syntax its producer used, not what the reader opening the
     * encrypted file supports. The header is instead raised to the minimum
     * version the chosen cipher requires, so the file stays self-consistent.
     */
    algorithm?: EncryptionAlgorithm;
    /**
     * Permits selecting a broken cipher (`'RC4-40'` or `'RC4-128'`). Without it,
     * asking for RC4 throws. Only useful for viewers predating Acrobat 7 (2005).
     */
    allowWeakCryptography?: boolean;
}
declare class PDFSecurity {
    context: PDFContext;
    private id;
    private encryption;
    private keyBits;
    private encryptionKey;
    private profile;
    static create(context: PDFContext, options: SecurityOptions): PDFSecurity;
    constructor(context: PDFContext, options: SecurityOptions);
    private initialize;
    /**
     * Raises the header to the lowest version that defines the chosen handler, so
     * the file never advertises a version older than the encryption it uses. The
     * version is only ever raised, never lowered.
     */
    private raiseHeaderVersion;
    /**
     * AES-256 is not part of PDF 1.7; it arrived with Adobe extension level 8,
     * which a 1.7 file declares through the catalog's `/Extensions` dictionary
     * (ISO 32000-1 §7.1, Annex E). Skipped for PDF 2.0 and later, where the
     * handler is part of the base specification.
     */
    private declareExtensionLevel;
    private initializeV1V2V4;
    private initializeV5;
    getEncryptFn(obj: number, gen: number): EncryptFn;
    encrypt(): this;
}
/**
 * Generate a random 16-byte file identifier suitable for the PDF trailer
 * `/ID` entry (and for encryption).
 */
export declare const generateRandomFileId: () => Uint8Array;
export default PDFSecurity;
//# sourceMappingURL=PDFSecurity.d.ts.map