'use strict';

// Local test harness for the Netlify Functions business logic.
// No real Netlify account/deployment is available in this sandbox, so we
// inject an in-memory mock of @netlify/blobs (with real ETag / CAS
// semantics, see mock-blobs.js) directly into Node's require cache before
// any function handler (or _lib/store.js) requires the real package.

const path = require('path');
const assert = require('assert');
const Module = require('module');

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
function adminEvent(method, body) {
  return {
    httpMethod: method,
    headers: {},
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

  await test('generate.js crea un lote de N códigos únicos', async () => {
    const res = await generateFn.handler(adminEvent('POST', { eventName: 'Fiesta', quantity: 50 }));
    const body = JSON.parse(res.body);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.stats.total, 50);
    assert.strictEqual(body.stats.disponible, 50);
    const codes = new Set(body.tickets.map((t) => t.code));
    assert.strictEqual(codes.size, 50, 'todos los códigos deben ser únicos');
  });

  await test('state.js refleja el lote generado', async () => {
    const res = await stateFn.handler(adminEvent('GET'));
    const body = JSON.parse(res.body);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(body.eventName, 'Fiesta');
    assert.strictEqual(body.stats.total, 50);
  });

  let dispensedCode = null;
  await test('dispense.js entrega el próximo código disponible', async () => {
    const res = await dispenseFn.handler(adminEvent('POST', { recipient: 'Juana Pérez' }));
    const body = JSON.parse(res.body);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(body.ticket.status, 'emitido');
    assert.strictEqual(body.ticket.recipient, 'Juana Pérez');
    assert.strictEqual(body.stats.disponible, 49);
    assert.strictEqual(body.stats.emitido, 1);
    dispensedCode = body.ticket.code;
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
    const stateRes = await stateFn.handler(adminEvent('GET'));
    const stateBody = JSON.parse(stateRes.body);
    const stillAvailable = stateBody.tickets.find((t) => t.status === 'disponible');
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
    const res = await dispenseFn.handler(adminEvent('POST', { recipient: 'Carlos Ruiz' }));
    const body = JSON.parse(res.body);
    secondDispensedCode = body.ticket.code;
    assert.strictEqual(body.ticket.status, 'emitido');
  });

  await test('cancel.js devuelve un código entregado al pool', async () => {
    const res = await cancelFn.handler(adminEvent('POST', { code: secondDispensedCode }));
    const body = JSON.parse(res.body);
    assert.strictEqual(res.statusCode, 200);
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
    const stateRes = await stateFn.handler(adminEvent('GET'));
    const stateBody = JSON.parse(stateRes.body);
    const stillAvailable = stateBody.tickets.find((t) => t.status === 'disponible');
    const res = await cancelFn.handler(adminEvent('POST', { code: stillAvailable.code }));
    const body = JSON.parse(res.body);
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(body.error, 'not_issued');
  });

  await test('generate.js con quantity inválida devuelve 400', async () => {
    const res = await generateFn.handler(adminEvent('POST', { eventName: 'X', quantity: 0 }));
    assert.strictEqual(res.statusCode, 400);
  });

  // ---- Concurrency: two simultaneous dispenses racing for one remaining ticket ----
  await test('dispense.js bajo concurrencia: con 1 disponible, sólo una de 3 llamadas simultáneas tiene éxito', async () => {
    mockBlobs.resetAll();
    await generateFn.handler(adminEvent('POST', { eventName: 'Concurrencia', quantity: 1, replace: true }));

    const results = await Promise.all([
      dispenseFn.handler(adminEvent('POST', { recipient: 'A' })),
      dispenseFn.handler(adminEvent('POST', { recipient: 'B' })),
      dispenseFn.handler(adminEvent('POST', { recipient: 'C' })),
    ]);
    const bodies = results.map((r) => JSON.parse(r.body));
    const successes = bodies.filter((b) => b.ok);
    const poolEmpty = bodies.filter((b) => !b.ok && b.error === 'pool_empty');
    assert.strictEqual(successes.length, 1, 'exactamente una entrega debe tener éxito');
    assert.strictEqual(poolEmpty.length, 2, 'las otras dos deben fallar con pool_empty');

    const stateRes = await stateFn.handler(adminEvent('GET'));
    const stateBody = JSON.parse(stateRes.body);
    assert.strictEqual(stateBody.stats.disponible, 0);
    assert.strictEqual(stateBody.stats.emitido, 1);
  });

  // ---- Concurrency: two simultaneous validations of the same code ----
  await test('validate.js bajo concurrencia: dos escaneos simultáneos del mismo código, sólo uno gana', async () => {
    mockBlobs.resetAll();
    await generateFn.handler(adminEvent('POST', { eventName: 'Concurrencia2', quantity: 1, replace: true }));
    const dRes = await dispenseFn.handler(adminEvent('POST', { recipient: 'Doble Scan' }));
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

  console.log('\n' + passCount + ' pruebas OK, ' + failCount + ' fallidas.');
  if (failCount > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
