// netlify/functions/lib/intake-steps.js
//
// What each step of an intake job DOES. lib/intake-job.js decides WHEN; this
// file does the work, calling the same audit the Zap path uses
// (disclosure-intake-check-background.js `core`).
//
// Every dependency arrives in `ctx`, so the local replay (checks/intake-job-
// replay.js) runs these exact functions against an in-memory store and files on
// disk:
//   ctx = { store, job, step, attempt, core, strips, gmail, signature, alert,
//           stateStore, callbackUrl, canonicalAddress, auditList?, log }
//
// Each step returns `apply(job)`, which records what it learned on the job
// record when the step is marked done.

const J = require('./intake-job');

const SHARE_LINK = /https?:\/\/(?:www\.)?(?:dropbox\.com\/(?:scl\/fo|scl\/fi|sh|s)\/[^\s"'<>)]+|drive\.google\.com\/(?:file\/d\/[A-Za-z0-9_-]+|open\?id=[A-Za-z0-9_-]+|uc\?[^\s"'<>)]*id=[A-Za-z0-9_-]+)[^\s"'<>)]*)/gi;

/**
 * Share links in an email body: Dropbox files/folders, Google Drive FILES.
 * The HTML body first, because Gmail hard-wraps the plain body and splits a
 * 140-character Dropbox URL across lines (see disclosure-intake-share-links).
 * A Drive file link becomes its direct-download form. Drive FOLDERS and
 * WeTransfer cannot be fetched server-side, so they are not matched here and
 * the email reads as "nothing reviewable", which is alerted.
 */
function shareLinks(html = '', text = '') {
  const found = new Map();
  const add = (raw) => {
    const url = raw.replace(/&amp;/g, '&').replace(/[.,;]+$/, '');
    const id = (url.match(/\/file\/d\/([A-Za-z0-9_-]+)/) || url.match(/[?&]id=([A-Za-z0-9_-]+)/) || [])[1];
    const direct = /drive\.google\.com/i.test(url) && id ? `https://drive.google.com/uc?export=download&id=${id}` : url;
    if (!found.has(direct)) found.set(direct, { name: `link ${found.size + 1}`, url: direct });
  };
  for (const m of String(html).matchAll(SHARE_LINK)) add(m[0]);
  for (const m of String(text).matchAll(SHARE_LINK)) add(m[0]);
  return [...found.values()];
}

const isPdfOrZip = (a) => /\.(pdf|zip)$/i.test(a.filename || '')
  || /application\/(pdf|zip|x-zip|x-zip-compressed)/i.test(a.mimeType || '');

// ---------------------------------------------------------------------------

async function load(ctx) {
  const { store, job, core, gmail } = ctx;
  let documents = [];
  if (job.source.localFiles) {
    const fs = require('fs');
    const path = require('path');
    documents = job.source.localFiles.map((p) => ({ name: path.basename(p), base64: fs.readFileSync(p).toString('base64') }));
  } else {
    const msg = await gmail.getMessage(job.source.messageId);
    for (const a of msg.attachments.filter(isPdfOrZip)) {
      const buf = await gmail.getAttachment(msg.id, a.attachmentId);
      documents.push({ name: a.filename, base64: buf.toString('base64') });
    }
    documents.push(...shareLinks(msg.bodyHtml, msg.bodyText));
  }

  const report = [];
  const docs = await core.loadDocuments(documents, report);
  const meta = [];
  for (let n = 0; n < docs.length; n++) {
    const buf = Buffer.from(docs[n].base64, 'base64');
    const pages = await core.pdfPageCount(buf);
    await J.putDoc(store, job.id, n, buf);
    meta.push({ n, name: docs[n].name, pages, bytes: buf.length });
  }
  ctx.log(`loaded ${meta.length} file(s), ${meta.reduce((s, d) => s + d.pages, 0)} page(s); `
    + `${report.filter((r) => !r.info).length} not reviewed`);
  return (j) => {
    j.docs = meta;
    j.skipped = report.filter((r) => !r.info);
    j.archives = report.filter((r) => r.info);
    J.addSteps(j, meta.length ? ['map', 'plan'] : ['finish']);
  };
}

