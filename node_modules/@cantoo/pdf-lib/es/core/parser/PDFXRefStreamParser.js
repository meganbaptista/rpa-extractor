import { ReparseError } from '../errors.js';
import PDFArray from '../objects/PDFArray.js';
import PDFName from '../objects/PDFName.js';
import PDFNumber from '../objects/PDFNumber.js';
import PDFRef from '../objects/PDFRef.js';
import ByteStream from './ByteStream.js';
class PDFXRefStreamParser {
    constructor(rawStream) {
        this.alreadyParsed = false;
        this.dict = rawStream.dict;
        this.bytes = ByteStream.fromPDFRawStream(rawStream);
        this.context = this.dict.context;
        this.context.pdfFileDetails.useObjectStreams = true;
        const Size = this.dict.lookup(PDFName.of('Size'), PDFNumber);
        const Index = this.dict.lookup(PDFName.of('Index'));
        if (Index instanceof PDFArray) {
            this.subsections = [];
            for (let idx = 0, len = Index.size(); idx < len; idx += 2) {
                const firstObjectNumber = Index.lookup(idx + 0, PDFNumber).asNumber();
                const length = Index.lookup(idx + 1, PDFNumber).asNumber();
                this.subsections.push({ firstObjectNumber, length });
            }
        }
        else {
            this.subsections = [{ firstObjectNumber: 0, length: Size.asNumber() }];
        }
        const W = this.dict.lookup(PDFName.of('W'), PDFArray);
        this.byteWidths = [-1, -1, -1];
        for (let idx = 0, len = W.size(); idx < len; idx++) {
            this.byteWidths[idx] = W.lookup(idx, PDFNumber).asNumber();
        }
    }
    parseIntoContext() {
        if (this.alreadyParsed) {
            throw new ReparseError('PDFXRefStreamParser', 'parseIntoContext');
        }
        this.alreadyParsed = true;
        // Merge with any previously parsed trailer. Later XRef streams (e.g. the
        // main body stream of a linearized PDF) often omit Root/Info/ID.
        const prev = this.context.trailerInfo;
        this.context.trailerInfo = {
            Size: this.dict.lookup(PDFName.of('Size'), PDFNumber) || prev.Size,
            Root: this.dict.get(PDFName.of('Root')) || prev.Root,
            Encrypt: this.dict.get(PDFName.of('Encrypt')) || prev.Encrypt,
            Info: this.dict.get(PDFName.of('Info')) || prev.Info,
            ID: this.dict.get(PDFName.of('ID')) || prev.ID,
        };
        // if open for incremental update, make sure next object number doesn't overlap a deleted one.
        // Use Math.max so a later section with a smaller Size (e.g. linearized PDFs) cannot lower the value.
        if (this.context.trailerInfo.Size &&
            this.context.pdfFileDetails.originalBytes) {
            this.context.largestObjectNumber = Math.max(this.context.largestObjectNumber, this.context.trailerInfo.Size.asNumber() - 1);
        }
        const entries = this.parseEntries();
        // for (let idx = 0, len = entries.length; idx < len; idx++) {
        // const entry = entries[idx];
        // if (entry.deleted) this.context.delete(entry.ref);
        // }
        return entries;
    }
    parseEntries() {
        const entries = [];
        const [typeFieldWidth, offsetFieldWidth, genFieldWidth] = this.byteWidths;
        for (let subsectionIdx = 0, subsectionLen = this.subsections.length; subsectionIdx < subsectionLen; subsectionIdx++) {
            const { firstObjectNumber, length } = this.subsections[subsectionIdx];
            for (let objIdx = 0; objIdx < length; objIdx++) {
                let type = 0;
                for (let idx = 0, len = typeFieldWidth; idx < len; idx++) {
                    type = (type << 8) | this.bytes.next();
                }
                let offset = 0;
                for (let idx = 0, len = offsetFieldWidth; idx < len; idx++) {
                    offset = (offset << 8) | this.bytes.next();
                }
                let generationNumber = 0;
                for (let idx = 0, len = genFieldWidth; idx < len; idx++) {
                    generationNumber = (generationNumber << 8) | this.bytes.next();
                }
                // When the `type` field is absent, it defaults to 1
                if (typeFieldWidth === 0)
                    type = 1;
                const objectNumber = firstObjectNumber + objIdx;
                const entry = {
                    ref: PDFRef.of(objectNumber, type === 2 ? 0 : generationNumber),
                    offset,
                    deleted: type === 0,
                    inObjectStream: type === 2,
                };
                entries.push(entry);
            }
        }
        return entries;
    }
}
PDFXRefStreamParser.forStream = (rawStream) => new PDFXRefStreamParser(rawStream);
export default PDFXRefStreamParser;
//# sourceMappingURL=PDFXRefStreamParser.js.map