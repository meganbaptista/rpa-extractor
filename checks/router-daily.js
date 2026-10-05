// checks/router-daily.js
//
// The router log's daily summary: 5:30 PM to 5:30 PM Pacific.
//   node checks/router-daily.js

const R = require('../netlify/functions/lib/shadow-render.js');
const { windowStart, dayLabel } = R._internal;

let failed = 0;
function ok(label, got, want) {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) { failed++; console.error(`FAIL  ${label}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`); }
  else console.log(`pass  ${label}`);
}

// Oct is daylight time, UTC-7: 5:30 PM PDT = 00:30 UTC the next day.
ok('5:29 PM Oct 3 PT is the Oct 2 day', windowStart('2026-10-04T00:29:00Z'), '2026-10-02');
ok('5:30 PM Oct 3 PT starts the Oct 3 day', windowStart('2026-10-04T00:30:00Z'), '2026-10-03');
ok('the DocuSign email (5:06 PM Oct 3) is the Oct 2 day', windowStart('2026-10-04T00:06:13Z'), '2026-10-02');
ok('9 AM Oct 4 PT is still the Oct 3 day', windowStart('2026-10-04T16:00:00Z'), '2026-10-03');
// December is standard time, UTC-8: 5:30 PM PST = 01:30 UTC.
ok('winter: 5:29 PM PST', windowStart('2026-12-02T01:29:00Z'), '2026-11-30');
ok('winter: 5:30 PM PST', windowStart('2026-12-02T01:30:00Z'), '2026-12-01');
ok('label', dayLabel('2026-10-03'), 'Sat Oct 3 5:30 PM to Sun Oct 4 5:30 PM');

const recs = [
  { at: '2026-10-04T16:00:00Z', mode: 'live', plannedLabel: 'Belle' },
  { at: '2026-10-04T16:05:00Z', mode: 'live', plannedLabel: 'Needs Attention' },
  { at: '2026-10-04T16:10:00Z', mode: 'live', plannedLabel: 'Belle + Megan' },
  { at: '2026-10-04T16:20:00Z', mode: 'live', plannedLabel: 'Edelyn' },
  { at: '2026-10-04T16:30:00Z', mode: 'live', plannedLabel: null, skip: true },
  { at: '2026-10-04T16:40:00Z', mode: 'error', plannedLabel: null },
];
const html = R.daily(recs, { nowIso: '2026-10-04T17:00:00Z' });
const row = html.split('<tr>').find((r) => r.includes('Sat Oct 3'));
const cells = (row.match(/<td class="ctr">(?:<b>)?(\d+)/g) || []).map((c) => +c.replace(/\D+/g, ''));
// Emails, Belle, NA, Belle+NA, Edelyn, Megan, Cleared
ok('counts: 5 emails (error excluded), Belle 2, NA 1, Belle+NA 3, Edelyn 1, Megan 1, cleared 1', cells, [5, 2, 1, 3, 1, 1, 1]);
ok('current day marked', html.includes('(so far)'), true);

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log('\nall router-daily checks pass');
