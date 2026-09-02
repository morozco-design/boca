'use strict';

// Smoke-tests the frontend (panel.html + index.html) against a mocked
// backend (window.fetch overridden with an in-memory model), using the
// pre-installed Chromium. This exercises the actual browser JS
// (panel.js / scanner.js / vendored qrcode-generator + jsQR) end to end,
// separately from the pure-Node business-logic tests in run-tests.js.

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = 'http://127.0.0.1:8765';
const SAMPLE_IMAGE_PATH = path.join(__dirname, '..', 'sample-coro-rodal.jpg');
// A tiny (108x192) real JPEG, base64-encoded, embedded directly in the mock
// fetch script below — this is what GET /.netlify/functions/event-image
// "serves" for any event with hasImage:true, standing in for the actual
// uploaded picture so the compositing code has real image bytes to draw.
const TINY_IMAGE_B64 = fs.readFileSync(path.join(__dirname, 'fixtures', 'tiny-sample-base64.txt'), 'utf8').trim();

// In-memory fake backend (multi-event) shared by the mocked fetch below.
const MOCK_FETCH_SCRIPT = `
window.__mockState = { events: [] };
window.__consoleErrors = [];
window.addEventListener('error', (e) => window.__consoleErrors.push(String(e.message)));

function statsOf(tickets) {
  return {
    total: tickets.length,
    disponible: tickets.filter(t => t.status === 'disponible').length,
    emitido: tickets.filter(t => t.status === 'emitido').length,
    usado: tickets.filter(t => t.status === 'usado').length,
  };
}
function summaries() {
  return window.__mockState.events.map(ev => ({ id: ev.id, name: ev.name, createdAt: ev.createdAt, stats: statsOf(ev.tickets), hasImage: !!ev.hasImage }));
}
function findEvent(id) {
  return window.__mockState.events.find(ev => ev.id === id) || null;
}
let __idCounter = 0;
function newId() { __idCounter++; return 'ev-' + __idCounter; }
const TINY_IMAGE_B64 = '${TINY_IMAGE_B64}';
function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const realFetch = window.fetch.bind(window);
window.fetch = function(url, opts) {
  opts = opts || {};
  if (typeof url === 'string' && url.indexOf('/.netlify/functions/') === 0) {
    const rawPath = url.replace('/.netlify/functions/', '');
    const qIdx = rawPath.indexOf('?');
    const path = qIdx === -1 ? rawPath : rawPath.slice(0, qIdx);
    const qs = qIdx === -1 ? '' : rawPath.slice(qIdx + 1);
    const params = new URLSearchParams(qs);
    const body = opts.body ? JSON.parse(opts.body) : {};

    function resp(status, data) {
      return Promise.resolve(new Response(JSON.stringify(data), { status: status, headers: { 'Content-Type': 'application/json' } }));
    }

    if (path === 'state') {
      const eventId = params.get('eventId');
      if (eventId) {
        const ev = findEvent(eventId);
        if (!ev) return resp(404, { ok: false, error: 'event_not_found', events: summaries() });
        return resp(200, { ok: true, events: summaries(), event: { id: ev.id, name: ev.name, createdAt: ev.createdAt, tickets: ev.tickets, stats: statsOf(ev.tickets), hasImage: !!ev.hasImage } });
      }
      return resp(200, { ok: true, events: summaries() });
    }
    if (path === 'event-image') {
      const method = (opts.method || 'GET').toUpperCase();
      if (method === 'POST') {
        const ev = findEvent(body.eventId);
        if (!ev) return resp(404, { ok: false, error: 'event_not_found' });
        if (!body.imageDataUrl || body.imageDataUrl.indexOf('data:image/') !== 0) return resp(400, { ok: false, error: 'invalid_image' });
        ev.hasImage = true;
        return resp(200, { ok: true, eventId: ev.id, hasImage: true });
      }
      if (method === 'DELETE') {
        const ev = findEvent(params.get('eventId'));
        if (!ev) return resp(404, { ok: false, error: 'event_not_found' });
        ev.hasImage = false;
        return resp(200, { ok: true, eventId: ev.id, hasImage: false });
      }
      // GET — serves the same tiny embedded JPEG for any event with hasImage,
      // standing in for the real per-event bytes stored by event-image.js.
      const ev = findEvent(params.get('eventId'));
      if (!ev || !ev.hasImage) {
        return Promise.resolve(new Response(JSON.stringify({ ok: false, error: 'not_found' }), { status: 404, headers: { 'Content-Type': 'application/json' } }));
      }
      return Promise.resolve(new Response(base64ToBytes(TINY_IMAGE_B64), { status: 200, headers: { 'Content-Type': 'image/jpeg' } }));
    }
    if (path === 'generate') {
      let ev;
      if (body.eventId) {
        ev = findEvent(body.eventId);
        if (!ev) return resp(404, { ok: false, error: 'event_not_found' });
        if (body.eventName) ev.name = body.eventName;
      } else {
        if (!body.eventName) return resp(400, { ok: false, error: 'missing_event_name' });
        ev = { id: newId(), name: body.eventName, tickets: [], createdAt: new Date(0).toISOString() };
        window.__mockState.events.push(ev);
      }
      const existing = body.replace ? [] : ev.tickets;
      const newTickets = [];
      for (let i = 0; i < body.quantity; i++) {
        newTickets.push({ code: 'MOCK-' + Math.random().toString(36).slice(2, 8).toUpperCase(), status: 'disponible', recipient: null, issuedAt: null, usedAt: null });
      }
      ev.tickets = existing.concat(newTickets);
      return resp(200, { ok: true, event: { id: ev.id, name: ev.name, tickets: ev.tickets, stats: statsOf(ev.tickets), hasImage: !!ev.hasImage }, events: summaries() });
    }
    if (path === 'dispense') {
      const ev = findEvent(body.eventId);
      if (!ev) return resp(404, { ok: false, error: 'event_not_found' });
      const quantity = body.quantity || 1;
      const dispensed = [];
      for (let i = 0; i < quantity; i++) {
        const ticket = ev.tickets.find(t => t.status === 'disponible');
        if (!ticket) break;
        ticket.status = 'emitido';
        ticket.recipient = body.recipient || null;
        ticket.issuedAt = new Date().toISOString();
        dispensed.push(ticket);
      }
      if (dispensed.length === 0) return resp(409, { ok: false, error: 'pool_empty' });
      return resp(200, { ok: true, eventId: ev.id, tickets: dispensed, ticket: dispensed[0], requested: quantity, dispensedCount: dispensed.length, stats: statsOf(ev.tickets) });
    }
    if (path === 'cancel') {
      let ticket = null, foundEv = null;
      for (const ev of window.__mockState.events) {
        const t = ev.tickets.find(tt => tt.code === body.code);
        if (t) { ticket = t; foundEv = ev; break; }
      }
      if (!ticket) return resp(404, { ok: false, error: 'not_found' });
      if (ticket.status === 'usado') return resp(409, { ok: false, error: 'already_used' });
      if (ticket.status === 'disponible') return resp(409, { ok: false, error: 'not_issued' });
      ticket.status = 'disponible';
      ticket.recipient = null;
      return resp(200, { ok: true, eventId: foundEv.id, tickets: foundEv.tickets, stats: statsOf(foundEv.tickets) });
    }
    if (path === 'delete-event') {
      const idx = window.__mockState.events.findIndex(ev => ev.id === body.eventId);
      if (idx === -1) return resp(404, { ok: false, error: 'event_not_found' });
      window.__mockState.events.splice(idx, 1);
      return resp(200, { ok: true, events: summaries() });
    }
    if (path === 'validate') {
      const code = body.code.replace('PU:', '');
      let ticket = null;
      for (const ev of window.__mockState.events) {
        const t = ev.tickets.find(tt => tt.code === code);
        if (t) { ticket = t; break; }
      }
      if (!ticket) return resp(404, { ok: false, reason: 'not_found' });
      if (ticket.status === 'usado') return resp(409, { ok: false, reason: 'already_used' });
      if (ticket.status === 'disponible') return resp(404, { ok: false, reason: 'not_issued' });
      ticket.status = 'usado';
      ticket.usedAt = new Date().toISOString();
      return resp(200, { ok: true, recipient: ticket.recipient });
    }
    return resp(404, { ok: false, error: 'unknown_endpoint' });
  }
  return realFetch(url, opts);
};
`;

