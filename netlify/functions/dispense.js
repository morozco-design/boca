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

const MAX_DISPENSE_QUANTITY = 500;

// Body: { eventId, recipient, quantity }
// `quantity` (default 1) lets the operator hand out several codes to the
// same recipient in one go (e.g. a family of 4). If the pool has fewer
// disponible tickets than requested, we dispense as many as there are
// (never zero unless the pool was already empty) and report the shortfall
// back to the caller instead of failing the whole batch.
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
  const quantityRaw = body.quantity == null ? 1 : Number(body.quantity);

  if (!eventId) return json(400, { ok: false, error: 'missing_event_id' });
  if (!Number.isInteger(quantityRaw) || quantityRaw < 1 || quantityRaw > MAX_DISPENSE_QUANTITY) {
    return json(400, { ok: false, error: 'invalid_quantity' });
  }

  let dispensedCodes = [];

  try {
    const nextState = await updateState((state) => {
      dispensedCodes = [];
      const ev = findEvent(state, eventId);
      if (!ev) throw new MutationRejected('event_not_found', 'Evento no encontrado.');
      const tickets = ev.tickets || [];
      const now = new Date().toISOString();
      for (let i = 0; i < quantityRaw; i++) {
        const ticket = tickets.find((t) => t.status === 'disponible');
        if (!ticket) break;
        ticket.status = 'emitido';
        ticket.recipient = recipient || null;
        ticket.issuedAt = now;
        dispensedCodes.push(ticket.code);
      }
      if (dispensedCodes.length === 0) {
        throw new MutationRejected('pool_empty', 'No quedan códigos disponibles en el pool.');
      }
      return state;
    });

    const ev = findEvent(nextState, eventId);
    const ticketByCode = new Map(ev.tickets.map((t) => [t.code, t]));
    const tickets = dispensedCodes.map((code) => ticketByCode.get(code));

    return json(200, {
      ok: true,
      eventId,
      tickets,
      ticket: tickets[0] || null, // backward-compat single-ticket field
      requested: quantityRaw,
      dispensedCount: tickets.length,
      stats: statsFor(ev.tickets),
    });
  } catch (err) {
    if (err instanceof MutationRejected) {
      const codeMap = { event_not_found: 404, pool_empty: 409 };
      return json(codeMap[err.code] || 400, { ok: false, error: err.code, message: err.message });
    }
    return json(500, { ok: false, error: 'server_error', message: String((err && err.message) || err), debug: blobsDebugInfo() });
  }
};
