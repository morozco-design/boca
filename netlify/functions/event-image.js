'use strict';

const { json, noContent, parseBody, CORS_HEADERS } = require('./_lib/http');
const { isAdminAuthorized } = require('./_lib/auth');
const {
  initFromEvent,
  blobsDebugInfo,
  getImageBlobStore,
  updateState,
  MutationRejected,
  findEvent,
} = require('./_lib/store');

// Generous headroom over what the panel actually sends: it always
// normalizes/recompresses to a 1080x1920 JPEG client-side (typically a few
// hundred KB), so anything near this limit means something odd was sent.
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const DATA_URL_RE = /^data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=]+)$/;

// One background image per event, stored as raw bytes (not JSON) in a
// dedicated Blobs store keyed by eventId — see _lib/store.js's
// getImageBlobStore() for why this is kept separate from the main state
// blob. `hasImage` on the event itself (in the main state) is what the
// panel checks to decide whether to show a preview/remove button without
// having to probe this endpoint first.
//
// GET    /.netlify/functions/event-image?eventId=xxx  -> the raw image (public — this
//        is what <img> tags and shared tickets load, same spirit as validate.js)
// POST   { eventId, imageDataUrl }                     -> upload/replace
// DELETE ?eventId=xxx                                  -> remove
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return noContent();
  initFromEvent(event);

  if (event.httpMethod === 'GET') {
    const eventId = (event.queryStringParameters && event.queryStringParameters.eventId) || '';
    if (!eventId) return json(400, { ok: false, error: 'missing_event_id' });
    try {
      const store = getImageBlobStore();
      const result = await store.getWithMetadata(eventId, { type: 'arrayBuffer' });
      if (!result || result.data == null) return json(404, { ok: false, error: 'not_found' });
      const contentType = (result.metadata && result.metadata.contentType) || 'image/jpeg';
      return {
        statusCode: 200,
        headers: Object.assign(
          { 'Content-Type': contentType, 'Cache-Control': 'private, max-age=300' },
          CORS_HEADERS
        ),
        body: Buffer.from(result.data).toString('base64'),
        isBase64Encoded: true,
      };
    } catch (err) {
      return json(500, { ok: false, error: 'server_error', message: String((err && err.message) || err), debug: blobsDebugInfo() });
    }
  }

  // Uploading/removing an image mutates the event, so it goes through the
  // same admin gate as generate/dispense/cancel/delete-event (currently a
  // no-op — the panel has no passcode — but kept for consistency and in
  // case that ever changes).
  if (!isAdminAuthorized(event)) {
    return json(401, { ok: false, error: 'unauthorized' });
  }

  if (event.httpMethod === 'POST') {
    const body = parseBody(event);
    if (!body) return json(400, { ok: false, error: 'invalid_json' });
    const eventId = typeof body.eventId === 'string' ? body.eventId.trim() : '';
    if (!eventId) return json(400, { ok: false, error: 'missing_event_id' });

    const dataUrl = typeof body.imageDataUrl === 'string' ? body.imageDataUrl : '';
    const match = dataUrl.match(DATA_URL_RE);
    if (!match) return json(400, { ok: false, error: 'invalid_image' });
    const contentType = match[1] === 'image/jpg' ? 'image/jpeg' : match[1];
    const buffer = Buffer.from(match[2], 'base64');
    if (buffer.length === 0) return json(400, { ok: false, error: 'invalid_image' });
    if (buffer.length > MAX_IMAGE_BYTES) return json(400, { ok: false, error: 'image_too_large' });

    try {
      // Confirm the event exists (and flip its hasImage flag) before we
      // bother writing the actual bytes.
      await updateState((state) => {
        const ev = findEvent(state, eventId);
        if (!ev) throw new MutationRejected('event_not_found', 'Evento no encontrado.');
        ev.hasImage = true;
        return state;
      });

      const store = getImageBlobStore();
      await store.set(eventId, buffer, { metadata: { contentType } });

      return json(200, { ok: true, eventId, hasImage: true });
    } catch (err) {
      if (err instanceof MutationRejected) {
        return json(err.code === 'event_not_found' ? 404 : 400, { ok: false, error: err.code, message: err.message });
      }
      return json(500, { ok: false, error: 'server_error', message: String((err && err.message) || err), debug: blobsDebugInfo() });
    }
  }

  if (event.httpMethod === 'DELETE') {
    const eventId = (event.queryStringParameters && event.queryStringParameters.eventId) || '';
    if (!eventId) return json(400, { ok: false, error: 'missing_event_id' });
    try {
      await updateState((state) => {
        const ev = findEvent(state, eventId);
        if (!ev) throw new MutationRejected('event_not_found', 'Evento no encontrado.');
        ev.hasImage = false;
        return state;
      });

      const store = getImageBlobStore();
      await store.delete(eventId);

      return json(200, { ok: true, eventId, hasImage: false });
    } catch (err) {
      if (err instanceof MutationRejected) {
        return json(err.code === 'event_not_found' ? 404 : 400, { ok: false, error: err.code, message: err.message });
      }
      return json(500, { ok: false, error: 'server_error', message: String((err && err.message) || err), debug: blobsDebugInfo() });
    }
  }

  return json(405, { ok: false, error: 'method_not_allowed' });
};
