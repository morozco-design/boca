'use strict';

const { json, noContent, parseBody } = require('./_lib/http');
const { isAdminAuthorized } = require('./_lib/auth');
const {
  updateState,
  MutationRejected,
  initFromEvent,
  blobsDebugInfo,
  randomId,
  statsFor,
  eventSummaries,
  findEvent,
} = require('./_lib/store');
const { generateUniqueCodes } = require('./_lib/codes');

const MAX_QUANTITY = 5000;

// Body:
//   { eventId, quantity, replace }        -> add codes to an existing event
//   { eventName, quantity }               -> create a new event with codes
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

  const eventId = typeof body.eventId === 'string' ? body.eventId.trim() : '';
  const eventName = typeof body.eventName === 'string' ? body.eventName.trim() : '';
  const quantity = Number(body.quantity);
  const replace = !!body.replace;

  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
    return json(400, { ok: false, error: 'invalid_quantity' });
  }
  if (!eventId && !eventName) {
    return json(400, { ok: false, error: 'missing_event_name' });
  }

  try {
    let targetId = eventId;
    const nextState = await updateState((state) => {
      state.events = state.events || [];

      let ev;
      if (eventId) {
        ev = findEvent(state, eventId);
        if (!ev) throw new MutationRejected('event_not_found', 'Evento no encontrado.');
        if (eventName) ev.name = eventName;
      } else {
        ev = {
          id: randomId(),
          name: eventName,
          tickets: [],
          createdAt: new Date().toISOString(),
        };
        state.events.push(ev);
      }
      targetId = ev.id;

      const existingTickets = replace ? [] : ev.tickets || [];
      // Uniqueness is global across every event, not just this one, so a
      // scanned code always maps to exactly one ticket regardless of event.
      const allExistingCodes = new Set(
        state.events.flatMap((e) => (e === ev ? existingTickets : e.tickets || []).map((t) => t.code))
      );
      const newCodes = generateUniqueCodes(quantity, allExistingCodes);
      const now = new Date().toISOString();
      const newTickets = newCodes.map((code) => ({
        code,
        status: 'disponible',
        recipient: null,
        issuedAt: null,
        usedAt: null,
        createdAt: now,
      }));
      ev.tickets = existingTickets.concat(newTickets);
      return state;
    });

    const ev = findEvent(nextState, targetId);
    return json(200, {
      ok: true,
      event: { id: ev.id, name: ev.name, createdAt: ev.createdAt, tickets: ev.tickets, stats: statsFor(ev.tickets), hasImage: !!ev.hasImage },
      events: eventSummaries(nextState),
    });
  } catch (err) {
    if (err instanceof MutationRejected) {
      const codeMap = { event_not_found: 404 };
      return json(codeMap[err.code] || 400, { ok: false, error: err.code, message: err.message });
    }
    return json(500, { ok: false, error: 'server_error', message: String((err && err.message) || err), debug: blobsDebugInfo() });
  }
};
