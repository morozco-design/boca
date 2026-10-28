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
// Las pruebas generales no usan el tope por mail; tiene su propia prueba.
process.env.MAX_PER_EMAIL = '1000';

const fn = (name) => require('../netlify/functions/' + name + '.js').handler;
const generate = fn('generate');
const stateFn = fn('state');
const saleInfo = fn('sale-info');
const createOrder = fn('create-order');
const webhook = fn('mp-webhook');
const orderStatus = fn('order-status');
const validate = fn('validate');
const editEvent = fn('edit-event');
const adminAuth = fn('admin-auth');
const eventImage = fn('event-image');
const backup = fn('backup');
const saleSettings = fn('sale-settings');

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
    assert.strictEqual(r.data.max, 8);
    assert.strictEqual(r.data.events.length, 1);
    assert.strictEqual(r.data.events[0].name, 'Fiesta BOCA');
    assert.strictEqual(r.data.events[0].available, 10);
    const raw = JSON.stringify(r.data);
    // (se compara con los códigos reales: un patrón genérico daba falsos positivos con ids numéricos)
    (await eventTickets(eventId)).forEach((t) => assert.ok(!raw.includes(t.code), 'no debe filtrar códigos'));
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

  await test('sin tope por persona: el mismo mail puede comprar más de 5 en total', async () => {
    // Ana ya compró 2 (pagadas); ahora reserva 3 más (5 en total, y seguiría pudiendo).
    const ok = await call(createOrder, 'POST', { body: buyer({ quantity: 3 }) });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.data));
  });

  await test('cantidad inválida (0, 9, texto, decimal) se rechaza', async () => {
    for (const q of [0, 9, 'x', 1.5]) {
      const r = await call(createOrder, 'POST', { body: buyer({ email: 'otro@example.com', quantity: q }) });
      assert.strictEqual(r.status, 400, 'cantidad ' + q);
    }
    assert.strictEqual((await call(createOrder, 'POST', { body: buyer({ email: 'malmail' }) })).status, 400);
  });

  await test('sin stock suficiente: 409 sold_out y después se puede comprar lo que queda', async () => {
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

  await test('si Mercado Pago falla al crear el pago, se liberan las entradas', async () => {
    const eid = await newEvent('Evento F', 3);
    setEvent(eid);
    mpState.failPreferences = true;
    const r = await call(createOrder, 'POST', { body: buyer({ name: 'Lu', email: 'lu@example.com', quantity: 3 }) });
    mpState.failPreferences = false;
    assert.strictEqual(r.status, 502);
    assert.strictEqual(count(await eventTickets(eid), 'disponible'), 3);
    const again = await call(createOrder, 'POST', { body: buyer({ name: 'Lu', email: 'lu@example.com', quantity: 3 }) });
    assert.strictEqual(again.status, 200, 'las entradas de Lu quedaron libres');
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

  await test('el panel (state) muestra como disponibles las reservas vencidas y como reservadas las vigentes', async () => {
    const eid = await newEvent('Evento reservas', 3);
    setEvent(eid);
    const a = await call(createOrder, 'POST', { body: buyer({ email: 'res1@example.com', quantity: 2 }) });
    assert.strictEqual(a.status, 200);
    let t = await eventTickets(eid);
    assert.strictEqual(count(t, 'reservado'), 2);
    const { updateState } = require('../netlify/functions/_lib/store');
    await updateState((s) => {
      s.events.find((e) => e.id === eid).tickets.forEach((x) => { if (x.status === 'reservado') x.reservedUntil = new Date(Date.now() - 60000).toISOString(); });
      return s;
    });
    t = await eventTickets(eid);
    assert.strictEqual(count(t, 'reservado'), 0);
    assert.strictEqual(count(t, 'disponible'), 3);
    const r = await call(stateFn, 'GET', { query: { eventId: eid } });
    assert.strictEqual(r.data.event.stats.disponible, 3);
  });

  await test('mail que falló: recargar la página de la entrada lo reintenta (y con debug=1 muestra el motivo)', async () => {
    const eid = await newEvent('Evento mail', 2);
    setEvent(eid);
    const r = await call(createOrder, 'POST', { body: buyer({ email: 'mailfalla@example.com', quantity: 1 }) });
    approvePayment('9101', r.data.orderId, 450);
    const saved = process.env.GMAIL_APP_PASSWORD;
    delete process.env.GMAIL_APP_PASSWORD;
    const before = sentMails.length;
    assert.strictEqual((await hook(9101)).status, 500);
    const sinDebug = await call(orderStatus, 'GET', { query: { id: r.data.orderId } });
    assert.strictEqual(sinDebug.data.emailSent, false);
    assert.ok(!('emailError' in sinDebug.data), 'sin debug no se muestra el motivo');
    const conDebug = await call(orderStatus, 'GET', { query: { id: r.data.orderId, debug: '1' } });
    assert.ok(/GMAIL_APP_PASSWORD/.test(conDebug.data.emailError));
    assert.strictEqual(sentMails.length, before);
    // Se arregla la configuración y se recarga la página.
    process.env.GMAIL_APP_PASSWORD = saved;
    const ok = await call(orderStatus, 'GET', { query: { id: r.data.orderId } });
    assert.strictEqual(ok.data.emailSent, true);
    assert.strictEqual(sentMails.length, before + 1);
    // Recargar de nuevo no manda otro.
    await call(orderStatus, 'GET', { query: { id: r.data.orderId } });
    assert.strictEqual(sentMails.length, before + 1);
  });

  await test('una sola compra de 8 entradas (más de 5) es válida si hay stock', async () => {
    const eid = await newEvent('Evento grande', 12);
    setEvent(eid);
    const r = await call(createOrder, 'POST', { body: buyer({ name: 'Gran', email: 'gran@example.com', quantity: 8 }) });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    approvePayment('9001', r.data.orderId, 450 * 8);
    await hook(9001);
    assert.strictEqual(count(await eventTickets(eid), 'emitido'), 8);
  });

  await test('editar evento: cambia nombre y aforo (sube y baja sin tocar entradas vendidas)', async () => {
    const eid = await newEvent('Para editar', 10);
    setEvent(eid);
    const r = await call(createOrder, 'POST', { body: buyer({ name: 'Edi', email: 'edi@example.com', quantity: 3 }) });
    assert.strictEqual(r.status, 200);
    approvePayment('9101', r.data.orderId, 450 * 3);
    await hook(9101);
    // Nombre + subir aforo a 15.
    const up = await call(editEvent, 'POST', { body: { eventId: eid, name: 'Nombre nuevo', capacity: 15 } });
    assert.strictEqual(up.status, 200, JSON.stringify(up.data));
    assert.strictEqual(up.data.event.name, 'Nombre nuevo');
    assert.strictEqual(up.data.event.tickets.length, 15);
    assert.strictEqual(count(up.data.event.tickets, 'emitido'), 3);
    // Bajar a 5: se quitan solo disponibles.
    const down = await call(editEvent, 'POST', { body: { eventId: eid, capacity: 5 } });
    assert.strictEqual(down.status, 200);
    assert.strictEqual(down.data.event.tickets.length, 5);
    assert.strictEqual(count(down.data.event.tickets, 'emitido'), 3);
    // Menos que lo vendido: se rechaza.
    const bad = await call(editEvent, 'POST', { body: { eventId: eid, capacity: 2 } });
    assert.strictEqual(bad.status, 409);
    assert.strictEqual(bad.data.error, 'capacity_below_sold');
    // Entradas inválidas.
    assert.strictEqual((await call(editEvent, 'POST', { body: { eventId: eid, capacity: 0 } })).status, 400);
    assert.strictEqual((await call(editEvent, 'POST', { body: { eventId: eid, name: '  ' } })).status, 400);
    assert.strictEqual((await call(editEvent, 'POST', { body: { eventId: 'nope', name: 'x' } })).status, 404);
    // El nombre nuevo se ve en la venta.
    assert.ok((await call(saleInfo, 'GET')).data.events.some((e) => e.name === 'Nombre nuevo'));
  });

  await test('contraseña del panel (ADMIN_PASSCODE de Netlify): pantalla de acceso, login y rutas protegidas', async () => {
    assert.strictEqual((await call(adminAuth, 'GET')).data.protected, false);
    process.env.ADMIN_PASSCODE = 'de-netlify';
    assert.strictEqual((await call(adminAuth, 'GET')).data.protected, true);
    assert.strictEqual((await call(adminAuth, 'POST', { body: { action: 'login' } })).status, 401);
    assert.strictEqual((await call(adminAuth, 'POST', { body: { action: 'login' }, headers: { 'x-admin-passcode': 'mala' } })).status, 401);
    assert.strictEqual((await call(adminAuth, 'POST', { body: { action: 'login' }, headers: { 'x-admin-passcode': 'de-netlify' } })).status, 200);
    assert.strictEqual((await call(editEvent, 'POST', { body: { eventId: 'x', name: 'y' } })).status, 401);
    assert.strictEqual((await call(saleInfo, 'GET')).status, 200);
    delete process.env.ADMIN_PASSCODE;
    assert.strictEqual((await call(stateFn, 'GET')).status, 200);
  });

  await test('imagen de la página de venta: se sube aparte del fondo de la entrada y el pago conserva su título', async () => {
    const eid = await newEvent('Con imagen', 5);
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const up = await call(eventImage, 'POST', { body: { eventId: eid, imageDataUrl: png, kind: 'sale' } });
    assert.strictEqual(up.status, 200, JSON.stringify(up.data));
    let ev = (await call(saleInfo, 'GET')).data.events.find((e) => e.id === eid);
    assert.strictEqual(ev.hasSaleImage, true);
    assert.strictEqual(ev.hasImage, undefined);
    const got = await eventImage({ httpMethod: 'GET', headers: {}, queryStringParameters: { eventId: eid, kind: 'sale' } });
    assert.strictEqual(got.statusCode, 200);
    assert.strictEqual(got.headers['Content-Type'], 'image/png');
    // El fondo de la entrada sigue sin imagen.
    assert.strictEqual((await call(eventImage, 'GET', { query: { eventId: eid } })).status, 404);
    // Título del pago en Mercado Pago.
    setEvent(eid);
    const r = await call(createOrder, 'POST', { body: buyer({ email: 'img@example.com', quantity: 1 }) });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    const pref = mpState.preferences[mpState.preferences.length - 1];
    assert.strictEqual(pref.items[0].title, 'Entrada - Con imagen');
    assert.strictEqual(pref.items[0].unit_price, 450);
    // Quitarla.
    assert.strictEqual((await call(eventImage, 'DELETE', { query: { eventId: eid, kind: 'sale' } })).status, 200);
    ev = (await call(saleInfo, 'GET')).data.events.find((e) => e.id === eid);
    assert.strictEqual(ev.hasSaleImage, false);
  });

  await test('orden de los eventos en la venta: la posición del panel manda', async () => {
    const a = await newEvent('Orden A', 2);
    const b = await newEvent('Orden B', 2);
    const names = () => call(saleInfo, 'GET').then((r) => r.data.events.map((e) => e.name));
    const base = await names();
    assert.ok(base.indexOf('Orden A') < base.indexOf('Orden B'));
    assert.strictEqual((await call(editEvent, 'POST', { body: { eventId: b, saleOrder: 1 } })).status, 200);
    const after = await names();
    assert.strictEqual(after[0], 'Orden B');
    assert.strictEqual((await call(editEvent, 'POST', { body: { eventId: b, saleOrder: 0 } })).status, 400);
    // Sin posición vuelve al orden de creación.
    await call(editEvent, 'POST', { body: { eventId: b, saleOrder: null } });
    const back = await names();
    assert.ok(back.indexOf('Orden A') < back.indexOf('Orden B'));
  });

  await test('mail con imagen del evento: llega la entrada completa (fondo + QR) además del QR', async () => {
    const fs = require('fs');
    const eid = await newEvent('Con poster', 4);
    const poster = fs.readFileSync(require('path').join(__dirname, 'fixtures', 'poster-con-recuadro.jpg'));
    const up = await call(eventImage, 'POST', { body: { eventId: eid, imageDataUrl: 'data:image/jpeg;base64,' + poster.toString('base64') } });
    assert.strictEqual(up.status, 200, JSON.stringify(up.data));
    setEvent(eid);
    const r = await call(createOrder, 'POST', { body: buyer({ name: 'Pia', email: 'pia@example.com', quantity: 2 }) });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    approvePayment('9301', r.data.orderId, 900);
    const before = sentMails.length;
    await hook(9301);
    assert.strictEqual(sentMails.length, before + 1);
    const mail = sentMails[sentMails.length - 1];
    const jpgs = mail.attachments.filter((a) => /^entrada-.*\.jpg$/.test(a.filename));
    const pngs = mail.attachments.filter((a) => /^qr-.*\.png$/.test(a.filename));
    assert.strictEqual(jpgs.length, 2);
    assert.strictEqual(pngs.length, 2);
    assert.ok(jpgs[0].content[0] === 0xff && jpgs[0].content[1] === 0xd8, 'es un JPEG');
    // El QR dentro de la imagen se lee y es el de esa entrada.
    const jpeg = require('jpeg-js');
    const jsQR = require('../public/vendor/jsQR.min.js');
    const d = jpeg.decode(jpgs[0].content, { useTArray: true });
    const qr = (jsQR.default || jsQR)(new Uint8ClampedArray(d.data), d.width, d.height);
    assert.ok(qr && qr.data.startsWith('PU:'), 'QR legible');
    assert.ok(mail.html.includes('cid:ticket0@entradas'));
    assert.ok(mail.codes === undefined);
    const code = qr.data.slice(3);
    assert.ok(jpgs[0].filename.includes(code));
  });

  await test('respaldo: JSON con eventos, entradas y pedidos; CSV con una fila por entrada; exige contraseña', async () => {
    const j = await call(backup, 'GET');
    assert.strictEqual(j.status, 200);
    assert.ok(j.data.events.length >= 3);
    assert.ok(j.data.orders.length >= 3);
    assert.ok(j.data.events.every((e) => Array.isArray(e.tickets)));
    const raw = await backup({ httpMethod: 'GET', headers: {}, queryStringParameters: { format: 'csv' } });
    assert.strictEqual(raw.statusCode, 200);
    assert.ok(/text\/csv/.test(raw.headers['Content-Type']));
    const lines = raw.body.trim().split(/\r?\n/);
    const total = j.data.events.reduce((n, e) => n + e.tickets.length, 0);
    assert.strictEqual(lines.length, total + 1);
    assert.ok(lines[0].includes('mail_comprador'));
    assert.ok(raw.body.includes('ana@example.com'));
    process.env.ADMIN_PASSCODE = 'x-clave';
    assert.strictEqual((await call(backup, 'GET')).status, 401);
    assert.strictEqual((await call(backup, 'GET', { headers: { 'x-admin-passcode': 'x-clave' } })).status, 200);
    delete process.env.ADMIN_PASSCODE;
  });

  await test('tope de 5 entradas por mail: suma compras, mayúsculas no engañan y se libera si no se paga', async () => {
    process.env.MAX_PER_EMAIL = '5';
    try {
      const eid = await newEvent('Tope por mail', 30);
      setEvent(eid);
      const info = (await call(saleInfo, 'GET')).data;
      assert.strictEqual(info.maxPerEmail, 5);
      const mk = (email, q) => call(createOrder, 'POST', { body: buyer({ name: 'Tope', email, quantity: q }) });
      // 6 de una vez: no.
      const six = await mk('tope@example.com', 6);
      assert.strictEqual(six.status, 409);
      assert.strictEqual(six.data.error, 'quota_exceeded');
      // 3 y luego 3 con el mismo mail (otra forma de escribirlo): la segunda no pasa, 2 sí.
      const a = await mk('tope@example.com', 3);
      assert.strictEqual(a.status, 200, JSON.stringify(a.data));
      const b = await mk('TOPE@Example.com', 3);
      assert.strictEqual(b.status, 409);
      assert.strictEqual(b.data.remaining, 2);
      const c = await mk('tope@example.com', 2);
      assert.strictEqual(c.status, 200);
      // Ya está en el máximo.
      const d = await mk('tope@example.com', 1);
      assert.strictEqual(d.status, 409);
      assert.strictEqual(d.data.remaining, 0);
      // Otro mail no se ve afectado.
      assert.strictEqual((await mk('otro-tope@example.com', 5)).status, 200);
      // Compras simultáneas con el mismo mail: no se pasan del tope.
      const race = await Promise.all([1, 2, 3, 4].map(() => mk('carrera@example.com', 2)));
      assert.strictEqual(race.filter((x) => x.status === 200).length, 2);
      // Si el pedido pagado cuenta: se paga a y sigue contando; las reservas vencidas liberan cupo.
      approvePayment('9401', a.data.orderId, 450 * 3);
      await hook(9401);
      assert.strictEqual((await mk('tope@example.com', 1)).status, 409);
      // Falla de Mercado Pago: el cupo vuelve.
      mpState.failPreferences = true;
      const f = await mk('falla@example.com', 5);
      assert.strictEqual(f.status, 502);
      mpState.failPreferences = false;
      assert.strictEqual((await mk('falla@example.com', 5)).status, 200);
      // Sin stock: tampoco consume cupo.
      const small = await newEvent('Chico', 2);
      setEvent(small);
      assert.strictEqual((await mk('stock@example.com', 4)).status, 409);
      assert.strictEqual((await mk('stock@example.com', 2)).status, 200);
    } finally {
      process.env.MAX_PER_EMAIL = '1000';
    }
  });

  await test('apertura programada: antes de la hora solo cuenta regresiva y no se puede comprar; después abre; exige contraseña', async () => {
    const eid = await newEvent('Programado', 5);
    setEvent(eid);
    const future = new Date(Date.now() + 3600 * 1000).toISOString();
    const set = await call(saleSettings, 'POST', { body: { opensAt: future } });
    assert.strictEqual(set.status, 200, JSON.stringify(set.data));
    assert.strictEqual((await call(saleSettings, 'GET')).data.opensAt, future);
    const info = (await call(saleInfo, 'GET')).data;
    assert.strictEqual(info.scheduled, true);
    assert.strictEqual(info.open, false);
    assert.strictEqual(info.opensAt, future);
    assert.ok(typeof info.now === 'number');
    assert.strictEqual(info.events, undefined, 'no lista eventos antes de abrir');
    const no = await call(createOrder, 'POST', { body: buyer({ email: 'temprano@example.com', quantity: 1 }) });
    assert.strictEqual(no.status, 409);
    assert.strictEqual(no.data.error, 'not_open_yet');
    // Fecha ya pasada: abierta.
    await call(saleSettings, 'POST', { body: { opensAt: new Date(Date.now() - 1000).toISOString() } });
    const open = (await call(saleInfo, 'GET')).data;
    assert.strictEqual(open.open, true);
    assert.ok(open.events.length > 0);
    assert.strictEqual((await call(createOrder, 'POST', { body: buyer({ email: 'a-tiempo@example.com', quantity: 1 }) })).status, 200);
    // Fecha inválida y contraseña.
    assert.strictEqual((await call(saleSettings, 'POST', { body: { opensAt: 'mañana' } })).status, 400);
    process.env.ADMIN_PASSCODE = 'clave-ap';
    assert.strictEqual((await call(saleSettings, 'POST', { body: { opensAt: future } })).status, 401);
    assert.strictEqual((await call(saleSettings, 'GET')).status, 401);
    delete process.env.ADMIN_PASSCODE;
    // Quitar la fecha: abierta sin más.
    assert.strictEqual((await call(saleSettings, 'POST', { body: { opensAt: null } })).data.opensAt, null);
    assert.strictEqual((await call(saleInfo, 'GET')).data.open, true);
  });

  console.log('\n' + pass + ' pasaron, ' + fail + ' fallaron');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
