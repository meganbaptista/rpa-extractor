// netlify/functions/disclosure-email-background.js
//
// ============================================================================
// DRAFTS THE REPLY TO THE COORDINATOR WHO SENT THE DISCLOSURES.
// ============================================================================
// The thing Megan actually asked for on day one: "My employee is leaving
// emails from 5-days ago just unanswered so we need to automate it." Every
// other consumer in this pipeline files, audits and reconciles. This one
// answers the email.
//
// A DRAFT, NEVER A SEND. Megan's call, and the right one for a letter going to
// another firm under her name. She presses send.
//
// THE THREAD IS FOUND BY LABEL, not by guessing. The pipeline is triggered by
// a FILE appearing in Drive and has no idea which email brought it, and
// searching the mailbox for a property address is guesswork - a subject line
// might read "902 Beverly Glen", "1333 S. Beverly Glen #902" or nothing at
// all. Megan: "Maybe we label the email something that claude can find that
// thread?" A label is a definite statement, made by the person who knows. The
// address only picks between threads that already carry it.
//
// WHAT IT SAYS is her own compliance checklist, verbatim - see
// lib/disclosure-reply.js for why two earlier versions were wrong.
//
// DISABLED BY DEFAULT in lib/consumers.js. Turning it on drafts mail about
// real deals to real people, so that is her switch to flip.
// ============================================================================

const { getStore } = require('@netlify/blobs');
const { EVENTS } = require('./lib/events');
const { parseRequestBody } = require('./lib/parse-body');
const { alert } = require('./lib/alert');
const gmail = require('./lib/gmail');
const { buildReply } = require('./lib/disclosure-reply');
const { withSignature } = require('./lib/signature');

const DONE_STORE = 'disclosure-email-done';

/**
 * The Gmail label that marks an incoming disclosure thread.
 *
 * Megan's, 2026-09-24: "How about 'FX Disclosures' for the label?" Defaulted
 * rather than left blank so there is nothing to configure, with the env var
 * kept as an override in case she renames it.
 */
const DEFAULT_THREAD_LABEL = 'FX Disclosures';
function threadLabel() {
  return String(process.env.DISCLOSURE_THREAD_LABEL || DEFAULT_THREAD_LABEL).trim();
}

function blobsConfig(name) {
  const siteID = process.env.BLOBS_SITE_ID || process.env.SITE_ID;
  const token = process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_API_TOKEN;
  return siteID && token ? { name, siteID, token } : { name };
}

exports.handler = async function (event) {
  const parsed = parseRequestBody(event);
  if (!parsed.ok) {
    console.error(`[disclosure-email] invalid request body - ${parsed.diagnostic}`);
    return { statusCode: 400 };
  }
  const envelope = parsed.body;
  if (envelope.event && envelope.event !== EVENTS.COMPLIANCE_RECONCILED) {
    console.log(`[disclosure-email] ignoring event type ${envelope.event}`);
    return { statusCode: 200 };
  }

  const address = String(envelope.address || '').trim();
  const eventId = envelope.id || '';
  const outstanding = Array.isArray(envelope.outstanding) ? envelope.outstanding : [];
  if (!address) {
    console.error('[disclosure-email] no address on the event');
    return { statusCode: 400 };
  }

  try {
    /** Idempotent, so a re-delivered event does not leave two drafts. */
    const done = getStore(blobsConfig(DONE_STORE));
    if (eventId && (await done.get(eventId, { type: 'json' }).catch(() => null))) {
      console.log(`[disclosure-email] already drafted for ${eventId}, skipping`);
      return { statusCode: 200 };
    }

    const label = threadLabel();
    const thread = await gmail.findLabelledThread(label, address).catch((err) => {
      console.warn(`[disclosure-email] thread lookup failed: ${err.message}`);
      return null;
    });

    const reply = buildReply({
      address,
      outstanding,
      senderName: (thread && thread.senderName) || '',
      unsortedPages: (envelope.coverage && envelope.coverage.unsortedPages) || [],
      outOfSequence: (envelope.coverage && envelope.coverage.outOfSequence) || [],
    });

    /**
     * A DRAFT IS STILL CREATED WHEN NO THREAD IS FOUND, with no recipient.
     *
     * The alternative is silence, and silence is the problem this consumer
     * exists to fix. An unaddressed draft sitting in her drafts folder is
     * something she can address in five seconds; a consumer that quietly did
     * nothing is five more days of an unanswered email.
     */
    const draft = await gmail.createDraft({
      to: thread ? thread.from : '',
      subject: thread && thread.subject ? `Re: ${thread.subject}` : reply.subject,
      htmlBody: withSignature(reply.htmlBody),
      threadId: thread ? thread.threadId : '',
      inReplyTo: thread ? thread.messageId : '',
    });

    console.log(`[disclosure-email] drafted reply for ${address}: ${reply.asks} open line(s), `
      + (thread ? `in thread ${thread.threadId} to ${thread.from}` : 'NO THREAD FOUND, draft has no recipient'));

    if (eventId) {
      await done.setJSON(eventId, {
        at: new Date().toISOString(),
        draftId: draft && draft.id,
        threadFound: !!thread,
        openLines: reply.asks,
      });
    }

    /**
     * ONE ALERT, AND ONLY FOR THE CASE SHE HAS TO FIX: a draft she cannot find
     * because it is not in a thread. A draft that landed correctly needs no
     * email about it - the draft IS the notification, sitting in her drafts
     * folder. Same rule as the compliance write.
     */
    if (!thread) {
      await alert(`disclosure-email-no-thread:${address}`,
        `Drafted the disclosure reply for ${address}, but could not find a labelled email thread for `
        + `it, so the draft has no recipient and is not in a conversation. `
        + `Check that the incoming email is labelled "${label}" and mentions the street number `
        + 'and street name.',
        { source: 'disclosure-pipeline', label: 'Disclosure Pipeline' });
    }

    return { statusCode: 200 };
  } catch (err) {
    console.error('[disclosure-email] ERROR:', err.message);
    await alert(`disclosure-email-failed:${address}`,
      `Could not draft the disclosure reply for ${address}: ${err.message}`,
      { source: 'disclosure-pipeline', label: 'Disclosure Pipeline' });
    return { statusCode: 500 };
  }
};

module.exports._internal = { threadLabel, DEFAULT_THREAD_LABEL };
