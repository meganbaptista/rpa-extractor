// checks/lib/memory-store.js
//
// An in-memory stand-in for a Netlify Blobs store, with the parts the intake
// job relies on: etags, conditional writes (onlyIfMatch / onlyIfNew), binary
// values and prefix listing. Used by checks/intake-job.js and the local replay.

function memoryStore() {
  const data = new Map();   // key -> { value, etag }
  let n = 0;
  const etag = () => `"e${++n}"`;
  const conditionOk = (key, opts = {}) => {
    const cur = data.get(key);
    if (opts.onlyIfNew && cur) return false;
    if (opts.onlyIfMatch && (!cur || cur.etag !== opts.onlyIfMatch)) return false;
    return true;
  };
  return {
    _data: data,
    async getWithMetadata(key) {
      const cur = data.get(key);
      if (!cur) return null;
      return { data: JSON.parse(cur.value), etag: cur.etag, metadata: {} };
    },
    async get(key, opts = {}) {
      const cur = data.get(key);
      if (!cur) return null;
      if (opts.type === 'json') return JSON.parse(cur.value);
      if (opts.type === 'arrayBuffer') {
        const b = cur.value;
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      }
      return cur.value;
    },
    async setJSON(key, value, opts = {}) {
      if (!conditionOk(key, opts)) return { modified: false };
      const e = etag();
      data.set(key, { value: JSON.stringify(value), etag: e });
      return { modified: true, etag: e };
    },
    async set(key, value, opts = {}) {
      if (!conditionOk(key, opts)) return { modified: false };
      const e = etag();
      data.set(key, { value: Buffer.isBuffer(value) ? Buffer.from(value) : value, etag: e });
      return { modified: true, etag: e };
    },
    async delete(key) { data.delete(key); },
    async list({ prefix = '' } = {}) {
      return { blobs: [...data.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) };
    },
  };
}

module.exports = { memoryStore };
