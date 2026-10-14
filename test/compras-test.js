'use strict';

// Pruebas de la venta online: reserva de entradas, pedidos, Mercado Pago y
// envío de mail. Mercado Pago, el mail y Netlify Blobs están simulados (no se
// toca ningún servicio real).

const assert = require('assert');
const crypto = require('crypto');

const mockBlobs = require('./mock-blobs');
const blobsPath = require.resolve('@netlify/blobs');
require.cache[blobsPath] = { id: blobsPath, filename: blobsPath, loaded: true, exports: mockBlobs };

// Mail simulado: guarda lo que se "envía".
const sentMails = [];
const nodemailerPath = require.resolve('nodemailer');
require.cache[nodemailerPath] = {
  id: nodemailerPath, filename: nodemailerPath, loaded: true,
  exports: { createTransport: () => ({ sendMail: async (m) => { sentMails.push(m); return {}; } }) },
};

// Mercado Pago simulado.
const mpState = { payments: {}, preferences: [], refunds: [], failPreferences: false, nextId: 1 };
global.fetch = async (url, opts) => {
  const u = String(url);
  const method = (opts && opts.method) || 'GET';
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
  if (u.endsWith('/checkout/preferences') && method === 'POST') {
    if (mpState.failPreferences) return reply(500, { message: 'boom' });
    const payload = JSON.parse(opts.body);
    mpState.preferences.push(payload);
    const id = 'pref-' + mpState.nextId++;
    return reply(201, { id, init_point: 'https://www.mercadopago.com.uy/checkout/v1/redirect?pref_id=' + id });
  }
  let m = u.match(/\/v1\/payments\/([^/]+)\/refunds$/);
  if (m && method === 'POST') { mpState.refunds.push(m[1]); return reply(201, { id: 1 }); }
  m = u.match(/\/v1\/payments\/([^/]+)$/);
  if (m) {
    const p = mpState.payments[m[1]];
    return p ? reply(200, p) : reply(404, { message: 'not found' });
  }
  return reply(404, {});
};

process.env.MP_ACCESS_TOKEN = 'TEST-token';
process.env.GMAIL_USER = 'vendedor@gmail.com';
process.env.GMAIL_APP_PASSWORD = 'abcd efgh ijkl mnop';
process.env.SITE_URL = 'https://mi-sitio.netlify.app';
delete process.env.MP_WEBHOOK_SECRET;
delete process.env.ADMIN_PASSCODE;

const fn = (name) => require('../netlify/functions/' + name + '.js').handler;
const generate = fn('generate');
const stateFn = fn('state');
const saleInfo = fn('sale-info');
const createOrder = fn('create-order');
const webhook = fn('mp-webhook');
const orderStatus = fn('order-status');
const validate = fn('validate');

let pass = 0;
let fail = 0;
async function test(name, f) {
  try { await f(); pass++; console.log('  ok  - ' + name); }
  catch (err) { fail++; console.log('FAIL  - ' + name + '\n        ' + (err && err.stack ? err.stack.split('\n').join('\n        ') : err)); }
}

async function call(handler, method, opts) {
  const o = opts || {};
  const res = await handler({
    httpMethod: method,
    headers: o.headers || {},
    queryStringParameters: o.query || null,
    body: o.body ? JSON.stringify(o.body) : null,
  });
  return { status: res.statusCode, data: res.body ? JSON.parse(res.body) : null };
}

async function newEvent(name, quantity) {
  const r = await call(generate, 'POST', { body: { eventName: name, quantity } });
  assert.strictEqual(r.status, 200);
  return r.data.event.id;
}

async function eventTickets(eventId) {
  const r = await call(stateFn, 'GET', { query: { eventId } });
  return r.data.event.tickets;
}

function count(tickets, status) { return tickets.filter((t) => t.status === status).length; }

function approvePayment(paymentId, orderId, amount, extra) {
  mpState.payments[paymentId] = Object.assign(
    { id: Number(paymentId), status: 'approved', external_reference: orderId, transaction_amount: amount, currency_id: 'UYU' },
    extra || {}
  );
}

