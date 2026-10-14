'use strict';

// Protección del panel y de las funciones de administración
// (state, generate, dispense, cancel, delete-event y la subida/borrado de
// imagen).
//
// Con la venta online abierta ESTO ES IMPORTANTE: sin clave, cualquiera que
// conozca la dirección de esas funciones podría ver todos los códigos o
// entregarse entradas gratis.
//
// Cómo se activa: en Netlify, Site configuration → Environment variables,
// creá ADMIN_PASSCODE con la clave que quieras. El panel la pide una vez por
// sesión del navegador. Si ADMIN_PASSCODE no existe, todo funciona abierto
// como antes (útil mientras probás).
//
// No usar la "Password protection" de Netlify para esto: protege el sitio
// entero y los compradores tampoco podrían entrar.
const crypto = require('crypto');

function isAdminAuthorized(event) {
  const expected = process.env.ADMIN_PASSCODE;
  if (!expected) return true;
  const headers = (event && event.headers) || {};
  let given = '';
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === 'x-admin-passcode') given = String(headers[k] || '');
  }
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

module.exports = { isAdminAuthorized };
