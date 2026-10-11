// netlify/functions/lib/keeva-alerts.js
//
// "NEW ESCROW READY", INTO KEEVA'S BELL (Keeva Notes phase 3, 2026-10-11).
// Megan: "when Belle puts a new escrow into the RPA-extractor it notifies
// jill once its ready to push into a new transaction" - a Slack bot post until
// now. Written straight into Keeva's notification store for whoever Keeva's
// "Who hears about what" routes it to (Jill by default), using this site's
// token, which reaches Keeva's store (Keeva's does not reach this one).
//
// Only for packets uploaded HERE: a contract read during Keeva's own Create
// Transaction (source 'keeva') already has a TC creating the deal.
// Never fatal: an extraction never fails because a bell could not ring.

'use strict';

const { getStore } = require('@netlify/blobs');
const crypto = require('crypto');

const KEEVA_SITE = () => process.env.KEEVA_SITE_ID || '85bb6dba-d5dc-4f6e-83db-6603cfbca323';
const DEFAULT_ROUTES = { 'new-escrow-ready': ['jill'] };
const BELL_LIMIT = 200;

function keevaStore(name) {
  const token = process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_API_TOKEN;
  return token ? getStore({ name, siteID: KEEVA_SITE(), token }) : null;
}

/** Who hears about a new escrow, per Keeva's setting. */
async function routedTo() {
  const s = keevaStore('keeva-alert-routes');
  if (!s) return [];
  const saved = await s.get('routes', { type: 'json' }).catch(() => null);
  return (saved && saved['new-escrow-ready']) || DEFAULT_ROUTES['new-escrow-ready'];
}

async function notifyNewEscrow(fields) {
  try {
    const bell = keevaStore('keeva-notifications');
    if (!bell) return;
    const address = String((fields && fields.property_address) || '').trim();
    const buyers = String((fields && fields.buyer_names) || '').trim();
    const users = await routedTo();
    const at = new Date().toISOString();
    await Promise.all(users.map(async (user) => {
      const key = `user/${user}`;
      const list = (await bell.get(key, { type: 'json' }).catch(() => null)) || [];
      const n = {
        id: crypto.randomUUID(),
        kind: 'event',
        transactionId: '',
        address,
        noteId: '',
        fromName: 'RPA extractor',
        title: 'New escrow ready',
        excerpt: `${address || 'A new contract'} is read and ready to create${buyers ? ` (buyers: ${buyers})` : ''}.`,
        at,
        href: '/transactions',
      };
      await bell.setJSON(key, [n, ...list].slice(0, BELL_LIMIT));
    }));
    console.log('[keeva-alerts] new escrow ready -> ' + users.join(', '));
  } catch (err) {
    console.warn('[keeva-alerts] could not ring the bell: ' + err.message);
  }
}

module.exports = { notifyNewEscrow };
