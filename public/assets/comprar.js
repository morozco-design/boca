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

  function selectedEvent() {
    if (!info) return null;
    var id = $('event-select').value;
    for (var i = 0; i < info.events.length; i++) {
      if (info.events[i].id === id) return info.events[i];
    }
    return null;
  }

  function updateTotal() {
    if (!info) return;
    var qty = parseInt($('buyer-qty').value, 10) || 1;
    $('total-line').textContent = money(info.price * qty);
  }

  // Cuando cambia el evento elegido: imagen, disponibilidad y cantidades.
  function onEventChange() {
    var ev = selectedEvent();
    if (!ev) return;
    $('event-title').textContent = ev.name;
    document.title = 'Entradas — ' + ev.name;

    var hero = $('hero');
    if (ev.hasImage) {
      hero.src = '/.netlify/functions/event-image?eventId=' + encodeURIComponent(ev.id);
      hero.alt = ev.name;
      hero.hidden = false;
    } else {
      hero.hidden = true;
      hero.removeAttribute('src');
    }

    $('available-line').textContent = ev.available <= 20
      ? 'Quedan ' + ev.available + ' entradas'
      : 'Entradas disponibles';

    var max = Math.max(1, Math.min(info.max, ev.available));
    var sel = $('buyer-qty');
    sel.innerHTML = '';
    for (var i = 1; i <= max; i++) {
      var o = document.createElement('option');
      o.value = String(i);
      o.textContent = String(i);
      sel.appendChild(o);
    }
    updateTotal();
  }

  function render() {
    show('loading-card', false);
    if (!info || !info.open) { show('closed-card', true); return; }
    if (info.events.every(function (e) { return e.soldOut; })) { show('soldout-card', true); return; }

    $('price-line').textContent = money(info.price) + ' por entrada';
    $('reserve-note').textContent = 'Máximo ' + info.max + ' entradas por persona. Se reservan unos minutos mientras pagás. Al terminar te mandamos las entradas por mail.';

    var sel = $('event-select');
    sel.innerHTML = '';
    var preferred = new URLSearchParams(window.location.search).get('evento');
    var chosen = null;
    info.events.forEach(function (ev) {
      var o = document.createElement('option');
      o.value = ev.id;
      o.textContent = ev.soldOut ? ev.name + ' — agotado' : ev.name;
      o.disabled = ev.soldOut;
      sel.appendChild(o);
      if (!ev.soldOut && !chosen) chosen = ev.id;
      if (preferred && !ev.soldOut && (ev.id === preferred || ev.name.toLowerCase() === preferred.toLowerCase())) chosen = ev.id;
    });
    sel.value = chosen;

    onEventChange();
    show('buy-card', true);
  }

  function load(keepForm) {
    fetch('/.netlify/functions/sale-info')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        info = data && data.ok ? data : { open: false, events: [] };
        if (keepForm) {
          // Refresco tras un "agotado": se vuelve a dibujar sin perder el mail.
          var email = $('buyer-email').value;
          render();
          $('buyer-email').value = email;
        } else {
          render();
        }
      })
      .catch(function () { show('loading-card', false); banner('No se pudo cargar la página. Revisá tu conexión y recargá.'); });
  }

  $('event-select').addEventListener('change', onEventChange);
  $('buyer-qty').addEventListener('change', updateTotal);

  $('buy-form').addEventListener('submit', function (e) {
    e.preventDefault();
    banner('');
    var ev = selectedEvent();
    var email = $('buyer-email').value.trim();
    var qty = parseInt($('buyer-qty').value, 10);
    if (!ev) { banner('Elegí un evento.'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { banner('Ingresá un mail válido.'); $('buyer-email').focus(); return; }

    var btn = $('btn-pay');
    btn.disabled = true;
    btn.textContent = 'Redirigiendo a Mercado Pago…';
    fetch('/.netlify/functions/create-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId: ev.id, email: email, quantity: qty }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.ok && data.checkoutUrl) {
          window.location.href = data.checkoutUrl;
          return;
        }
        banner((data && data.message) || 'No se pudo iniciar el pago. Probá de nuevo.');
        if (data && (data.error === 'sold_out' || data.error === 'event_not_found')) load(true);
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
  load(false);
})();
