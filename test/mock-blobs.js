'use strict';

// In-memory stand-in for @netlify/blobs with real ETag / compare-and-swap
// semantics, so _lib/store.js's optimistic-concurrency logic can be
// exercised without a real Netlify deployment.

const crypto = require('crypto');

function makeStore() {
  const data = new Map(); // key -> { value, etag }

  function etagFor(value) {
    return crypto.createHash('sha1').update(JSON.stringify(value)).digest('hex');
  }

  function jitter() {
    // A tiny random delay forces genuine interleaving between "concurrent"
    // async calls in the test suite, so the CAS retry loop in _lib/store.js
    // actually gets exercised under contention instead of running strictly
    // sequentially.
    return new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 8)));
  }

  return {
    async getWithMetadata(key, opts) {
      await jitter();
      const entry = data.get(key);
      if (!entry) return null;
      return { data: entry.value, etag: entry.etag, metadata: {} };
    },
    async setJSON(key, value, options) {
      await jitter();
      const entry = data.get(key);
      const conditions = options || {};
      if (conditions.onlyIfNew) {
        if (entry) return { modified: false };
      } else if (conditions.onlyIfMatch) {
        if (!entry || entry.etag !== conditions.onlyIfMatch) return { modified: false };
      }
      const etag = etagFor(value);
      data.set(key, { value: JSON.parse(JSON.stringify(value)), etag });
      return { modified: true, etag };
    },
    // test helper, not part of the real API
    _dump() {
      return Array.from(data.entries());
    },
    _reset() {
      data.clear();
    },
  };
}

const stores = new Map();

function getStore(opts) {
  const name = typeof opts === 'string' ? opts : (opts && opts.name) || 'default';
  if (!stores.has(name)) stores.set(name, makeStore());
  return stores.get(name);
}

function resetAll() {
  stores.clear();
}

// The real @netlify/blobs needs connectLambda(event) called before getStore()
// when running in "Lambda compatibility mode" (see _lib/store.js). The mock
// store here doesn't need any such handshake, so this is just a harmless
// no-op — it exists so requiring `connectLambda` from this mock doesn't blow
// up with "not a function".
function connectLambda() {}

module.exports = { getStore, connectLambda, resetAll, __isMock: true };
