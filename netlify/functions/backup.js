'use strict';

const { json, noContent, CORS_HEADERS } = require('./_lib/http');
const { isAdminAuthorized } = require('./_lib/auth');
const { readState, initFromEvent, blobsDebugInfo, getOrdersStore } = require('./_lib/store');

// SOLO ADMIN. Devuelve una copia de todo lo importante para guardar:
//   GET            -> JSON con eventos, entradas (con su estado) y pedidos online.
//   GET ?format=csv -> planilla (CSV, abre en Excel) con una fila por entrada.
// No incluye las imágenes de los eventos (esas las tenés en tus archivos).

async function listOrders() {
  const store = getOrdersStore();
  const orders = [];
  let keys = [];
  const res = await store.list();
  keys = ((res && res.blobs) || []).map((b) => b.key).filter((k) => k && k.indexOf('order-') === 0);
  for (let i = 0; i < keys.length; i += 20) {
    const chunk = keys.slice(i, i + 20);
    const got = await Promise.all(chunk.map((k) => store.getWithMetadata(k, { type: 'json' }).catch(() => null)));
    for (const g of got) if (g && g.data && typeof g.data === 'object') orders.push(g.data);
  }
  return orders;
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return noContent();
  if (event.httpMethod !== 'GET') return json(405, { ok: false, error: 'method_not_allowed' });
  initFromEvent(event);
  if (!(await isAdminAuthorized(event))) return json(401, { ok: false, error: 'unauthorized' });

  try {
    const { state } = await readState();
    const orders = await listOrders();
    const stamp = new Date().toISOString();
    const day = stamp.slice(0, 10);
    const qs = event.queryStringParameters || {};

    if (qs.format === 'csv') {
      const byOrder = {};
      orders.forEach((o) => { byOrder[o.id] = o; });
      const head = ['evento', 'codigo', 'estado', 'entregada_a', 'emitida', 'usada', 'mail_comprador', 'pedido', 'numero_de_pago'];
      const rows = [head];
      for (const ev of state.events || []) {
        for (const t of ev.tickets || []) {
          const o = t.orderId ? byOrder[t.orderId] : null;
          rows.push([ev.name, t.code, t.status, t.recipient || '', t.issuedAt || '', t.usedAt || '', o ? o.email : '', t.orderId || '', o ? (o.paymentId || '') : '']);
        }
      }
      // BOM para que Excel respete los acentos.
      const body = '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
      return {
        statusCode: 200,
        headers: Object.assign({
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="entradas-' + day + '.csv"',
          'Cache-Control': 'no-store',
        }, CORS_HEADERS),
        body,
      };
    }

    const payload = { ok: true, app: 'pase-unico', version: 1, exportedAt: stamp, events: state.events || [], orders };
    return {
      statusCode: 200,
      headers: Object.assign({
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="respaldo-entradas-' + day + '.json"',
        'Cache-Control': 'no-store',
      }, CORS_HEADERS),
      body: JSON.stringify(payload, null, 1),
    };
  } catch (err) {
    return json(500, { ok: false, error: 'server_error', message: String((err && err.message) || err), debug: blobsDebugInfo() });
  }
};