function hook(paymentId, extraEvent) {
  return call(webhook, 'POST', Object.assign({
    query: { type: 'payment', 'data.id': String(paymentId) },
    body: { type: 'payment', data: { id: String(paymentId) } },
  }, extraEvent || {}));
}

let currentEvent = null;
function setEvent(id) { currentEvent = id; }
const buyer = (over) => Object.assign({ eventId: currentEvent, name: 'Ana Pérez', email: 'ana@example.com', quantity: 2 }, over || {});

async function main() {
  console.log('Pase Único — pruebas de la venta online\n');
  mockBlobs.resetAll();

  const eventId = await newEvent('Fiesta BOCA', 10);
  setEvent(eventId);

  let order1 = null;

  await test('sale-info: venta abierta con precio, máximo y disponibles (sin códigos)', async () => {
    const r = await call(saleInfo, 'GET');
    assert.strictEqual(r.data.open, true);
    assert.strictEqual(r.data.price, 450);
    assert.strictEqual(r.data.max, 5);
    assert.strictEqual(r.data.events.length, 1);
    assert.strictEqual(r.data.events[0].name, 'Fiesta BOCA');
    assert.strictEqual(r.data.events[0].available, 10);
    assert.ok(!JSON.stringify(r.data).match(/[A-Z0-9]{4}-[A-Z0-9]{4}/), 'no debe filtrar códigos');
  });

  await test('SALE_OPEN=false cierra la venta (sale-info y create-order)', async () => {
    process.env.SALE_OPEN = 'false';
    const r = await call(saleInfo, 'GET');
    assert.strictEqual(r.data.open, false);
    const c = await call(createOrder, 'POST', { body: buyer() });
    assert.strictEqual(c.status, 409);
    delete process.env.SALE_OPEN;
  });

  await test('create-order: reserva 2 entradas, crea el pago y devuelve el link', async () => {
    const r = await call(createOrder, 'POST', { body: buyer() });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.ok(r.data.checkoutUrl.startsWith('https://www.mercadopago.com.uy/'));
    order1 = r.data.orderId;
    const pref = mpState.preferences[mpState.preferences.length - 1];
    assert.strictEqual(pref.external_reference, order1);
    assert.strictEqual(pref.items[0].quantity, 2);
    assert.strictEqual(pref.items[0].unit_price, 450);
    assert.strictEqual(pref.items[0].currency_id, 'UYU');
    assert.strictEqual(pref.notification_url, 'https://mi-sitio.netlify.app/.netlify/functions/mp-webhook');
    assert.ok(/-03:00$/.test(pref.expiration_date_to));
    const t = await eventTickets(eventId);
    assert.strictEqual(count(t, 'reservado'), 2);
    assert.strictEqual(count(t, 'disponible'), 8);
    assert.strictEqual((await call(saleInfo, 'GET')).data.events.find((e) => e.id === eventId).available, 8);
  });

  await test('una entrada reservada (sin pagar) NO pasa en la puerta', async () => {
    const t = (await eventTickets(eventId)).find((x) => x.status === 'reservado');
    const r = await call(validate, 'POST', { body: { code: 'PU:' + t.code } });
    assert.strictEqual(r.status, 404);
    assert.strictEqual(r.data.reason, 'not_issued');
  });

  await test('order-status: pendiente no muestra códigos ni mail', async () => {
    const r = await call(orderStatus, 'GET', { query: { id: order1 } });
    assert.strictEqual(r.data.status, 'pendiente');
    assert.ok(!r.data.codes);
    assert.ok(!JSON.stringify(r.data).includes('ana@example.com'));
  });

  await test('webhook: pago aprobado entrega 2 entradas y manda UN mail con los QR', async () => {
    approvePayment('1001', order1, 900);
    const r = await hook(1001);
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.outcome, 'paid');
    const t = await eventTickets(eventId);
    assert.strictEqual(count(t, 'emitido'), 2);
    assert.strictEqual(count(t, 'reservado'), 0);
    assert.ok(t.filter((x) => x.status === 'emitido').every((x) => x.recipient === 'Ana Pérez'));
    assert.strictEqual(sentMails.length, 1);
    const mail = sentMails[0];
    assert.strictEqual(mail.to, 'ana@example.com');
    assert.strictEqual(mail.attachments.length, 2);
    assert.ok(mail.attachments.every((a) => a.cid && Buffer.isBuffer(a.content) && a.content.length > 100));
    assert.ok(mail.html.includes('/entrada.html?o=' + order1));
    const codes = t.filter((x) => x.status === 'emitido').map((x) => x.code);
    codes.forEach((c) => assert.ok(mail.text.includes(c)));
  });

  await test('webhook repetido: no entrega de más ni manda otro mail', async () => {
    const r = await hook(1001);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(count(await eventTickets(eventId), 'emitido'), 2);
    assert.strictEqual(sentMails.length, 1);
  });

  await test('order-status: pagado muestra los códigos', async () => {
    const r = await call(orderStatus, 'GET', { query: { id: order1 } });
    assert.strictEqual(r.data.status, 'pagado');
    assert.strictEqual(r.data.codes.length, 2);
    assert.strictEqual(r.data.emailSent, true);
    assert.strictEqual(r.data.eventName, 'Fiesta BOCA');
  });

  await test('la entrada comprada entra una sola vez en la puerta', async () => {
    const code = (await call(orderStatus, 'GET', { query: { id: order1 } })).data.codes[0];
    const a = await call(validate, 'POST', { body: { code: 'PU:' + code } });
    assert.strictEqual(a.status, 200);
    assert.strictEqual(a.data.recipient, 'Ana Pérez');
    const b = await call(validate, 'POST', { body: { code: 'PU:' + code } });
    assert.strictEqual(b.status, 409);
  });

  await test('tres avisos simultáneos del mismo pago: 1 solo mail y entradas sin duplicar', async () => {
    const r = await call(createOrder, 'POST', { body: buyer({ name: 'Beto', email: 'beto@example.com', quantity: 3 }) });
    assert.strictEqual(r.status, 200);
    approvePayment('1002', r.data.orderId, 1350);
    const before = sentMails.length;
    const results = await Promise.all([hook(1002), hook(1002), hook(1002)]);
    results.forEach((x) => assert.strictEqual(x.status, 200, JSON.stringify(x.data)));
    assert.strictEqual(sentMails.length, before + 1);
    const t = await eventTickets(eventId);
    // 2 de Ana (una ya se usó en la puerta) + 3 de Beto.
    assert.strictEqual(count(t, 'emitido') + count(t, 'usado'), 5);
    assert.strictEqual(t.filter((x) => x.orderId === r.data.orderId && x.status === 'emitido').length, 3);
  });

  await test('tope por persona: con el mismo mail no se pasa de 5 (suma pedidos)', async () => {
    // Ana ya compró 2 (pagadas).
    const ok = await call(createOrder, 'POST', { body: buyer({ quantity: 3 }) });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.data));
    const no = await call(createOrder, 'POST', { body: buyer({ quantity: 1, email: 'ANA@example.com' }) });
    assert.strictEqual(no.status, 409);
    assert.strictEqual(no.data.error, 'quota_exceeded');
    assert.strictEqual(no.data.remaining, 0);
  });

  await test('cantidad inválida (0, 6, texto) se rechaza', async () => {
    for (const q of [0, 6, 'x', 1.5]) {
      const r = await call(createOrder, 'POST', { body: buyer({ email: 'otro@example.com', quantity: q }) });
      assert.strictEqual(r.status, 400, 'cantidad ' + q);
    }
    assert.strictEqual((await call(createOrder, 'POST', { body: buyer({ email: 'malmail' }) })).status, 400);
  });

  await test('sin stock suficiente: 409 sold_out y no consume el cupo del comprador', async () => {
    // Quedan 10 - 5 emitidas - 3 reservadas por Ana = 2.
    const r = await call(createOrder, 'POST', { body: buyer({ name: 'Carla', email: 'carla@example.com', quantity: 4 }) });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.data.error, 'sold_out');
    assert.strictEqual(r.data.available, 2);
    const again = await call(createOrder, 'POST', { body: buyer({ name: 'Carla', email: 'carla@example.com', quantity: 2 }) });
    assert.strictEqual(again.status, 200, JSON.stringify(again.data));
  });

  await test('pago con monto menor al del pedido: no se entregan entradas (queda para revisar)', async () => {
    const eid = await newEvent('Evento B', 4);
    setEvent(eid);
    const r = await call(createOrder, 'POST', { body: buyer({ name: 'Dani', email: 'dani@example.com', quantity: 2 }) });
    approvePayment('2001', r.data.orderId, 100);
    const before = sentMails.length;
    const w = await hook(2001);
    assert.strictEqual(w.data.outcome, 'revisar');
    assert.strictEqual(count(await eventTickets(eid), 'emitido'), 0);
    assert.strictEqual(sentMails.length, before);
  });

  await test('pago no aprobado (pendiente/rechazado): no entrega nada', async () => {
    setEvent((await call(stateFn, 'GET')).data.events.find((e) => e.name === 'Evento B').id);
    const r = await call(createOrder, 'POST', { body: buyer({ name: 'Eli', email: 'eli@example.com', quantity: 1 }) });
    approvePayment('2002', r.data.orderId, 450, { status: 'rejected' });
    const w = await hook(2002);
    assert.strictEqual(w.data.outcome, 'pending');
    const s = await call(orderStatus, 'GET', { query: { id: r.data.orderId } });
    assert.strictEqual(s.data.status, 'pendiente');
  });

  await test('webhook perdido: order-status con payment_id confirma el pago igual', async () => {
    const eid = await newEvent('Evento C', 3);
    setEvent(eid);
    const r = await call(createOrder, 'POST', { body: buyer({ name: 'Fede', email: 'fede@example.com', quantity: 1 }) });
    approvePayment('3001', r.data.orderId, 450);
    const before = sentMails.length;
    const s = await call(orderStatus, 'GET', { query: { id: r.data.orderId, payment_id: '3001' } });
    assert.strictEqual(s.data.status, 'pagado');
    assert.strictEqual(s.data.codes.length, 1);
    assert.strictEqual(sentMails.length, before + 1);
  });

  await test('payment_id de OTRO pedido no sirve para confirmar este', async () => {
    const eid = currentEvent;
    const a = await call(createOrder, 'POST', { body: buyer({ name: 'Gus', email: 'gus@example.com', quantity: 1 }) });
    const b = await call(createOrder, 'POST', { body: buyer({ name: 'Hugo', email: 'hugo@example.com', quantity: 1 }) });
    approvePayment('3002', b.data.orderId, 450); // pago real, pero del pedido de Hugo
    const s = await call(orderStatus, 'GET', { query: { id: a.data.orderId, payment_id: '3002' } });
    assert.strictEqual(s.data.status, 'pendiente');
    assert.strictEqual(count(await eventTickets(eid), 'emitido'), 1); // solo la de Fede
  });

  await test('reserva vencida + pago tardío sin stock: se reembolsa y no se entrega', async () => {
    const eid = await newEvent('Evento D', 2);
    setEvent(eid);
    const x = await call(createOrder, 'POST', { body: buyer({ name: 'Ian', email: 'ian@example.com', quantity: 2 }) });
    // Vence la reserva de Ian.
    const { updateState } = require('../netlify/functions/_lib/store');
    await updateState((s) => {
      s.events.find((e) => e.id === eid).tickets.forEach((t) => { if (t.status === 'reservado') t.reservedUntil = new Date(Date.now() - 60000).toISOString(); });
      return s;
    });
    assert.strictEqual((await call(saleInfo, 'GET')).data.events.find((e) => e.id === eid).available, 2, 'la reserva vencida cuenta como disponible');
    const y = await call(createOrder, 'POST', { body: buyer({ name: 'Jara', email: 'jara@example.com', quantity: 2 }) });
    assert.strictEqual(y.status, 200, JSON.stringify(y.data));
    // Ian paga tarde.
    approvePayment('4001', x.data.orderId, 900);
    const before = sentMails.length;
    const w = await hook(4001);
    assert.strictEqual(w.data.outcome, 'reembolsado');
    assert.deepStrictEqual(mpState.refunds.filter((p) => p === '4001'), ['4001']);
    assert.strictEqual(sentMails.length, before);
    assert.strictEqual(count(await eventTickets(eid), 'emitido'), 0);
    // Jara sí recibe las suyas.
    approvePayment('4002', y.data.orderId, 900);
    assert.strictEqual((await hook(4002)).data.outcome, 'paid');
    assert.strictEqual(count(await eventTickets(eid), 'emitido'), 2);
  });

  await test('reserva vencida pero nadie tomó las entradas: un pago tardío igual las recibe', async () => {
    const eid = await newEvent('Evento E', 2);
    setEvent(eid);
    const x = await call(createOrder, 'POST', { body: buyer({ name: 'Kai', email: 'kai@example.com', quantity: 2 }) });
    const { updateState } = require('../netlify/functions/_lib/store');
    await updateState((s) => {
      s.events.find((e) => e.id === eid).tickets.forEach((t) => { t.reservedUntil = new Date(Date.now() - 60000).toISOString(); });
      return s;
    });
    approvePayment('5001', x.data.orderId, 900);
    assert.strictEqual((await hook(5001)).data.outcome, 'paid');
    assert.strictEqual(count(await eventTickets(eid), 'emitido'), 2);
  });

  await test('si Mercado Pago falla al crear el pago, se liberan las entradas y el cupo', async () => {
    const eid = await newEvent('Evento F', 3);
    setEvent(eid);
    mpState.failPreferences = true;
    const r = await call(createOrder, 'POST', { body: buyer({ name: 'Lu', email: 'lu@example.com', quantity: 3 }) });
    mpState.failPreferences = false;
    assert.strictEqual(r.status, 502);
    assert.strictEqual(count(await eventTickets(eid), 'disponible'), 3);
    const again = await call(createOrder, 'POST', { body: buyer({ name: 'Lu', email: 'lu@example.com', quantity: 3 }) });
    assert.strictEqual(again.status, 200, 'el cupo de Lu quedó libre');
  });

  await test('si falla el mail, el pago igual se registra y el reintento lo manda', async () => {
    const eid = await newEvent('Evento G', 2);
    setEvent(eid);
    const r = await call(createOrder, 'POST', { body: buyer({ name: 'Mia', email: 'mia@example.com', quantity: 1 }) });
    approvePayment('6001', r.data.orderId, 450);
    const saved = process.env.GMAIL_APP_PASSWORD;
    delete process.env.GMAIL_APP_PASSWORD;
    const before = sentMails.length;
    const w1 = await hook(6001);
    assert.strictEqual(w1.status, 500); // Mercado Pago va a reintentar
    assert.strictEqual(count(await eventTickets(eid), 'emitido'), 1, 'la entrada ya está entregada');
    process.env.GMAIL_APP_PASSWORD = saved;
    const w2 = await hook(6001);
    assert.strictEqual(w2.status, 200);
    assert.strictEqual(sentMails.length, before + 1);
  });

  await test('firma del webhook: con clave secreta, firma válida pasa e inválida se rechaza', async () => {
    process.env.MP_WEBHOOK_SECRET = 'secreto123';
    const eid = await newEvent('Evento H', 2);
    setEvent(eid);
    const r = await call(createOrder, 'POST', { body: buyer({ name: 'Noa', email: 'noa@example.com', quantity: 1 }) });
    approvePayment('7001', r.data.orderId, 450);
    const ts = String(Date.now());
    const reqId = 'req-abc';
    const v1 = crypto.createHmac('sha256', 'secreto123').update('id:7001;request-id:' + reqId + ';ts:' + ts + ';').digest('hex');
    const bad = await hook(7001, { headers: { 'x-signature': 'ts=' + ts + ',v1=' + '0'.repeat(64), 'x-request-id': reqId } });
    assert.strictEqual(bad.status, 401);
    const none = await hook(7001);
    assert.strictEqual(none.status, 401);
    assert.strictEqual(count(await eventTickets(eid), 'emitido'), 0);
    const good = await hook(7001, { headers: { 'X-Signature': 'ts=' + ts + ',v1=' + v1, 'X-Request-Id': reqId } });
    assert.strictEqual(good.status, 200, JSON.stringify(good.data));
    assert.strictEqual(count(await eventTickets(eid), 'emitido'), 1);
    delete process.env.MP_WEBHOOK_SECRET;
  });

  await test('avisos que no son de pagos se ignoran con 200', async () => {
    const r = await call(webhook, 'POST', { query: { type: 'merchant_order', 'data.id': '5' }, body: {} });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.ignored, true);
  });

  await test('ADMIN_PASSCODE: con clave configurada, las funciones de admin la exigen', async () => {
    process.env.ADMIN_PASSCODE = 'clave-secreta';
    assert.strictEqual((await call(stateFn, 'GET')).status, 401);
    assert.strictEqual((await call(stateFn, 'GET', { headers: { 'x-admin-passcode': 'mala' } })).status, 401);
    assert.strictEqual((await call(stateFn, 'GET', { headers: { 'X-Admin-Passcode': 'clave-secreta' } })).status, 200);
    assert.strictEqual((await call(generate, 'POST', { body: { eventName: 'x', quantity: 1 } })).status, 401);
    // Las públicas siguen abiertas.
    assert.strictEqual((await call(saleInfo, 'GET')).status, 200);
    assert.strictEqual((await call(validate, 'POST', { body: { code: 'ZZZZ-ZZZZ' } })).status, 404);
    delete process.env.ADMIN_PASSCODE;
  });

  await test('sale-info lista todos los eventos del panel; los agotados quedan marcados', async () => {
    const e2 = await newEvent('Segunda fecha', 1);
    await newEvent('Evento sin códigos todavía', 1); // se crea con 1 código
    const r = await call(saleInfo, 'GET');
    const names = r.data.events.map((e) => e.name);
    assert.ok(names.includes('Fiesta BOCA') && names.includes('Segunda fecha'));
    // Se compra la única entrada de "Segunda fecha": pasa a agotado.
    const c = await call(createOrder, 'POST', { body: buyer({ eventId: e2, email: 'solo@example.com', quantity: 1 }) });
    assert.strictEqual(c.status, 200, JSON.stringify(c.data));
    const after = (await call(saleInfo, 'GET')).data.events.find((e) => e.id === e2);
    assert.strictEqual(after.soldOut, true);
    assert.strictEqual(after.available, 0);
    // Sin eventId o con uno inexistente se rechaza.
    assert.strictEqual((await call(createOrder, 'POST', { body: buyer({ eventId: '' }) })).status, 400);
    const bad = await call(createOrder, 'POST', { body: buyer({ eventId: 'no-existe', email: 'zz@example.com' }) });
    assert.strictEqual(bad.status, 409);
    assert.strictEqual(bad.data.error, 'event_not_found');
  });

  await test('el nombre es opcional: sin nombre la entrada queda a nombre del mail', async () => {
    const eid = await newEvent('Evento sin nombre', 2);
    const r = await call(createOrder, 'POST', { body: { eventId: eid, email: 'sinnombre@example.com', quantity: 1 } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    approvePayment('9001', r.data.orderId, 450);
    assert.strictEqual((await hook(9001)).data.outcome, 'paid');
    const t = (await eventTickets(eid)).find((x) => x.status === 'emitido');
    assert.strictEqual(t.recipient, 'sinnombre@example.com');
    const mail = sentMails[sentMails.length - 1];
    assert.ok(!mail.html.includes('undefined'));
    assert.ok(mail.html.includes('¡Gracias por tu compra!'));
  });

  console.log('\n' + pass + ' pasaron, ' + fail + ' fallaron');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
