// checks/package-live.js
//
// The automatic buyer email (Megan, 2026-10-27): plain-English "still to
// come" from the audit's still-needed lines, the page guide from the build,
// the red CHECK BEFORE SENDING box, filling a Zap-shaped draft, and the
// safety stops (her own package already in the folder, a build problem).
//   node checks/package-live.js

const L = require('../netlify/functions/lib/package-live.js');
const PJ = require('../netlify/functions/lib/package-job.js');
let failed = 0;
function ok(label, got, want) { if (got !== want) { failed++; console.error(`FAIL  ${label}: got ${got}, want ${want}`); } else console.log(`pass  ${label}`); }

(async () => {
  // ---- still to come, from real lists ----
  const sunny = L.stillToComeFrom({ still_needed_lines: 'SFLS - If your brokerage does not require this form, please email us confirming this\nFHDS w. Boxes Checked in Sec 2 and YES Checked in Sec 3\nNHD Statement\nRCSD-S LLC - Yes, please verify RPA sec. 34 for Entity section to be filled out\nWCMD\nMCA\nSBSA\nSan Fernando Local Area Disclosures', response_flags_count: 13 }, ['sbsa', 'wfda']);
  ok('Sunnyslope: buyer words, in order', sunny.items.join(' | '), "the square footage disclosure | the fire safety disclosure | the natural hazard disclosure statement | the form confirming who signs for the seller | the plumbing fixtures and carbon monoxide detector notice | the market conditions advisory | the San Fernando local area disclosures | updates to a few of the seller's answers");
  ok('Sunnyslope: a form we added from the template is not "to come"', sunny.items.some((s) => /statewide/.test(s)), false);
  ok('Sunnyslope: nothing unsure', sunny.unsure.length, 0);
  const rubio = L.stillToComeFrom({ still_needed_lines: 'WCMD', response_flags_count: 27 });
  ok('Rubio', rubio.items.join(' | '), "the plumbing fixtures and carbon monoxide detector notice | updates to a few of the seller's answers");
  const ours = L.stillToComeFrom({ still_needed_lines: 'BA AVID\nVP - once completed\nProperty Inspections or BIW\nTermite Inspection or BIW\nContingency Release(s)\nReceipt for Reports (RFR)\nLA AVID\nSomething Odd 12', response_flags_count: 0 });
  ok('our own items and escrow steps are never "from the seller"', ours.items.join(' | '), "the listing agent's visual inspection");
  ok('a line it has no words for goes to the red box, not guessed', ours.unsure.join(), 'Something Odd 12');
  ok('no form codes ever reach the buyer', [...sunny.items, ...rubio.items, ...ours.items].some((s) => /\b(TDS|SPQ|SFLS|FHDS|NHD|WCMD|MCA|SBSA|AVID|RCSD)\b/.test(s)), false);

  // ---- page guide from the build ----
  const plan = { units: [{ section: 1 }, { section: 1 }, { section: 3 }, { section: 5 }], guide: [{ sections: [1], label: "The seller's disclosures about the condition of the home" }, { sections: [2, 3, 4], label: 'Additional forms' }, { sections: [5, 6], label: 'Standard advisories' }], leftOut: [{ what: 'BIW', why: 'buyer investigation waiver (always removed)' }] };
  const g = L.guideFromPlan(plan, [[1, 3], [4, 8], [9, 12], [13, 30]]);
  ok('guide ranges', g.map((x) => `${x.from}-${x.to}`).join(','), '1-8,9-12,13-30');

  // ---- filling a Zap-shaped draft ----
  const ZAP = '<div dir="ltr"><div>Hello Jesse,<br><br>Attached is a package of important disclosures ...<br><br></div>-- <br><div>Megan Baptista</div></div>';
  let updatedRaw = '';
  const gmail = {
    listDrafts: async () => [{ id: 'd1', message: { id: 'm1' } }],
    getMessage: async (id) => (id === 'm1' ? { bodyHtml: ZAP, headers: { to: 'buyer@example.com', subject: 'Seller Disclosure Package | 1 Main St' } } : { bodyText: 'read back ok' }),
    updateDraftRaw: async (id, raw) => { updatedRaw = raw; return { message: { id: 'm2' } }; },
    labelId: async (n) => `L_${n}`,
    modifyMessage: async () => {},
  };
  const built = { name: 'Disclosures - 1 Main St.pdf', pkg: { pages: 30, ranges: [[1, 3], [4, 8], [9, 12], [13, 30]], bytes: Buffer.from('%PDF pkg') }, attachments: [{ name: 'Natural Hazard Disclosure Report.pdf', bytes: Buffer.from('%PDF nhd') }] };
  const d = await L.fillDraft({ gmail, street: '1 Main St', address: '1 Main St, Orange, CA 92867', built, plan, still: rubio, warnings: ['check the AAA'], notes: [], source: '"Disclosures" (Listing TC)' });
  const html = Buffer.from(updatedRaw.split(/\r\n\r\n/)[2].split('--')[0].replace(/\s+/g, ''), 'base64').toString('utf8');
  ok('draft filled in place', d.draftId, 'd1');
  ok('red box above the greeting', html.indexOf('CHECK BEFORE SENDING') < html.indexOf('Hello Jesse'), true);
  ok('box lists what was left out, with the reason', /Left out of the package:.*BIW: buyer investigation waiver \(always removed\)/s.test(html), true);
  ok('box lists the warnings', /check the AAA/.test(html), true);
  ok('her opening paragraph and the guide', /package of important disclosures that have been filled out by the seller/.test(html) && /Pages 1 - 8/.test(html), true);
  ok('still to come in buyer words', /plumbing fixtures and carbon monoxide detector notice/.test(html), true);
  ok('package and report attached', (updatedRaw.match(/filename="/g) || []).length, 2);

  // ---- safety stops ----
  const noDraftGmail = { ...gmail, listDrafts: async () => [] };
  const e = await L.fillDraft({ gmail: noDraftGmail, street: '1 Main St', address: 'x', built, plan, still: rubio, warnings: [], notes: [], source: '' }).then(() => null, (err) => err);
  ok('no Zap draft yet: a retryable error', e && e.code, 'no-draft');

  // deliverLive: her own package in the folder = nothing touched; a problem = no fill.
  const alerts = []; const saved = [];
  const ctx = { store: { get: async () => null, setJSON: async () => {} }, job: { id: 'j', address: '1 Main St, Orange, CA', source: { subject: 's', from: 'f' } }, drive: { uploadMultipart: async ({ name }) => saved.push(name) }, gmail, alert: async (k, m) => alerts.push(m), log: () => {} };
  const r0 = { built, plan, drop: { warnings: [], notes: [], dropIns: {} }, deal: { folder: { id: 'f' }, files: [{ name: 'Disclosures - 1 Main St.pdf' }] } };
  ok('her package already in the folder: nothing saved, nothing filled', `${await PJ.deliverLive(ctx, { ...r0, built: { ...built, problems: [] } }, {}, false)}|${saved.length}`, 'package: "Disclosures - 1 Main St.pdf" already in the deal folder, nothing changed (built by hand)|0');
  const r1 = { ...r0, built: { ...built, problems: [] }, deal: { folder: { id: 'f' }, files: [{ name: 'SELLER DISCLOSURES SS.pdf' }] } };
  ok('her package under her own name: nothing touched', /SELLER DISCLOSURES SS\.pdf" already in the deal folder/.test(await PJ.deliverLive(ctx, r1, {}, false)), true);
  const ctxSent = { ...ctx, gmail: { ...gmail, listMessages: async () => [{ id: 's1' }], getMessage: async () => ({ headers: { subject: 'Seller Disclosure Package | 1 Main St' }, internalDate: '1' }) } };
  const r2 = { ...r0, built: { ...built, problems: [] }, deal: { folder: { id: 'f' }, files: [] } };
  ok('a package email already sent: nothing touched', /already sent/.test(await PJ.deliverLive(ctxSent, r2, {}, false)), true);
  ok('a build problem: not filled, alerted, trial instead', `${await PJ.deliverLive(ctx, { ...r0, built: { ...built, problems: ['page 3 came out blank'] } }, {}, false)}|${alerts.length}`, 'null|1');

  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall package-live checks pass');
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
