'use strict';

const crypto = require('crypto');

const API = 'https://api.mercadopago.com';

class MpError extends Error {
  constructor(message, status, detail) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

async function mpFetch(path, options) {
  const token = process.env.MP_ACCESS_TOKEN;
  if (!token) throw new MpError('MP_ACCESS_TOKEN no está configurado en Netlify.', 500);
  const opts = options || {};
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  if (opts.idempotencyKey) headers['X-Idempotency-Key'] = opts.idempotencyKey;
  const res = await fetch(API + path, {
    method: opts.method || 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (!res.ok) {
    throw new MpError('Mercado Pago respondió ' + res.status, res.status, data);
  }
  return data;
}

function createPreference(payload) {
  return mpFetch('/checkout/preferences', { method: 'POST', body: payload });
}

function getPayment(id) {
  return mpFetch('/v1/payments/' + encodeURIComponent(id));
}

function refundPayment(id) {
  // La clave de idempotencia evita un doble reembolso si se reintenta.
  return mpFetch('/v1/payments/' + encodeURIComponent(id) + '/refunds', {
    method: 'POST',
    body: {},
    idempotencyKey: 'refund-' + id,
  });
}

function header(event, name) {
  const headers = (event && event.headers) || {};
  const wanted = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === wanted) return headers[k];
  }
  return '';
}

// Verifica la firma x-signature que Mercado Pago agrega a cada notificación:
// HMAC-SHA256 de "id:<data.id>;request-id:<x-request-id>;ts:<ts>;" con la
// clave secreta del webhook. Si falta algún dato, se omite de la cadena.
function verifySignature(event, dataId, secret) {
  const sig = header(event, 'x-signature');
  if (!sig || !secret) return false;
  let ts = '';
  let v1 = '';
  sig.split(',').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx < 0) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k === 'ts') ts = v;
    if (k === 'v1') v1 = v;
  });
  if (!ts || !v1) return false;
  const requestId = header(event, 'x-request-id');
  const id = /^[a-zA-Z0-9]+$/.test(String(dataId)) ? String(dataId).toLowerCase() : String(dataId);
  let manifest = '';
  if (id) manifest += 'id:' + id + ';';
  if (requestId) manifest += 'request-id:' + requestId + ';';
  manifest += 'ts:' + ts + ';';
  const expected = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(v1, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { createPreference, getPayment, refundPayment, verifySignature, MpError };
