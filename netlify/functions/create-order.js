'use strict';

const { json, noContent, parseBody } = require('./_lib/http');
const { saleConfig, siteUrl, mpDate } = require('./_lib/config');
const {
  updateState,
  MutationRejected,
  initFromEvent,
  blobsDebugInfo,
  findEvent,
  randomId,
} = require('./_lib/store');
const { reserveTickets, releaseOrder, countAvailable, resolveSaleEvent } = require('./_lib/reservations');
const { createOrder, updateOrder, reserveBuyerQuota, releaseBuyerQuota, QuotaExceeded } = require('./_lib/orders');
const mp = require('./_lib/mp');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// PÚBLICO. Body: { name, email, quantity }
// 1) aparta las entradas (nadie más las puede comprar mientras se paga),
// 2) crea el pedido, 3) crea el pago en Mercado Pago y devuelve el link.
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return noContent();
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' });
  initFromEvent(event);

  const cfg = saleConfig();
  if (!cfg.open) return json(409, { ok: false, error: 'sale_closed', message: 'La venta no está abierta.' });

  const body = parseBody(event);
  if (!body) return json(400, { ok: false, error: 'invalid_json' });
  const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const quantity = Number(body.quantity);

  if (name.length < 2 || name.length > 80) return json(400, { ok: false, error: 'invalid_name', message: 'Ingresá tu nombre.' });
  if (!EMAIL_RE.test(email) || email.length > 120) return json(400, { ok: false, error: 'invalid_email', message: 'Ingresá un mail válido.' });
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > cfg.max) {
    return json(400, { ok: false, error: 'invalid_quantity', message: 'Podés comprar entre 1 y ' + cfg.max + ' entradas.' });
  }

  const nowMs = Date.now();
  const untilMs = nowMs + cfg.reserveMinutes * 60 * 1000;
  const untilIso = new Date(untilMs).toISOString();
  const orderId = randomId();
  const site = siteUrl(event);
  let buyerReserved = false;
  let ticketsReserved = false;
  let eventName = '';
  let saleEventId = null;

  try {
    // Tope por persona.
    await reserveBuyerQuota(email, orderId, quantity, untilIso, cfg.max, nowMs);
    buyerReserved = true;

    // Apartar las entradas.
    let codes = null;
    let availableNow = 0;
    try {
      await updateState((state) => {
        const ev = resolveSaleEvent(state, cfg.eventId);
        if (!ev) throw new MutationRejected('event_not_found', 'Evento no encontrado.');
        saleEventId = ev.id;
        eventName = ev.name;
        codes = reserveTickets(ev, quantity, orderId, name, untilIso, nowMs);
        if (!codes) {
          availableNow = countAvailable(ev, nowMs);
          throw new MutationRejected('sold_out', 'No hay entradas suficientes.');
        }
        return state;
      });
    } catch (err) {
      if (err instanceof MutationRejected && err.code === 'event_not_found') {
        await releaseBuyerQuota(email, orderId);
        return json(409, { ok: false, error: 'sale_closed', message: 'La venta no está abierta.' });
      }
      if (err instanceof MutationRejected && err.code === 'sold_out') {
        await releaseBuyerQuota(email, orderId);
        return json(409, {
          ok: false,
          error: 'sold_out',
          available: availableNow,
          message: availableNow > 0 ? 'Quedan solo ' + availableNow + ' entradas.' : 'Las entradas se agotaron.',
        });
      }
      throw err;
    }
    ticketsReserved = true;

    const total = cfg.price * quantity;
    await createOrder({
      id: orderId,
      eventId: saleEventId,
      eventName,
      name,
      email,
      quantity,
      unitPrice: cfg.price,
      total,
      currency: cfg.currency,
      codes,
      status: 'pendiente',
      createdAt: new Date(nowMs).toISOString(),
      reservedUntil: untilIso,
    });

    const preference = await mp.createPreference({
      items: [{
        id: saleEventId,
        title: 'Entrada - ' + eventName,
        quantity,
        unit_price: cfg.price,
        currency_id: cfg.currency,
      }],
      payer: { name, email },
      external_reference: orderId,
      notification_url: site + '/.netlify/functions/mp-webhook',
      back_urls: {
        success: site + '/entrada.html?o=' + orderId,
        pending: site + '/entrada.html?o=' + orderId,
        failure: site + '/comprar.html?pago=fallido',
      },
      auto_return: 'approved',
      expires: true,
      expiration_date_from: mpDate(nowMs),
      expiration_date_to: mpDate(untilMs),
    });

    const checkoutUrl = preference.init_point;
    if (!checkoutUrl) throw new Error('Mercado Pago no devolvió el link de pago.');
    await updateOrder(orderId, (o) => {
      o.preferenceId = preference.id;
      return o;
    });

    return json(200, { ok: true, orderId, checkoutUrl, reservedUntil: untilIso });
  } catch (err) {
    // Si algo falló después de apartar las entradas, se devuelven al pool.
    try {
      if (ticketsReserved) {
        await updateState((state) => {
          const ev = findEvent(state, saleEventId);
          if (ev) releaseOrder(ev, orderId);
          return state;
        });
      }
      if (buyerReserved) await releaseBuyerQuota(email, orderId);
      if (ticketsReserved) {
        await updateOrder(orderId, (o) => {
          o.status = 'fallido';
          o.note = String((err && err.message) || err);
          return o;
        });
      }
    } catch (cleanupErr) {
      console.error('[compras] no se pudo liberar la reserva de ' + orderId + ':', cleanupErr && cleanupErr.message);
    }

    if (err instanceof QuotaExceeded) {
      return json(409, {
        ok: false,
        error: 'quota_exceeded',
        remaining: err.remaining,
        message: err.remaining > 0
          ? 'Con este mail solo podés comprar ' + err.remaining + ' entrada(s) más.'
          : 'Con este mail ya llegaste al máximo de ' + cfg.max + ' entradas.',
      });
    }
    if (err instanceof mp.MpError) {
      console.error('[compras] error de Mercado Pago:', err.status, JSON.stringify(err.detail));
      return json(502, { ok: false, error: 'payment_provider_error', message: 'No se pudo iniciar el pago. Probá de nuevo en un momento.' });
    }
    return json(500, { ok: false, error: 'server_error', message: String((err && err.message) || err), debug: blobsDebugInfo() });
  }
};
