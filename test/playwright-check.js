'use strict';

// Smoke-tests the frontend (panel.html + index.html) against a mocked
// backend (window.fetch overridden with an in-memory model), using the
// pre-installed Chromium. This exercises the actual browser JS
// (panel.js / scanner.js / vendored qrcode-generator + jsQR) end to end,
// separately from the pure-Node business-logic tests in run-tests.js.

const { chromium } = require('playwright');

const BASE = 'http://127.0.0.1:8765';

// In-memory fake backend shared by the mocked fetch below.
function makeServerState() {
  return { eventName: '', tickets: [] };
}

const MOCK_FETCH_SCRIPT = `
window.__mockState = { eventName: '', tickets: [] };
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

const realFetch = window.fetch.bind(window);
window.fetch = function(url, opts) {
  opts = opts || {};
  if (typeof url === 'string' && url.indexOf('/.netlify/functions/') === 0) {
    const path = url.replace('/.netlify/functions/', '');
    const body = opts.body ? JSON.parse(opts.body) : {};
    const state = window.__mockState;

    function resp(status, data) {
      return Promise.resolve(new Response(JSON.stringify(data), { status: status, headers: { 'Content-Type': 'application/json' } }));
    }

    if (path === 'state') {
      return resp(200, { ok: true, eventName: state.eventName, tickets: state.tickets, stats: statsOf(state.tickets) });
    }
    if (path === 'generate') {
      const existing = body.replace ? [] : state.tickets;
      const newTickets = [];
      for (let i = 0; i < body.quantity; i++) {
        newTickets.push({ code: 'MOCK-' + Math.random().toString(36).slice(2, 8).toUpperCase(), status: 'disponible', recipient: null, issuedAt: null, usedAt: null });
      }
      state.tickets = existing.concat(newTickets);
      state.eventName = body.eventName || state.eventName;
      return resp(200, { ok: true, eventName: state.eventName, tickets: state.tickets, stats: statsOf(state.tickets) });
    }
    if (path === 'dispense') {
      const ticket = state.tickets.find(t => t.status === 'disponible');
      if (!ticket) return resp(409, { ok: false, error: 'pool_empty' });
      ticket.status = 'emitido';
      ticket.recipient = body.recipient || null;
      ticket.issuedAt = new Date().toISOString();
      return resp(200, { ok: true, ticket: ticket, stats: statsOf(state.tickets) });
    }
    if (path === 'cancel') {
      const ticket = state.tickets.find(t => t.code === body.code);
      if (!ticket) return resp(404, { ok: false, error: 'not_found' });
      if (ticket.status === 'usado') return resp(409, { ok: false, error: 'already_used' });
      if (ticket.status === 'disponible') return resp(409, { ok: false, error: 'not_issued' });
      ticket.status = 'disponible';
      ticket.recipient = null;
      return resp(200, { ok: true, tickets: state.tickets, stats: statsOf(state.tickets) });
    }
    if (path === 'validate') {
      const code = body.code.replace('PU:', '');
      const ticket = state.tickets.find(t => t.code === code);
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

  // Generate
  await page.fill('#input-event-name', 'Evento de Prueba');
  await page.fill('#input-quantity', '10');
  await page.click('#btn-generate');
  await page.waitForTimeout(300);
  const total = await page.textContent('#stat-total');
  check('panel: genera lote de 10', total.trim() === '10');

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
