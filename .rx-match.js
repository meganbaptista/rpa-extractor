// Scratch: which source pages does each filed PDF actually contain?
const fs=require('fs'),crypto=require('crypto'),path=require('path');
const { PDFParse } = require('pdf-parse');
const { CanvasFactory } = require('pdf-parse/worker');
const SCALE=0.6;
async function hashes(file){
  const buf=fs.readFileSync(file);
  const out=[];
  const p=new PDFParse({data:new Uint8Array(buf),CanvasFactory});
  try{
    const r=await p.getScreenshot({scale:SCALE});
    for(const pg of r.pages||[]){
      if(!pg.data) continue;
      out.push({n:pg.pageNumber,h:crypto.createHash('sha1').update(Buffer.from(pg.data)).digest('hex').slice(0,16)});
    }
  } finally { await p.destroy(); }
  return out;
}
(async()=>{
  const src=await hashes("/Users/meganbaptista/Downloads/Seller Disclosures.pdf");
  const byHash=new Map(src.map(x=>[x.h,x.n]));
  console.log('source pages hashed:',src.length);
  const D="/Users/meganbaptista/Library/CloudStorage/GoogleDrive-megan@mytcconcierge.com/My Drive/00 MTC CLIENTS/Simon Mashian/00 ESCROW/1333 S Beverly Glen Blvd #902, Los Angeles, CA 90024";
  for(const f of process.argv.slice(2)){
    const hs=await hashes(path.join(D,f));
    const pages=hs.map(x=>byHash.has(x.h)?byHash.get(x.h):'?');
    console.log(`${pages.join(',').padEnd(12)}  ${f}`);
  }
})().catch(e=>{console.error('FAILED:',e.message);process.exit(1);});