/**
 * Every page of every file, matched to a form by its header/footer, or listed
 * as unmatched. A file whose pages cannot be read is retried with the step; on
 * the LAST attempt it is recorded as not page-checked instead, so one bad file
 * cannot stop the whole delivery.
 */
async function map(ctx) {
  const { store, job, strips } = ctx;
  const lastTry = ctx.attempt >= J.MAX_ATTEMPTS;
  const out = {};
  for (const d of job.docs) {
    try {
      const buf = await J.getDoc(store, job.id, d.n);
      const rows = await strips.readAllStrips(buf, d.pages, d.name);
      // readStripsFor does NOT throw when a batch of pages fails (an API error,
      // a bad key): it returns those pages marked `unread`, and the span logic
      // then GUESSES where forms begin. Found on the first replay, 2026-10-21,
      // when every call 401'd and the step still "succeeded". An unread page is
      // a failure here: retry the step, and on the last try report the pages
      // as unmatched rather than accept a guess.
      const unread = rows.filter((r) => r.unread).map((r) => r.page);
      if (unread.length && !lastTry) {
        throw new Error(`${d.name}: ${unread.length} page(s) could not be read (${J.compactPages(unread)})`);
      }
      const forms = strips.documentsFromStrips(rows.filter((r) => !r.unread));
      out[d.n] = {
        forms: forms.map((f) => ({
          name: f.title || f.carCode || f.footerName || '',
          code: f.carCode || '',
          pages: f.pages,
          notes: f.notes || [],
        })),
        unclaimed: strips.unclaimedPages(forms, d.pages),
      };
    } catch (err) {
      if (!lastTry) throw err;
      ctx.log(`page reading failed for ${d.name} on the last try, recording it as not page-checked: ${err.message}`);
    }
  }
  await J.putOut(store, job.id, 'map', out);
  return null;
}

async function loadDocObjects(ctx) {
  const objs = [];
  for (const d of ctx.job.docs) {
    const buf = await J.getDoc(ctx.store, ctx.job.id, d.n);
    objs.push({ name: d.name, base64: buf.toString('base64'), _n: d.n });
  }
  return objs;
}

async function plan(ctx) {
  const objs = await loadDocObjects(ctx);
  const batches = await ctx.core.planBatches(objs);
  const lite = batches.map((b) => b.map((d) => ({ n: d._n, skipBooklet: d._skipBookletStatement === true })));
  await J.putOut(ctx.store, ctx.job.id, 'plan', lite);
  ctx.log(`${lite.length} batch(es): ${lite.map((b) => b.length).join(', ')} file(s)`);
  const steps = [];
  for (let i = 0; i < lite.length; i++) steps.push(`identify:${i}`, `review:${i}`);
  steps.push('finish');
  return (j) => J.addSteps(j, steps);
}

async function batchDocs(ctx, i) {
  const lite = await J.getOut(ctx.store, ctx.job.id, 'plan');
  const byN = new Map(ctx.job.docs.map((d) => [d.n, d]));
  const out = [];
  for (const b of lite[i]) {
    const buf = await J.getDoc(ctx.store, ctx.job.id, b.n);
    const d = { name: byN.get(b.n).name, base64: buf.toString('base64') };
    if (b.skipBooklet) d._skipBookletStatement = true;
    out.push(d);
  }
  return out;
}

async function identify(ctx, i) {
  const r = await ctx.core.identifyForms(await batchDocs(ctx, i));
  await J.putOut(ctx.store, ctx.job.id, `identify:${i}`, r);
  ctx.log(`batch ${i + 1}: ${(r.forms || []).length} form(s)`);
  return null;
}

async function review(ctx, i) {
  const r = await ctx.core.reviewAnswers(await batchDocs(ctx, i));
  await J.putOut(ctx.store, ctx.job.id, `review:${i}`, r);
  ctx.log(`batch ${i + 1}: ${(r.responseFlags || []).length} answer flag(s)`);
  return null;
}

// ---------------------------------------------------------------------------
// finish: reconcile, then deliver. Side effects (callback, draft, label) are
// recorded as they happen, so a retried finish never repeats one.
// ---------------------------------------------------------------------------

