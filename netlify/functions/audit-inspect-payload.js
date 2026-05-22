// netlify/functions/audit-inspect-payload.js
//
// ============================================================================
// TEMPORARY READ-ONLY DIAGNOSTIC FUNCTION — delete after the signature-audit
// confabulation bug is isolated.
// ============================================================================
// Reads the assembled audit payload blob — the exact PDF bytes that
// audit-background.js feeds into the Anthropic `document` block — and reports
// truncation indicators.
//
// It does NOT write or delete any blob. It does NOT call the Anthropic API.
// It does NOT modify any other function. It only reads.
//
// ----------------------------------------------------------------------------
// USAGE (GET — just open the URL in a browser):
//
//   Inspect a payload:
//     /.netlify/functions/audit-inspect-payload?jobId=YOUR_JOB_ID
//
//   Find a jobId (lists stored payload keys):
//     /.netlify/functions/audit-inspect-payload?list=1
//
//   Byte-exact comparison to the original contract PDF:
//     /.netlify/functions/audit-inspect-payload?jobId=YOUR_JOB_ID&expectedMd5=...&expectedSize=...
//
// ----------------------------------------------------------------------------
// To get expectedMd5 / expectedSize of the original contract PDF — no repo
// clone needed, just run this on the machine that has the PDF:
//
//   Windows : certutil -hashfile "C:\path\to\contract.pdf" MD5
//             (size: right-click > Properties, "Size", in bytes)
//   Mac     : md5 contract.pdf        and        stat -f %z contract.pdf
//   Linux   : md5sum contract.pdf     and        stat -c %s contract.pdf
//
// Passing the md5 + size (the file's fingerprint) is deliberate — uploading the
// whole PDF through this endpoint would hit the same ~4.5 MB synchronous-body
// limit that forced the chunked-upload architecture in the first place. The
// md5 is a complete byte-identity check at a few dozen characters.
// ============================================================================

const { getStore } = require('@netlify/blobs');
const { PDFDocument } = require('pdf-lib');
const crypto = require('crypto');

function blobsConfig(name) {
  return {
    name,
    siteID: process.env.SITE_ID || process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_BLOBS_TOKEN,
  };
}

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
};

function json(statusCode, obj) {
  return { statusCode, headers, body: JSON.stringify(obj, null, 2) };
}

