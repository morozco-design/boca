(function () {
  'use strict';

  var QR_PREFIX = 'PU:';

  var panelView = document.getElementById('panel-view');

  var statTotal = document.getElementById('stat-total');
  var statDisponible = document.getElementById('stat-disponible');
  var statEmitido = document.getElementById('stat-emitido');
  var soldOutBanner = document.getElementById('sold-out-banner');

  var inputEventName = document.getElementById('input-event-name');
  var inputQuantity = document.getElementById('input-quantity');
  var btnGenerate = document.getElementById('btn-generate');
  var generateWarning = document.getElementById('generate-warning');

  var inputRecipient = document.getElementById('input-recipient');
  var btnDispense = document.getElementById('btn-dispense');

  var searchInput = document.getElementById('search-code');
  var btnRefresh = document.getElementById('btn-refresh');
  var btnPrintAll = document.getElementById('btn-print-all');
  var poolView = document.getElementById('pool-view');
  var emptyPoolHint = document.getElementById('empty-pool-hint');

  var dispenseModal = document.getElementById('dispense-modal');
  var modalQrHolder = document.getElementById('modal-qr-holder');
  var modalCodeText = document.getElementById('modal-code-text');
  var modalRecipientText = document.getElementById('modal-recipient-text');
  var btnCloseModal = document.getElementById('btn-close-modal');

  var confirmModal = document.getElementById('confirm-modal');
  var confirmTitle = document.getElementById('confirm-title');
  var confirmMessage = document.getElementById('confirm-message');
  var btnConfirmCancel = document.getElementById('btn-confirm-cancel');
  var btnConfirmOk = document.getElementById('btn-confirm-ok');

  var printArea = document.getElementById('print-area');
  var toastRegion = document.getElementById('toast-region');

  var state = { eventName: '', tickets: [] };

  function toast(msg) {
    var el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    toastRegion.appendChild(el);
    setTimeout(function () { el.remove(); }, 3200);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function api(path, method, body) {
    var headers = { 'Content-Type': 'application/json' };
    return fetch('/.netlify/functions/' + path, {
      method: method || 'GET',
      headers: headers,
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (res) {
      return res.json().then(function (data) {
        return { status: res.status, data: data };
      });
    });
  }

  function showConfirm(title, message, onConfirm) {
    confirmTitle.textContent = title;
    confirmMessage.textContent = message;
    confirmModal.hidden = false;
    function cleanup() {
      confirmModal.hidden = true;
      btnConfirmOk.removeEventListener('click', onOk);
      btnConfirmCancel.removeEventListener('click', onCancel);
    }
    function onOk() { cleanup(); onConfirm(); }
    function onCancel() { cleanup(); }
    btnConfirmOk.addEventListener('click', onOk);
    btnConfirmCancel.addEventListener('click', onCancel);
  }

  // ---- QR rendering (qrcode-generator global `qrcode`) ----
  function drawQR(canvas, text, size) {
    var qr = window.qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    var dataUrl = qr.createDataURL(Math.max(4, Math.round(size / qr.getModuleCount())), 4);
    var img = new Image();
    img.onload = function () {
      var ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    };
    img.src = dataUrl;
  }

  function qrDataUrlSync(text, cellSize) {
    var qr = window.qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    return qr.createDataURL(cellSize || 5, 4);
  }

  // ---- State loading / rendering ----
  function loadState() {
    api('state', 'GET').then(function (result) {
      if (result.data && result.data.ok) {
        state.eventName = result.data.eventName || '';
        state.tickets = result.data.tickets || [];
        inputEventName.value = state.eventName;
        refreshDerivedUI();
        renderPoolView();
      }
    }).catch(function () {
      toast('No se pudo actualizar el estado.');
    });
  }

  function refreshDerivedUI() {
    var tickets = state.tickets;
    var total = tickets.length;
    var disponible = tickets.filter(function (t) { return t.status === 'disponible'; }).length;
    var emitido = tickets.filter(function (t) { return t.status === 'emitido'; }).length;
    statTotal.textContent = total;
    statDisponible.textContent = disponible;
    statEmitido.textContent = emitido;
    soldOutBanner.hidden = !(total > 0 && disponible === 0);
    btnDispense.disabled = disponible === 0;
  }

  function renderPoolView() {
    var term = searchInput.value.trim().toLowerCase();
    var tickets = state.tickets.filter(function (t) {
      if (!term) return true;
      return (t.code && t.code.toLowerCase().indexOf(term) !== -1) ||
             (t.recipient && t.recipient.toLowerCase().indexOf(term) !== -1);
    });
    if (tickets.length === 0) {
      poolView.innerHTML = '';
      emptyPoolHint.hidden = state.tickets.length > 0 ? true : false;
      if (state.tickets.length > 0 && term) {
        poolView.innerHTML = '<p class="hint">No se encontraron códigos.</p>';
        emptyPoolHint.hidden = true;
      }
      return;
    }
    emptyPoolHint.hidden = true;
    var html = tickets.slice(0, 500).map(function (t) {
      var pillClass = 'pill-' + t.status;
      var pillLabel = t.status === 'disponible' ? 'Disponible' : t.status === 'emitido' ? 'Entregado' : 'Usado';
      var meta = t.recipient ? escapeHtml(t.recipient) : (t.status === 'disponible' ? 'En el pool' : '');
      var cancelBtn = t.status === 'emitido'
        ? '<button class="btn btn-secondary btn-small btn-cancel-issue" data-code="' + escapeHtml(t.code) + '">Cancelar entrega</button>'
        : '';
      return '<div class="ticket-card">' +
        '<div>' +
        '<div class="code">' + escapeHtml(t.code) + '</div>' +
        '<div class="meta">' + meta + '</div>' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:8px;">' +
        '<span class="pill ' + pillClass + '">' + pillLabel + '</span>' +
        cancelBtn +
        '</div>' +
        '</div>';
    }).join('');
    poolView.innerHTML = html;
    if (tickets.length > 500) {
      poolView.innerHTML += '<p class="hint">Mostrando los primeros 500 resultados. Refiná la búsqueda para ver más.</p>';
    }
  }

  searchInput.addEventListener('input', renderPoolView);
  btnRefresh.addEventListener('click', loadState);

  poolView.addEventListener('click', function (e) {
    var btn = e.target.closest('.btn-cancel-issue');
    if (!btn) return;
    var code = btn.getAttribute('data-code');
    showConfirm('Cancelar entrega', '¿Confirmás que el código ' + code + ' vuelve al pool disponible?', function () {
      api('cancel', 'POST', { code: code }).then(function (result) {
        if (result.data && result.data.ok) {
          state.tickets = result.data.tickets;
          refreshDerivedUI();
          renderPoolView();
          toast('Entrega cancelada.');
        } else {
          toast((result.data && result.data.message) || 'No se pudo cancelar la entrega.');
        }
      }).catch(function () {
        toast('Sin conexión con el servidor.');
      });
    });
  });

  // ---- Generate ----
  function doGenerate(replace) {
    var eventName = inputEventName.value.trim();
    var quantity = parseInt(inputQuantity.value, 10);
    if (!quantity || quantity < 1) {
      generateWarning.hidden = false;
      generateWarning.textContent = 'Ingresá una cantidad válida.';
      return;
    }
    generateWarning.hidden = true;
    btnGenerate.disabled = true;
    btnGenerate.textContent = 'Generando…';
    api('generate', 'POST', { eventName: eventName, quantity: quantity, replace: !!replace })
      .then(function (result) {
        if (result.data && result.data.ok) {
          state.eventName = result.data.eventName;
          state.tickets = result.data.tickets;
          refreshDerivedUI();
          renderPoolView();
          toast('Lote generado: ' + quantity + ' códigos.');
        } else {
          toast((result.data && result.data.message) || 'No se pudo generar el lote.');
        }
      })
      .catch(function () {
        toast('Sin conexión con el servidor.');
      })
      .finally(function () {
        btnGenerate.disabled = false;
        btnGenerate.textContent = 'Generar lote';
      });
  }

  btnGenerate.addEventListener('click', function () {
    if (state.tickets.length > 0) {
      showConfirm(
        'Ya existe un lote',
        'Ya hay ' + state.tickets.length + ' códigos generados. Si continuás, se agregarán códigos nuevos a los que ya existen (los entregados y usados no se tocan). ¿Continuar?',
        function () { doGenerate(false); }
      );
    } else {
      doGenerate(false);
    }
  });

  // ---- Dispense ----
  btnDispense.addEventListener('click', function () {
    var recipient = inputRecipient.value.trim();
    btnDispense.disabled = true;
    api('dispense', 'POST', { recipient: recipient }).then(function (result) {
      if (result.data && result.data.ok) {
        var ticket = result.data.ticket;
        state.tickets = state.tickets.map(function (t) {
          return t.code === ticket.code ? ticket : t;
        });
        refreshDerivedUI();
        renderPoolView();
        openDispenseModal(ticket);
        inputRecipient.value = '';
      } else if (result.data && result.data.error === 'pool_empty') {
        toast('No quedan códigos disponibles en el pool.');
      } else {
        toast((result.data && result.data.message) || 'No se pudo entregar un código.');
      }
    }).catch(function () {
      toast('Sin conexión con el servidor.');
    }).finally(function () {
      refreshDerivedUI();
    });
  });

  function openDispenseModal(ticket) {
    dispenseModal.hidden = false;
    modalCodeText.textContent = ticket.code;
    modalRecipientText.textContent = ticket.recipient ? 'A nombre de ' + ticket.recipient : '';
    drawQR(modalQrHolder, QR_PREFIX + ticket.code, 220);
  }

  btnCloseModal.addEventListener('click', function () {
    dispenseModal.hidden = true;
  });

  // ---- Print all issued tickets ----
  btnPrintAll.addEventListener('click', function () {
    var issued = state.tickets.filter(function (t) { return t.status === 'emitido' || t.status === 'usado'; });
    if (issued.length === 0) {
      toast('No hay códigos entregados para imprimir.');
      return;
    }
    var html = issued.map(function (t) {
      var url = qrDataUrlSync(QR_PREFIX + t.code, 5);
      return '<div style="display:inline-block;width:33%;text-align:center;padding:12px;box-sizing:border-box;">' +
        '<img src="' + url + '" style="width:160px;height:160px;" />' +
        '<div style="font-family:monospace;font-size:14px;margin-top:4px;">' + escapeHtml(t.code) + '</div>' +
        '<div style="font-size:12px;color:#555;">' + escapeHtml(t.recipient || '') + '</div>' +
        '</div>';
    }).join('');
    printArea.innerHTML = html;
    printArea.hidden = false;
    setTimeout(function () {
      window.print();
      printArea.hidden = true;
    }, 80);
  });

  // ---- Boot ----
  loadState();
})();
