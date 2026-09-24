// Scratch: does the audit now list BLANK signature lines? Hand over for deletion.
const fs=require('fs');const { PDFDocument } = require('pdf-lib');
const S=require('./netlify/functions/lib/page-strips.js');
const A=require('./netlify/functions/lib/document-audit.js');
const { statusSuffix, formLabel } = require('./netlify/functions/disclosure-split-background.js')._internal;
(async()=>{
  const buf=fs.readFileSync("/Users/meganbaptista/Downloads/Seller Disclosures.pdf");
  const src=await PDFDocument.load(buf,{ignoreEncryption:true});
  const carve=async(nums)=>{const o=await PDFDocument.create();
    const c=await o.copyPages(src,nums.map(n=>n-1));c.forEach(p=>o.addPage(p));
    return Buffer.from(await o.save());};
  const {rows}=JSON.parse(fs.readFileSync('/tmp/rx-strips/e2e.json'));
  const docs=S.documentsFromStrips(rows);
  const want=[[8,9,10],[42,43]];
  for(const pages of want){
    const doc=docs.find(d=>d.pages[0]===pages[0])||{pages,title:'',brand:'',carCode:'',footerName:'',notes:[]};
    doc.pages=pages;
    for(let i=0;i<2;i++){
      const [r]=await A._internal.auditGroup([doc],docs,carve,`aba probe pp${pages[0]}`);
      const a=r.audit||{};
      const f={code:a.code||'',name:a.name||'',required_signers:a.required_signers,present_signers:a.present_signers};
      const resolved=A._internal.resolveSigners(a,f.code);
      const full={...f,...resolved};
      console.log(`pp${pages.join(',')} run${i+1}: ${formLabel(full)} - ${statusSuffix(full)}`);
      console.log('   lines: '+(resolved.lines||[]).map(l=>`${l.label}${l.signed?'':' [BLANK]'}`).join(' | '));
      console.log(`   model said req=${(a.required_signers||[]).join('+')||'-'} -> resolved req=${resolved.required_signers.join('+')||'-'} have=${resolved.present_signers.join('+')||'-'}`);
    }
  }
})().catch(e=>{console.error('FAILED:',e.message);process.exit(1);});
