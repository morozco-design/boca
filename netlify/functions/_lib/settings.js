'use strict';

const { getOrdersStore } = require('./store');

// Ajustes de la venta online que se manejan desde el panel.
//   opensAt: fecha y hora (ISO, UTC) en que se habilita la compra; null = ya abierta.
const KEY = 'sale-settings';

async function getSaleSettings() {
  try {
    const found = await getOrdersStore().getWithMetadata(KEY, { type: 'json' });
    const d = found && found.data;
    const t = d && d.opensAt ? Date.parse(d.opensAt) : NaN;
    return { opensAt: Number.isFinite(t) ? new Date(t).toISOString() : null };
  } catch (e) {
    return { opensAt: null };
  }
}

async function setSaleSettings(opensAtIso) {
  const store = getOrdersStore();
  if (!opensAtIso) {
    await store.delete(KEY);
    return { opensAt: null };
  }
  await store.setJSON(KEY, { opensAt: opensAtIso, updatedAt: new Date().toISOString() });
  return { opensAt: opensAtIso };
}

module.exports = { getSaleSettings, setSaleSettings };
