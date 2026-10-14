'use strict';

const { json, noContent, parseBody } = require('./_lib/http');
const { siteUrl } = require('./_lib/config');
const { initFromEvent } = require('./_lib/store');
const { processPayment } = require('./_lib/fulfill');
const mp = require('./_lib/mp');

// Mercado Pago llama acá cuando hay novedades de un pago. Se responde 200
// rápido a todo lo que no es un pago, y 500 si algo falló de nuestro lado
// (para que Mercado Pago reintente más tarde).
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return noContent();
  if (event.httpMethod !== 'POST' && event.httpMethod !== 'GET') {
    return json(405, { ok: false, error: 'method_not_allowed' });
  }
  initFromEvent(event);

  const q = event.queryStringParameters || {};
  const body = parseBody(event) || {};
  const type = q.type || q.topic || body.type || body.topic || '';
  const dataId = String(q['data.id'] || (body.data && body.data.id) || q.id || '');

  if (type !== 'payment' || !dataId) return json(200, { ok: true, ignored: true });

  const secret = process.env.MP_WEBHOOK_SECRET;
  if (secret && !mp.verifySignature(event, q['data.id'] || (body.data && body.data.id) || '', secret)) {
    return json(401, { ok: false, error: 'invalid_signature' });
  }

  try {
    const result = await processPayment(dataId, { siteUrl: siteUrl(event) });
    if (result.emailError) {
      return json(500, { ok: false, error: 'email_failed', outcome: result.outcome });
    }
    return json(200, { ok: true, outcome: result.outcome });
  } catch (err) {
    console.error('[compras] webhook falló:', err && err.message, err && err.detail ? JSON.stringify(err.detail) : '');
    return json(500, { ok: false, error: 'server_error' });
  }
};
