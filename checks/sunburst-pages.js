// checks/sunburst-pages.js: a form the review must read is never skipped.
// 3175 Sunburst (Megan, 2026-11-24, "VERY BAD"): the SPQ and TDS were flattened
// images whose only text was e-signature stamps, so the page picker read 5 of
// 49 pages and none of the TDS or SPQ answers were checked.
const assert = require('assert');
const { pageTextLen } = require('../netlify/functions/disclosure-intake-check-background.js')._internal;

const stampsOnly = 'BM-SIGNED\n8f000...\n11/23/26\n\t04:58 PM PST\nBM-SIGNED\ncd613...\n\t11/23/26\n\t05:02 PM PST\nPackage ID: DFBBAD2A309AB9A1C15B559E715F81E8\tPackage ID: 12ED7427840CC4DC8CCBA6720914387D';
assert.ok(pageTextLen(stampsOnly) < 150, 'a page of e-sign stamps counts as a scan');
const withDates = 'Nov 23, 2026\nNov 23, 2026\n' + stampsOnly;
assert.ok(pageTextLen(withDates) < 150, 'signing dates are stamps too');
const realPage = 'SELLER PROPERTY QUESTIONNAIRE (C.A.R. Form SPQ, Revised 6/24) 7. REPAIRS AND ALTERATIONS: ARE YOU (SELLER) AWARE OF... A. Any alterations, modifications, replacements, improvements, remodeling or material repairs on the Property';
assert.ok(pageTextLen(realPage) >= 150, 'a real form page still has text');
console.log('sunburst-pages: e-sign stamps are not page text');
