// Scratch: does a non-contiguous page list build the right PDF, in order?
const fs=require('fs'),crypto=require('crypto');
const { PDFDocument } = require('pdf-lib');
const { PDFParse } = require('pdf-parse');
const { CanvasFactory } = require('pdf-parse/worker');
async function hashes(data){
  const p=new PDFParse({data:new Uint8Array(data),CanvasFactory});
  try{ const r=await p.getScreenshot({scale:0.6});
    return (r.pages||[]).filter(x=>x.data).map(x=>({n:x.pageNumber,
      h:crypto.createHash('sha1').update(Buffer.from(x.data)).digest('hex').slice(0,16)}));
  } finally { await p.destroy(); }
}
(async()=>{
  const buf=fs.readFileSync("/Users/meganbaptista/Downloads/Seller Disclosures.pdf");
  const src=await PDFDocument.load(buf,{ignoreEncryption:true});
  const byHash=new Map((await hashes(buf)).map(x=>[x.h,x.n]));
  for(const want of [[18,42,43],[17,27]]){
    const o=await PDFDocument.create();
    const c=await o.copyPages(src,want.map(n=>n-1));
    c.forEach(pg=>o.addPage(pg));
    const out=Buffer.from(await o.save());
    const got=(await hashes(out)).map(x=>byHash.get(x.h)??'?');
    const ok=JSON.stringify(got)===JSON.stringify(want);
    console.log((ok?'ok   ':'FAIL ')+'requested ['+want.join(',')+'] -> built ['+got.join(',')+']  '+out.length+' bytes');
  }
})().catch(e=>{console.error('FAILED:',e.message);process.exit(1);});
