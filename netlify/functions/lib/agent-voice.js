// netlify/functions/lib/agent-voice.js
//
// THE CORRECTIONS, WRITTEN THE WAY MEGAN WOULD WRITE THEM (2026-11-03).
//
// Megan, on 533 Lincoln: "we are getting agents lashing out at us over these
// corrections, although correct, it needs to stop reading so AI ... its up to
// you to sound like me, a human." And: "way less words, it needs to be as if I
// put it together not regergitating the seller whole response and giving a
// dissertation." The 533 Lincoln email listed 20 lines for about 12 questions
// (SPQ 5B twice, the lead report three times), each quoting the seller back
// and ending "Could you update it to Yes?".
//
// Two steps. onePerQuestion keeps ONE flag per form + item (code). Then
// writeAsks has the model write the short, grouped lines, and the code checks
// the result: every question is still named, nothing is long, no dashes. A
// result that fails the check is never used; the caller falls back to its own
// plain lines. The model writes wording only; which questions are asked is
// decided before it and checked after it.
//
// KEPT, on Megan's word: a TDS answer that disagrees with the SPQ ("that is
// one area TCs always address").

const { callClaude } = require('./claude');

const norm = (s) => String(s == null ? '' : s).trim().toUpperCase().replace(/\s+/g, '');

/** A question's identity: form + item; a form-level flag (no item) keeps its own issue. */
function questionKey(f) {
  const item = norm(f && f.item);
  return item ? `${norm(f.form)}|${item}` : `${norm(f && f.form)}||${f && f.issue}|${String((f && f.reason) || '').slice(0, 60)}`;
}

/**
 * ONE FLAG PER QUESTION. Where the same question was flagged more than once
 * (different evidence, two review passes), the one that names another form is
 * kept, since the TDS-vs-SPQ disagreement is the ask TCs expect.
 */
function onePerQuestion(flags) {
  const byKey = new Map();
  const order = [];
  for (const f of flags || []) {
    if (!f) continue;
    const k = questionKey(f);
    const have = byKey.get(k);
    if (!have) { byKey.set(k, f); order.push(k); continue; }
    if (!have.other_form && f.other_form) byKey.set(k, f);
  }
  return order.map((k) => byKey.get(k));
}

const STYLE = `You write one section of an email from Megan, a California transaction coordinator, to the
other side's agent about their seller's disclosures. Agents have been getting upset at emails that read
like a machine. Write it the way Megan writes when she puts it together herself: a friendly, busy
professional, TC to TC.

RULES
- Fewest words possible. Direct. No filler (no "just", "please", "so this should be revisited", "we
  received", "I noticed"). The agent must see exactly what to change.
- Every line: the questions, a colon, the evidence in 2 to 5 words, then the change in 2 to 4 words.
  "SPQ 5B-C: Receipt for Reports received. Change to Yes."
  "SPQ 6H, 9A: Travelers claim received. Change to Yes."
  "SPQ 15D: TDS C2 says shared walls. Change to Yes."
  "TDS C1, C2, C9: add an explanation since the response was marked "Yes"."
  "LPD 1A-B: lead report received. Change to Yes."
  "SOLAR: needed, SPQ 8B is Yes."
- At most 12 words a line (the explanation line above may run to 14).
- A Yes with no explanation always reads: add an explanation since the response was marked "Yes".
- Name questions by form and number. A range (SPQ 5B-C) only when EVERY question in it is one given;
  otherwise list them (SPQ 5B, 6H, 9A).
- Questions resting on the same evidence share one line.
- Never quote or retell the question or the seller's answer.
- No em dashes or en dashes (a hyphen in a range is fine). No exclamation marks.
- Nothing outside the lines.

Return ONLY JSON: {"lines":[{"ids":[<question ids this line covers>],"text":"<the line>"}]}
Every question id must be covered by exactly one line.`;

/** The facts the writer gets: short, no seller narrative beyond the review's reason. */
function briefOf(f, id) {
  return {
    id,
    question: [f.form, f.item].filter(Boolean).join(' '),
    marked: f.marked || '',
    should_be: f.should_be || '',
    other_form: f.other_form || '',
    document: String(f.document || '').slice(0, 160),
    kind: f.issue || '',
    why: String(f.reason || '').replace(/\s+/g, ' ').slice(0, 300),
  };
}

const DASH = /[–—]/;

