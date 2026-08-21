'use strict';

const { json, noContent } = require('./_lib/http');
const { isAdminAuthorized } = require('./_lib/auth');
const { readState, initFromEvent, blobsDebugInfo } = require('./_lib/store');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return noContent();
  if (event.httpMethod !== 'GET') {
    return json(405, { ok: false, error: 'method_not_allowed' });
  }
  if (!isAdminAuthorized(event)) {
    return json(401, { ok: false, error: 'unauthorized' });
  }
  initFromEvent(event);

  try {
    const { state } = await readState();
    const tickets = state.tickets || [];
    const stats = {
      total: tickets.length,
      disponible: tickets.filter((t) => t.status === 'disponible').length,
      emitido: tickets.filter((t) => t.status === 'emitido').length,
      usado: tickets.filter((t) => t.status === 'usado').length,
    };

    return json(200, {
      ok: true,
      eventName: state.eventName || '',
      tickets,
      stats,
      updatedAt: state.updatedAt || null,
    });
  } catch (err) {
    return json(500, { ok: false, error: 'server_error', message: String((err && err.message) || err), debug: blobsDebugInfo() });
  }
};