async function finish(ctx) {
  const { store, job, core } = ctx;
  const live = job.mode === 'live';

  if (!job.docs.length) {
    const why = job.skipped.length ? job.skipped.map((s) => `${s.name} (${s.reason})`).join('; ') : 'no PDF, zip or share link in the email';
    await ctx.alert(`intake-empty:${job.id}`,
      `Nothing reviewable in "${job.source.subject}" from ${job.source.from}: ${why}. Check the email by hand.`);
    if (live) await removeLabel(ctx);
    return (j) => { j.status = 'done'; j.outcome = 'nothing reviewable'; };
  }

  const lite = (await J.getOut(store, job.id, 'plan')) || [];
  const byN = new Map(job.docs.map((d) => [d.n, d]));
  const batches = lite.map((b) => b.map((x) => ({ name: byN.get(x.n).name })));
  const outcomes = [];
  const reviewed = {};
  for (let i = 0; i < lite.length; i++) {
    const idr = await J.getOut(store, job.id, `identify:${i}`);
    const rev = await J.getOut(store, job.id, `review:${i}`);
    if (rev && rev.reviewedPages) {
      for (const [name, pages] of Object.entries(rev.reviewedPages)) reviewed[name] = (reviewed[name] || []).concat(pages);
    }
    if (!idr) { outcomes.push({ ok: false, err: new Error('identify gave up') }); continue; }
    const settled = rev ? { status: 'fulfilled', value: rev } : { status: 'rejected', reason: new Error('review gave up') };
    outcomes.push({ ok: true, r: core.combineIdentifyReview(idr, settled) });
  }
  const merged = core.mergeBatchResults(batches, outcomes);

  const address = ctx.canonicalAddress(merged.propertyAddress || job.source.propertyAddress || '');
  if (!address) throw new Error('could not read a property address from the documents');

  // The per-deal received set, accumulated across emails exactly as the Zap path
  // does. Shadow mode reads it but never writes it.
  const key = core.normalizeAddress(address);
  const prior = (await ctx.stateStore.get(key, { type: 'json' })) || { address, received: [] };
  const received = core.mergeForms(prior.received, merged.forms);
  if (live) await ctx.stateStore.setJSON(key, { address, received, updatedAt: Date.now() });

  const maps = (await J.getOut(store, job.id, 'map')) || {};
  const acct = J.pageAccounting(job.docs, maps, reviewed);
  const gaps = acct.unclaimed.length || acct.unmapped.length || job.skipped.length || job.gaveUp.length;
  const acctText = J.accountingText(acct, job.skipped, job.gaveUp);

  const effects = (await J.getOut(store, job.id, 'finish-effects')) || {};
  const saveEffects = () => J.putOut(store, job.id, 'finish-effects', effects);

  const deliver = async (payload) => {
    // Megan reads the PS card, not the logs: the page accounting goes on it.
    if (gaps) {
      payload.ps_comment = `${payload.ps_comment || ''}\n\nINTAKE CHECK\n${acctText}`;
      payload.ps_comment_md = `${payload.ps_comment_md || ''}\n\n**INTAKE CHECK**\n${acctText}`;
    }
    await J.putOut(store, job.id, 'payload', payload);
    if (!live) {
      if (!effects.trialDraft && ctx.gmail) {
        effects.trialDraft = await trialDraft(ctx, payload, address, acct, acctText);
        await saveEffects();
      }
      return;
    }
    if (!effects.callback) {
      await core.sendCallback(ctx.callbackUrl, payload);
      effects.callback = Date.now(); await saveEffects();
    }
    if (!effects.draft && payload.chase_email_body_html) {
      const draft = await ctx.gmail.createDraft({
        to: job.source.fromIsUs ? '' : job.source.from,
        subject: `Re: ${String(job.source.subject || '').replace(/^\s*(re:\s*)+/i, '')}`,
        htmlBody: ctx.signature.withSignature(payload.chase_email_body_html, await ctx.signature.liveSignature(ctx.gmail)),
        threadId: job.source.threadId,
        inReplyTo: job.source.rfcMessageId || '',
      });
      effects.draft = (draft && draft.id) || 'created'; await saveEffects();
    }
  };

  const payload = await core.reconcileAndCallback(
    address, received, ctx.auditList || '', ctx.callbackUrl,
    merged.responseFlags, merged.keyAnswers, job.source.threadId, merged.dropped,
    merged.reviewIncomplete, job.source.fromName || '',
    {
      skipClaim: true,
      deliver,
      extraPayload: {
        intake_job_id: job.id,
        page_accounting_text: acctText,
        page_accounting_alert: gaps ? acctText : '',
      },
    },
  );

  if (live && !effects.label) { await removeLabel(ctx); effects.label = Date.now(); await saveEffects(); }
  if (gaps) {
    await ctx.alert(`intake-gaps:${job.id}`,
      `${address}: the intake finished but some of the package was not fully checked.\n${acctText}`);
  }
  return (j) => {
    j.address = address;
    j.status = 'done';
    j.outcome = payload
      ? `${payload.overall_status}: ${payload.still_needed_count} to request, ${payload.response_flags_count} answer flag(s)`
      : 'finished';
  };
}

