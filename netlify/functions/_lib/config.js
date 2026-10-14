'use strict';

// Configuración de la venta online, toda por variables de entorno de Netlify
// (Site configuration → Environment variables). Nada de esto va en el código.
//
//   SALE_EVENT_ID       nombre exacto del evento a la venta (como aparece en el panel) o su id
//   TICKET_PRICE        precio de UNA entrada, en pesos uruguayos (ej: 600)
//   SALE_OPEN           opcional: poné "false" para cerrar la venta sin borrar nada
//   MAX_PER_PERSON      opcional: máximo de entradas por persona (por defecto 5)
//   RESERVE_MINUTES     opcional: minutos que se reservan las entradas mientras se paga (por defecto 15)
//   MP_ACCESS_TOKEN     Access Token de Mercado Pago (de prueba o de producción)
//   MP_WEBHOOK_SECRET   opcional pero recomendado: clave secreta del webhook de Mercado Pago
//   GMAIL_USER          casilla de Gmail desde la que se mandan las entradas
//   GMAIL_APP_PASSWORD  contraseña de aplicación de esa cuenta de Gmail
//   MAIL_FROM_NAME      opcional: nombre que ve el comprador como remitente
//   SITE_URL            opcional: URL pública del sitio (si no, se usa la que da Netlify)

function intEnv(name, fallback) {
  const n = parseInt(process.env[name], 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function saleConfig() {
  const eventId = (process.env.SALE_EVENT_ID || '').trim();
  const price = Number(process.env.TICKET_PRICE);
  const configured = Boolean(eventId) && Number.isFinite(price) && price > 0;
  return {
    eventId,
    price,
    currency: 'UYU',
    max: intEnv('MAX_PER_PERSON', 5),
    reserveMinutes: intEnv('RESERVE_MINUTES', 15),
    open: configured && String(process.env.SALE_OPEN || '').toLowerCase() !== 'false',
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
