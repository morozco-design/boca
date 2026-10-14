'use strict';

const crypto = require('crypto');
const { getOrdersStore } = require('./store');

const MAX_RETRIES = 8;

class QuotaExceeded extends Error {
  constructor(remaining) {
    super('quota_exceeded');
    this.code = 'quota_exceeded';
    this.remaining = remaining;
  }
}

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

// ---- Máximo de entradas por persona -------------------------------------
// Se lleva un índice por mail (hash) con los pedidos que cuentan: los pagados
// y los pendientes que todavía no vencieron. Es un freno razonable, no un
// control de identidad: alguien con varios mails distintos puede saltearlo.

function buyerKey(email) {
  const h = crypto.createHash('sha256').update(String(email).trim().toLowerCase()).digest('hex');
  return 'buyer-' + h.slice(0, 32);
}

function liveEntries(entries, nowMs) {
  return (entries || []).filter((e) => e.paid || Date.parse(e.until) > nowMs);
}

async function reserveBuyerQuota(email, orderId, quantity, untilIso, max, nowMs) {
  await casUpdate(getOrdersStore(), buyerKey(email), (current) => {
    const entries = liveEntries(current && current.entries, nowMs);
    const used = entries.reduce((sum, e) => sum + e.qty, 0);
    if (used + quantity > max) throw new QuotaExceeded(Math.max(0, max - used));
    entries.push({ orderId, qty: quantity, until: untilIso, paid: false });
    return { entries };
  });
}

async function releaseBuyerQuota(email, orderId) {
  await casUpdate(getOrdersStore(), buyerKey(email), (current) => {
    if (!current) return undefined;
    return { entries: current.entries.filter((e) => e.orderId !== orderId) };
  });
}

async function markBuyerPaid(email, orderId) {
  await casUpdate(getOrdersStore(), buyerKey(email), (current) => {
    if (!current) return undefined;
    let changed = false;
    const entries = current.entries.map((e) => {
      if (e.orderId === orderId && !e.paid) { changed = true; return Object.assign({}, e, { paid: true }); }
      return e;
    });
    return changed ? { entries } : undefined;
  });
}

module.exports = {
  casUpdate,
  getOrder,
  createOrder,
  updateOrder,
  isValidOrderId,
  reserveBuyerQuota,
  releaseBuyerQuota,
  markBuyerPaid,
  QuotaExceeded,
};
