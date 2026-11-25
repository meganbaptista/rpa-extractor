// netlify/functions/voice-study-background.js
//
// HOW MEGAN WRITES HER DISCLOSURE EMAILS (2026-11-24). Megan: "we look
// ridiculous with some of these emails, it should be a direct representation
// of how I email." And: "my last 30 are probably all you." So two sources,
// read only, nothing sent, labelled, drafted or changed:
//
//   mine   her sent disclosure-correction emails from BEFORE the drafts began
//          (the reply drafts went live 2026-09-24): her own words.
//   pairs  since then, each draft this site made next to what she actually
//          sent in that thread: every edit she made is a correction.
//
// Started by hand: POST with header x-voice-key matching the key saved at
// meta/voice-study { key } in the intake store. The report is saved to
// meta/voice-study-report and read off the site for the analysis.

const rt = require('./lib/intake-runtime');
const gmail = require('./lib/gmail');
const J = require('./lib/intake-job');

const DRAFTS_BEGAN = '2026/09/20';
const LOOKS_LIKE_REVIEW = /\b(SPQ|TDS|AVID|SBSA|LPD|NHD|AD)\b|still need|take another look|disclosures?/i;
const MAX_MINE = 60;
const MAX_PAIRS = 40;

async function hers(log) {
  // Her corrections to the listing side, not the Zaps' automatic sends (File Audit lists, AVID receipts).
  const q = `in:sent before:${DRAFTS_BEGAN} after:2025/01/01 ("take another look" OR "still need" OR "recommend" OR "could you" OR "please update") (SPQ OR TDS) -"AUTOMATIC MESSAGE" -subject:"File Audit"`;
  const ids = await gmail.listMessages({ q, maxPages: 3, pageSize: 100 });
  const out = [];
  for (const { id } of ids) {
    if (out.length >= MAX_MINE) break;
    const m = await gmail.getMessage(id).catch(() => null);
    if (!m || !(m.labelIds || []).includes('SENT')) continue;
    const text = String(m.newestText || '').trim();
    // A correction email names forms and questions; a one-line "Thank you!" teaches nothing; a Zap's template is not her.
    if (text.length < 120 || !LOOKS_LIKE_REVIEW.test(text) || /<!DOCTYPE|<html|AUTOMATIC MESSAGE/i.test(text)) continue;
    out.push({ date: new Date(Number(m.internalDate)).toISOString().slice(0, 10), subject: m.headers.subject || '', text: text.slice(0, 4000) });
  }
  log(`mine: ${out.length} of ${ids.length} sent emails kept`);
  return out;
}

async function drafted(store, log) {
  const { blobs } = await store.list({ prefix: 'job/' });
  const ids = blobs.map((b) => b.key.slice(4)).filter((id) => !/_r\d+$|_trial/.test(id)).sort().reverse();
  const out = [];
  for (const id of ids) {
    if (out.length >= MAX_PAIRS) break;
    const job = await J.readJob(store, id).then((r) => r && r.job).catch(() => null);
    if (!job || job.mode !== 'live' || !job.source || !job.source.threadId) continue;
    const effects = (await J.getOut(store, id, 'finish-effects').catch(() => null)) || {};
    if (!effects.draft || /^held/.test(String(effects.draft))) continue;
    const payload = await J.getOut(store, id, 'payload').catch(() => null);
    const draft = payload && (payload.chase_email_body || '');
    if (!draft) continue;
    const thread = await gmail.getThreadMessages(job.source.threadId).catch(() => []);
    /*
      EVERY message she sent in the thread after the draft, not just the first
      (2026-11-24, 20232 Delita: the first was a separate "Awesome, thank you
      so much!", so the study wrongly said she dropped the whole draft). The
      analysis picks the one that matches the draft.
    */
    const sentAll = thread.filter((m) => (m.labelIds || []).includes('SENT') && Number(m.internalDate) > Number(job.createdAt || 0)).slice(0, 6);
    if (!sentAll.length) continue;
    out.push({
      jobId: id, address: job.address || '', draft: String(draft).slice(0, 4000),
      sent: sentAll.map((m) => ({ at: new Date(Number(m.internalDate)).toISOString(), text: String(m.newestText || '').slice(0, 4000) })),
    });
  }
  log(`pairs: ${out.length} draft/sent pairs`);
  return out;
}

exports.handler = async function (event) {
  rt.connect(event);
  const store = rt.jobStore();
  const conf = await store.get('meta/voice-study', { type: 'json' }).catch(() => null);
  const key = (event.headers || {})['x-voice-key'] || '';
  if (!conf || !conf.key || key !== conf.key) {
    console.warn('[voice-study] refused: no or wrong key');
    return { statusCode: 403 };
  }
  const log = (s) => console.log(`[voice-study] ${s}`);
  try {
    const report = { at: new Date().toISOString(), mine: await hers(log), pairs: await drafted(store, log) };
    await store.setJSON('meta/voice-study-report', report);
    log('report saved');
  } catch (err) {
    console.error(`[voice-study] ${err.message}`);
    await store.setJSON('meta/voice-study-report', { at: new Date().toISOString(), error: err.message });
  }
  return { statusCode: 202 };
};
