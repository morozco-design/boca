'use strict';

const { json, noContent, parseBody } = require('./_lib/http');
const { isAdminAuthorized } = require('./_lib/auth');
const { updateState, MutationRejected, initFromEvent } = require('./_lib/store');

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
  const recipient = typeof body.recipient === 'string' ? body.recipient.trim() : '';

  let dispensedCode = null;

  try {
    const nextState = await updateState((state) => {
      const tickets = state.tickets || [];
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

    const ticket = nextState.tickets.find((t) => t.code === dispensedCode);
    const stats = {
      total: nextState.tickets.length,
      disponible: nextState.tickets.filter((t) => t.status === 'disponible').length,
      emitido: nextState.tickets.filter((t) => t.status === 'emitido').length,
      usado: nextState.tickets.filter((t) => t.status === 'usado').length,
    };

    return json(200, { ok: true, ticket, stats });
  } catch (err) {
    if (err instanceof MutationRejected && err.code === 'pool_empty') {
      return json(409, { ok: false, error: 'pool_empty' });
    }
    return json(500, { ok: false, error: 'server_error', message: String((err && err.message) || err) });
  }
};
