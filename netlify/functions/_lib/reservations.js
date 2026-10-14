'use strict';

// Una entrada "reservada" está apartada para un comprador que todavía está
// pagando. No cuenta como disponible (nadie más puede llevársela) ni como
// vendida. Si el pago no llega antes de `reservedUntil`, vuelve al pool.

function freeTicket(t) {
  t.status = 'disponible';
  t.recipient = null;
  delete t.orderId;
  delete t.reservedUntil;
  delete t.issuedAt;
}

function isExpiredReservation(t, nowMs) {
  return t.status === 'reservado' && Date.parse(t.reservedUntil || '') < nowMs;
}

// Devuelve al pool las reservas vencidas de un evento. Muta `ev`.
function releaseExpired(ev, nowMs) {
  let released = 0;
  for (const t of ev.tickets || []) {
    if (isExpiredReservation(t, nowMs)) {
      freeTicket(t);
      released++;
    }
  }
  return released;
}

// Cuántas se pueden vender ahora mismo (sin mutar nada).
function countAvailable(ev, nowMs) {
  let n = 0;
  for (const t of ev.tickets || []) {
    if (t.status === 'disponible' || isExpiredReservation(t, nowMs)) n++;
  }
  return n;
}

// Aparta `quantity` entradas para un pedido. Devuelve los códigos, o null si
// no alcanzan (en ese caso no toca nada). Muta `ev`.
function reserveTickets(ev, quantity, orderId, name, untilIso, nowMs) {
  releaseExpired(ev, nowMs);
  const free = (ev.tickets || []).filter((t) => t.status === 'disponible');
  if (free.length < quantity) return null;
  const picked = free.slice(0, quantity);
  for (const t of picked) {
    t.status = 'reservado';
    t.orderId = orderId;
    t.reservedUntil = untilIso;
    t.recipient = name || null;
  }
  return picked.map((t) => t.code);
}

// Libera las reservas de un pedido (si falló la creación del pago).
function releaseOrder(ev, orderId) {
  for (const t of ev.tickets || []) {
    if (t.status === 'reservado' && t.orderId === orderId) freeTicket(t);
  }
}

// SALE_EVENT_ID puede ser el id del evento o directamente su nombre exacto
// (sin importar mayúsculas), que es lo más fácil de copiar del panel.
function resolveSaleEvent(state, ref) {
  const r = String(ref || '').trim();
  if (!r) return null;
  const events = state.events || [];
  return events.find((e) => e.id === r) || events.find((e) => String(e.name || '').trim().toLowerCase() === r.toLowerCase()) || null;
}

module.exports = { resolveSaleEvent, freeTicket, releaseExpired, countAvailable, reserveTickets, releaseOrder };
