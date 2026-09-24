// Scratch: audit ONE document with the whole packet's context. Hand over for deletion.
const fs=require('fs');const { PDFDocument } = require('pdf-lib');
const S=require('./netlify/functions/lib/page-strips.js');
const A=require('./netlify/functions/lib/document-audit.js');
(async()=>{
  const file="/Users/meganbaptista/Downloads/Seller Disclosures.pdf";
  const buf=fs.readFileSync(file);
  const src=await PDFDocument.load(buf,{ignoreEncryption:true});
  const carve=async(nums)=>{const o=await PDFDocument.create();
    const c=await o.copyPages(src,nums.map(n=>n-1));c.forEach(p=>o.addPage(p));
    return Buffer.from(await o.save());};
  const {rows}=JSON.parse(fs.readFileSync('/tmp/rx-strips/e2e.json'));
  const docs=S.documentsFromStrips(rows);
  const target=docs.find(d=>d.pages[0]===Number(process.argv[2]||47));
  console.log('target:',target.pages.join(','),'| strip brand:',JSON.stringify(target.brand));
  const runs=Number(process.argv[3]||3);
  for(let i=0;i<runs;i++){
    const [r]=await A._internal.auditGroup([target],docs,carve,`avid probe ${i+1}`);
    const a=r.audit||{};
    console.log(`run ${i+1}: code=${a.code}  req=${(a.required_signers||[]).join('+')}  have=${(a.present_signers||[]).join('+')}`);
  }
})().catch(e=>{console.error('FAILED:',e.message);process.exit(1);});
