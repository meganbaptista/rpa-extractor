// Scratch: strip read -> spans -> per-document identify+audit. Hand over for deletion.
const fs=require('fs');const path=require('path');
const { PDFDocument } = require('pdf-lib');
const { PDFParse } = require('pdf-parse');
const { CanvasFactory } = require('pdf-parse/worker');
const S=require('./netlify/functions/lib/page-strips.js');
const A=require('./netlify/functions/lib/document-audit.js');
(async()=>{
  const file=process.argv[2];
  const buf=fs.readFileSync(file);
  const info=new PDFParse({data:new Uint8Array(buf),CanvasFactory});
  let total; try{const i=await info.getInfo();total=i.total??i.pages?.length;}finally{await info.destroy();}
  const src=await PDFDocument.load(buf,{ignoreEncryption:true});
  const carve=async(nums)=>{const o=await PDFDocument.create();
    const c=await o.copyPages(src,nums.map(n=>n-1)); c.forEach(p=>o.addPage(p));
    return Buffer.from(await o.save());};

  const t0=Date.now();
  const cached=process.env.STRIP_CACHE && fs.existsSync(process.env.STRIP_CACHE);
  const rows=cached ? JSON.parse(fs.readFileSync(process.env.STRIP_CACHE)).rows
                    : await S.readAllStrips(buf,total,path.basename(file));
  if(!cached && process.env.STRIP_CACHE) fs.writeFileSync(process.env.STRIP_CACHE,JSON.stringify({rows}));
  const docs=S.documentsFromStrips(rows);
  const tStrips=Date.now();
  console.log(`${total} pages -> ${docs.length} documents in ${((tStrips-t0)/1000).toFixed(0)}s`+
    (cached?' (strips cached)':''));
  console.log(`audit calls: ${A.groupForAudit(docs).length}`);

  const forms=await A.auditDocuments(docs,carve,path.basename(file));
  console.log(`audited in ${((Date.now()-tStrips)/1000).toFixed(0)}s\n`);
  for(const f of forms){
    const a=f.pages[0],b=f.pages[f.pages.length-1];
    const req=(f.required_signers||[]).join('+')||'-';
    const pres=(f.present_signers||[]).join('+')||'-';
    console.log(`pp${a}${b!==a?'-'+b:''}  ${(f.code||'--').padEnd(7)} ${(f.name||'(UNNAMED)').slice(0,52).padEnd(52)} req=${req.padEnd(12)} have=${pres.padEnd(12)}`+
      (f.parent_code?` parent=${f.parent_code}`:'')+(f.doc_no?` no=${f.doc_no}`:'')+(f.review?`  << ${f.review}`:''));
  }
  const claimed=new Set(forms.flatMap(f=>f.pages));
  const miss=[];for(let p=1;p<=total;p++)if(!claimed.has(p))miss.push(p);
  console.log(`\ncoverage: ${claimed.size}/${total} pages, unclaimed: ${miss.length?miss.join(','):'NONE'}`);
  fs.writeFileSync('/tmp/rx-strips/e2e.json',JSON.stringify({rows,forms},null,1));
})().catch(e=>{console.error('FAILED:',e.message);process.exit(1);});
