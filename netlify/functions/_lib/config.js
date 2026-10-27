'use strict';

// Configuración de la venta online.
//
// El precio es FIJO y está acá (PRICE_UYU): $450 por entrada. Para cambiarlo
// editá ese número y volvé a subir el archivo.
//
// Los eventos a la venta son todos los que existen en el panel (con códigos
// generados); el comprador elige cuál.
//
// Variables de entorno de Netlify (Site configuration → Environment variables):
//   MP_ACCESS_TOKEN     Access Token de Mercado Pago (de prueba o de producción)
//   MP_WEBHOOK_SECRET   opcional pero recomendado: clave secreta del webhook de Mercado Pago
//   GMAIL_USER          casilla de Gmail desde la que se mandan las entradas
//   GMAIL_APP_PASSWORD  contraseña de aplicación de esa cuenta de Gmail
//   ADMIN_PASSCODE      clave del panel (imprescindible antes de abrir la venta)
//   SALE_OPEN           opcional: poné "false" para cerrar la venta sin borrar nada
//   MAX_PER_EMAIL       opcional: máximo de entradas por mail (por defecto 5), sumando todas sus compras.
//   MAX_PER_ORDER       opcional: tope técnico de entradas por compra (por defecto 8). No hay límite por persona.
//   RESERVE_MINUTES     opcional: minutos que se reservan las entradas mientras se paga (por defecto 15)
//   MAIL_FROM_NAME      opcional: nombre que ve el comprador como remitente
//   SITE_URL            opcional: URL pública del sitio (si no, se usa la que da Netlify)

const PRICE_UYU = 450;

function intEnv(name, fallback) {
  const n = parseInt(process.env[name], 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function saleConfig() {
  return {
    price: PRICE_UYU,
    currency: 'UYU',
    max: intEnv('MAX_PER_ORDER', 8),
    maxPerEmail: intEnv('MAX_PER_EMAIL', 5),
    reserveMinutes: intEnv('RESERVE_MINUTES', 15),
    open: String(process.env.SALE_OPEN || '').toLowerCase() !== 'false',
  };
}

function siteUrl(event) {
  const fromEnv = (process.env.SITE_URL || process.env.URL || '').trim().replace(/\/+$/, '');
  if (fromEnv) return fromEnv;
  const headers = (event && event.headers) || {};
  const host = headers['x-forwarded-host'] || headers.host || '';
  return host ? 'https://' + host : '';
}

// Uruguay no tiene horario de verano: siempre UTC-3. Mercado Pago pide las
// fechas con offset explícito.
function mpDate(ms) {
  return new Date(ms - 3 * 3600 * 1000).toISOString().replace('Z', '-03:00');
}

module.exports = { saleConfig, siteUrl, mpDate };
