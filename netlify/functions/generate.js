'use strict';

const { json, noContent, parseBody } = require('./_lib/http');
const { isAdminAuthorized } = require('./_lib/auth');
const { updateState, initFromEvent } = require('./_lib/store');
const { generateUniqueCodes } = require('./_lib/codes');

const MAX_QUANTITY = 5000;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return noContent();
  if (event.httpMethod !== 'POST') {
    return json(405, { ok: false, error: 'method_not_allowed' });
  }
  if (!isAdminAuthorized(event)) {
    return json(401, { ok: false, error: 'unauthorized' });
  }
  initFromEvent(event);

  const body = parseBody(event);
  if (!body) return json(400, { ok: false, error: 'invalid_json' });

  const eventName = typeof body.eventName === 'string' ? body.eventName.trim() : '';
  const quantity = Number(body.quantity);
  const replace = !!body.replace;

  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
    return json(400, { ok: false, error: 'invalid_quantity' });
  }

  try {
    const nextState = await updateState((state) => {
      const existingTickets = replace ? [] : state.tickets || [];
      const existingCodes = new Set(existingTickets.map((t) => t.code));
      const newCodes = generateUniqueCodes(quantity, existingCodes);
      const now = new Date().toISOString();
      const newTickets = newCodes.map((code) => ({
        code,
        status: 'disponible',
        recipient: null,
        issuedAt: null,
        usedAt: null,
        createdAt: now,
      }));
      return {
        eventName: eventName || state.eventName || '',
        tickets: existingTickets.concat(newTickets),
      };
    });

    const stats = {
      total: nextState.tickets.length,
      disponible: nextState.tickets.filter((t) => t.status === 'disponible').length,
      emitido: nextState.tickets.filter((t) => t.status === 'emitido').length,
      usado: nextState.tickets.filter((t) => t.status === 'usado').length,
    };

    return json(200, { ok: true, eventName: nextState.eventName, stats, tickets: nextState.tickets });
  } catch (err) {
    return json(500, { ok: false, error: 'server_error', message: String((err && err.message) || err) });
  }
};
