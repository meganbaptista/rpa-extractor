// Scratch harness for the strip read. Hand to Megan for deletion.
// Usage: node .rx-strips-probe.js render <pdf> <pages...>
//        node .rx-strips-probe.js read   <pdf> [firstPage] [lastPage]
const fs = require('fs');
const path = require('path');
const S = require('./netlify/functions/lib/page-strips.js');
const { PDFParse } = require('pdf-parse');
const { CanvasFactory } = require('pdf-parse/worker');

async function pageCount(buf) {
  const p = new PDFParse({ data: new Uint8Array(buf), CanvasFactory });
  try { return (await p.getInfo()).pages?.length || (await p.getInfo()).total; }
  finally { await p.destroy(); }
}

(async () => {
  const [mode, file, ...rest] = process.argv.slice(2);
  const buf = fs.readFileSync(file);
  const out = '/tmp/rx-strips';
  fs.mkdirSync(out, { recursive: true });

  if (mode === 'render') {
    const pages = rest.map(Number);
    const rendered = await S.renderStrips(buf, pages);
    for (const r of rendered) {
      const [head, foot] = await S.cropStrips(r.png);
      fs.writeFileSync(path.join(out, `p${r.pageNumber}-head.png`), head);
      fs.writeFileSync(path.join(out, `p${r.pageNumber}-foot.png`), foot);
      console.log(`p${r.pageNumber}: full=${r.png.length}b head=${head.length}b foot=${foot.length}b`);
    }
    console.log('wrote to', out);
    return;
  }

  if (mode === 'read') {
    const info = new PDFParse({ data: new Uint8Array(buf), CanvasFactory });
    let total;
    try { const i = await info.getInfo(); total = i.total ?? i.pages?.length; }
    finally { await info.destroy(); }
    const first = Number(rest[0] || 1);
    const last = Number(rest[1] || total);
    console.log(`${path.basename(file)}: ${total} pages, reading ${first}-${last}`);
    const t0 = Date.now();
    const want = [];
    for (let p = first; p <= last; p++) want.push(p);
    const rows = await S.readStripsFor(buf, want, path.basename(file));
    const docs = S.documentsFromStrips(rows);
    console.log(`\n--- ${rows.length} strip rows in ${((Date.now()-t0)/1000).toFixed(0)}s ---`);
    for (const r of rows) {
      console.log(`p${String(r.page).padStart(3)} ${r.unread ? 'UNREAD ' : '       '}` +
        `code=${(r.carCode||'-').padEnd(6)} m/n=${r.m}/${r.n} ctr=${(r.counter||'-').padEnd(12)} ` +
        `brand=${(r.brand||'-').slice(0,26).padEnd(26)} title=${r.title||'-'}`);
    }
    console.log(`\n--- ${docs.length} documents ---`);
    for (const d of docs) {
      console.log(`pp${d.pages[0]}-${d.pages[d.pages.length-1]} (${d.pages.length}) ` +
        `[${d.startedBy}] ${d.carCode||'--'} | ${d.brand||'--'} | ${d.title||'(untitled)'}` +
        (d.notes.length ? `  << ${d.notes.join('; ')}` : ''));
    }
    const missing = want.filter((p) => !docs.some((d) => d.pages.includes(p)));
    console.log(`\nunclaimed pages: ${missing.length ? missing.join(',') : 'NONE'}`);
    fs.writeFileSync(path.join(out, 'read.json'), JSON.stringify({rows, docs}, null, 1));
    return;
  }
  console.log('modes: render | read');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
