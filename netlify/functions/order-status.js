'use strict';

const { json, noContent } = require('./_lib/http');
const { siteUrl } = require('./_lib/config');
const { initFromEvent, readState, findEvent, blobsDebugInfo } = require('./_lib/store');
const { getOrder, isValidOrderId } = require('./_lib/orders');
const { processPayment } = require('./_lib/fulfill');

// PÚBLICO. GET ?id=<pedido>[&payment_id=<pago>]
// El id del pedido es un código largo e imposible de adivinar: quien lo tiene
// puede ver las entradas de ese pedido (por eso nunca se muestra el mail).
// Si Mercado Pago ya mandó al comprador de vuelta pero el aviso del webhook
// todavía no llegó, `payment_id` permite confirmar el pago ya mismo.
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return noContent();
  if (event.httpMethod !== 'GET') return json(405, { ok: false, error: 'method_not_allowed' });
  initFromEvent(event);

  const q = event.queryStringParameters || {};
  const id = q.id || '';
  if (!isValidOrderId(id)) return json(400, { ok: false, error: 'invalid_id' });

  try {
    let order = await getOrder(id);
    if (!order) return json(404, { ok: false, error: 'not_found' });

    const paymentId = String(q.payment_id || q.collection_id || '').replace(/[^0-9]/g, '');
    if (order.status === 'pendiente' && paymentId) {
      try {
        await processPayment(paymentId, { expectedOrderId: id, siteUrl: siteUrl(event) });
        order = (await getOrder(id)) || order;
      } catch (err) {
        console.error('[compras] no se pudo confirmar el pago ' + paymentId + ':', err && err.message);
      }
    }

    const payload = { ok: true, status: order.status, quantity: order.quantity, eventId: order.eventId };
    const { state } = await readState();
    const ev = findEvent(state, order.eventId);
    payload.eventName = ev ? ev.name : order.eventName;
    payload.hasImage = !!(ev && ev.hasImage);
    if (order.status === 'pagado') {
      payload.codes = order.codes;
      payload.name = order.name;
      payload.emailSent = !!order.emailSentAt;
    }
    if (order.status === 'pendiente') payload.reservedUntil = order.reservedUntil;
    return json(200, payload);
  } catch (err) {
    return json(500, { ok: false, error: 'server_error', message: String((err && err.message) || err), debug: blobsDebugInfo() });
  }
};
