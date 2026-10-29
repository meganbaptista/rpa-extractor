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
const rc = require('./revision-check');
const R = require('./buyer-revision');
const A = require('./package-assemble');
const RL = require('./revision-local');
const { buildRevisionEmail } = require('./buyer-email');
const { buildMime } = require('./mime');

const SHARE_LINK = /https?:\/\/(?:www\.)?(?:dropbox\.com\/(?:scl\/fo|scl\/fi|sh|s)\/[^\s"'<>)]+|drive\.google\.com\/(?:file\/d\/[A-Za-z0-9_-]+|open\?id=[A-Za-z0-9_-]+|uc\?[^\s"'<>)]*id=[A-Za-z0-9_-]+|drive\/(?:u\/\d+\/)?folders\/[A-Za-z0-9_-]+)[^\s"'<>)]*|docs\.google\.com\/document\/d\/[A-Za-z0-9_-]+[^\s"'<>)]*)/gi;
const DS = require('./drive-share');

/**
 * Share links in an email body: Dropbox files/folders, Google Drive files AND
 * FOLDERS (2026-10-29, 135 S Vendome: a Drive folder link was not read at all).
 * The HTML body first, because Gmail hard-wraps the plain body and splits a
 * 140-character Dropbox URL across lines (see disclosure-intake-share-links).
 * A Drive link carries `drive` ({ kind, id, resourceKey }): the load step opens
 * it as Megan's Google account (lib/drive-share.js), and keeps the public
 * direct-download URL only as the fallback for a file. WeTransfer still cannot
 * be fetched.
 */
function shareLinks(html = '', text = '') {
  const found = new Map();
  const add = (raw) => {
    const url = raw.replace(/&amp;/g, '&').replace(/[.,;]+$/, '');
    const drive = DS.parseDriveLink(url);
    const direct = drive && drive.kind === 'file' ? `https://drive.google.com/uc?export=download&id=${drive.id}` : url;
    const keyOf = drive ? `drive:${drive.id}` : direct;
    if (!found.has(keyOf)) found.set(keyOf, { name: `link ${found.size + 1}`, url: direct, ...(drive ? { drive } : {}) });
  };
  for (const m of String(html).matchAll(SHARE_LINK)) add(m[0]);
  for (const m of String(text).matchAll(SHARE_LINK)) add(m[0]);
  return [...found.values()];
}

/** Later replies in the thread, from someone else, with files or a link, and not labelled themselves. */
function laterReplies(thread, msg, me, labelId) {
  return (thread || []).filter((m) => m.id !== msg.id
    && Number(m.internalDate) > Number(msg.internalDate)
    && !(me && String((m.headers && m.headers.from) || '').toLowerCase().includes(me))
    && !(labelId && (m.labelIds || []).includes(labelId))
    && ((m.attachments || []).some(isPdfOrZip) || shareLinks(m.bodyHtml, m.bodyText).length > 0));
}

const isPdfOrZip = (a) => /\.(pdf|zip)$/i.test(a.filename || '')
  || /application\/(pdf|zip|x-zip|x-zip-compressed)/i.test(a.mimeType || '');

// ---------------------------------------------------------------------------

const replyTime = (m) => new Date(Number(m.internalDate)).toLocaleString('en-US',
  { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

async function load(ctx) {
  const { store, job, core, gmail } = ctx;
  let documents = [];
  // What a Google Drive link held, or why it could not be read: shown with the run's report.
  const driveNotes = [];
  let msg = null;
  // A REPLY TO HER CORRECTIONS EMAIL is a revision: check the items she asked
  // for and draft the buyer reply (revcheck, revdraft) instead of auditing it
  // as a new package. A replay can preset job.source.revision.
  let revision = job.source.revision || null;
  if (job.source.localFiles) {
    const fs = require('fs');
    const path = require('path');
    documents = job.source.localFiles.map((p) => ({ name: path.basename(p), base64: fs.readFileSync(p).toString('base64') }));
  } else {
    msg = await gmail.getMessage(job.source.messageId);
    let replies = [msg];
    if (!revision && gmail.getThreadMessages) {
      try {
        const thread = await gmail.getThreadMessages(msg.threadId);
        const found = rc.findCorrectionsEmail(thread, msg);
        if (!found) {
          // LATER REPLIES WITH THE FILES (135 S Vendome, 2026-10-28): the label
          // sat on the forwarded acceptance email, and the listing side's
          // disclosures came as a REPLY in the same thread (a Drive link), so the
          // run read only the purchase contract and called every disclosure
          // missing. A later reply from someone else that carries files or a
          // link is read too, unless it carries the label itself (then it is its
          // own run, and reading it here would draft twice).
          const me = String(process.env.GMAIL_IMPERSONATE_SUBJECT || process.env.GOOGLE_IMPERSONATE_SUBJECT || '').trim().toLowerCase();
          const later = laterReplies(thread, msg, me, job.source.labelId);
          if (later.length) {
            replies = [msg, ...later];
            ctx.log(`also reading ${later.length} later reply(ies) in the thread with files or a link: ${later.map((m) => (m.headers && m.headers.from) || m.id).join(', ')}`);
          }
        }
        if (found) {
          const split = rc.splitOurs(found.items);
          revision = { correctionsId: found.msg.id, correctionsDate: (found.msg.headers && found.msg.headers.date) || '', items: split.seller, ours: split.ours };
          // EVERY listing-side reply with files since her corrections email, up
          // to this one: corrections often come in more than one email (12273
          // Donald Reed, 2026-10-23: two emails, one thread), and a re-sent form
          // supersedes the earlier copy (1222 N Kings Rd #8). The check sees
          // them all, each file labelled with its reply's time.
          const since = Number(found.msg.internalDate);
          replies = thread.filter((m) => !(m.labelIds || []).includes('SENT') && Number(m.internalDate) > since
            && Number(m.internalDate) <= Number(msg.internalDate) && (m.attachments || []).some(isPdfOrZip));
          if (!replies.some((m) => m.id === msg.id)) replies.push(msg);
          revision.replies = replies.map((m) => ({ id: m.id, at: Number(m.internalDate) }));
          ctx.log(`revision: answers the corrections email of ${revision.correctionsDate} (${found.items.length} item(s)); ${replies.length} reply(ies) with files since`);
        }
      } catch (err) {
        // Retry the step; on the last try carry on as a new package (the full
        // audit) rather than drop the delivery.
        if (ctx.attempt < J.MAX_ATTEMPTS) throw new Error(`could not read the thread: ${err.message}`);
        ctx.log(`could not read the thread on the last try, auditing as a new package: ${err.message}`);
        replies = [msg];
      }
    }
    for (const m of replies) {
      const label = replies.length > 1 ? `[reply ${replyTime(m)}] ` : '';
      for (const a of (m.attachments || []).filter(isPdfOrZip)) {
        const buf = await gmail.getAttachment(m.id, a.attachmentId);
        documents.push({ name: `${label}${a.filename}`, base64: buf.toString('base64') });
      }
      for (const l of shareLinks(m.bodyHtml, m.bodyText)) {
        if (!l.drive) { documents.push({ ...l, name: `${label}${l.name}` }); continue; }
        // GOOGLE DRIVE: opened as Megan's account; a folder walked like a Dropbox zip.
        const got = await DS.expandDriveLink(l.drive, { maxDocBytes: core.MAX_DOC_BYTES, maxTotalBytes: core.MAX_UNZIP_TOTAL_BYTES, isBlocked: core.isBlockedName })
          .catch((err) => ({ docs: [], notes: [{ name: 'Google Drive link', reason: `could not be read: ${err.message}` }], failed: true }));
        documents.push(...got.docs.map((d) => ({ ...d, name: `${label}${d.name}` })));
        driveNotes.push(...got.notes);
        // A single FILE the account cannot open may still be public: try the direct download.
        if (got.failed && l.drive.kind === 'file') documents.push({ name: `${label}${l.name}`, url: l.url });
        ctx.log(`Google Drive ${l.drive.kind} ${l.drive.id}: ${got.docs.length} file(s) read${got.failed ? ' (could not be opened)' : ''}`);
      }
    }
  }

  const report = [...driveNotes];
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
  // FILES NOT AUDITED ARE STILL KEPT (reports skipped by name, files too large
  // to review), as doc/<id>/x<k>, so the buyer package can be built from the
  // job alone. Not reviewed, not counted in page accounting.
  const extras = [];
  for (const r of report) {
    if (!r.bytes) continue;
    const key = `x${extras.length}`;
    await J.putDoc(store, job.id, key, r.bytes);
    extras.push({ key, name: r.name, bytes: r.bytes.length, reason: r.reason });
  }
  if (extras.length) ctx.log(`kept ${extras.length} file(s) not audited: ${extras.map((e) => e.name).join(', ')}`);
  return (j) => {
    j.docs = meta;
    j.skipped = report.filter((r) => !r.info);
    j.archives = report.filter((r) => r.info);
    j.extras = extras;
    // A share link that could not be opened: the run never saw those files.
    j.linkUnread = driveNotes.filter((n) => !n.info && /could not be (?:opened|read)|could not be listed/.test(n.reason)).map((n) => `${n.name}: ${n.reason}`);
    if (revision && meta.length) j.revision = revision;
    J.addSteps(j, !meta.length ? ['finish'] : (revision ? ['revcheck', 'revdraft'] : ['map', 'plan']));
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
  const lite = batches.map((b) => b.map((d) => ({ n: d._n, skipBooklet: d._skipBookletStatement === true, skipPages: d._skipPages || [] })));
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
    if (b.skipPages && b.skipPages.length) d._skipPages = b.skipPages;
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
    // A DRIVE LINK WE COULD NOT OPEN means the files were never read, so
    // "everything is missing" is wrong: no request goes to the agent; Megan is
    // told why instead (135 S Vendome, 2026-10-28, drafted a 15-item request).
    if (!effects.draft && (job.linkUnread || []).length) {
      await ctx.alert(`intake-link-unread:${job.id}`,
        `${address}: the Google Drive link in the listing side's email could not be opened, so no request was drafted. ${job.linkUnread.join('; ')}. Share it with your account, or download the files and send them to yourself.`);
      effects.draft = 'held: Drive link unread'; await saveEffects();
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
    // The buyer package (lib/package-job.js) runs next and closes the job.
    J.addSteps(j, ['package']);
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

// ---------------------------------------------------------------------------
// REVISIONS (phase 3): the listing side's reply to her corrections email.
// ---------------------------------------------------------------------------

function revisionModel(content) {
  const { callClaude } = require('./claude');
  return callClaude({
    fn: 'disclosure-revision',
    model: process.env.INTAKE_MODEL || 'claude-opus-4-8',
    content,
    maxTokens: 16000,
  });
}

/** Each item of her corrections email, checked by two reads (lib/revision-check.js). */
async function revcheck(ctx) {
  const { store, job } = ctx;
  const files = [];
  for (const d of job.docs) files.push({ n: d.n, name: d.name, pages: d.pages, base64: (await J.getDoc(store, job.id, d.n)).toString('base64') });
  const r = await rc.checkRevisions({ items: job.revision.items, files, callModel: ctx.revisionModel || revisionModel });
  await J.putOut(store, job.id, 'revcheck', r);
  const count = (st) => r.items.filter((v) => v.status === st).length;
  ctx.log(`${count('fixed')} fixed, ${count('open')} open, ${count('unclear')} to check`);
  return null;
}

/**
 * The buyer reply, with the check on top in red. SHADOW: a standalone
 * "[TRIAL]" draft addressed to Megan only (Megan, 2026-10-22), nothing saved
 * to Drive. LIVE: a reply in the package thread to its recipients, the PDF
 * saved beside the package, and the label removed.
 */
async function revdraft(ctx) {
  const { store, job, gmail } = ctx;
  const live = job.mode === 'live';
  const rev = await J.getOut(store, job.id, 'revcheck');
  const effects = (await J.getOut(store, job.id, 'finish-effects')) || {};
  const saveEffects = () => J.putOut(store, job.id, 'finish-effects', effects);
  const address = ctx.canonicalAddress(rev.address || '') || rev.address || '';
  const tally = ['fixed', 'open', 'unclear'].map((st) => rev.items.filter((v) => v.status === st).length);
  const finished = (j) => {
    j.address = address;
    j.status = 'done';
    j.outcome = `revision: ${tally[0]} fixed, ${tally[1]} still open, ${tally[2]} to check`;
  };

  // job.redraft: correct the buyer draft already made, in place (restart tool).
  if (!effects.draft || job.redraft) {
    const pkg = address ? await R.findSentPackage(gmail, address) : null;
    // Purchase-agreement documents never go to the buyers: filed as FX (if
    // their fix came back) and left out of the update (lib/revision-check.js).
    const contractNs = new Set(rev.ordered.filter((f) => rc.contractCode(f)).map((f) => f.n));
    const contractFiled = [];
    const items0 = rev.items.filter((v) => !contractNs.has(v.n));
    const ordered0 = rev.ordered.filter((f) => !contractNs.has(f.n));
    // Package rules inside each file (rc.pagesToSend): no DSDT / BIE / BIW
    // pages, and only the changed pages of a long report (6051 Scenic: the
    // whole NHD report went to the buyer for one signature).
    const sel = new Map(); const pageNotes = [];
    for (const f of ordered0) {
      const fixPages = items0.filter((v) => v.n === f.n && v.page).map((v) => Number(v.page));
      let texts = [];
      try { texts = await ctx.core.pdfPageTexts(await J.getDoc(store, job.id, f.n)); } catch (err) { texts = []; }
      let formPages = null;
      if (rc.needsPageMap(f, texts) && ctx.strips) {
        try {
          const buf = await J.getDoc(store, job.id, f.n);
          const rows = await ctx.strips.readAllStrips(buf, f.pages, f.name);
          formPages = ctx.strips.documentsFromStrips(rows.filter((x) => !x.unread)).map((d) => ({ name: d.title || d.carCode || d.footerName || '', pages: d.pages }));
        } catch (err) { ctx.log(`page map for ${f.name} failed: ${err.message}`); }
      }
      const r = rc.pagesToSend(f, texts, fixPages, formPages);
      sel.set(f.n, r.pages);
      if (r.dropped.length) pageNotes.push(`${String(f.name).replace(/^\[reply [^\]]*\]\s*/, '')}: left out ${r.dropped.join(', ')}.`);
    }
    const ordered = ordered0.map((f) => ({ ...f, pages: sel.get(f.n).length }));
    const items = items0.map((v) => (v.n != null && sel.has(v.n) && v.page && sel.get(v.n).includes(Number(v.page))
      ? { ...v, page: sel.get(v.n).indexOf(Number(v.page)) + 1 } : v));
    // Only the files that carry a fix go to the buyer (Megan, 2026-10-22).
    const plan = rc.attachmentPlan(items, ordered);
    const fileBytes = async (f) => {
      const buf = await J.getDoc(store, job.id, f.n);
      const want = sel.get(f.n);
      return want.length === rev.ordered.find((x) => x.n === f.n).pages ? buf : R.pickPages(buf, want, { render: ctx.core.renderPagesAsImages });
    };
    let pdf = await R.mergePdfs(await Promise.all(plan.attached.map(fileBytes)), {
      render: ctx.core.renderPagesAsImages, pageCount: ctx.core.pdfPageCount, names: plan.attached.map((f) => f.name),
    });
    // THE SAME BLANK-PAGE NET AS THE PACKAGE (2506 Westminster, 2026-10-26: all
    // 11 merged pages came out blank while the originals read fine). Every page
    // is rendered; a blank one whose original is not is rebuilt from an image
    // of the original, and a page still blank after that is said loudly.
    const blankNotes = []; const blankProblems = [];
    try {
      const sources = [];
      plan.attached.forEach((f, i) => { for (let p = 1; p <= pdf.parts[i]; p++) sources.push({ src: { type: 'file', n: f.n }, page: (sel.get(f.n) || [])[p - 1] || p, label: f.name }); });
      const deps = {
        render: ctx.core.renderPagesAsImages, pageCount: ctx.core.pdfPageCount, pageTexts: ctx.core.pdfPageTexts,
        getBytes: (src) => J.getDoc(store, job.id, src.n),
      };
      const texts = new Map();
      const textOf = async (src, page) => {
        if (!texts.has(src.n)) texts.set(src.n, await ctx.core.pdfPageTexts(await deps.getBytes(src)));
        return ((texts.get(src.n) || []).find((t) => t.num === page) || {}).text || '';
      };
      const r = await A.checkAndRepair({ bytes: pdf.bytes, pages: pdf.pages, sources }, deps, textOf, 'revised PDF', blankNotes, blankProblems);
      pdf = { ...pdf, bytes: r.built.bytes };
      if (!r.checked) blankNotes.push('The blank-page check could not run: open the revised PDF and look before sending.');
    } catch (err) {
      blankNotes.push(`The blank-page check failed (${err.message}): open the revised PDF and look before sending.`);
    }
    // LOCAL AREA DISCLOSURES FROM OUR OWN PACKAGE when still open and the form
    // asks the seller nothing (lib/revision-local.js; Megan 2026-10-26/27).
    const localNotes = [];
    let localAdded = [];
    const lc = RL.localItems(rev.items);
    if (live && address && lc.ours.length) {
      try {
        const got = await RL.fromOurPackage(address, {
          drive: ctx.drive, findDealFolder: R.findDealFolder, pageTexts: ctx.core.pdfPageTexts, strips: ctx.strips,
          pickPages: R.pickPages, render: ctx.core.renderPagesAsImages, pageCount: ctx.core.pdfPageCount,
        });
        if (got.bytes) {
          const start = pdf.pages + 1;
          const merged = await R.mergePdfs([pdf.bytes, got.bytes], { render: ctx.core.renderPagesAsImages, pageCount: ctx.core.pdfPageCount, names: ['revised pages', 'local area disclosures'] });
          pdf = { ...pdf, bytes: merged.bytes, pages: merged.pages };
          localAdded = lc.ours.map((v) => ({ ...v, status: 'fixed', n: null, mergedPage: start, buyerLine: RL.buyerLine(v.item), addedByUs: true }));
          localNotes.push(`Added the local area disclosures ourselves from ${got.source} (the listing side has not sent them): pages ${start}-${pdf.pages}, check the address on page ${start}.`);
        } else {
          localNotes.push(`The local area disclosures are still open and ours could not be added: ${got.why}.`);
        }
      } catch (err) {
        localNotes.push(`The local area disclosures are still open and ours could not be added: ${err.message}.`);
      }
    }
    if (lc.theirs.length) localNotes.push(`${lc.theirs.map((v) => v.item).join(', ')}: the seller fills this one in, so it stays a request to the listing side.`);
    effects.localAdded = localAdded.map((v) => v.item);
    const verdicts = plan.verdicts.map((v) => localAdded.find((a) => a.item === v.item) || v);
    const inputs = rc.emailInputs(verdicts, plan.attached);
    const greeting = pkg ? rc.greetingFrom(pkg.original) : '';
    const built = buildRevisionEmail({ greeting, ...inputs, totalPages: pdf.pages });
    const notes = [];
    let banner = '';
    // Several replies with revisions in one thread (1222 N Kings Rd #8: a 3:17
    // reply with one seller's signature, a 3:39 reply signed by both). Megan:
    // the older draft says it is superseded; a newer one says what it replaces.
    try {
      const sentAt = Number(job.source.receivedAt || 0);
      const deliveries = (await gmail.getThreadMessages(job.source.threadId))
        .filter((m) => !(m.labelIds || []).includes('SENT') && m.id !== job.source.messageId
          && Number(m.internalDate) > Date.parse(job.revision.correctionsDate || 0) && (m.attachments || []).some(isPdfOrZip));
      const when = (m) => new Date(Number(m.internalDate)).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      const later = deliveries.filter((m) => Number(m.internalDate) > sentAt);
      const earlier = deliveries.filter((m) => Number(m.internalDate) < sentAt);
      if (later.length) banner = `SUPERSEDED: a later reply with revisions arrived (${later.map(when).join(', ')}). Its draft checks every reply together; use that one, not this.`;
      else if (earlier.length) notes.push(`This checks every reply since your corrections email together (${[...earlier, { internalDate: sentAt }].map(when).join(', ')}); it replaces any draft made for the earlier one${earlier.length > 1 ? 's' : ''}.`);
    } catch (err) {
      ctx.log(`could not compare with other replies in the thread: ${err.message}`);
    }
    notes.push(greeting ? `Greeting copied from your package email ("${greeting}").` : 'No greeting was found in your package email; add one.');
    notes.push('Only the items in your corrections email were checked; a new form in this delivery was not audited.');
    if ((job.revision.ours || []).length) notes.push(`Yours to add (you said so in your email, not checked and not in the buyer email): ${job.revision.ours.join('; ')}.`);
    if (plan.left.length) notes.push(`Not attached (no fix in them): ${plan.left.map((f) => f.name).join(', ')}.`);
    if (live && address && contractNs.size) {
      const deal = await R.findDealFolder(ctx.drive, address);
      for (const f of rev.ordered.filter((x) => contractNs.has(x.n))) {
        const code = rc.contractCode(f);
        const fixed = rev.items.some((v) => v.n === f.n && v.status === 'fixed');
        if (code === 'COUNTER' || !fixed) continue;
        const name = `FX - ${code}.pdf`;
        if (await R.saveToDealFolder(ctx.drive, deal, name, await J.getDoc(store, job.id, f.n))) contractFiled.push(name);
      }
    }
    for (const f of rev.ordered.filter((x) => contractNs.has(x.n))) {
      const code = rc.contractCode(f);
      const filed = contractFiled.find((n) => n === `FX - ${code}.pdf`);
      notes.push(code === 'COUNTER'
        ? `${f.name} is a counter offer: not sent to the buyers, it is yours to handle.`
        : `${f.name} is a purchase-agreement document: not sent to the buyers${filed ? `; saved in the deal folder as "${filed}", tick it on the compliance list` : '; file it if it is fully signed'}.`);
    }
    notes.push(...pageNotes, ...localNotes);
    notes.push(...blankNotes);
    if (blankProblems.length) notes.push(`DO NOT SEND AS IS: ${blankProblems.join('; ')}.`);
    if (pdf.rebuilt.length) notes.push(`Damaged file(s) rebuilt as page images so they could be attached: ${pdf.rebuilt.join(', ')}. Check they read clearly.`);
    if (!address) notes.push('The property address could not be read from the revised forms.');
    else if (!pkg) notes.push(`No sent "Seller Disclosure Package" email was found for ${address}, so this is not in the buyer thread and has no recipients.`);
    if (built.warnings.length) notes.push(`The buyer email was not written: ${built.warnings.join('; ')}.`);
    const note = rc.checkNoteHtml({ verdicts: verdicts.concat(rev.items.filter((v) => contractNs.has(v.n))), correctionsDate: job.revision.correctionsDate, extra: notes, banner });
    const html = ctx.signature.withSignature(note + (built.html || ''), await ctx.signature.liveSignature(gmail));
    // Named like her deal folder: the address read from the forms can drop
    // the "St" (20701 Schoolcraft, 2026-10-26).
    const dealForName = live && address ? await R.findDealFolder(ctx.drive, address).catch(() => null) : null;
    const pdfName = `Revised Disclosures - ${(dealForName && dealForName.folder && dealForName.folder.name) || address || 'unknown address'}.pdf`;

    let d;
    if (live) {
      if (address) {
        const deal = dealForName || await R.findDealFolder(ctx.drive, address);
        effects.savedToDrive = await R.saveToDealFolder(ctx.drive, deal, pdfName, pdf.bytes);
      }
      d = await R.createRevisionDraft(gmail, {
        pkg, html, pdfName, pdfBytes: pdf.bytes, labels: ['Buyer Disclosures', 'Edelyn'],
        inThread: !!(pkg && built.html), to: '', replaceDraftId: job.redraft && effects.draft && effects.draft !== 'created' ? effects.draft : '',
      });
    } else {
      const me = String(process.env.GMAIL_IMPERSONATE_SUBJECT || process.env.GOOGLE_IMPERSONATE_SUBJECT || '').trim();
      const labels = String(process.env.INTAKE_TRIAL_LABELS || 'Megan,Edelyn').split(',').map((x) => x.trim()).filter(Boolean);
      d = await R.createRevisionDraft(gmail, {
        pkg, html, pdfName, pdfBytes: pdf.bytes, labels, inThread: false, to: me, subjectPrefix: '[TRIAL] ',
      });
    }
    effects.draft = d.draftId || 'created';
    await saveEffects();
    await J.putOut(store, job.id, 'revdraft', { draftId: d.draftId, headers: d.headers, labelled: d.labelled, pdfName, pdfPages: pdf.pages, warnings: built.warnings, notes });
  }
  // THE FOLLOW-UP TO THE LISTING SIDE for what is still open, as a reply in
  // their thread to the people her corrections email went to. Its own effect
  // key, so a re-run that already made the buyer draft makes only this.
  if (!effects.followUp) {
    const open = rev.items.filter((v) => v.status === 'open' && !(effects.localAdded || []).includes(v.item)).map((v) => v.item);
    if (!open.length) {
      effects.followUp = 'nothing open';
    } else {
      const corr = await gmail.getMessage(job.revision.correctionsId).catch(() => null);
      const ch = (corr && corr.headers) || {};
      const html = ctx.signature.withSignature(rc.followUpHtml({ greeting: corr ? rc.greetingFrom(corr) : '', open }),
        await ctx.signature.liveSignature(gmail));
      const subject = `Re: ${String(job.source.subject || '').replace(/^\s*(re:\s*)+/i, '')}`;
      const me = String(process.env.GMAIL_IMPERSONATE_SUBJECT || process.env.GOOGLE_IMPERSONATE_SUBJECT || '').trim();
      const headers = live
        ? { To: ch.to || job.source.from, Cc: ch.cc || '', Subject: subject, 'In-Reply-To': job.source.rfcMessageId, References: job.source.rfcMessageId }
        : { To: me, Subject: `[TRIAL] ${subject}` };
      const created = await gmail.createDraftRaw(buildMime({ headers, html }), live ? { threadId: job.source.threadId } : {});
      effects.followUp = (created && created.id) || 'created';
      ctx.log(`follow-up to the listing side drafted: ${open.length} open item(s)`);
    }
    await saveEffects();
  }
  if (live && !effects.label) { await removeLabel(ctx); effects.label = Date.now(); await saveEffects(); }
  return finished;
}

/*
  THE LABEL COMES OFF THE WHOLE CONVERSATION (Megan, 2026-10-29: "I add the
  label on what I need, you do your work, and then unlabel it. if its unlabeled
  then a new email in that thread shouldnt get accidentally audited"). Labelling
  a conversation in Gmail labels every email in it; taking it off only the one
  audited left the rest labelled (1826 W. 78th had four), each a later audit
  waiting to happen.
*/
async function removeLabel(ctx) {
  const { job, gmail } = ctx;
  if (!job.source.labelId || !gmail) return;
  if (job.source.threadId && gmail.modifyThread) {
    try { await gmail.modifyThread(job.source.threadId, { remove: [job.source.labelId] }); return; }
    catch (err) { ctx.log && ctx.log(`could not unlabel the conversation (${err.message}); unlabelling the email`); }
  }
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
    case 'package': return require('./package-job').packageStep(ctx);
    case 'revcheck': return revcheck(ctx);
    case 'revdraft': return revdraft(ctx);
    default: throw new Error(`unknown step ${name}`);
  }
}

module.exports = { run, shareLinks, isPdfOrZip, laterReplies };
