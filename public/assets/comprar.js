(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var info = null;

  function money(n) {
    return '$ ' + Number(n).toLocaleString('es-UY', { maximumFractionDigits: 0 });
  }

  function show(id, on) { $(id).hidden = !on; }

  function banner(msg) {
    var b = $('banner');
    b.textContent = msg || '';
    b.hidden = !msg;
  }

  function updateTotal() {
    if (!info) return;
    var qty = parseInt($('buyer-qty').value, 10) || 1;
    $('total-line').textContent = money(info.price * qty);
  }

  function render() {
    show('loading-card', false);
    if (!info || !info.open) { show('closed-card', true); return; }
    $('event-title').textContent = info.eventName;
    document.title = 'Entradas — ' + info.eventName;
    if (info.soldOut) { show('soldout-card', true); return; }

    if (info.hasImage) {
      var hero = $('hero');
      hero.src = '/.netlify/functions/event-image?eventId=' + encodeURIComponent(info.eventId);
      hero.alt = info.eventName;
      hero.hidden = false;
    }
    $('price-line').textContent = money(info.price) + ' por entrada';
    $('available-line').textContent = info.available <= 20
      ? 'Quedan ' + info.available + ' entradas'
      : 'Entradas disponibles';

    var max = Math.min(info.max, info.available);
    var sel = $('buyer-qty');
    sel.innerHTML = '';
    for (var i = 1; i <= max; i++) {
      var o = document.createElement('option');
      o.value = String(i);
      o.textContent = String(i);
      sel.appendChild(o);
    }
    $('reserve-note').textContent = 'Máximo ' + info.max + ' entradas por persona. Se reservan unos minutos mientras pagás. Al terminar te mandamos las entradas por mail.';
    updateTotal();
    show('buy-card', true);
  }

  function load() {
    fetch('/.netlify/functions/sale-info')
      .then(function (r) { return r.json(); })
      .then(function (data) { info = data && data.ok ? data : { open: false }; render(); })
      .catch(function () { show('loading-card', false); banner('No se pudo cargar la página. Revisá tu conexión y recargá.'); });
  }

  $('buyer-qty').addEventListener('change', updateTotal);

  $('buy-form').addEventListener('submit', function (e) {
    e.preventDefault();
    banner('');
    var name = $('buyer-name').value.trim();
    var email = $('buyer-email').value.trim();
    var qty = parseInt($('buyer-qty').value, 10);
    if (name.length < 2) { banner('Ingresá tu nombre.'); $('buyer-name').focus(); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { banner('Ingresá un mail válido.'); $('buyer-email').focus(); return; }

    var btn = $('btn-pay');
    btn.disabled = true;
    btn.textContent = 'Redirigiendo a Mercado Pago…';
    fetch('/.netlify/functions/create-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, email: email, quantity: qty }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.ok && data.checkoutUrl) {
          window.location.href = data.checkoutUrl;
          return;
        }
        banner((data && data.message) || 'No se pudo iniciar el pago. Probá de nuevo.');
        if (data && (data.error === 'sold_out')) load();
        btn.disabled = false;
        btn.textContent = 'Pagar con Mercado Pago';
      })
      .catch(function () {
        banner('Sin conexión con el servidor. Probá de nuevo.');
        btn.disabled = false;
        btn.textContent = 'Pagar con Mercado Pago';
      });
  });

  if (/[?&]pago=fallido/.test(window.location.search)) {
    banner('El pago no se completó. No se te cobró nada; podés intentarlo de nuevo.');
  }
  load();
})();
