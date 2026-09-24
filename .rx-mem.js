// Scratch: peak RSS through the render+crop stage only (no model calls).
const fs=require('fs');
const S=require('./netlify/functions/lib/page-strips.js');
let peak=0;
const tick=setInterval(()=>{const m=process.memoryUsage().rss/1048576;if(m>peak)peak=m;},50);
(async()=>{
  const buf=fs.readFileSync("/Users/meganbaptista/Downloads/Seller Disclosures.pdf");
  const pages=Array.from({length:65},(_,i)=>i+1);
  const mode=process.argv[2];
  if(mode==='old'){
    const rendered=await S.renderStrips(buf,pages);
    const cropped=[];
    for(const r of rendered){const [h,f]=await S.cropStrips(r.png);cropped.push({h,f});}
    console.log('OLD  full pages held:',rendered.length,'strips:',cropped.length);
  }else{
    const cropped=await S.renderStripsCropped(buf,pages);
    console.log('NEW  strips:',cropped.length,'| bytes:',
      (cropped.reduce((n,c)=>n+c.head.length+c.foot.length,0)/1048576).toFixed(1)+'MB');
  }
  clearInterval(tick);
  console.log('peak RSS:',peak.toFixed(0)+'MB');
})();
