'use strict';

const { json, noContent, parseBody } = require('./_lib/http');
const { isAdminAuthorized } = require('./_lib/auth');
const {
  updateState,
  MutationRejected,
  initFromEvent,
  blobsDebugInfo,
  statsFor,
  findEvent,
} = require('./_lib/store');

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
  const recipient = typeof body.recipient === 'string' ? body.recipient.trim() : '';

  if (!eventId) return json(400, { ok: false, error: 'missing_event_id' });

  let dispensedCode = null;

  try {
    const nextState = await updateState((state) => {
      const ev = findEvent(state, eventId);
      if (!ev) throw new MutationRejected('event_not_found', 'Evento no encontrado.');
      const tickets = ev.tickets || [];
      const ticket = tickets.find((t) => t.status === 'disponible');
      if (!ticket) {
        throw new MutationRejected('pool_empty', 'No quedan códigos disponibles en el pool.');
      }
      ticket.status = 'emitido';
      ticket.recipient = recipient || null;
      ticket.issuedAt = new Date().toISOString();
      dispensedCode = ticket.code;
      return state;
    });

    const ev = findEvent(nextState, eventId);
    const ticket = ev.tickets.find((t) => t.code === dispensedCode);

    return json(200, { ok: true, eventId, ticket, stats: statsFor(ev.tickets) });
  } catch (err) {
    if (err instanceof MutationRejected) {
      const codeMap = { event_not_found: 404, pool_empty: 409 };
      return json(codeMap[err.code] || 400, { ok: false, error: err.code, message: err.message });
    }
    return json(500, { ok: false, error: 'server_error', message: String((err && err.message) || err), debug: blobsDebugInfo() });
  }
};
