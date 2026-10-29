// checks/drive-share.js
//
// GOOGLE DRIVE FOLDER LINKS in a disclosure email are read (135 S Vendome,
// 2026-10-28: the folder was never opened, every disclosure came back
// "missing", and the team downloaded the files and sent them to themselves).
// Walked with the same rules as a whole-folder Dropbox zip.
//   node checks/drive-share.js

const DS = require('../netlify/functions/lib/drive-share.js');
const S = require('../netlify/functions/lib/intake-steps.js');
let failed = 0;
function ok(label, got, want) { if (got !== want) { failed++; console.error(`FAIL  ${label}: got ${got}, want ${want}`); } else console.log(`pass  ${label}`); }

const FOLDER = 'application/vnd.google-apps.folder';
const PDF = Buffer.from('%PDF-1.4 test');
// A stand-in for Google Drive, shaped like a real agent's deal folder.
function fakeApi(tree, { denied = [] } = {}) {
  const byId = new Map();
  const walk = (node) => { byId.set(node.id, node); (node.kids || []).forEach(walk); };
  walk(tree);
  const fail = (id) => { if (denied.includes(id)) { const e = new Error('not found'); e.status = 404; throw e; } };
  const downloads = [];
  return {
    downloads,
    remember() {},
    async meta(id) { fail(id); const n = byId.get(id); if (!n) { const e = new Error('nf'); e.status = 404; throw e; } return n; },
    async list(id) { fail(id); return byId.get(id).kids || []; },
    async download(id) { fail(id); downloads.push(byId.get(id).name); return PDF; },
    async exportPdf(id) { downloads.push(`${byId.get(id).name} (as PDF)`); return PDF; },
  };
}
const f = (id, name, mimeType = 'application/pdf', size = 1000) => ({ id, name, mimeType, size: String(size) });
const tree = {
  id: 'root', name: '135 S Vendome', mimeType: FOLDER, kids: [
    { id: 'sd', name: 'Seller Disclosures', mimeType: FOLDER, kids: [f('a', 'TDS.pdf'), f('b', 'SPQ.pdf'), f('big', 'Huge Scan.pdf', 'application/pdf', 40 * 1048576)] },
    { id: 'br', name: 'Buyer Reports', mimeType: FOLDER, kids: [f('c', 'Home Inspection.pdf')] },
    { id: 'rc', name: 'Receipts', mimeType: FOLDER, kids: [f('d', 'Seller Explanation for 6H.pdf'), f('e', 'Plumber invoice.pdf')] },
    { id: 'ps', name: 'Previous Sale Disclosures', mimeType: FOLDER, kids: [f('g', 'TDS 2019.pdf')] },
    f('h', 'Lease Agreements', 'application/vnd.google-apps.document'),
    f('i', 'notes.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    f('j', 'NHD Report.pdf'),
  ],
};

(async () => {
  // Link finding: the folder link in her agent's email (HTML), a file link, Dropbox untouched.
  const links = S.shareLinks('<a href="https://drive.google.com/drive/folders/1Xy_ZabcdEFGhijkLMNOP?usp=sharing">Google Drive Link</a>', 'see https://drive.google.com/file/d/1QwErTyUiOpAsDfGh/view and https://www.dropbox.com/scl/fo/abc/xyz?dl=0');
  ok('a Drive FOLDER link is found', links[0].drive && links[0].drive.kind, 'folder');
  ok('a Drive file link is found', links[1].drive && links[1].drive.kind, 'file');
  ok('Dropbox is still a plain link', Boolean(links[2] && !links[2].drive && /dropbox/.test(links[2].url)), true);
  ok('a newer link keeps its access key', DS.parseDriveLink('https://drive.google.com/drive/u/1/folders/1AbCdEfGhIjKlMnOp?resourcekey=0-abc').resourceKey, '0-abc');

  // Walking the folder.
  const api = fakeApi(tree);
  const got = await DS.expandDriveLink({ kind: 'folder', id: 'root' }, { api, maxDocBytes: 28 * 1048576, maxTotalBytes: 120 * 1048576, isBlocked: () => false });
  const names = got.docs.map((d) => d.name).sort().join(', ');
  ok('the disclosures are read, the Google Doc as a PDF, the explanation rescued from Receipts', names, 'Lease Agreements.pdf, NHD Report.pdf, SPQ.pdf, Seller Explanation for 6H.pdf, TDS.pdf');
  ok('buyer reports, receipts and the prior sale are never downloaded', ['Home Inspection.pdf', 'Plumber invoice.pdf', 'TDS 2019.pdf'].some((n) => api.downloads.includes(n)), false);
  ok('a file over the review limit is named, not downloaded', got.notes.some((n) => /Huge Scan/.test(n.name) && /too large/.test(n.reason)), true);
  ok('a Word file is named as not a PDF', got.notes.some((n) => /notes\.docx/.test(n.name) && /not a PDF/.test(n.reason)), true);
  ok('it read something, so it did not fail', got.failed, false);

  // A folder the account cannot open: said in plain words, never "no disclosures".
  const denied = await DS.expandDriveLink({ kind: 'folder', id: 'root' }, { api: fakeApi(tree, { denied: ['root'] }) });
  ok('an unshared folder fails', denied.failed, true);
  ok('and says why, in plain words', /not shared with the account/.test(denied.notes[0].reason), true);

  // THE LINK CAME AS A REPLY (Vendome: the label sat on the forwarded acceptance email).
  const fwd = { id: 'f', internalDate: '100', headers: { from: 'Megan <megan@mytcconcierge.com>' }, labelIds: ['L'], attachments: [{ filename: 'Purchase Contract.pdf' }] }
  const stef = { id: 's', internalDate: '200', headers: { from: 'Stefanie <stefanie@maggieding.com>' }, labelIds: [], attachments: [], bodyHtml: '<a href="https://drive.google.com/drive/folders/1Xy_ZabcdEFGhij">Google Drive Link</a>' }
  const chat = { id: 'c', internalDate: '300', headers: { from: 'John <john@x.com>' }, labelIds: [], attachments: [], bodyText: 'thanks!' }
  const ours = { id: 'o', internalDate: '400', headers: { from: 'megan@mytcconcierge.com' }, labelIds: [], attachments: [{ filename: 'Our Package.pdf' }] }
  const labelled = { ...stef, id: 'l', internalDate: '500', labelIds: ['L'] }
  const got2 = S.laterReplies([fwd, stef, chat, ours, labelled], fwd, 'megan@mytcconcierge.com', 'L').map((m) => m.id).join(',')
  ok('the reply with the Drive link is read; a chat reply, our own email and a reply that is its own run are not', got2, 's')

  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall drive-share checks pass');
  process.exit(failed ? 1 : 0);
})();
