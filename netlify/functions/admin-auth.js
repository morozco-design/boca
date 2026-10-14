'use strict';

const { json, noContent, parseBody } = require('./_lib/http');
const { isAdminAuthorized, isPasscodeRequired } = require('./_lib/auth');

// GET                       -> { protected }  (público: el panel lo usa para
//                              saber si tiene que mostrar la pantalla de acceso)
// POST { action: 'login' }  -> 200 si la clave del header es correcta, 401 si no.
// La clave en sí se define con ADMIN_PASSCODE en Netlify.
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return noContent();
  if (event.httpMethod === 'GET') return json(200, { ok: true, protected: isPasscodeRequired() });
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' });
  if (!(await isAdminAuthorized(event))) return json(401, { ok: false, error: 'unauthorized' });
  const body = parseBody(event) || {};
  if (body.action !== 'login') return json(400, { ok: false, error: 'invalid_action' });
  return json(200, { ok: true, protected: isPasscodeRequired() });
};
