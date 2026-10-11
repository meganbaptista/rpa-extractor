// netlify/functions/scoreboard.js
//
// POST  -> start a fresh day-0 scoreboard run (scoreboard-background) and
//          answer at once. Read-only, no model: safe to call.
// GET   -> when the last run finished and whether it failed. The board itself
//          (addresses, dates) is read by Keeva from the 'scoreboard' store and
//          shown behind the team login; this site has no login, so it never
//          serves the board.

'use strict';

const { getStore } = require('@netlify/blobs');

function blobsConfig(name) {
  const siteID = process.env.BLOBS_SITE_ID || process.env.SITE_ID;
  const token = process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_API_TOKEN;
  return siteID && token ? { name, siteID, token } : { name };
}

exports.handler = async function (event) {
  const headers = { 'content-type': 'application/json', 'access-control-allow-origin': '*' };
  if (event.httpMethod === 'POST') {
    const base = process.env.URL || `https://${event.headers.host}`;
    await fetch(`${base}/.netlify/functions/scoreboard-background`, { method: 'POST' }).catch(() => {});
    return { statusCode: 202, headers, body: JSON.stringify({ started: true }) };
  }
  const store = getStore(blobsConfig('scoreboard'));
  const [latest, failed] = await Promise.all([
    store.get('latest', { type: 'json' }).catch(() => null),
    store.get('latest-error', { type: 'json' }).catch(() => null),
  ]);
  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      lastRun: latest ? latest.generatedAt : null,
      intros: latest ? latest.intros : 0,
      paired: latest ? latest.paired : 0,
      lastError: failed && (!latest || failed.at > latest.generatedAt) ? failed : null,
    }),
  };
};
