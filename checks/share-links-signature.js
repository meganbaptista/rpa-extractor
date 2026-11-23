// checks/share-links-signature.js: a signature's Drive link is not a disclosures link
// (4145 Creciente, 2026-11-23: Compass's "Agent Support Directory" held the draft).
const assert = require('assert');
const { shareLinks } = require('../netlify/functions/lib/intake-steps.js');
const sig = 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view?usp=sharing';
const real = 'https://drive.google.com/drive/folders/1ZyXwVuTsRqPoNm';
const html = `<p>Here you go!</p><p>Disclosures: <a href="${real}">click here</a></p>`
  + `<p><b>Need Help Fast?</b> Download or bookmark our <a href="${sig}">Agent Support Directory</a> for quick access.</p>`;
const text = `Here you go!\nDisclosures: ${real}\nNeed Help Fast? Download or bookmark our Agent Support Directory <${sig}> for quick access.`;
const got = shareLinks(html, text).map((l) => l.drive && l.drive.id);
assert.deepStrictEqual(got, ['1ZyXwVuTsRqPoNm'], `only the disclosures folder, got ${JSON.stringify(got)}`);
// The Creciente email itself: only the signature link, so no link at all.
assert.deepStrictEqual(shareLinks(`<p>Here you go!</p><p>Download or bookmark our <a href="${sig}">Agent Support Directory</a></p>`, ''), []);
console.log('share links: signature links skipped');
