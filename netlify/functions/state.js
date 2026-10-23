'use strict';

const { json, noContent } = require('./_lib/http');
const { isAdminAuthorized } = require('./_lib/auth');
const { readState, initFromEvent, blobsDebugInfo, statsFor, eventSummaries, findEvent } = require('./_lib/store');
const { releaseExpired } = require('./_lib/reservations');

// GET /state              -> { ok, events: [summary...], updatedAt }
// GET /state?eventId=xxx  -> { ok, events: [summary...], event: {id,name,tickets,stats,createdAt}, updatedAt }
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return noContent();
  if (event.httpMethod !== 'GET') {
    return json(405, { ok: false, error: 'method_not_allowed' });
  }
  initFromEvent(event);
  if (!(await isAdminAuthorized(event))) {
    return json(401, { ok: false, error: 'unauthorized' });
  }
  initFromEvent(event);

  const eventId = (event.queryStringParameters && event.queryStringParameters.eventId) || '';

  try {
    const { state } = await readState();
    // Las reservas vencidas (alguien empezó a pagar y no terminó) ya no
    // cuentan: se muestran como disponibles. Es solo para la respuesta, no se
    // guarda nada; el sistema las libera de verdad en la próxima compra.
    const nowMs = Date.now();
    (state.events || []).forEach((ev) => releaseExpired(ev, nowMs));
    const events = eventSummaries(state);

    const payload = { ok: true, events, updatedAt: state.updatedAt || null };

    if (eventId) {
      const ev = findEvent(state, eventId);
      if (!ev) return json(404, { ok: false, error: 'event_not_found', events });
      payload.event = {
        id: ev.id,
        name: ev.name,
        createdAt: ev.createdAt || null,
        tickets: ev.tickets || [],
        stats: statsFor(ev.tickets),
        hasImage: !!ev.hasImage,
        hasSaleImage: !!ev.hasSaleImage,
      };
    }

    return json(200, payload);
  } catch (err) {
    return json(500, { ok: false, error: 'server_error', message: String((err && err.message) || err), debug: blobsDebugInfo() });
  }
};
