// Probe: can one call carry several document blocks, each answered separately?
const fs=require('fs');
const { PDFDocument } = require('pdf-lib');
const { callClaude } = require('./netlify/functions/lib/claude.js');
(async()=>{
  const buf=fs.readFileSync("/Users/meganbaptista/Library/CloudStorage/GoogleDrive-megan@mytcconcierge.com/My Drive/COMPANY DISCLOSURES/00 Company SALE Templates/Coldwell Banker/CB DISCLOSURES.pdf");
  const src=await PDFDocument.load(buf,{ignoreEncryption:true});
  const carve=async(nums)=>{const o=await PDFDocument.create();
    const c=await o.copyPages(src,nums.map(n=>n-1)); c.forEach(p=>o.addPage(p));
    return Buffer.from(await o.save());};
  const spans=[[1,2,3],[4],[5,6],[7,8,9]];
  const content=[];
  for(let i=0;i<spans.length;i++){
    content.push({type:'text',text:`=== DOCUMENT ${i+1} (pages ${spans[i].join(',')} of the packet) ===`});
    content.push({type:'document',source:{type:'base64',media_type:'application/pdf',
      data:(await carve(spans[i])).toString('base64')},title:`document-${i+1}.pdf`});
  }
  content.push({type:'text',text:'For EACH document above return its printed title and its page count. '+
    'Respond with ONLY {"documents":[{"n":1,"title":"","pages":0}]} , one entry per document, in order.'});
  const raw=await callClaude({fn:'multidoc-probe',model:'claude-opus-4-8',content,maxTokens:2000,effort:'low'});
  console.log(raw.slice(0,900));
})().catch(e=>{console.error('FAILED:',e.message);process.exit(1);});
