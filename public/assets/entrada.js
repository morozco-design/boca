(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var params = new URLSearchParams(window.location.search);
  var orderId = params.get('o') || '';
  // Mercado Pago agrega estos datos al volver al sitio.
  var paymentId = params.get('payment_id') || params.get('collection_id') || '';

  var POLL_MS = 3000;
  var MAX_POLLS = 40; // ~2 minutos
  var polls = 0;
  var rendered = false;

  function setStatus(title, text, spinning) {
    $('status-title').textContent = title;
    $('status-text').textContent = text;
    $('spinner').hidden = !spinning;
    $('status-card').hidden = false;
  }

  function download(canvas, code) {
    canvas.toBlob(function (blob) {
      if (!blob) return;
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'entrada-' + code + '.jpg';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    }, 'image/jpeg', 0.92);
  }

  function renderPasses(data) {
    if (rendered) return;
    rendered = true;
    var holder = $('passes');
    holder.innerHTML = '';
    var drawers = [];
    data.codes.forEach(function (code) {
      var wrap = document.createElement('div');
      wrap.className = 'pass';
      var canvas = document.createElement('canvas');
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-secondary';
      btn.textContent = 'Guardar imagen';
      btn.addEventListener('click', function () { download(canvas, code); });
      wrap.appendChild(canvas);
      wrap.appendChild(btn);
      holder.appendChild(wrap);
      drawers.push({ canvas: canvas, ticket: { code: code } });
    });
    holder.hidden = false;

    function drawPlain() {
      drawers.forEach(function (d) { window.TicketCard.drawPlainCard(d.canvas, d.ticket); });
    }
    if (data.hasImage) {
      window.TicketCard.loadBackgroundImage(data.eventId)
        .then(function (bg) {
          drawers.forEach(function (d) { window.TicketCard.drawTicketCard(d.canvas, bg, d.ticket); });
        })
        .catch(drawPlain);
    } else {
      drawPlain();
    }
  }

  function poll() {
    var url = '/.netlify/functions/order-status?id=' + encodeURIComponent(orderId) +
      (paymentId ? '&payment_id=' + encodeURIComponent(paymentId) : '');
    fetch(url)
      .then(function (r) { return r.json().then(function (d) { return { status: r.status, data: d }; }); })
      .then(function (res) {
        var data = res.data;
        if (!data || !data.ok) {
          setStatus('No encontramos este pedido', 'Revisá el link del mail o volvé a la página de compra.', false);
          return;
        }
        if (data.eventName) $('event-title').textContent = data.eventName;

        if (data.status === 'pagado') {
          setStatus('¡Listo! Tu pago se acreditó',
            (data.codes.length === 1 ? 'Esta es tu entrada. ' : 'Estas son tus ' + data.codes.length + ' entradas. ') +
            (data.emailSent ? 'También te las mandamos por mail.' : 'En unos minutos te llegan también por mail.') +
            ' Mostrá el QR en la puerta: cada una se valida una sola vez.', false);
          renderPasses(data);
          return;
        }
        if (data.status === 'reembolsado') {
          setStatus('Te devolvimos el dinero', 'Cuando se acreditó tu pago ya no quedaban entradas, así que se reembolsó el monto completo. Disculpá las molestias.', false);
          return;
        }
        if (data.status === 'revisar') {
          setStatus('Estamos revisando tu pago', 'Hubo una diferencia con el monto. Escribinos y lo resolvemos enseguida.', false);
          return;
        }
        if (data.status === 'fallido') {
          setStatus('No se pudo completar la compra', 'No se te cobró nada. Podés intentarlo de nuevo desde la página de compra.', false);
          return;
        }
        // pendiente
        polls++;
        if (polls >= MAX_POLLS) {
          setStatus('Todavía no vemos el pago acreditado',
            'Si ya pagaste, quedate tranquilo: apenas se acredite te mandamos las entradas por mail. También podés recargar esta página en unos minutos.', false);
          return;
        }
        setStatus('Confirmando tu pago…', 'Esto tarda unos segundos. No cierres esta página.', true);
        setTimeout(poll, POLL_MS);
      })
      .catch(function () {
        polls++;
        if (polls < MAX_POLLS) setTimeout(poll, POLL_MS);
        else setStatus('Sin conexión', 'Recargá la página para ver tus entradas.', false);
      });
  }

  if (!orderId) {
    setStatus('Falta el número de pedido', 'Abrí el link que te llegó por mail.', false);
  } else {
    poll();
  }
})();
