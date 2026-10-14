'use strict';

const mp = require('./mp');
const { sendTicketsEmail } = require('./mailer');
const { getOrder, updateOrder } = require('./orders');
const { updateState, readState, MutationRejected, findEvent } = require('./store');
const { releaseExpired } = require('./reservations');

// Confirma un pago de Mercado Pago y entrega las entradas. Lo llaman tanto el
// webhook como la página de "gracias" (por si el aviso se demora), y es
// seguro llamarlo varias veces para el mismo pago: no entrega dos veces ni
// manda dos mails.
//
// Nunca se confía en lo que diga quien llama: el pago se consulta a Mercado
// Pago con nuestro token, y tiene que estar aprobado, ser de este pedido
// (external_reference) y cubrir el monto.
async function processPayment(paymentId, opts) {
  const options = opts || {};
  const payment = await mp.getPayment(paymentId);
  const orderId = payment.external_reference;
  if (!orderId || (options.expectedOrderId && orderId !== options.expectedOrderId)) {
    return { outcome: 'ignored' };
  }
  let order = await getOrder(orderId);
  if (!order) return { outcome: 'ignored' };

  if (payment.status !== 'approved') {
    if (order.status === 'pendiente' && order.paymentStatus !== payment.status) {
      await updateOrder(orderId, (o) => {
        o.paymentStatus = payment.status;
        return o;
      });
    }
    return { outcome: 'pending', paymentStatus: payment.status };
  }

  if (order.status === 'reembolsado' || order.status === 'revisar') {
    return { outcome: order.status };
  }

  if (order.status !== 'pagado') {
    const amountOk = Number(payment.transaction_amount) + 0.001 >= order.total && payment.currency_id === order.currency;
    if (!amountOk) {
      await updateOrder(orderId, (o) => {
        if (o.status !== 'pendiente') return undefined;
        o.status = 'revisar';
        o.note = 'El monto o la moneda del pago no coinciden con el pedido.';
        o.paymentId = String(payment.id);
        return o;
      });
      return { outcome: 'revisar' };
    }

    let finalCodes = [];
    try {
      await updateState((state) => {
        const ev = findEvent(state, order.eventId);
        if (!ev) throw new MutationRejected('event_not_found', 'Evento no encontrado.');
        const now = new Date().toISOString();
        const nowMs = Date.now();

        // 1) Las entradas que ya eran de este pedido (aunque la reserva haya
        //    vencido, si nadie las tomó todavía siguen siendo suyas).
        const own = ev.tickets.filter((t) => t.orderId === order.id && (t.status === 'reservado' || t.status === 'emitido'));
        // 2) Si faltan, se completan con entradas libres.
        const missing = order.quantity - own.length;
        const extra = [];
        if (missing > 0) {
          releaseExpired(ev, nowMs);
          const free = ev.tickets.filter((t) => t.status === 'disponible');
          if (free.length < missing) throw new MutationRejected('no_stock', 'Ya no quedan entradas.');
          extra.push(...free.slice(0, missing));
        }
        const all = own.concat(extra);
        for (const t of all) {
          if (t.status !== 'emitido') t.issuedAt = now;
          t.status = 'emitido';
          t.orderId = order.id;
          t.recipient = order.name || order.email || null;
          delete t.reservedUntil;
        }
        finalCodes = all.map((t) => t.code);
        return state;
      });
    } catch (err) {
      if (err instanceof MutationRejected && err.code === 'no_stock') {
        // Pagó, pero entre tanto se perdió la reserva y no quedan entradas:
        // se devuelve el dinero completo en lugar de quedarse con un pago sin
        // entrada.
        await mp.refundPayment(payment.id);
        await updateOrder(orderId, (o) => {
          o.status = 'reembolsado';
          o.paymentId = String(payment.id);
          o.note = 'Sin stock al confirmar el pago; se reembolsó.';
          return o;
        });
        return { outcome: 'reembolsado' };
      }
      throw err;
    }

    const updated = await updateOrder(orderId, (o) => {
      if (o.status === 'pagado') return undefined;
      o.status = 'pagado';
      o.paymentId = String(payment.id);
      o.paidAt = new Date().toISOString();
      o.codes = finalCodes;
      return o;
    });
    order = updated.value || order;
  }

  const emailError = await ensureEmail(order.id, options.siteUrl);
  return { outcome: 'paid', emailError: emailError || null };
}

// Manda el mail una sola vez aunque lleguen varios avisos a la vez: el primero
// "reclama" el envío, y si falla se libera para que un reintento lo vuelva a
// intentar. Devuelve un mensaje de error o null.
async function ensureEmail(orderId, siteUrl) {
  const claim = await updateOrder(orderId, (o) => {
    if (o.status !== 'pagado' || o.emailSentAt) return undefined;
    if (o.emailClaimedAt && Date.now() - Date.parse(o.emailClaimedAt) < 120000) return undefined;
    o.emailClaimedAt = new Date().toISOString();
    return o;
  });
  if (!claim.changed) return null;
  const order = claim.value;
  try {
    const { state } = await readState();
    const ev = findEvent(state, order.eventId);
    await sendTicketsEmail({
      to: order.email,
      name: order.name,
      eventName: ev ? ev.name : order.eventName,
      codes: order.codes,
      link: siteUrl ? siteUrl + '/entrada.html?o=' + encodeURIComponent(order.id) : '',
    });
    await updateOrder(orderId, (o) => {
      o.emailSentAt = new Date().toISOString();
      o.emailError = null;
      return o;
    });
    return null;
  } catch (err) {
    const message = String((err && err.message) || err);
    console.error('[compras] no se pudo mandar el mail del pedido ' + orderId + ':', message);
    await updateOrder(orderId, (o) => {
      o.emailClaimedAt = null;
      o.emailError = message;
      return o;
    });
    return message;
  }
}

module.exports = { processPayment, ensureEmail };
