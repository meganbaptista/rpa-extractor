// netlify/functions/scoreboard-background.js
//
// THE DAY-0 SCOREBOARD, BUILT (lib/scoreboard.js). Reads Megan's sent escrow
// introduction emails (her answer key, lib/timeline-email.js), pairs each
// with the extraction that created that deal, scores every date, and saves
// the board to the 'scoreboard' store as 'latest'. Keeva's Engine page shows
// it behind the team login; this site has none, so nothing here serves it.
//
// Read-only: Gmail is read, never changed; no model is called. Started by
// POST /.netlify/functions/scoreboard (background: up to 15 minutes).

'use strict';

const { getStore } = require('@netlify/blobs');
const gmail = require('./lib/gmail');
const { parseSubject, parseTimeline } = require('./lib/timeline-email');
const { propertyKey, pickExtraction, scorePair, buildBoard } = require('./lib/scoreboard');

function blobsConfig(name) {
  const siteID = process.env.BLOBS_SITE_ID || process.env.SITE_ID;
  const token = process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_API_TOKEN;
  return siteID && token ? { name, siteID, token } : { name };
}

async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) {
      const item = items[i++];
      try { out.push(await fn(item)); } catch (e) { console.warn('[scoreboard] skipped one: ' + e.message); }
    }
  }));
  return out;
}

exports.handler = async function (event) {
  const days = Math.min(Math.max(parseInt((event.queryStringParameters || {}).days, 10) || 200, 30), 730);
  const started = Date.now();
  const board = getStore(blobsConfig('scoreboard'));
  try {
    // 1. Her introduction emails: the day-0 answer key.
    const listed = await gmail.listMessages({ q: `from:me subject:"Escrow Introductions" newer_than:${days}d`, maxPages: 30 });
    const emails = (await pool(listed, 4, async (m) => {
      const msg = await gmail.getMessage(m.id);
      const subj = parseSubject(msg.headers.subject);
      if (!subj) return null;
      const sentAt = new Date(Number(msg.internalDate) || Date.parse(msg.headers.date)).toISOString();
      const dates = parseTimeline(msg.bodyText, sentAt);
      return dates ? { address: subj.address, side: subj.side, sentAt, dates } : null;
    })).filter(Boolean);
    // One per deal and side: the first one sent (a resend can carry corrections).
    const firsts = new Map();
    for (const e of emails.sort((a, b) => a.sentAt.localeCompare(b.sentAt))) {
      const k = propertyKey(e.address) + '|' + e.side;
      if (!firsts.has(k)) firsts.set(k, e);
    }

    // 2. Every extraction, by property.
    const jobs = getStore(blobsConfig('extraction-jobs'));
    const { blobs } = await jobs.list();
    const extractions = (await pool(blobs, 16, async (b) => {
      const j = await jobs.get(b.key, { type: 'json' });
      const text = ((j && j.result && j.result.content) || []).map((c) => c.text || '').join('');
      if (!text) return null;
      const fields = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
      if (!fields.property_address || !('final_purchase_price' in fields)) return null; // an RPA, not an RLA
      return { key: propertyKey(fields.property_address), at: j.completed_at || j.submitted_at || '', fields };
    })).filter(Boolean);

    // 3. Pair and score.
    const pairs = [];
    const unpaired = [];
    for (const e of firsts.values()) {
      const x = pickExtraction(extractions, propertyKey(e.address), e.sentAt);
      if (!x) { unpaired.push(e.address); continue; }
      pairs.push({ address: e.address, side: e.side, sentAt: e.sentAt, extractedAt: x.at, score: scorePair(e, x.fields) });
    }
    const result = {
      generatedAt: new Date().toISOString(),
      days,
      emailsRead: listed.length,
      intros: firsts.size,
      paired: pairs.length,
      withCounts: pairs.filter((p) => Object.values(p.score).some((r) => r.counted !== null)).length,
      unpaired,
      ...buildBoard(pairs),
      durationMs: Date.now() - started,
    };
    await board.setJSON('latest', result);
    console.log(`[scoreboard] ${result.intros} intros, ${result.paired} paired, ${result.misses.length} misses, ${result.durationMs}ms`);
  } catch (err) {
    console.error('[scoreboard] failed:', err);
    await board.setJSON('latest-error', { at: new Date().toISOString(), error: err.message }).catch(() => {});
  }
  return { statusCode: 202 };
};
