'use strict';

// Smoke-tests the frontend (panel.html + index.html) against a mocked
// backend (window.fetch overridden with an in-memory model), using the
// pre-installed Chromium. This exercises the actual browser JS
// (panel.js / scanner.js / vendored qrcode-generator + jsQR) end to end,
// separately from the pure-Node business-logic tests in run-tests.js.

const { chromium } = require('playwright');

const BASE = 'http://127.0.0.1:8765';

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
  return window.__mockState.events.map(ev => ({ id: ev.id, name: ev.name, createdAt: ev.createdAt, stats: statsOf(ev.tickets) }));
}
function findEvent(id) {
  return window.__mockState.events.find(ev => ev.id === id) || null;
}
let __idCounter = 0;
function newId() { __idCounter++; return 'ev-' + __idCounter; }

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
        return resp(200, { ok: true, events: summaries(), event: { id: ev.id, name: ev.name, createdAt: ev.createdAt, tickets: ev.tickets, stats: statsOf(ev.tickets) } });
      }
      return resp(200, { ok: true, events: summaries() });
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
      return resp(200, { ok: true, event: { id: ev.id, name: ev.name, tickets: ev.tickets, stats: statsOf(ev.tickets) }, events: summaries() });
    }
    if (path === 'dispense') {
      const ev = findEvent(body.eventId);
      if (!ev) return resp(404, { ok: false, error: 'event_not_found' });
      const ticket = ev.tickets.find(t => t.status === 'disponible');
      if (!ticket) return resp(409, { ok: false, error: 'pool_empty' });
      ticket.status = 'emitido';
      ticket.recipient = body.recipient || null;
      ticket.issuedAt = new Date().toISOString();
      return resp(200, { ok: true, eventId: ev.id, ticket: ticket, stats: statsOf(ev.tickets) });
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

  // Dispense
  await page.fill('#input-recipient', 'Ana Test');
  await page.click('#btn-dispense');
  await page.waitForTimeout(300);
  check('panel: modal de entrega visible tras dispense', await page.isVisible('#dispense-modal'));
  const modalCode = (await page.textContent('#modal-code-text')).trim();
  check('panel: modal muestra un código', modalCode.length > 0 && modalCode !== '—');

  // QR actually rendered onto the canvas (non-blank)
  const qrDrawn = await page.evaluate(() => {
    const canvas = document.getElementById('modal-qr-holder');
    const ctx = canvas.getContext('2d');
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] < 250) return true; // found a non-white pixel
    }
    return false;
  });
  check('panel: el canvas del QR tiene contenido dibujado (no en blanco)', qrDrawn);

  await page.click('#btn-close-modal');
  await page.waitForTimeout(150);
  check('panel: modal se cierra', !(await page.isVisible('#dispense-modal')));

  const emitidoStat = await page.textContent('#stat-emitido');
  check('panel: stat emitido = 1 tras entrega', emitidoStat.trim() === '1');

  // Cancel entrega
  await page.click('.btn-cancel-issue');
  await page.waitForTimeout(200);
  check('panel: aparece modal de confirmación al cancelar', await page.isVisible('#confirm-modal'));
  await page.click('#btn-confirm-ok');
  await page.waitForTimeout(300);
  const disponibleStat = await page.textContent('#stat-disponible');
  check('panel: cancelar entrega devuelve el ticket al pool (disponible=10)', disponibleStat.trim() === '10');

  // Search filter
  await page.fill('#search-code', 'ZZZZ-NOEXISTE');
  await page.waitForTimeout(150);
  const poolHtml = await page.innerHTML('#pool-view');
  check('panel: búsqueda sin resultados no rompe la UI', poolHtml.indexOf('No se encontraron') !== -1);
  await page.fill('#search-code', '');

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