async function main() {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage();
  await page.addInitScript(MOCK_FETCH_SCRIPT);

  const failures = [];
  function check(name, cond) {
    if (cond) {
      console.log('  ok  - ' + name);
    } else {
      failures.push(name);
      console.log('FAIL  - ' + name);
    }
  }

  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('  [console.error] ' + msg.text());
  });

  await page.goto(BASE + '/panel.html');
  await page.waitForTimeout(200);
  check('panel: carga directo sin pedir clave', await page.isVisible('#panel-view'));
  check('panel: sin eventos, arranca en modo "nuevo evento" (stats ocultas)', !(await page.isVisible('#stats-row')));

  // Create the first event
  await page.fill('#input-event-name', 'Evento de Prueba');
  await page.fill('#input-quantity', '10');
  await page.click('#btn-generate');
  await page.waitForTimeout(300);
  const total = await page.textContent('#stat-total');
  check('panel: crea evento y genera lote de 10', total.trim() === '10');
  check('panel: tras crear el evento aparece el botón de eliminar', await page.isVisible('#btn-delete-event'));

  // Dispense a single ticket
  await page.fill('#input-recipient', 'Ana Test');
  await page.fill('#input-dispense-quantity', '1');
  await page.click('#btn-dispense');
  await page.waitForTimeout(300);
  check('panel: modal de entrega visible tras dispense', await page.isVisible('#dispense-modal'));
  const modalTicketCount1 = await page.$$eval('.modal-ticket', (els) => els.length);
  check('panel: modal muestra exactamente 1 entrada', modalTicketCount1 === 1);
  const modalCode = (await page.textContent('.modal-ticket .code-text')).trim();
  check('panel: modal muestra un código', modalCode.length > 0);

  // QR actually rendered onto the canvas (non-blank)
  const qrDrawn = await page.evaluate(() => {
    const canvas = document.querySelector('.modal-qr-canvas');
    const ctx = canvas.getContext('2d');
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] < 250) return true; // found a non-white pixel
    }
    return false;
  });
  check('panel: el canvas del QR tiene contenido dibujado (no en blanco)', qrDrawn);
  check('panel: cada entrada del modal tiene su botón de WhatsApp', await page.isVisible('.modal-ticket .btn-share-whatsapp'));

  await page.click('#btn-close-modal');
  await page.waitForTimeout(150);
  check('panel: modal se cierra', !(await page.isVisible('#dispense-modal')));

  check('panel: aparece "Ver entrada" para reabrir la última entrega', await page.isVisible('#btn-view-last'));
  await page.click('#btn-view-last');
  await page.waitForTimeout(150);
  check('panel: "Ver entrada" reabre el modal con la última entrega', await page.isVisible('#dispense-modal'));
  await page.click('#btn-close-modal');
  await page.waitForTimeout(150);

  const emitidoStat = await page.textContent('#stat-emitido');
  check('panel: stat emitido = 1 tras entrega', emitidoStat.trim() === '1');

  // Dispense several at once to the same recipient
  await page.fill('#input-recipient', 'Familia López');
  await page.fill('#input-dispense-quantity', '3');
  await page.click('#btn-dispense');
  await page.waitForTimeout(300);
  const modalTicketCount3 = await page.$$eval('.modal-ticket', (els) => els.length);
  check('panel: entregar cantidad > 1 muestra esa cantidad de entradas en el modal', modalTicketCount3 === 3);
  const emitidoAfterBatch = await page.textContent('#stat-emitido');
  check('panel: stat emitido = 4 tras entregar 3 más', emitidoAfterBatch.trim() === '4');
  await page.click('#btn-close-modal');
  await page.waitForTimeout(150);

  // "Ver entrada" per row in the list, and the WhatsApp share fallback
  // (headless Chromium has no navigator.share, so it should fall back to
  // opening a wa.me link — stub window.open to check without actually
  // navigating away).
  await page.evaluate(() => { window.__openedUrls = []; window.open = (url) => { window.__openedUrls.push(url); return null; }; });
  check('panel: cada entrada emitida tiene botón "Ver entrada" en la lista', await page.isVisible('.btn-view-ticket'));
  check('panel: cada entrada emitida tiene botón de WhatsApp en la lista', await page.isVisible('.btn-share-whatsapp'));
  await page.click('.btn-view-ticket');
  await page.waitForTimeout(150);
  check('panel: "Ver entrada" de una fila reabre el modal para ese código', await page.isVisible('#dispense-modal'));
  await page.click('#btn-close-modal');
  await page.waitForTimeout(150);

  await page.click('.btn-share-whatsapp');
  await page.waitForTimeout(400);
  const openedUrls = await page.evaluate(() => window.__openedUrls);
  check('panel: compartir por WhatsApp abre un link de wa.me (fallback sin Web Share API)', openedUrls.length === 1 && openedUrls[0].indexOf('wa.me') !== -1);

  // Cancel entrega
  await page.click('.btn-cancel-issue');
  await page.waitForTimeout(200);
  check('panel: aparece modal de confirmación al cancelar', await page.isVisible('#confirm-modal'));
  await page.click('#btn-confirm-ok');
  await page.waitForTimeout(300);
  const disponibleStat = await page.textContent('#stat-disponible');
  check('panel: cancelar entrega devuelve el ticket al pool (disponible=7, tras entregar 4 y cancelar 1)', disponibleStat.trim() === '7');

  // Search filter
  await page.fill('#search-code', 'ZZZZ-NOEXISTE');
  await page.waitForTimeout(150);
  const poolHtml = await page.innerHTML('#pool-view');
  check('panel: búsqueda sin resultados no rompe la UI', poolHtml.indexOf('No se encontraron') !== -1);
  await page.fill('#search-code', '');

  // ---- Event background image: uploading one composites the QR onto it;
  // removing it reverts new tickets to the plain QR-only display ----
  check('panel: sin imagen todavía, no aparece el botón de "Quitar imagen"', !(await page.isVisible('#btn-remove-image')));
  await page.setInputFiles('#input-event-image', SAMPLE_IMAGE_PATH);
  await page.waitForTimeout(500);
  check('panel: subir una imagen la muestra en la vista previa', await page.isVisible('#image-preview'));
  check('panel: tras subir la imagen aparece el botón "Quitar imagen"', await page.isVisible('#btn-remove-image'));

  await page.fill('#input-recipient', 'Con Imagen');
  await page.fill('#input-dispense-quantity', '1');
  await page.click('#btn-dispense');
  await page.waitForTimeout(500);
  check('panel: con imagen de fondo, el modal de entrega usa el canvas compuesto (no el QR simple)', await page.$('.modal-ticket-canvas') !== null && await page.$('.modal-qr-canvas') === null);
  const compositeDrawn = await page.evaluate(() => {
    const canvas = document.querySelector('.modal-ticket-canvas');
    const ctx = canvas.getContext('2d');
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let nonWhite = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] < 250 || data[i + 1] < 250 || data[i + 2] < 250) nonWhite++;
    }
    return nonWhite;
  });
  check('panel: el canvas compuesto tiene contenido dibujado (imagen de fondo + tarjeta QR, no en blanco)', compositeDrawn > 1000);
  check('panel: el ticket compuesto igual conserva el botón de WhatsApp', await page.isVisible('.modal-ticket--composite .btn-share-whatsapp'));
  await page.click('#btn-close-modal');
  await page.waitForTimeout(150);

  await page.click('#btn-remove-image');
  await page.waitForTimeout(150);
  check('panel: quitar imagen pide confirmación', await page.isVisible('#confirm-modal'));
  await page.click('#btn-confirm-ok');
  await page.waitForTimeout(300);
  check('panel: tras quitar la imagen, la vista previa vuelve a "Sin imagen"', !(await page.isVisible('#image-preview')));
  check('panel: tras quitar la imagen, desaparece el botón "Quitar imagen"', !(await page.isVisible('#btn-remove-image')));

  await page.fill('#input-recipient', 'Sin Imagen');
  await page.click('#btn-dispense');
  await page.waitForTimeout(400);
  check('panel: sin imagen de fondo, el modal de entrega vuelve a usar el QR simple', await page.$('.modal-qr-canvas') !== null && await page.$('.modal-ticket-canvas') === null);
  await page.click('#btn-close-modal');
  await page.waitForTimeout(150);

  // ---- Multi-event: create a second event and switch between them ----
  await page.selectOption('#select-event', '__new__');
  await page.waitForTimeout(100);
  check('panel: elegir "+ Nuevo evento" vuelve a ocultar las stats', !(await page.isVisible('#stats-row')));
  await page.fill('#input-event-name', 'Segundo Evento');
  await page.fill('#input-quantity', '5');
  await page.click('#btn-generate');
  await page.waitForTimeout(300);
  const totalSecondEvent = await page.textContent('#stat-total');
  check('panel: crea un segundo evento independiente con 5 códigos', totalSecondEvent.trim() === '5');

  const optionCount = await page.$$eval('#select-event option', (opts) => opts.length);
  check('panel: el selector de eventos lista ambos eventos + la opción de nuevo evento', optionCount === 3);

  // Switch back to the first event and confirm its data is intact
  const firstEventValue = await page.$$eval('#select-event option', (opts) =>
    opts.map((o) => ({ value: o.value, text: o.textContent })).find((o) => o.text.indexOf('Evento de Prueba') === 0).value
  );
  await page.selectOption('#select-event', firstEventValue);
  await page.waitForTimeout(300);
  const totalBackToFirst = await page.textContent('#stat-total');
  check('panel: volver al primer evento conserva sus 10 códigos', totalBackToFirst.trim() === '10');

  // Delete the second event
  const secondEventValue = await page.$$eval('#select-event option', (opts) =>
    opts.map((o) => ({ value: o.value, text: o.textContent })).find((o) => o.text.indexOf('Segundo Evento') === 0).value
  );
  await page.selectOption('#select-event', secondEventValue);
  await page.waitForTimeout(200);
  await page.click('#btn-delete-event');
  await page.waitForTimeout(150);
  check('panel: eliminar evento pide confirmación', await page.isVisible('#confirm-modal'));
  await page.click('#btn-confirm-ok');
  await page.waitForTimeout(300);
  const optionCountAfterDelete = await page.$$eval('#select-event option', (opts) => opts.length);
  check('panel: tras eliminar el segundo evento sólo queda uno + "nuevo evento"', optionCountAfterDelete === 2);

  const jsErrors = await page.evaluate(() => window.__consoleErrors);
  check('panel: sin errores de JS no capturados', jsErrors.length === 0);

  // ---- Scanner page: full encode -> decode round trip using the real
  // vendored qrcode-generator (to make the QR image) and jsQR (to decode it)
  await page.goto(BASE + '/index.html');
  await page.waitForTimeout(200);

  const roundTrip = await page.evaluate(async () => {
    // Draw a QR for a known payload using a temporary qrcode-generator
    // instance loaded the same way panel.js does.
    const script = document.createElement('script');
    script.src = '/vendor/qrcode.min.js';
    await new Promise((resolve) => { script.onload = resolve; document.head.appendChild(script); });

    const payload = 'PU:TEST-CODE1';
    const qr = window.qrcode(0, 'M');
    qr.addData(payload);
    qr.make();
    const cellSize = 6;
    const margin = 4;
    const moduleCount = qr.getModuleCount();
    const size = moduleCount * cellSize + margin * 2;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#000';
    for (let r = 0; r < moduleCount; r++) {
      for (let c = 0; c < moduleCount; c++) {
        if (qr.isDark(r, c)) {
          ctx.fillRect(margin + c * cellSize, margin + r * cellSize, cellSize, cellSize);
        }
      }
    }
    const imageData = ctx.getImageData(0, 0, size, size);
    const decoded = window.jsQR(imageData.data, imageData.width, imageData.height);
    return { payload, decodedText: decoded ? decoded.data : null };
  });
  check('scanner: round-trip encode->decode de jsQR/qrcode-generator', roundTrip.decodedText === roundTrip.payload);

  await browser.close();

  console.log('\n' + (failures.length === 0 ? 'Todas las pruebas de navegador pasaron.' : failures.length + ' pruebas fallidas: ' + failures.join(', ')));
  if (failures.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
