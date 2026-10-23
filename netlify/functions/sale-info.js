'use strict';

const { json, noContent } = require('./_lib/http');
const { saleConfig } = require('./_lib/config');
const { readState, initFromEvent, blobsDebugInfo } = require('./_lib/store');
const { countAvailable } = require('./_lib/reservations');

// PÚBLICO. Lo que necesita la página de compra: los eventos creados en el
// panel (con entradas generadas), cuántas quedan de cada uno, el precio fijo
// y el tope técnico por compra. Nunca devuelve códigos.
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return noContent();
  if (event.httpMethod !== 'GET') return json(405, { ok: false, error: 'method_not_allowed' });
  initFromEvent(event);

  const cfg = saleConfig();
  if (!cfg.open) return json(200, { ok: true, open: false });

  try {
    const { state } = await readState();
    const nowMs = Date.now();
    const events = (state.events || [])
      .filter((ev) => (ev.tickets || []).length > 0)
      .map((ev) => {
        const available = countAvailable(ev, nowMs);
        return { id: ev.id, name: ev.name, hasSaleImage: !!ev.hasSaleImage, available, soldOut: available === 0 };
      });
    return json(200, {
      ok: true,
      open: events.length > 0,
      price: cfg.price,
      currency: cfg.currency,
      max: cfg.max,
      events,
    });
  } catch (err) {
    return json(500, { ok: false, error: 'server_error', message: String((err && err.message) || err), debug: blobsDebugInfo() });
  }
};
