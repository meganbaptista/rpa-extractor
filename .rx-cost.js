// Scratch: measure real token usage for one strip batch + one audit group.
const fs=require('fs');const { PDFDocument } = require('pdf-lib');
const usageLog=require('./netlify/functions/lib/usage-log.js');
const seen=[];
usageLog.logUsage=async(r)=>{seen.push(r);};
const S=require('./netlify/functions/lib/page-strips.js');
const A=require('./netlify/functions/lib/document-audit.js');
const PRICE={in:5,out:25};
const usd=(u)=>((u.input_tokens||0)*PRICE.in+(u.output_tokens||0)*PRICE.out
  +(u.cache_read_input_tokens||0)*PRICE.in*0.1
  +(u.cache_creation_input_tokens||0)*PRICE.in*1.25)/1e6;
(async()=>{
  const file="/Users/meganbaptista/Downloads/Seller Disclosures.pdf";
  const buf=fs.readFileSync(file);
  const src=await PDFDocument.load(buf,{ignoreEncryption:true});
  const carve=async(nums)=>{const o=await PDFDocument.create();
    const c=await o.copyPages(src,nums.map(n=>n-1));c.forEach(p=>o.addPage(p));
    return Buffer.from(await o.save());};
  const {rows}=JSON.parse(fs.readFileSync('/tmp/rx-strips/e2e.json'));
  const docs=S.documentsFromStrips(rows);

  console.log('--- one strip batch (10 pages, 20 strip images) ---');
  await S.readStripsFor(buf,[1,2,3,4,5,6,7,8,9,10],'cost probe');
  const strip=seen.pop();
  console.log(JSON.stringify(strip.usage),'-> $'+usd(strip.usage).toFixed(4));

  console.log('--- one audit group (5 documents) ---');
  const group=A.groupForAudit(docs)[0];
  console.log('group holds',group.length,'documents /',group.reduce((n,d)=>n+d.pages.length,0),'pages');
  await A._internal.auditGroup(group,docs,carve,'cost probe');
  const audit=seen.pop();
  console.log(JSON.stringify(audit.usage),'-> $'+usd(audit.usage).toFixed(4));

  const nStrip=Math.ceil(65/10), nAudit=A.groupForAudit(docs).length;
  const total=nStrip*usd(strip.usage)+nAudit*usd(audit.usage);
  console.log(`\n=== 65-page packet: ${nStrip} strip calls + ${nAudit} audit calls ===`);
  console.log(`strips  ${nStrip} x $${usd(strip.usage).toFixed(4)} = $${(nStrip*usd(strip.usage)).toFixed(3)}`);
  console.log(`audit   ${nAudit} x $${usd(audit.usage).toFixed(4)} = $${(nAudit*usd(audit.usage)).toFixed(3)}`);
  console.log(`TOTAL   ~$${total.toFixed(2)}  (per page ~$${(total/65).toFixed(3)})`);
})().catch(e=>{console.error('FAILED:',e.message);process.exit(1);});
