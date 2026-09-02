'use strict';

const { json, noContent, parseBody } = require('./_lib/http');
const { isAdminAuthorized } = require('./_lib/auth');
const {
  updateState,
  MutationRejected,
  initFromEvent,
  blobsDebugInfo,
  eventSummaries,
  getImageBlobStore,
} = require('./_lib/store');

// Permanently removes an event and every ticket/code that belongs to it.
// There is no undo — the panel is expected to confirm with the user before
// calling this.
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return noContent();
  if (event.httpMethod !== 'POST') {
    return json(405, { ok: false, error: 'method_not_allowed' });
  }
  if (!isAdminAuthorized(event)) {
    return json(401, { ok: false, error: 'unauthorized' });
  }
  initFromEvent(event);

  const body = parseBody(event) || {};
  const eventId = typeof body.eventId === 'string' ? body.eventId.trim() : '';
  if (!eventId) return json(400, { ok: false, error: 'missing_event_id' });

  try {
    const nextState = await updateState((state) => {
      const events = state.events || [];
      const idx = events.findIndex((ev) => ev.id === eventId);
      if (idx === -1) throw new MutationRejected('event_not_found', 'Evento no encontrado.');
      events.splice(idx, 1);
      state.events = events;
      return state;
    });

    // Best-effort cleanup: an orphaned image blob costs nothing functionally
    // (nothing references it once the event is gone), but there's no reason
    // to let it linger. Never let this fail the request — the event itself
    // is already gone by this point.
    try {
      await getImageBlobStore().delete(eventId);
    } catch (imgErr) {
      console.error('[pase-unico] no se pudo borrar la imagen del evento eliminado:', {
        eventId,
        message: imgErr && imgErr.message,
      });
    }

    return json(200, { ok: true, events: eventSummaries(nextState) });
  } catch (err) {
    if (err instanceof MutationRejected) {
      const codeMap = { event_not_found: 404 };
      return json(codeMap[err.code] || 400, { ok: false, error: err.code, message: err.message });
    }
    return json(500, { ok: false, error: 'server_error', message: String((err && err.message) || err), debug: blobsDebugInfo() });
  }
};
