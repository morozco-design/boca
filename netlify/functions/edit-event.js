'use strict';

const { json, noContent, parseBody } = require('./_lib/http');
const { isAdminAuthorized } = require('./_lib/auth');
const {
  updateState,
  MutationRejected,
  initFromEvent,
  blobsDebugInfo,
  statsFor,
  eventSummaries,
  findEvent,
} = require('./_lib/store');
const { generateUniqueCodes } = require('./_lib/codes');

const MAX_CAPACITY = 5000;

// Body: { eventId, name?, capacity? }
//   name     -> nuevo nombre del evento.
//   capacity -> aforo total (cantidad de códigos del evento). Si sube, se
//               agregan códigos disponibles. Si baja, se quitan solo códigos
//               disponibles (nunca uno reservado, entregado o usado); si el
//               aforo pedido es menor que lo ya reservado/entregado, se rechaza.
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return noContent();
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' });
  initFromEvent(event);
  if (!(await isAdminAuthorized(event))) return json(401, { ok: false, error: 'unauthorized' });

  const body = parseBody(event);
  if (!body) return json(400, { ok: false, error: 'invalid_json' });

  const eventId = typeof body.eventId === 'string' ? body.eventId.trim() : '';
  if (!eventId) return json(400, { ok: false, error: 'missing_event_id' });

  const hasName = body.name !== undefined && body.name !== null;
  const name = hasName ? String(body.name).trim() : '';
  if (hasName && (!name || name.length > 120)) {
    return json(400, { ok: false, error: 'invalid_name', message: 'El nombre no puede estar vacío (máximo 120 caracteres).' });
  }
  const hasCap = body.capacity !== undefined && body.capacity !== null && body.capacity !== '';
  const capacity = hasCap ? Number(body.capacity) : null;
  if (hasCap && (!Number.isInteger(capacity) || capacity < 1 || capacity > MAX_CAPACITY)) {
    return json(400, { ok: false, error: 'invalid_capacity', message: 'El aforo tiene que ser un número entre 1 y ' + MAX_CAPACITY + '.' });
  }
  if (!hasName && !hasCap) return json(400, { ok: false, error: 'nothing_to_change' });

  try {
    const nextState = await updateState((state) => {
      const ev = findEvent(state, eventId);
      if (!ev) throw new MutationRejected('event_not_found', 'Evento no encontrado.');
      if (hasName) ev.name = name;

      if (hasCap) {
        const tickets = ev.tickets || [];
        const free = tickets.filter((t) => t.status === 'disponible');
        const locked = tickets.length - free.length;
        if (capacity < locked) {
          throw new MutationRejected(
            'capacity_below_sold',
            'No se puede bajar de ' + locked + ': ya hay ' + locked + ' entradas reservadas, entregadas o usadas.'
          );
        }
        if (capacity > tickets.length) {
          const all = new Set(state.events.flatMap((e) => (e.tickets || []).map((t) => t.code)));
          const now = new Date().toISOString();
          const add = generateUniqueCodes(capacity - tickets.length, all).map((code) => ({
            code, status: 'disponible', recipient: null, issuedAt: null, usedAt: null, createdAt: now,
          }));
          ev.tickets = tickets.concat(add);
        } else if (capacity < tickets.length) {
          // Se descartan los últimos disponibles hasta llegar al aforo.
          let toRemove = tickets.length - capacity;
          const keep = [];
          for (let i = tickets.length - 1; i >= 0; i--) {
            if (toRemove > 0 && tickets[i].status === 'disponible') { toRemove--; continue; }
            keep.unshift(tickets[i]);
          }
          ev.tickets = keep;
        }
      }
      return state;
    });

    const ev = findEvent(nextState, eventId);
    return json(200, {
      ok: true,
      event: { id: ev.id, name: ev.name, createdAt: ev.createdAt, tickets: ev.tickets, stats: statsFor(ev.tickets), hasImage: !!ev.hasImage },
      events: eventSummaries(nextState),
    });
  } catch (err) {
    if (err instanceof MutationRejected) {
      const status = err.code === 'event_not_found' ? 404 : err.code === 'capacity_below_sold' ? 409 : 400;
      return json(status, { ok: false, error: err.code, message: err.message });
    }
    return json(500, { ok: false, error: 'server_error', message: String((err && err.message) || err), debug: blobsDebugInfo() });
  }
};
