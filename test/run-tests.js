'use strict';

// Local test harness for the Netlify Functions business logic.
// No real Netlify account/deployment is available in this sandbox, so we
// inject an in-memory mock of @netlify/blobs (with real ETag / CAS
// semantics, see mock-blobs.js) directly into Node's require cache before
// any function handler (or _lib/store.js) requires the real package.

const assert = require('assert');

const mockBlobs = require('./mock-blobs');
const realPath = require.resolve('@netlify/blobs');
require.cache[realPath] = {
  id: realPath,
  filename: realPath,
  loaded: true,
  exports: mockBlobs,
};

const stateFn = require('../netlify/functions/state.js');
const generateFn = require('../netlify/functions/generate.js');
const dispenseFn = require('../netlify/functions/dispense.js');
const cancelFn = require('../netlify/functions/cancel.js');
const validateFn = require('../netlify/functions/validate.js');
const deleteEventFn = require('../netlify/functions/delete-event.js');
const eventImageFn = require('../netlify/functions/event-image.js');

let passCount = 0;
let failCount = 0;

async function test(name, fn) {
  try {
    await fn();
    passCount++;
    console.log('  ok  - ' + name);
  } catch (err) {
    failCount++;
    console.log('FAIL  - ' + name);
    console.log('        ' + (err && err.stack ? err.stack.split('\n').join('\n        ') : err));
  }
}

// El panel ya no pide clave de administrador (por pedido explícito), así
// que admin/público comparten la misma forma de evento; se mantienen dos
// nombres de función sólo para que el resto de las pruebas se lean igual
// que antes (qué endpoint se llama "como admin" vs "como escaneo público").
function adminEvent(method, body, query) {
  return {
    httpMethod: method,
    headers: {},
    queryStringParameters: query || null,
    body: body ? JSON.stringify(body) : null,
  };
}

function publicEvent(method, body) {
  return {
    httpMethod: method,
    headers: {},
    body: body ? JSON.stringify(body) : null,
  };
}

