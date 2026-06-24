// ─── PLACEHOLDER SCRUB ───────────────────────────────────────────────────────
// The extraction prompts ask the model to return an EMPTY STRING when a value
// can't be read. But on hard/corrupt PDFs a model sometimes emits a literal
// placeholder instead — e.g. "<UNKNOWN>", "N/A", "TBD". Those are dangerous for
// two reasons:
//   1. They are non-empty, so the missingCritical safety net (and any
//      "is this field filled?" check) treats the field as successfully
//      extracted and never re-escalates or flags it.
//   2. An angle-bracket placeholder like "<UNKNOWN>" is parsed as an unknown
//      HTML tag by the review UI and renders as NOTHING — so a missed field
//      looks like an ordinary blank the user can't tell was a miss.
// Scrubbing them back to "" restores honest blanks: the field reads as missing
// (so it re-escalates / shows empty for manual entry) instead of fake-filled.
//
// Conservative on purpose: only EXACT-MATCH sentinels (trimmed) are scrubbed —
// never substrings — so a legitimate value that merely contains one of these
// words is left untouched. Any fully angle-bracketed token (<...>) is always
// scrubbed: those are never a real RPA value and always break HTML rendering.
const PLACEHOLDER_RE = /^\s*(?:<[^>]*>|unknown|n\/a|n\.a\.?|tbd|tba|see\s+addendum|not\s+found|not\s+available|unreadable|illegible)\s*$/i;

function isPlaceholder(value) {
  return typeof value === 'string' && PLACEHOLDER_RE.test(value);
}

// Mutate `fields` in place: any string value that is a placeholder sentinel
// becomes "". Returns the list of keys that were scrubbed (for logging).
function scrubPlaceholders(fields) {
  const scrubbed = [];
  if (!fields || typeof fields !== 'object') return scrubbed;
  for (const [key, value] of Object.entries(fields)) {
    if (isPlaceholder(value)) {
      fields[key] = '';
      scrubbed.push(key);
    }
  }
  return scrubbed;
}

module.exports = { PLACEHOLDER_RE, isPlaceholder, scrubPlaceholders };
