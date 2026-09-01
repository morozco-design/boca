'use strict';

const crypto = require('crypto');
const { getStore, connectLambda } = require('@netlify/blobs');

const STORE_NAME = 'pase-unico';
const STATE_KEY = 'state';
const MAX_RETRIES = 8;

function randomId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return crypto.randomBytes(16).toString('hex');
}

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
      // Log instead of swallowing silently: if this throws in production
      // (e.g. event.blobs missing/malformed), the real reason should show
      // up in Netlify's function logs instead of being hidden behind the
      // generic MissingBlobsEnvironmentError that getStore() throws next.
      console.error('[pase-unico] connectLambda(event) falló:', {
        message: err && err.message,
        hasBlobsField: typeof event?.blobs,
        headerKeys: event?.headers ? Object.keys(event.headers) : null,
      });
    }
  } else {
    console.error('[pase-unico] connectLambda no está disponible en @netlify/blobs (versión inesperada del paquete).');
  }
}

function emptyState() {
  return {
    events: [],
    updatedAt: null,
  };
}

// The store used to hold a single event ({eventName, tickets}). Now it holds
// several ({events: [{id, name, tickets, createdAt}]}). Any state blob
// written before this change is transparently upgraded into the new shape
// the first time it's read, so existing deployments don't lose their pool.
//
// IMPORTANT: the id given to that migrated event MUST be deterministic, not
// random. readState() is called on every GET (read-only, no write), so if
// this minted a fresh random id each time, two back-to-back reads of the
// same still-unmigrated blob would disagree on the event's id — the classic
// symptom was the panel fetching the event list (id A), then immediately
// fetching that event's detail (id B, freshly re-migrated), getting a 404,
// retrying the whole cycle, forever, while every mutation (delete/dispense/
// cancel) also failed with "event not found" because the id the client held
// never matched whatever id the next internal read happened to mint. A
// fixed id sidesteps all of that: there is at most one such legacy event
// per blob (the old single-event architecture never had more than one), so
// a constant is safe and every read/write agrees on it until a real
// mutation persists the new shape (which then keeps this same id forever).
const LEGACY_EVENT_ID = 'legacy-event';

function migrateState(raw) {
  if (!raw || typeof raw !== 'object') return emptyState();
  if (Array.isArray(raw.events)) return raw;
  if (Array.isArray(raw.tickets)) {
    return {
      events: [
        {
          id: LEGACY_EVENT_ID,
          name: raw.eventName || 'Evento',
          tickets: raw.tickets,
          createdAt: raw.updatedAt || new Date().toISOString(),
        },
      ],
      updatedAt: raw.updatedAt || null,
    };
  }
  return emptyState();
}

function statsFor(tickets) {
  const list = tickets || [];
  return {
    total: list.length,
    disponible: list.filter((t) => t.status === 'disponible').length,
    emitido: list.filter((t) => t.status === 'emitido').length,
    usado: list.filter((t) => t.status === 'usado').length,
  };
}

// Summary shape used for the event picker (no ticket codes/recipients).
function eventSummaries(state) {
  return (state.events || []).map((ev) => ({
    id: ev.id,
    name: ev.name,
    createdAt: ev.createdAt || null,
    stats: statsFor(ev.tickets),
  }));
}

function findEvent(state, eventId) {
  return (state.events || []).find((ev) => ev.id === eventId) || null;
}

// The automatic detection (connectLambda above, relying on Netlify's
// Lambda-compatibility event/headers) has proven flaky in some deployments.
// As a reliable fallback, if these two environment variables are set on the
// site, we configure the store with them explicitly — this bypasses the
// automatic mechanism entirely and always works, per Netlify's own docs
// (https://docs.netlify.com/build/data-and-storage/netlify-blobs/):
//   - BLOBS_SITE_ID: the site's "Project ID" (Project configuration →
//     General → Project information → Project ID).
//   - BLOBS_TOKEN: a Netlify Personal Access Token (User settings →
//     Applications → Personal access tokens → New access token).
// Whether BLOBS_SITE_ID/BLOBS_TOKEN are visible to this function at
// runtime — NEVER the values themselves, just booleans. Handlers attach
// this to their error responses (see http.js's errorJson) so it shows up
// directly in the browser's Network tab, instead of depending on Netlify's
// real-time function log (which has proven unreliable to read in practice).
function blobsDebugInfo() {
  return {
    hasSiteID: Boolean(process.env.BLOBS_SITE_ID),
    hasToken: Boolean(process.env.BLOBS_TOKEN),
  };
}

function manualBlobsOptions() {
  const siteID = process.env.BLOBS_SITE_ID;
  const token = process.env.BLOBS_TOKEN;
  if (siteID && token) {
    return { siteID, token };
  }
  return {};
}

// We deliberately do NOT request 'strong' consistency here. Strong reads
// need an extra 'uncachedEdgeURL' that's only populated by Netlify's full
// automatic environment detection — which is exactly what's unreliable on
// this deployment (see manualBlobsOptions above), and mixing a manual
// siteID/token with a partial automatic context throws:
// "...has not been configured with a 'uncachedEdgeURL' property".
// This is safe to skip: our own compare-and-swap retry loop in updateState
// already handles a read seeing a slightly-stale ETag — it just retries
// against a fresh read, which 'eventual' consistency (the default) still
// serves correctly once the write has propagated.
function getBlobStore() {
  return getStore({ name: STORE_NAME, ...manualBlobsOptions() });
}

// Reads the current state plus its ETag (undefined if the key has never
// been written yet). Always returns a usable state object.
async function readState() {
  const store = getBlobStore();
  const result = await store.getWithMetadata(STATE_KEY, { type: 'json' });
  if (!result || result.data == null) {
    return { state: emptyState(), etag: undefined };
  }
  return { state: migrateState(result.data), etag: result.etag };
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
    // A short, growing backoff gives 'eventual' consistency a moment to
    // propagate before the next read, instead of hammering it immediately.
    if (attempt < MAX_RETRIES - 1) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(50 * (attempt + 1), 400)));
    }
  }
  throw lastErr || new Error('No se pudo guardar el estado (demasiados conflictos).');
}

module.exports = {
  readState,
  updateState,
  emptyState,
  MutationRejected,
  initFromEvent,
  blobsDebugInfo,
  randomId,
  statsFor,
  eventSummaries,
  findEvent,
  STORE_NAME,
  STATE_KEY,
};