async function main() {
  console.log('Pase Único — pruebas de lógica de backend\n');

  mockBlobs.resetAll();

  let eventAId = null;
  await test('generate.js sin eventId crea un evento nuevo con un lote de N códigos únicos', async () => {
    const res = await generateFn.handler(adminEvent('POST', { eventName: 'Fiesta', quantity: 50 }));
    const body = JSON.parse(res.body);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.event.name, 'Fiesta');
    assert.strictEqual(body.event.stats.total, 50);
    assert.strictEqual(body.event.stats.disponible, 50);
    const codes = new Set(body.event.tickets.map((t) => t.code));
    assert.strictEqual(codes.size, 50, 'todos los códigos deben ser únicos');
    assert.strictEqual(body.events.length, 1);
    eventAId = body.event.id;
  });

  await test('state.js (sin eventId) lista los eventos existentes', async () => {
    const res = await stateFn.handler(adminEvent('GET'));
    const body = JSON.parse(res.body);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(body.events.length, 1);
    assert.strictEqual(body.events[0].name, 'Fiesta');
    assert.strictEqual(body.events[0].stats.total, 50);
    assert.strictEqual(body.event, undefined, 'sin eventId no debe incluir detalle');
  });

  await test('state.js?eventId=... devuelve el detalle (tickets incluidos) de ese evento', async () => {
    const res = await stateFn.handler(adminEvent('GET', null, { eventId: eventAId }));
    const body = JSON.parse(res.body);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(body.event.id, eventAId);
    assert.strictEqual(body.event.tickets.length, 50);
  });

  await test('state.js?eventId=inexistente devuelve 404', async () => {
    const res = await stateFn.handler(adminEvent('GET', null, { eventId: 'no-existe' }));
    assert.strictEqual(res.statusCode, 404);
  });

  let dispensedCode = null;
  await test('dispense.js entrega el próximo código disponible del evento indicado', async () => {
    const res = await dispenseFn.handler(adminEvent('POST', { eventId: eventAId, recipient: 'Juana Pérez' }));
    const body = JSON.parse(res.body);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(body.ticket.status, 'emitido');
    assert.strictEqual(body.ticket.recipient, 'Juana Pérez');
    assert.strictEqual(body.stats.disponible, 49);
    assert.strictEqual(body.stats.emitido, 1);
    dispensedCode = body.ticket.code;
  });

  await test('dispense.js sin eventId devuelve 400', async () => {
    const res = await dispenseFn.handler(adminEvent('POST', { recipient: 'Sin evento' }));
    assert.strictEqual(res.statusCode, 400);
  });

  await test('dispense.js con eventId inexistente devuelve 404', async () => {
    const res = await dispenseFn.handler(adminEvent('POST', { eventId: 'no-existe', recipient: 'X' }));
    assert.strictEqual(res.statusCode, 404);
  });

  await test('validate.js (público, sin passcode) valida un código entregado y lo marca usado', async () => {
    const res = await validateFn.handler(publicEvent('POST', { code: 'PU:' + dispensedCode }));
    const body = JSON.parse(res.body);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.recipient, 'Juana Pérez');
  });

  await test('validate.js rechaza el mismo código usado por segunda vez', async () => {
    const res = await validateFn.handler(publicEvent('POST', { code: dispensedCode }));
    const body = JSON.parse(res.body);
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(body.ok, false);
    assert.strictEqual(body.reason, 'already_used');
  });

  await test('validate.js rechaza un código que nunca fue entregado (todavía en el pool)', async () => {
    const stateRes = await stateFn.handler(adminEvent('GET', null, { eventId: eventAId }));
    const stateBody = JSON.parse(stateRes.body);
    const stillAvailable = stateBody.event.tickets.find((t) => t.status === 'disponible');
    const res = await validateFn.handler(publicEvent('POST', { code: stillAvailable.code }));
    const body = JSON.parse(res.body);
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(body.reason, 'not_issued');
  });

  await test('validate.js rechaza un código inexistente', async () => {
    const res = await validateFn.handler(publicEvent('POST', { code: 'ZZZZ-9999' }));
    const body = JSON.parse(res.body);
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(body.reason, 'not_found');
  });

  let secondDispensedCode = null;
  await test('dispense.js entrega otro código para probar cancelación', async () => {
    const res = await dispenseFn.handler(adminEvent('POST', { eventId: eventAId, recipient: 'Carlos Ruiz' }));
    const body = JSON.parse(res.body);
    secondDispensedCode = body.ticket.code;
    assert.strictEqual(body.ticket.status, 'emitido');
  });

  await test('cancel.js devuelve un código entregado al pool (busca el evento por código, sin necesitar eventId)', async () => {
    const res = await cancelFn.handler(adminEvent('POST', { code: secondDispensedCode }));
    const body = JSON.parse(res.body);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(body.eventId, eventAId);
    const ticket = body.tickets.find((t) => t.code === secondDispensedCode);
    assert.strictEqual(ticket.status, 'disponible');
    assert.strictEqual(ticket.recipient, null);
  });

  await test('cancel.js rechaza cancelar un código ya usado en la puerta', async () => {
    const res = await cancelFn.handler(adminEvent('POST', { code: dispensedCode }));
    const body = JSON.parse(res.body);
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(body.error, 'already_used');
  });

  await test('cancel.js rechaza cancelar un código que no fue entregado', async () => {
    const stateRes = await stateFn.handler(adminEvent('GET', null, { eventId: eventAId }));
    const stateBody = JSON.parse(stateRes.body);
    const stillAvailable = stateBody.event.tickets.find((t) => t.status === 'disponible');
    const res = await cancelFn.handler(adminEvent('POST', { code: stillAvailable.code }));
    const body = JSON.parse(res.body);
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(body.error, 'not_issued');
  });

  await test('generate.js con quantity inválida devuelve 400', async () => {
    const res = await generateFn.handler(adminEvent('POST', { eventName: 'X', quantity: 0 }));
    assert.strictEqual(res.statusCode, 400);
  });

  await test('generate.js sin eventId y sin eventName devuelve 400', async () => {
    const res = await generateFn.handler(adminEvent('POST', { quantity: 5 }));
    assert.strictEqual(res.statusCode, 400);
  });

  await test('generate.js con eventId inexistente devuelve 404', async () => {
    const res = await generateFn.handler(adminEvent('POST', { eventId: 'no-existe', quantity: 5 }));
    assert.strictEqual(res.statusCode, 404);
  });

  // ---- Multi-event isolation ----
  let eventBId = null;
  await test('generate.js crea un segundo evento independiente del primero', async () => {
    const res = await generateFn.handler(adminEvent('POST', { eventName: 'Cumpleaños', quantity: 10 }));
    const body = JSON.parse(res.body);
    assert.strictEqual(res.statusCode, 200);
    eventBId = body.event.id;
    assert.notStrictEqual(eventBId, eventAId);
    assert.strictEqual(body.events.length, 2, 'ahora debe haber dos eventos listados');
  });

  await test('generate.js genera códigos que nunca chocan entre eventos distintos', async () => {
    const stateA = JSON.parse((await stateFn.handler(adminEvent('GET', null, { eventId: eventAId }))).body);
    const stateB = JSON.parse((await stateFn.handler(adminEvent('GET', null, { eventId: eventBId }))).body);
    const codesA = new Set(stateA.event.tickets.map((t) => t.code));
    const codesB = stateB.event.tickets.map((t) => t.code);
    codesB.forEach((c) => assert.ok(!codesA.has(c), 'un código de B no debería existir en A'));
  });

  await test('dispense.js sobre el evento B no afecta el pool del evento A', async () => {
    const beforeA = JSON.parse((await stateFn.handler(adminEvent('GET', null, { eventId: eventAId }))).body);
    await dispenseFn.handler(adminEvent('POST', { eventId: eventBId, recipient: 'De evento B' }));
    const afterA = JSON.parse((await stateFn.handler(adminEvent('GET', null, { eventId: eventAId }))).body);
    assert.strictEqual(afterA.event.stats.disponible, beforeA.event.stats.disponible, 'el pool de A no debe cambiar');
  });

  await test('generate.js agrega más códigos a un evento existente (eventId) sin tocar los ya entregados/usados', async () => {
    const before = JSON.parse((await stateFn.handler(adminEvent('GET', null, { eventId: eventAId }))).body);
    const res = await generateFn.handler(adminEvent('POST', { eventId: eventAId, quantity: 5 }));
    const body = JSON.parse(res.body);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(body.event.stats.total, before.event.stats.total + 5);
    assert.strictEqual(body.event.stats.emitido, before.event.stats.emitido, 'los ya entregados siguen entregados');
    assert.strictEqual(body.event.stats.usado, before.event.stats.usado, 'los ya usados siguen usados');
  });

  await test('generate.js con eventId y replace:true reemplaza sólo los códigos de ese evento', async () => {
    const res = await generateFn.handler(adminEvent('POST', { eventId: eventBId, quantity: 3, replace: true }));
    const body = JSON.parse(res.body);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(body.event.stats.total, 3);
    assert.strictEqual(body.event.stats.disponible, 3);
  });

  // ---- Delete event ----
  await test('delete-event.js elimina el evento y sus códigos dejan de ser válidos', async () => {
    const stateB = JSON.parse((await stateFn.handler(adminEvent('GET', null, { eventId: eventBId }))).body);
    const someCode = stateB.event.tickets[0].code;

    const res = await deleteEventFn.handler(adminEvent('POST', { eventId: eventBId }));
    const body = JSON.parse(res.body);
    assert.strictEqual(res.statusCode, 200);
    assert.ok(!body.events.some((e) => e.id === eventBId), 'el evento borrado no debe seguir en la lista');
    assert.ok(body.events.some((e) => e.id === eventAId), 'el evento A debe seguir existiendo');

    const validateRes = await validateFn.handler(publicEvent('POST', { code: someCode }));
    const validateBody = JSON.parse(validateRes.body);
    assert.strictEqual(validateRes.statusCode, 404);
    assert.strictEqual(validateBody.reason, 'not_found');
  });

  await test('delete-event.js sobre un evento inexistente devuelve 404', async () => {
    const res = await deleteEventFn.handler(adminEvent('POST', { eventId: 'no-existe' }));
    assert.strictEqual(res.statusCode, 404);
  });

  // ---- dispense.js quantity: entregar varias entradas de una vez ----
  await test('dispense.js con quantity entrega varios códigos de una vez al mismo destinatario', async () => {
    const res = await dispenseFn.handler(adminEvent('POST', { eventId: eventAId, recipient: 'Familia Gómez', quantity: 3 }));
    const body = JSON.parse(res.body);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(body.dispensedCount, 3);
    assert.strictEqual(body.requested, 3);
    assert.strictEqual(body.tickets.length, 3);
    const codes = new Set(body.tickets.map((t) => t.code));
    assert.strictEqual(codes.size, 3, 'los 3 códigos entregados deben ser distintos entre sí');
    body.tickets.forEach((t) => {
      assert.strictEqual(t.status, 'emitido');
      assert.strictEqual(t.recipient, 'Familia Gómez');
    });
  });

  await test('dispense.js con quantity mayor al pool disponible entrega lo que queda y lo informa', async () => {
    const genRes = await generateFn.handler(adminEvent('POST', { eventName: 'Pool Chico', quantity: 2 }));
    const smallEventId = JSON.parse(genRes.body).event.id;
    const res = await dispenseFn.handler(adminEvent('POST', { eventId: smallEventId, recipient: 'Grupo Grande', quantity: 5 }));
    const body = JSON.parse(res.body);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(body.requested, 5);
    assert.strictEqual(body.dispensedCount, 2, 'sólo debe entregar los 2 que había disponibles');
    assert.strictEqual(body.stats.disponible, 0);
  });

  await test('dispense.js con quantity inválida (0, negativa o no entera) devuelve 400', async () => {
    const res0 = await dispenseFn.handler(adminEvent('POST', { eventId: eventAId, quantity: 0 }));
    assert.strictEqual(res0.statusCode, 400);
    const resNeg = await dispenseFn.handler(adminEvent('POST', { eventId: eventAId, quantity: -1 }));
    assert.strictEqual(resNeg.statusCode, 400);
    const resFloat = await dispenseFn.handler(adminEvent('POST', { eventId: eventAId, quantity: 2.5 }));
    assert.strictEqual(resFloat.statusCode, 400);
  });

  // ---- event-image.js: imagen de fondo por evento ----
  const TINY_PNG_DATA_URL =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

  await test('event-image.js: GET sin imagen subida devuelve 404', async () => {
    const res = await eventImageFn.handler(adminEvent('GET', null, { eventId: eventAId }));
    assert.strictEqual(res.statusCode, 404);
  });

  await test('event-image.js: POST sube una imagen válida y marca hasImage en el evento', async () => {
    const res = await eventImageFn.handler(adminEvent('POST', { eventId: eventAId, imageDataUrl: TINY_PNG_DATA_URL }));
    const body = JSON.parse(res.body);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.hasImage, true);

    const stateRes = JSON.parse((await stateFn.handler(adminEvent('GET', null, { eventId: eventAId }))).body);
    assert.strictEqual(stateRes.event.hasImage, true, 'el detalle del evento debe reflejar hasImage');
    const listRes = JSON.parse((await stateFn.handler(adminEvent('GET'))).body);
    assert.strictEqual(listRes.events.find((e) => e.id === eventAId).hasImage, true, 'el listado también debe reflejar hasImage');
  });

  await test('event-image.js: GET después de subir devuelve los mismos bytes con el content-type correcto', async () => {
    const res = await eventImageFn.handler(adminEvent('GET', null, { eventId: eventAId }));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers['Content-Type'], 'image/png');
    assert.strictEqual(res.isBase64Encoded, true);
    const expectedBase64 = TINY_PNG_DATA_URL.split(',')[1];
    assert.strictEqual(res.body, expectedBase64);
  });

  await test('event-image.js: POST con data URL inválida devuelve 400', async () => {
    const res = await eventImageFn.handler(adminEvent('POST', { eventId: eventAId, imageDataUrl: 'not-a-data-url' }));
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(JSON.parse(res.body).error, 'invalid_image');
  });

  await test('event-image.js: POST con eventId inexistente devuelve 404 y no escribe ninguna imagen', async () => {
    const res = await eventImageFn.handler(adminEvent('POST', { eventId: 'no-existe', imageDataUrl: TINY_PNG_DATA_URL }));
    assert.strictEqual(res.statusCode, 404);
  });

  await test('event-image.js: GET/DELETE sin eventId devuelven 400', async () => {
    const getRes = await eventImageFn.handler(adminEvent('GET', null, {}));
    assert.strictEqual(getRes.statusCode, 400);
    const delRes = await eventImageFn.handler(adminEvent('DELETE', null, {}));
    assert.strictEqual(delRes.statusCode, 400);
  });

  await test('event-image.js: DELETE quita la imagen y desmarca hasImage', async () => {
    const res = await eventImageFn.handler(adminEvent('DELETE', null, { eventId: eventAId }));
    const body = JSON.parse(res.body);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(body.hasImage, false);

    const stateRes = JSON.parse((await stateFn.handler(adminEvent('GET', null, { eventId: eventAId }))).body);
    assert.strictEqual(stateRes.event.hasImage, false);

    const getRes = await eventImageFn.handler(adminEvent('GET', null, { eventId: eventAId }));
    assert.strictEqual(getRes.statusCode, 404, 'tras borrarla, la imagen ya no debe estar disponible');
  });

  await test('event-image.js: DELETE sobre un evento sin imagen (o inexistente) devuelve 404', async () => {
    const res = await eventImageFn.handler(adminEvent('DELETE', null, { eventId: 'no-existe' }));
    assert.strictEqual(res.statusCode, 404);
  });

  await test('delete-event.js borra en cascada la imagen del evento eliminado', async () => {
    const genRes = await generateFn.handler(adminEvent('POST', { eventName: 'Con Imagen', quantity: 2 }));
    const imgEventId = JSON.parse(genRes.body).event.id;
    await eventImageFn.handler(adminEvent('POST', { eventId: imgEventId, imageDataUrl: TINY_PNG_DATA_URL }));

    const beforeDelete = await eventImageFn.handler(adminEvent('GET', null, { eventId: imgEventId }));
    assert.strictEqual(beforeDelete.statusCode, 200, 'la imagen debe existir antes de borrar el evento');

    await deleteEventFn.handler(adminEvent('POST', { eventId: imgEventId }));

    const afterDelete = await eventImageFn.handler(adminEvent('GET', null, { eventId: imgEventId }));
    assert.strictEqual(afterDelete.statusCode, 404, 'la imagen debe desaparecer junto con el evento');
  });

  // ---- Concurrency: two simultaneous dispenses racing for one remaining ticket ----
  await test('dispense.js bajo concurrencia: con 1 disponible, sólo una de 3 llamadas simultáneas tiene éxito', async () => {
    mockBlobs.resetAll();
    const genRes = await generateFn.handler(adminEvent('POST', { eventName: 'Concurrencia', quantity: 1 }));
    const concurrencyEventId = JSON.parse(genRes.body).event.id;

    const results = await Promise.all([
      dispenseFn.handler(adminEvent('POST', { eventId: concurrencyEventId, recipient: 'A' })),
      dispenseFn.handler(adminEvent('POST', { eventId: concurrencyEventId, recipient: 'B' })),
      dispenseFn.handler(adminEvent('POST', { eventId: concurrencyEventId, recipient: 'C' })),
    ]);
    const bodies = results.map((r) => JSON.parse(r.body));
    const successes = bodies.filter((b) => b.ok);
    const poolEmpty = bodies.filter((b) => !b.ok && b.error === 'pool_empty');
    assert.strictEqual(successes.length, 1, 'exactamente una entrega debe tener éxito');
    assert.strictEqual(poolEmpty.length, 2, 'las otras dos deben fallar con pool_empty');

    const stateRes = await stateFn.handler(adminEvent('GET', null, { eventId: concurrencyEventId }));
    const stateBody = JSON.parse(stateRes.body);
    assert.strictEqual(stateBody.event.stats.disponible, 0);
    assert.strictEqual(stateBody.event.stats.emitido, 1);
  });

  // ---- Concurrency: two simultaneous validations of the same code ----
  await test('validate.js bajo concurrencia: dos escaneos simultáneos del mismo código, sólo uno gana', async () => {
    mockBlobs.resetAll();
    const genRes = await generateFn.handler(adminEvent('POST', { eventName: 'Concurrencia2', quantity: 1 }));
    const concurrencyEventId = JSON.parse(genRes.body).event.id;
    const dRes = await dispenseFn.handler(adminEvent('POST', { eventId: concurrencyEventId, recipient: 'Doble Scan' }));
    const dBody = JSON.parse(dRes.body);
    const code = dBody.ticket.code;

    const results = await Promise.all([
      validateFn.handler(publicEvent('POST', { code: code })),
      validateFn.handler(publicEvent('POST', { code: code })),
    ]);
    const bodies = results.map((r) => JSON.parse(r.body));
    const oks = bodies.filter((b) => b.ok);
    const rejected = bodies.filter((b) => !b.ok);
    assert.strictEqual(oks.length, 1, 'sólo un escaneo debe habilitar el ingreso');
    assert.strictEqual(rejected.length, 1);
    assert.strictEqual(rejected[0].reason, 'already_used');
  });

  // ---- Backward compatibility: migrating a pre-multi-event state blob ----
  await test('store.js migra automáticamente un estado viejo (single-event) al leerlo', async () => {
    mockBlobs.resetAll();
    const legacyStore = mockBlobs.getStore({ name: 'pase-unico' });
    await legacyStore.setJSON('state', {
      eventName: 'Evento Viejo',
      tickets: [{ code: 'AAAA-1111', status: 'disponible', recipient: null, issuedAt: null, usedAt: null, createdAt: '2025-01-01T00:00:00.000Z' }],
      updatedAt: '2025-01-01T00:00:00.000Z',
    }, { onlyIfNew: true });

    const res = await stateFn.handler(adminEvent('GET'));
    const body = JSON.parse(res.body);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(body.events.length, 1);
    assert.strictEqual(body.events[0].name, 'Evento Viejo');
    assert.strictEqual(body.events[0].stats.total, 1);
  });

  // ---- Regression: the migrated id must be STABLE across reads. Bug found
  // in production: it used to mint a fresh random id on every read (state.js
  // never writes), so the panel's list-fetch and detail-fetch disagreed on
  // the event's id, causing an infinite 404-retry loop and "eliminar evento"
  // silently failing (the id it sent never matched the id the delete's own
  // internal read had just re-minted).
  await test('store.js: el id migrado es estable entre lecturas sucesivas de un blob viejo sin persistir', async () => {
    mockBlobs.resetAll();
    const legacyStore = mockBlobs.getStore({ name: 'pase-unico' });
    await legacyStore.setJSON('state', {
      eventName: 'Evento Viejo',
      tickets: [{ code: 'BBBB-2222', status: 'disponible', recipient: null, issuedAt: null, usedAt: null, createdAt: '2025-01-01T00:00:00.000Z' }],
      updatedAt: '2025-01-01T00:00:00.000Z',
    }, { onlyIfNew: true });

    const listRes = JSON.parse((await stateFn.handler(adminEvent('GET'))).body);
    const idFromList = listRes.events[0].id;
    const detailRes = await stateFn.handler(adminEvent('GET', null, { eventId: idFromList }));
    assert.strictEqual(detailRes.statusCode, 200, 'el id obtenido del listado debe servir para pedir el detalle sin dar 404');
    const idFromSecondList = JSON.parse((await stateFn.handler(adminEvent('GET'))).body).events[0].id;
    assert.strictEqual(idFromSecondList, idFromList, 'dos lecturas del mismo blob viejo deben migrar al mismo id');
  });

  await test('dispense.js funciona contra un blob viejo sin necesitar ninguna mutación previa que lo migre', async () => {
    mockBlobs.resetAll();
    const legacyStore = mockBlobs.getStore({ name: 'pase-unico' });
    await legacyStore.setJSON('state', {
      eventName: 'Evento Viejo 2',
      tickets: [{ code: 'CCCC-3333', status: 'disponible', recipient: null, issuedAt: null, usedAt: null, createdAt: '2025-01-01T00:00:00.000Z' }],
      updatedAt: '2025-01-01T00:00:00.000Z',
    }, { onlyIfNew: true });

    const idFromList = JSON.parse((await stateFn.handler(adminEvent('GET'))).body).events[0].id;
    const res = await dispenseFn.handler(adminEvent('POST', { eventId: idFromList, recipient: 'Alguien' }));
    const body = JSON.parse(res.body);
    assert.strictEqual(res.statusCode, 200, 'la entrega debe funcionar aunque el blob todavía no se haya migrado a disco');
    assert.strictEqual(body.ticket.status, 'emitido');
  });

  console.log('\n' + passCount + ' pruebas OK, ' + failCount + ' fallidas.');
  if (failCount > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
