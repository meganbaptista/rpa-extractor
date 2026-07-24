// netlify/functions/lib/claude.js
//
// Shared Anthropic transport for the disclosure / audit family of functions.
//
// WHY THIS EXISTS: every function had its own copy of callClaude, and every copy
// was NON-STREAMING and retried only HTTP 429/529. A non-streaming request whose
// generation runs past ~300s trips undici's headersTimeout (no first byte yet) and
// `fetch` THROWS "fetch failed" — a thrown error the 429/529 branch never sees, so
// the whole multi-minute run died. Proven on disclosure-intake (a heavy answer-review
// pass). This module fixes it in ONE place so the copies can't drift again:
//   - STREAM the response, so continuous token flow keeps the socket alive regardless
//     of how long the generation takes (headers arrive at once; only the sub-second
//     gaps between chunks are timed).
//   - RETRY thrown network errors (fetch failed / ECONNRESET / mid-stream socket drop)
//     with backoff, in addition to the existing 429/529 handling.
//
// Cost is unchanged: streaming bills identical tokens. effort is per-call so mechanical
// calls (page classify, list reconcile) can pass 'medium' while the quality-critical
// reads stay 'high'.
// ----------------------------------------------------------------------------

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const usageLog = require('./usage-log');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Read an Anthropic SSE stream to completion: accumulate the text, the final
// stop_reason, and the usage totals (input/cache from message_start, final
// output_tokens from message_delta). Thinking deltas (display:'omitted') are ignored.
async function readClaudeStream(response) {
  let text = '';
  let stopReason = null;
  let usage = {};
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;               // skip "event:" lines and blanks
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let evt;
      try { evt = JSON.parse(payload); } catch { continue; }
      if (evt.type === 'message_start' && evt.message && evt.message.usage) {
        usage = { ...evt.message.usage };
      } else if (evt.type === 'content_block_delta' && evt.delta && evt.delta.type === 'text_delta') {
        text += evt.delta.text;
      } else if (evt.type === 'message_delta') {
        if (evt.delta && evt.delta.stop_reason) stopReason = evt.delta.stop_reason;
        if (evt.usage) usage = { ...usage, ...evt.usage };
      } else if (evt.type === 'error') {
        throw new Error(`Claude stream error: ${JSON.stringify(evt.error)}`);
      }
    }
  }
  return { text, stopReason, usage };
}

// Stream one Anthropic message call and return the concatenated text.
// opts:
//   fn             - usage-ledger label (also the default log prefix). Required for logging.
//   model          - model id (each caller passes its own MODEL constant)
//   content        - the user message content (string blocks array)
//   maxTokens      - default 16000
//   effort         - 'high' (default) | 'medium' | 'low'; per-call reasoning budget
//   thinking       - default adaptive/omitted
//   note           - extra ledger note
//   maxTokensError - message thrown when the response is truncated at max_tokens
//   logTag         - console prefix (defaults to fn)
//   attempt        - internal (retry counter)
async function callClaude(opts) {
  const {
    fn,
    model,
    content,
    maxTokens = 16000,
    effort = 'high',
    thinking = { type: 'adaptive', display: 'omitted' },
    note = '',
    maxTokensError = 'Output hit max_tokens — raise the ceiling and re-run.',
    logTag = fn || 'claude',
    attempt = 0,
  } = opts;
  const MAX_RETRIES = 4;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY env var not set');

  let response;
  try {
    response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        thinking,
        output_config: { effort },
        stream: true,
        messages: [{ role: 'user', content }],
      }),
    });
  } catch (err) {
    // Network-level failure ("fetch failed", ECONNRESET, headers/socket timeout). No response
    // ever came back, so the 429/529 branch below can never see it — retry it here.
    if (attempt < MAX_RETRIES) {
      const delay = Math.min(1000 * Math.pow(2, attempt), 30000);
      console.log(`[${logTag}] fetch error "${err.message}" — retrying in ${delay}ms (${attempt + 1}/${MAX_RETRIES})`);
      await sleep(delay);
      return callClaude({ ...opts, attempt: attempt + 1 });
    }
    throw new Error(`Claude API fetch failed after ${MAX_RETRIES + 1} attempts: ${err.message}`);
  }

  if ((response.status === 429 || response.status === 529) && attempt < MAX_RETRIES) {
    const retryAfter = response.headers.get('retry-after');
    const delay = retryAfter ? Math.min(parseFloat(retryAfter) * 1000, 30000) : Math.min(1000 * Math.pow(2, attempt), 30000);
    console.log(`[${logTag}] ${response.status}, retrying in ${delay}ms (${attempt + 1}/${MAX_RETRIES})`);
    await sleep(delay);
    return callClaude({ ...opts, attempt: attempt + 1 });
  }
  if (!response.ok) throw new Error(`Claude API error ${response.status}: ${await response.text()}`);

  // The stream can also throw mid-flight if the socket drops. Treat that like any other
  // transient fetch failure and retry the whole call rather than failing the run.
  let result;
  try {
    result = await readClaudeStream(response);
  } catch (err) {
    if (attempt < MAX_RETRIES) {
      const delay = Math.min(1000 * Math.pow(2, attempt), 30000);
      console.log(`[${logTag}] stream error "${err.message}" — retrying in ${delay}ms (${attempt + 1}/${MAX_RETRIES})`);
      await sleep(delay);
      return callClaude({ ...opts, attempt: attempt + 1 });
    }
    throw new Error(`Claude API stream failed after ${MAX_RETRIES + 1} attempts: ${err.message}`);
  }

  // Ledger BEFORE the truncation guard: a max_tokens response is billed in full
  // (thinking tokens included) and then throws, so logging after the guard would make
  // the most expensive failures the invisible ones.
  if (fn) await usageLog.logUsage({ fn, model, effort, usage: result.usage, note });
  if (result.stopReason === 'max_tokens') throw new Error(maxTokensError);
  return result.text;
}

module.exports = { callClaude, readClaudeStream };