/** "5B-C", "5B-5D", "C1-C3" in a line -> each range's items: ["5B","5C"]. */
function rangesIn(text) {
  const out = [];
  const rx = /\b(\d+)([A-Z])\s*-\s*(?:\1)?([A-Z])\b|\b([A-Z])(\d+)\s*-\s*(?:\4)?(\d+)\b/gi;
  let m;
  while ((m = rx.exec(String(text || '')))) {
    const items = [];
    if (m[1]) {
      const a = m[2].toUpperCase().charCodeAt(0); const b = m[3].toUpperCase().charCodeAt(0);
      if (b > a && b - a < 15) for (let c = a; c <= b; c++) items.push(`${m[1]}${String.fromCharCode(c)}`);
    } else {
      const a = Number(m[5]); const b = Number(m[6]);
      if (b > a && b - a < 30) for (let n = a; n <= b; n++) items.push(`${m[4].toUpperCase()}${n}`);
    }
    if (items.length) out.push(items);
  }
  return out;
}

/** Every item a line names, ranges expanded. */
function namesOf(text) {
  return new Set(rangesIn(text).flat());
}

/**
 * Is the writer's answer usable? Every id covered once, each line names its
 * questions' numbers, short, no dashes. Returns the reason it is not, or ''.
 */
function checkLines(lines, briefs) {
  if (!Array.isArray(lines) || !lines.length) return 'no lines';
  const seen = new Map();
  for (const l of lines) {
    if (!l || typeof l.text !== 'string' || !Array.isArray(l.ids) || !l.ids.length) return 'a line without text or ids';
    const text = l.text.trim();
    if (DASH.test(text)) return `a dash in "${text}"`;
    if (text.split(/\s+/).length > 16) return `too long (12 words at most): "${text}"`;
    if (/\b(just|please|kindly|so this should be revisited|we received|per)\b/i.test(text)) return `filler in "${text}"`;
    // Megan, 2026-11-03: a Yes with no explanation says why it is asked.
    const needsWhy = l.ids.some((id) => (briefs.find((x) => x.id === id) || {}).kind === 'yes_no_explanation');
    if (needsWhy && !/since the response was marked "?yes"?/i.test(text)) return `"${text}" must end: since the response was marked "Yes"`;
    for (const id of l.ids) {
      const b = briefs.find((x) => x.id === id);
      if (!b) return `unknown id ${id}`;
      seen.set(id, (seen.get(id) || 0) + 1);
      const item = String(b.question.split(' ').slice(1).join(' ') || b.question).trim().toUpperCase();
      if (item && !namesOf(text).has(item) && !text.toUpperCase().includes(item)) return `"${text}" does not name ${b.question}`;
    }
    // A range may only cover questions that were asked: "SPQ 5A-C" when 5A was never flagged is wrong.
    const asked = new Set(l.ids.map((id) => String((briefs.find((x) => x.id === id) || { question: '' }).question.split(' ').slice(1).join(' ')).toUpperCase()));
    for (const r of rangesIn(text)) {
      const extra = r.filter((x) => !asked.has(x));
      if (extra.length) return `"${text}" includes ${extra.join(', ')}, which was not asked`;
    }
  }
  const missing = briefs.filter((b) => !seen.has(b.id)).map((b) => b.question);
  if (missing.length) return `not covered: ${missing.join(', ')}`;
  const twice = briefs.filter((b) => seen.get(b.id) > 1).map((b) => b.question);
  if (twice.length) return `covered twice: ${twice.join(', ')}`;
  return '';
}

function parseLines(raw) {
  const t = String(raw || '').replace(/```json|```/g, '').trim();
  const m = t.match(/\{[\s\S]*\}/);
  const j = JSON.parse(m ? m[0] : t);
  return j && j.lines;
}

/**
 * The answer lines in Megan's voice, or null (the caller then uses its own
 * plain lines). `call` is for checks; live it is callClaude.
 */
async function writeAsks(flags, { model, call = callClaude, address = '' } = {}) {
  const list = (flags || []).filter(Boolean);
  if (!list.length) return [];
  const briefs = list.map((f, i) => briefOf(f, `q${i + 1}`));
  let note = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await call({
        fn: 'agent-voice',
        model,
        effort: 'medium',
        maxTokens: 4000,
        note: address,
        content: [{ type: 'text', text: `${STYLE}\n\nQUESTIONS\n${JSON.stringify(briefs, null, 1)}${note}` }],
      });
      const lines = parseLines(raw);
      const why = checkLines(lines, briefs);
      if (!why) return lines.map((l) => l.text.trim());
      console.warn(`[agent-voice] ${address}: attempt ${attempt + 1} not used (${why})`);
      note = `\n\nYOUR LAST ANSWER WAS NOT USABLE: ${why}. Fix that.`;
    } catch (err) {
      console.warn(`[agent-voice] ${address}: attempt ${attempt + 1} failed: ${err.message}`);
    }
  }
  return null;
}

module.exports = { onePerQuestion, questionKey, writeAsks, checkLines, STYLE };
