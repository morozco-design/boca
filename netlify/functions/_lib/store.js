'use strict';

const { getStore, connectLambda } = require('@netlify/blobs');

const STORE_NAME = 'pase-unico';
const STATE_KEY = 'state';
const MAX_RETRIES = 8;

// These functions use the classic "Lambda compatibility mode" handler style
// (exports.handler = async (event) => {...}), and for that style Netlify
// does NOT auto-configure Netlify Blobs — the docs are explicit that you
// must call connectLambda(event) yourself, right before touching the
// store, or every getStore() call fails with:
// "The environment has not been configured to use Netlify Blobs."
// Every handler calls this first, passing the raw Lambda event it received.
function initFromEvent(event) {
  if (typeof connectLambda === 'function') {
    try {
      connectLambda(event);
    } catch (err) {
      // In tests (mocked @netlify/blobs) or any non-Lambda invocation this
      // is a no-op; swallow so it never breaks a handler that doesn't need it.
    }
  }
}

function emptyState() {
  return {
    eventName: '',
    tickets: [],
    updatedAt: null,
  };
}

function getBlobStore() {
  return getStore({ name: STORE_NAME, consistency: 'strong' });
}

// Reads the current state plus its ETag (undefined if the key has never
// been written yet). Always returns a usable state object.
async function readState() {
  const store = getBlobStore();
  const result = await store.getWithMetadata(STATE_KEY, { type: 'json', consistency: 'strong' });
  if (!result || result.data == null) {
    return { state: emptyState(), etag: undefined };
  }
  return { state: result.data, etag: result.etag };
}

// A logic-level rejection thrown by a mutator (e.g. "this code was already
// used"). Distinguished from a CAS retry so callers can tell the two apart.
class MutationRejected extends Error {
  constructor(code, message) {
    super(message || code);
    this.rejected = true;
    this.code = code;
  }
}

// Applies `mutator(state)` to the current state under optimistic
// concurrency control. `mutator` receives a deep-ish working copy of the
// state and must return the new state object (or throw MutationRejected to
// abort without writing). Retries automatically on a CAS conflict (another
// request wrote in between) up to MAX_RETRIES times, re-running the
// mutator against the freshest state each time.
async function updateState(mutator) {
  const store = getBlobStore();
  let lastErr = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const { state, etag } = await readState();
    const working = JSON.parse(JSON.stringify(state));
    let nextState;
    try {
      nextState = await mutator(working);
    } catch (err) {
      if (err instanceof MutationRejected) throw err;
      throw err;
    }
    nextState.updatedAt = new Date().toISOString();
    const setOptions = etag ? { onlyIfMatch: etag } : { onlyIfNew: true };
    const result = await store.setJSON(STATE_KEY, nextState, setOptions);
    if (result.modified) {
      return nextState;
    }
    lastErr = new Error('conflict');
    // Someone else wrote in between; loop and retry against fresh state.
  }
  throw lastErr || new Error('No se pudo guardar el estado (demasiados conflictos).');
}

module.exports = { readState, updateState, emptyState, MutationRejected, initFromEvent, STORE_NAME, STATE_KEY };