async function pageCount(buf) {
  try {
    const doc = await PDFDocument.load(buf, {
      ignoreEncryption: true,
      updateMetadata: false,
    });
    return doc.getPageCount();
  } catch (e) {
    return `UNREADABLE BY pdf-lib (${e.message})`;
  }
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  if (!process.env.NETLIFY_BLOBS_TOKEN || !(process.env.SITE_ID || process.env.NETLIFY_SITE_ID)) {
    return json(500, { error: 'Missing NETLIFY_BLOBS_TOKEN or SITE_ID / NETLIFY_SITE_ID env vars.' });
  }

  const params = event.queryStringParameters || {};

  // ----- list mode: enumerate stored payload keys so you can find the jobId.
  if (params.list) {
    const out = {};
    for (const storeName of ['audit-payloads', 'extraction-payloads']) {
      try {
        const store = getStore(blobsConfig(storeName));
        const { blobs } = await store.list();
        out[storeName] = blobs.map((b) => b.key);
      } catch (e) {
        out[storeName] = `ERROR: ${e.message}`;
      }
    }
    return json(200, { mode: 'list', stores: out });
  }

  const jobId = params.jobId;
  if (!jobId) {
    return json(400, { error: 'Missing jobId. Use ?jobId=YOUR_JOB_ID, or ?list=1 to see available keys.' });
  }

  // ----- retrieve the payload: audit-payloads first (what audit-background.js
  //       actually reads), then extraction-payloads as a fallback.
  let payload = null;
  let sourceStore = null;
  for (const storeName of ['audit-payloads', 'extraction-payloads']) {
    try {
      const store = getStore(blobsConfig(storeName));
      const got = await store.get(jobId, { type: 'json' });
      if (got) { payload = got; sourceStore = storeName; break; }
    } catch (e) {
      // try the next store
    }
  }
  if (!payload) {
    return json(404, {
      error: `No blob found for jobId=${jobId} in audit-payloads or extraction-payloads.`,
      hint: 'If the run is old the payload may already be deleted. Re-run the contract through the pipeline and use the fresh jobId, or try ?list=1.',
    });
  }

  const rawData = payload.documents && payload.documents[0] && payload.documents[0].data;
  if (typeof rawData !== 'string') {
    return json(422, { error: 'Blob found but documents[0].data is missing or not a string.', sourceStore });
  }

  // ----- detect a stray data-URI prefix (its presence is itself a bug).
  const hasPrefix = rawData.startsWith('data:');
  const b64 = hasPrefix ? rawData.slice(rawData.indexOf(',') + 1) : rawData;

  // ----- decode + structural checks.
  const buf = Buffer.from(b64, 'base64');
  const head = buf.slice(0, 8).toString('latin1');
  const tail = buf.slice(-1024).toString('latin1'); // %%EOF sits in the last bytes
  const startsPDF = head.startsWith('%PDF-');
  const endsEOF = tail.includes('%%EOF');
  const pages = await pageCount(buf);
  const md5 = crypto.createHash('md5').update(buf).digest('hex');

  const report = {
    mode: 'inspect',
    jobId,
    sourceStore, // 'extraction-payloads' here (not 'audit-payloads') hints the orchestrator copy never ran.
    payload: {
      base64Chars: rawData.length,
      dataUriPrefix: hasPrefix
        ? 'PRESENT — BUG: a data: URI prefix should have been stripped before storage'
        : 'none',
      decodedBytes: buf.length,
      decodedMB: (buf.length / 1048576).toFixed(2),
      startsWithPdfHeader: startsPDF,
      endsWithEOF: endsEOF,
      pageCount: pages,
      md5,
    },
    truncationIndicators: [],
    verdict: '',
  };

  if (!startsPDF) {
    report.truncationIndicators.push('Decoded data does not start with %PDF- — not a valid PDF header.');
  }
  if (!endsEOF) {
    report.truncationIndicators.push('No %%EOF near the end of the file — the tail is missing (TRUNCATED).');
  }
  if (typeof pages === 'string') {
    report.truncationIndicators.push('pdf-lib could not parse the PDF — likely corrupt or truncated.');
  }

  // ----- optional byte-exact comparison against the original.
  if (params.expectedMd5 || params.expectedSize) {
    const cmp = {};
    if (params.expectedMd5) {
      cmp.expectedMd5 = params.expectedMd5;
      cmp.md5Match = md5.toLowerCase() === params.expectedMd5.toLowerCase();
    }
    if (params.expectedSize) {
      const exp = parseInt(params.expectedSize, 10);
      cmp.expectedSize = exp;
      cmp.sizeMatch = buf.length === exp;
      cmp.byteDifference = buf.length - exp;
    }
    report.comparisonToOriginal = cmp;
  }

  // ----- verdict.
  const cmp = report.comparisonToOriginal;
  if (cmp && cmp.md5Match === true) {
    report.verdict =
      'DELIVERY PROVEN CLEAN — the payload is byte-identical to the original. ' +
      'The confabulation bug is NOT PDF delivery. It is the prompt and/or the model+thinking config.';
  } else if (cmp && cmp.md5Match === false) {
    report.verdict =
      'DELIVERY BROKEN — payload md5 does not match the original. ' +
      'The chunk-upload/assembly path is corrupting the file. The prompt is not the issue.';
  } else if (report.truncationIndicators.length > 0) {
    report.verdict =
      'DELIVERY LIKELY BROKEN — truncation indicators present (see truncationIndicators). ' +
      'The chunk-upload/assembly path is dropping data.';
  } else {
    report.verdict =
      `No truncation indicators — the payload is a well-formed ` +
      `${typeof pages === 'number' ? pages + '-page ' : ''}PDF that decodes cleanly. ` +
      `If pageCount and decodedBytes match the original, delivery is effectively clean. ` +
      `Add &expectedMd5=...&expectedSize=... for a byte-exact confirmation.`;
  }

  return json(200, report);
};
