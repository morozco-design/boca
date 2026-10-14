'use strict';

// Protección del panel y de las funciones de administración
// (state, generate, dispense, cancel, delete-event, edit-event y la
// subida/borrado de imagen).
//
// Con la venta online abierta ESTO ES IMPORTANTE: sin clave, cualquiera que
// conozca la dirección de esas funciones podría ver todos los códigos o
// entregarse entradas gratis.
//
// La clave se administra desde Netlify: Site configuration → Environment
// variables → ADMIN_PASSCODE (después, un redeploy). Para cambiarla, editá la
// variable; para quitarla, borrala. El panel muestra una pantalla de acceso y
// recuerda la clave solo mientras la pestaña esté abierta.
// Si ADMIN_PASSCODE no existe, todo queda abierto (útil mientras probás).
//
// No usar la "Password protection" de Netlify para esto: protege el sitio
// entero y los compradores tampoco podrían entrar.
const crypto = require('crypto');

function sha(v) { return crypto.createHash('sha256').update(String(v)).digest(); }

function isPasscodeRequired() {
  return !!process.env.ADMIN_PASSCODE;
}

async function isAdminAuthorized(event) {
  const expected = process.env.ADMIN_PASSCODE;
  if (!expected) return true;
  const headers = (event && event.headers) || {};
  let given = '';
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === 'x-admin-passcode') given = String(headers[k] || '');
  }
  return crypto.timingSafeEqual(sha(given), sha(expected));
}

module.exports = { isAdminAuthorized, isPasscodeRequired };
