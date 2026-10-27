'use strict';

const { getOrdersStore } = require('./store');

const MAX_RETRIES = 8;

// Lee-modifica-escribe con control de concurrencia optimista (ETag), igual
// que el resto del sistema. `mutator(current|null)` devuelve el valor nuevo,
// o `undefined` para no escribir nada. Puede lanzar para abortar.
async function casUpdate(store, key, mutator) {
  let lastErr = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const found = await store.getWithMetadata(key, { type: 'json' });
    const current = found && found.data != null ? JSON.parse(JSON.stringify(found.data)) : null;
    const etag = found ? found.etag : undefined;
    const next = await mutator(current);
    if (next === undefined) return { value: current, changed: false };
    const res = await store.setJSON(key, next, etag ? { onlyIfMatch: etag } : { onlyIfNew: true });
    if (res.modified) return { value: next, changed: true };
    lastErr = new Error('conflict');
    await new Promise((r) => setTimeout(r, Math.min(50 * (attempt + 1), 400)));
  }
  throw lastErr || new Error('No se pudo guardar (demasiados conflictos).');
}

function orderKey(id) {
  return 'order-' + id;
}

function isValidOrderId(id) {
  return typeof id === 'string' && /^[0-9a-zA-Z-]{16,64}$/.test(id);
}

async function getOrder(id) {
  if (!isValidOrderId(id)) return null;
  const found = await getOrdersStore().getWithMetadata(orderKey(id), { type: 'json' });
  return found && found.data != null ? found.data : null;
}

async function createOrder(order) {
  const res = await getOrdersStore().setJSON(orderKey(order.id), order, { onlyIfNew: true });
  if (!res.modified) throw new Error('order_exists');
  return order;
}

// mutator(order) -> order | undefined. Devuelve { value, changed }.
async function updateOrder(id, mutator) {
  if (!isValidOrderId(id)) return { value: null, changed: false };
  return casUpdate(getOrdersStore(), orderKey(id), (current) => {
    if (!current) return undefined;
    return mutator(current);
  });
}

// ---- Máximo de entradas por mail -----------------------------------------
// Un registro por mail (guardado con hash, sin el mail a la vista) con las
// entradas de cada pedido: las pagadas cuentan siempre; las de un pedido sin
// pagar cuentan solo mientras dura su reserva. Se actualiza con control de
// concurrencia para que dos compras simultáneas con el mismo mail no se
// pasen del tope.
const crypto = require('crypto');

class QuotaExceeded extends Error {
  constructor(used, limit) {
    super('quota_exceeded');
    this.code = 'quota_exceeded';
    this.used = used;
    this.limit = limit;
    this.remaining = Math.max(0, limit - used);
  }
}

function buyerKey(email) {
  return 'buyer-' + crypto.createHash('sha1').update(String(email || '').trim().toLowerCase()).digest('hex');
}

function usedBy(entries, nowMs) {
  let n = 0;
  for (const id of Object.keys(entries)) {
    const e = entries[id];
    if (e.paid || Date.parse(e.until || '') > nowMs) n += e.qty;
  }
  return n;
}

// Reserva cupo para un pedido. Lanza QuotaExceeded si se pasa del tope.
async function claimBuyerQuota(email, orderId, qty, untilMs, limit, nowMs) {
  await casUpdate(getOrdersStore(), buyerKey(email), (cur) => {
    const entries = (cur && cur.entries) || {};
    for (const id of Object.keys(entries)) {
      if (!entries[id].paid && !(Date.parse(entries[id].until || '') > nowMs)) delete entries[id];
    }
    const used = usedBy(entries, nowMs);
    if (used + qty > limit) throw new QuotaExceeded(used, limit);
    entries[orderId] = { qty, until: new Date(untilMs).toISOString(), paid: false };
    return { entries };
  });
}

async function releaseBuyerQuota(email, orderId) {
  await casUpdate(getOrdersStore(), buyerKey(email), (cur) => {
    if (!cur || !cur.entries || !cur.entries[orderId]) return undefined;
    delete cur.entries[orderId];
    return cur;
  });
}

async function markBuyerPaid(email, orderId, qty) {
  await casUpdate(getOrdersStore(), buyerKey(email), (cur) => {
    const entries = (cur && cur.entries) || {};
    if (entries[orderId] && entries[orderId].paid) return undefined;
    entries[orderId] = { qty, until: (entries[orderId] && entries[orderId].until) || new Date().toISOString(), paid: true };
    return { entries };
  });
}

module.exports = {
  QuotaExceeded,
  claimBuyerQuota,
  releaseBuyerQuota,
  markBuyerPaid,
  casUpdate,
  getOrder,
  createOrder,
  updateOrder,
  isValidOrderId,
};
