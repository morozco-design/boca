'use strict';

const { json, noContent, parseBody } = require('./_lib/http');
const { isAdminAuthorized } = require('./_lib/auth');
const { updateState, MutationRejected, initFromEvent, blobsDebugInfo, statsFor } = require('./_lib/store');

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
  const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
  if (!code) return json(400, { ok: false, error: 'missing_code' });

  let foundEventId = null;

  try {
    const nextState = await updateState((state) => {
      const events = state.events || [];
      let ticket = null;
      for (const ev of events) {
        const t = (ev.tickets || []).find((tt) => tt.code === code);
        if (t) {
          ticket = t;
          foundEventId = ev.id;
          break;
        }
      }
      if (!ticket) {
        throw new MutationRejected('not_found', 'Código no encontrado.');
      }
      if (ticket.status === 'usado') {
        throw new MutationRejected('already_used', 'Este código ya fue usado en la puerta; no se puede cancelar la entrega.');
      }
      if (ticket.status === 'disponible') {
        throw new MutationRejected('not_issued', 'Este código no está entregado.');
      }
      ticket.status = 'disponible';
      ticket.recipient = null;
      ticket.issuedAt = null;
      return state;
    });

    const ev = (nextState.events || []).find((e) => e.id === foundEventId);
    return json(200, { ok: true, eventId: foundEventId, stats: statsFor(ev.tickets), tickets: ev.tickets });
  } catch (err) {
    if (err instanceof MutationRejected) {
      const codeMap = { not_found: 404, already_used: 409, not_issued: 409 };
      return json(codeMap[err.code] || 400, { ok: false, error: err.code, message: err.message });
    }
    return json(500, { ok: false, error: 'server_error', message: String((err && err.message) || err), debug: blobsDebugInfo() });
  }
};