/**
 * SHADOW MODE: the result as a draft Megan can open, NOT in the thread.
 *
 * Two drafts in one thread cannot both be seen on her computer (Megan,
 * 2026-10-21: "i have to go into my phone and pull it up"), so the trial draft
 * stands alone in Drafts, with no recipient (Send does nothing), a [TRIAL]
 * subject, a box saying how the run went, then the exact reply live mode would
 * have drafted. INTAKE_TRIAL_LABELS (default "Megan,Edelyn") are put on it; a
 * label Gmail refuses is logged, never fatal.
 */
async function trialDraft(ctx, payload, address, acct, acctText) {
  const { job, gmail } = ctx;
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const mins = Math.max(1, Math.round((Date.now() - (job.createdAt || Date.now())) / 60000));
  const box = '<div style="border:2px solid #b45309;padding:10px 12px;margin-bottom:16px;font-family:Arial,sans-serif;font-size:13px">'
    + '<b>TRIAL RUN OF THE NEW INTAKE (not sent, nothing changed)</b><br>'
    + `Email: "${esc(job.source.subject)}" from ${esc(job.source.from)}<br>`
    + `Finished in about ${mins} min. ${acct.claimed} of ${acct.total} pages matched to a form.<br>`
    + esc(acctText).replace(/\n/g, '<br>')
    + '<br><br>Below is the reply it would have drafted. Compare it with the draft in the email thread.</div>';
  const body = payload.chase_email_body_html || '<p>(no reply: nothing to chase)</p>';
  const draft = await gmail.createDraft({
    to: '',
    subject: `[TRIAL] ${address} - new intake result`,
    htmlBody: box + body,
  });
  const messageId = draft && draft.message && draft.message.id;
  const names = String(process.env.INTAKE_TRIAL_LABELS || 'Megan,Edelyn').split(',').map((s) => s.trim()).filter(Boolean);
  if (messageId && names.length) {
    try {
      const ids = (await Promise.all(names.map((n) => gmail.labelId(n)))).filter(Boolean);
      if (ids.length) await gmail.modifyMessage(messageId, { add: ids });
      if (ids.length < names.length) ctx.log(`trial draft: some labels not found in Gmail (${names.join(', ')})`);
    } catch (err) {
      ctx.log(`trial draft created, but labelling it failed: ${err.message}`);
    }
  }
  return (draft && draft.id) || 'created';
}

async function removeLabel(ctx) {
  const { job, gmail } = ctx;
  if (!job.source.labelId || !gmail) return;
  await gmail.modifyMessage(job.source.messageId, { remove: [job.source.labelId] });
}

async function run(name, ctx) {
  const [kind, idx] = name.split(':');
  const i = idx === undefined ? undefined : Number(idx);
  switch (kind) {
    case 'load': return load(ctx);
    case 'map': return map(ctx);
    case 'plan': return plan(ctx);
    case 'identify': return identify(ctx, i);
    case 'review': return review(ctx, i);
    case 'finish': return finish(ctx);
    default: throw new Error(`unknown step ${name}`);
  }
}

module.exports = { run, shareLinks, isPdfOrZip };
