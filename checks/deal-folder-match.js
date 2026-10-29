// The deal folder is found whatever spelling the street type is in
// (2073 Deer Trl, 2026-10-29: the address said "Trl", the folder "Trail",
// and the buyer package was not saved). Placeholder folders, no real deal data.
const assert = require('node:assert');
const { findDealFolder } = require('../netlify/functions/lib/buyer-revision');

const FOLDERS = [
  '2073 Deer Trail, Yucca Valley, CA 92284',
  '20731 Deer Trail, Somewhere, CA',
  '2073 Deer Run Rd, Elsewhere, CA',
  '4180-4182 Sunnyslope Ave, Sherman Oaks, CA',
  '103 N Laurel Avenue, Los Angeles, CA',
];
const drive = {
  asked: [],
  async findFoldersNameContains(text) {
    this.asked.push(text);
    const t = text.toLowerCase();
    return FOLDERS.filter((n) => n.toLowerCase().split(/[\s,-]+/).some((w) => w.startsWith(t))).map((name, i) => ({ id: `f${i}`, name }));
  },
  async listChildren() { return []; },
};

(async () => {
  const deer = await findDealFolder(drive, '2073 Deer Trl, Yucca Valley, CA 92284');
  assert.equal(deer.folder && deer.folder.name, FOLDERS[0], 'Trl should find the Trail folder');
  assert.equal(drive.asked.pop(), 'Deer', 'Drive is searched by the street name word');

  const duplex = await findDealFolder(drive, '4180 - 4182 Sunnyslope Ave, Sherman Oaks, CA');
  assert.equal(duplex.folder && duplex.folder.name, FOLDERS[3]);

  const laurel = await findDealFolder(drive, '103 N Laurel Ave, Los Angeles, CA');
  assert.equal(laurel.folder && laurel.folder.name, FOLDERS[4], 'Ave should find the Avenue folder');
  assert.equal(drive.asked.pop(), 'Laurel', 'a direction is never the search word');

  const none = await findDealFolder(drive, '2073 Deer Ln, Yucca Valley, CA');
  assert.equal(none.folder, null, 'a different street type is a different street');
  console.log('deal-folder-match: ok');
})().catch((e) => { console.error(e); process.exit(1); });
