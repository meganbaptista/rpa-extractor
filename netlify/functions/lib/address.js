// netlify/functions/lib/address.js
//
// Canonical address formatting — ONE source of truth so every producer of a
// property address (the extractor, the disclosure intake, the compliance check,
// and the Zapier sheet/search via the mirror snippet) emits the SAME string.
// This matters because Zapier exact-match lookups and Process Street record joins
// key on the literal address; "Avenue" vs "Ave" silently breaks them.
//
// What it does: abbreviates the STREET SUFFIX to USPS shorthand (Avenue -> Ave,
// Street -> St, ...) and abbreviates a leading directional (North -> N). It only
// touches the street segment (before the first comma), never the city/state/zip,
// and only the last non-unit token, so "Avenue of the Stars" and city names are
// left alone. Pure string in, pure string out. No requires.

const SUFFIX = {
  avenue: 'Ave', ave: 'Ave', av: 'Ave',
  street: 'St', st: 'St', str: 'St',
  boulevard: 'Blvd', blvd: 'Blvd', boul: 'Blvd',
  drive: 'Dr', dr: 'Dr',
  road: 'Rd', rd: 'Rd',
  lane: 'Ln', ln: 'Ln',
  court: 'Ct', ct: 'Ct',
  place: 'Pl', pl: 'Pl',
  terrace: 'Ter', ter: 'Ter', terr: 'Ter',
  circle: 'Cir', cir: 'Cir',
  way: 'Way',
  trail: 'Trl', trl: 'Trl',
  parkway: 'Pkwy', pkwy: 'Pkwy',
  highway: 'Hwy', hwy: 'Hwy',
  square: 'Sq', sq: 'Sq',
  plaza: 'Plz', plz: 'Plz',
  point: 'Pt', pt: 'Pt',
  cove: 'Cv', cv: 'Cv',
  loop: 'Loop',
  path: 'Path',
  pike: 'Pike',
  row: 'Row',
  run: 'Run',
  pass: 'Pass',
  walk: 'Walk',
  alley: 'Aly', aly: 'Aly',
  crossing: 'Xing', xing: 'Xing',
  expressway: 'Expy', expy: 'Expy',
  freeway: 'Fwy', fwy: 'Fwy',
};

const DIR = {
  north: 'N', n: 'N',
  south: 'S', s: 'S',
  east: 'E', e: 'E',
  west: 'W', w: 'W',
  northeast: 'NE', ne: 'NE',
  northwest: 'NW', nw: 'NW',
  southeast: 'SE', se: 'SE',
  southwest: 'SW', sw: 'SW',
};

// Tokens that mark a unit/secondary designator — skipped when finding the suffix.
const UNIT = /^(#|unit|apt|apartment|ste|suite|no|num|bldg|building|fl|floor|rm|room|lot|space|spc)\.?$/i;

function isUnitToken(t) {
  return UNIT.test(t) || /^#/.test(t) || /^\d+[a-z]?$/i.test(t);
}

// Canonicalize one address string. Idempotent — running it twice yields the same.
function canonicalAddress(addr) {
  const raw = String(addr == null ? '' : addr).replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  const segs = raw.split(',');
  let street = segs[0].trim();
  if (!street) return segs.map((s) => s.trim()).join(', ');

  const tokens = street.split(' ');

  // Abbreviate the street suffix: scan from the end, skip unit tokens, replace the
  // first "real" token if it's a known suffix.
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (isUnitToken(tokens[i])) continue;
    const key = tokens[i].toLowerCase().replace(/\./g, '');
    if (SUFFIX[key]) tokens[i] = SUFFIX[key];
    break; // only consider the last non-unit token
  }

  // Abbreviate a leading directional (the token right after the house number).
  if (tokens.length >= 2 && /^\d/.test(tokens[0])) {
    const key = tokens[1].toLowerCase().replace(/\./g, '');
    if (DIR[key]) tokens[1] = DIR[key];
  }

  segs[0] = tokens.join(' ');
  return segs.map((s) => s.trim()).filter((s) => s.length).join(', ');
}

module.exports = { canonicalAddress };
