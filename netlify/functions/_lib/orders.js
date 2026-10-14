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

module.exports = {
  casUpdate,
  getOrder,
  createOrder,
  updateOrder,
  isValidOrderId,
};
