'use strict';

const { json, noContent } = require('./_lib/http');
const { saleConfig } = require('./_lib/config');
const { readState, initFromEvent, blobsDebugInfo } = require('./_lib/store');
const { countAvailable, resolveSaleEvent } = require('./_lib/reservations');

// PÚBLICO. Lo que necesita la página de compra: nombre del evento, precio y
// cuántas entradas quedan. Nunca devuelve códigos.
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return noContent();
  if (event.httpMethod !== 'GET') return json(405, { ok: false, error: 'method_not_allowed' });
  initFromEvent(event);

  const cfg = saleConfig();
  if (!cfg.open) return json(200, { ok: true, open: false });

  try {
    const { state } = await readState();
    const ev = resolveSaleEvent(state, cfg.eventId);
    if (!ev) return json(200, { ok: true, open: false });
    const available = countAvailable(ev, Date.now());
    return json(200, {
      ok: true,
      open: true,
      eventId: ev.id,
      eventName: ev.name,
      hasImage: !!ev.hasImage,
      price: cfg.price,
      currency: cfg.currency,
      max: cfg.max,
      available,
      soldOut: available === 0,
    });
  } catch (err) {
    return json(500, { ok: false, error: 'server_error', message: String((err && err.message) || err), debug: blobsDebugInfo() });
  }
};
