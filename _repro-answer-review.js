// TEMPORARY DIAGNOSTIC — do not commit. Delete when done.
//
// Reproduces the EXACT answer-review API call the disclosure-intake pipeline makes,
// using the real PDF and the real page set from the failing 19230 Vintage run
// (pages 26, 27, 29, 30, 31, 32, 33, 38, 40 — logged by the deployed function).
//
// Every reproduction so far has gone through Claude Code's tool layer and come back
// CORRECT, while production comes back WRONG. This script removes that difference: it
// builds the identical content array (N image blocks, then the prompt) and posts it to
// the same model with the same effort and max_tokens.
//
// RUN:
//   cd ~/Documents/GitHub/rpa-extractor
//   export ANTHROPIC_API_KEY='sk-ant-...'      # your Console key; never pasted to me
//   node _repro-answer-review.js
//
// Optional: node _repro-answer-review.js --scale 2.0
//
// Cost: one Opus call, roughly $0.50-$0.90.

const fs = require('fs');
const { CanvasFactory } = require('pdf-parse/worker');
const { PDFParse } = require('pdf-parse');
const { PDFDocument } = require('pdf-lib');

const SRC = '/Users/meganbaptista/Downloads/DISCLOSURES SE.pdf';
const QA_PAGES = [26, 27, 29, 30, 31, 32, 33, 38, 40];   // exactly what production rendered
const MODEL = 'claude-opus-4-8';

const scaleArg = process.argv.indexOf('--scale');
const SCALE = scaleArg > -1 ? parseFloat(process.argv[scaleArg + 1]) : 2.5;  // QA_HIRES_SCALE

// The call is NOT deterministic: production returned 14 flags (7 false) on the same input
// where a single local run returned 5 correct ones. A single sample proves nothing about a
// prompt change, so measure a RATE over N runs.
// Env vars, not flags: pasted --flags kept getting mangled by the shell.
//   RUNS=5 node _repro-answer-review.js
//   RUNS=5 PROMPT=/path/to/prompt.txt node _repro-answer-review.js
const runsArg = process.argv.indexOf('--runs');
const RUNS = parseInt(process.env.RUNS, 10) || (runsArg > -1 ? parseInt(process.argv[runsArg + 1], 10) : 1);

// Use an alternate prompt file instead of the live one (for A/B testing a fix).
const promptArg = process.argv.indexOf('--prompt');
const PROMPT_FILE = process.env.PROMPT || (promptArg > -1 ? process.argv[promptArg + 1] : '');

// Pull the live prompt straight out of the function so this can never drift from it.
function livePrompt() {
  if (PROMPT_FILE) return fs.readFileSync(PROMPT_FILE, 'utf8');
  const src = fs.readFileSync('netlify/functions/disclosure-intake-check-background.js', 'utf8');
  const m = src.match(/const ANSWER_REVIEW_PROMPT =[\s\S]*?;\n/)[0]
    .replace('const ANSWER_REVIEW_PROMPT =', 'return (')
    .replace(/;\n$/, ');');
  return new Function(m)();
}

// Pages 26/27/29 ARE among the images sent. On them, verified by eye:
//   TDS date = 07/08/2026 | Exhaust Fan = None | 220V = None | Fireplace = The family room
//   Roof = Tile/Clay, Age = 32 years | SPQ APN = 276-152-020 | TDS Section C HOA = Yes
// So any flag matching this is a FALSE POSITIVE about a page the model was actually shown.
const FALSE_RE = /disclosure date|exhaust fan|220 volt|fireplace|\broof\b|\bapn\b|assessor|\bc1[234]\b/i;
const isFalseFlag = (f) => FALSE_RE.test(`${f.form || ''} ${f.item || ''} ${f.reason || ''}`);

(async () => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { console.error('Set ANTHROPIC_API_KEY first.'); process.exit(1); }

  const buf = fs.readFileSync(SRC);
  const src = await PDFDocument.load(buf, { ignoreEncryption: true });
  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, QA_PAGES.map((n) => n - 1));
  copied.forEach((p) => out.addPage(p));
  const subBuf = Buffer.from(await out.save());

  const parser = new PDFParse({ data: new Uint8Array(subBuf), CanvasFactory });
  const r = await parser.getScreenshot({ scale: SCALE, first: QA_PAGES.length });
  await parser.destroy();
  const imgs = (r.pages || []).filter((p) => p.data).map((p) => Buffer.from(p.data).toString('base64'));
  console.log(`rendered ${imgs.length} page(s) at scale ${SCALE} -> real pages ${QA_PAGES.join(', ')}`);

  // IDENTICAL shape to reviewAnswers(): images first, prompt last.
  const content = imgs.map((b64) => ({
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: b64 },
  }));
  content.push({ type: 'text', text: livePrompt() });

  const prompt = livePrompt();
  console.log(`prompt: ${PROMPT_FILE || 'live (from the function file)'} — ${prompt.length} chars`);
  console.log(`runs:   ${RUNS}\n`);

  const oneRun = async (n) => {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 48000,
        // MUST match callClaude() exactly. Omitting `thinking` produced 264 output tokens
        // of filler ("placeholder") instead of production's 19,566 tokens of real
        // reasoning — a different call entirely, and a worthless comparison.
        thinking: { type: 'adaptive', display: 'omitted' },
        output_config: { effort: 'high' },
        messages: [{ role: 'user', content: [...content.slice(0, -1), { type: 'text', text: prompt }] }],
      }),
    });
    const data = await res.json();
    if (!res.ok) { console.error(`run ${n}: API error ${res.status}`, JSON.stringify(data).slice(0, 300)); return null; }
    const text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
    let parsed;
    try { parsed = JSON.parse(text.replace(/^```(json)?|```$/gm, '').trim()); }
    catch { console.error(`run ${n}: unparseable output`); return null; }

    const flags = parsed.response_flags || [];
    const bogus = flags.filter(isFalseFlag);
    const hoaWrong = parsed.key_answers?.hoa_any_no === 'yes';   // truth is "no"
    const bad = bogus.length > 0 || hoaWrong;
    console.log(
      `run ${String(n).padStart(2)}: out=${String(data.usage?.output_tokens).padStart(6)}  `
      + `flags=${String(flags.length).padStart(2)}  false=${String(bogus.length).padStart(2)}  `
      + `hoa=${parsed.key_answers?.hoa_any_no}  ${bad ? '<<< BAD DRAW' : 'clean'}`
    );
    for (const f of bogus) console.log(`         FALSE: [${f.form} ${f.item}] ${(f.reason || '').slice(0, 90)}`);
    return { bad, bogus: bogus.length, out: data.usage?.output_tokens || 0 };
  };

  const results = [];
  for (let i = 1; i <= RUNS; i++) {
    const r = await oneRun(i);
    if (r) results.push(r);
  }

  const badRuns = results.filter((r) => r.bad).length;
  const totalFalse = results.reduce((a, r) => a + r.bogus, 0);
  const avgOut = Math.round(results.reduce((a, r) => a + r.out, 0) / (results.length || 1));
  console.log('\n' + '='.repeat(62));
  console.log(`BAD DRAWS: ${badRuns}/${results.length}   total false flags: ${totalFalse}   avg output tokens: ${avgOut}`);
  console.log('='.repeat(62));
})();
