// netlify/functions/lib/email-layout.js
//
// AN EMAIL THAT LOOKS TYPED BY A PERSON (Megan, 2026-11-17: "my biggest gripe
// with AI emails, they format the first line so far down and its super
// noticable" ... "We need to make sure this edit is done on ALL drafted
// emails"). Two rules, the same as Keeva's src/lib/email-mime.ts:
//
//   1. THE FIRST LINE SITS AT THE TOP. Lines are written as <p>, and a
//      paragraph's top margin pushed the greeting down from Gmail's "to me".
//      Empty lines at the top are dropped and the first paragraph's top
//      margin is 0.
//   2. ONE BLANK LINE BEFORE THE SIGNATURE. Empty lines are trimmed off the
//      end of the body and the start of the signature before they are joined.
//
// Applied where every draft passes (mime.buildMime, gmail.createDraft,
// signature.withSignature), so no single email can be missed. Pure, for
// checks/email-layout.js.

const EMPTY_BIT = String.raw`(?:\s|&nbsp;|<br\s*\/?>|<(p|div)[^>]*>(?:\s|&nbsp;|<br\s*\/?>)*<\/\1>)`;
const LEADING = new RegExp(`^${EMPTY_BIT}+`, 'i');
const TRAILING = new RegExp(`${EMPTY_BIT}+$`, 'i');

/** Rule 1. Idempotent: a body already flush is returned unchanged. */
function flushTop(html) {
  const trimmed = String(html || '').replace(LEADING, '');
  return trimmed.replace(/^((?:<div[^>]*>\s*)*)<p(\s[^>]*)?>/i, (_m, wrappers, attrs = '') => {
    const style = /\sstyle="([^"]*)"/i.exec(attrs);
    if (style && /(^|;)\s*margin-top\s*:\s*0/i.test(style[1])) return _m;
    const rest = attrs.replace(/\sstyle="[^"]*"/i, '');
    const css = style ? `margin-top:0;${style[1]}` : 'margin-top:0';
    return `${wrappers}<p${rest} style="${css}">`;
  });
}

/** Rule 2's trims, for the join in signature.withSignature. */
function trimEnd(html) { return String(html || '').replace(TRAILING, ''); }
function trimStart(html) {
  return String(html || '').replace(LEADING, '').replace(/^(<div[^>]*>)(?:\s|&nbsp;|<br\s*\/?>)+/i, '$1');
}

module.exports = { flushTop, trimEnd, trimStart };
