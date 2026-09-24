// netlify/functions/lib/map-limit.js
//
// Run an async mapper over a list, at most N at a time, preserving order.
//
// WHY A LIMIT AND NOT Promise.all. The disclosure split makes one model call
// per group of documents, and those calls are independent - run in sequence a
// 65-page packet took 335 seconds, which on a 110-page delivery would crowd
// the background function's ceiling. But Promise.all over every group at once
// invites 429s from the API and, worse, holds every carved PDF in memory at the
// same time; the renderer in this pipeline already had to be chunked because
// one whole-document pass died with no stack, just `Duration:`.
//
// So: bounded. Order is preserved because the caller matches results back to
// documents positionally, and a shuffled return would file forms under each
// other's names.
async function mapLimit(items, limit, fn) {
  const list = [...items];
  const out = new Array(list.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= list.length) return;
      out[i] = await fn(list[i], i);
    }
  };
  const width = Math.max(1, Math.min(limit, list.length));
  await Promise.all(Array.from({ length: width }, worker));
  return out;
}

module.exports = { mapLimit };
