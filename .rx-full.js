const fs=require('fs');const S=require('./netlify/functions/lib/page-strips.js');
(async()=>{const [f,...pp]=process.argv.slice(2);
const r=await S.renderStrips(fs.readFileSync(f),pp.map(Number));
for(const x of r){fs.writeFileSync(`/tmp/rx-strips/FULL-p${x.pageNumber}.png`,x.png);console.log('FULL-p'+x.pageNumber);}})();
