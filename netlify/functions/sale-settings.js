'use strict';

const { json, noContent, parseBody } = require('./_lib/http');
const { isAdminAuthorized } = require('./_lib/auth');
const { initFromEvent, blobsDebugInfo } = require('./_lib/store');
const { getSaleSettings, setSaleSettings } = require('./_lib/settings');

// SOLO ADMIN.
//   GET                      -> { opensAt }   (ISO en UTC, o null)
//   POST { opensAt }         -> fija la fecha y hora de apertura de la venta
//   POST { opensAt: null }   -> sin fecha: la venta queda abierta
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return noContent();
  initFromEvent(event);
  if (!(await isAdminAuthorized(event))) return json(401, { ok: false, error: 'unauthorized' });
  try {
    if (event.httpMethod === 'GET') {
      return json(200, Object.assign({ ok: true, now: Date.now() }, await getSaleSettings()));
    }
    if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' });
    const body = parseBody(event) || {};
    let iso = null;
    if (body.opensAt !== null && body.opensAt !== undefined && body.opensAt !== '') {
      const t = Date.parse(String(body.opensAt));
      if (!Number.isFinite(t)) return json(400, { ok: false, error: 'invalid_date', message: 'La fecha y hora no son válidas.' });
      iso = new Date(t).toISOString();
    }
    return json(200, Object.assign({ ok: true, now: Date.now() }, await setSaleSettings(iso)));
  } catch (err) {
    return json(500, { ok: false, error: 'server_error', message: String((err && err.message) || err), debug: blobsDebugInfo() });
  }
};
