(function () {
  'use strict';

  var QR_PREFIX = 'PU:';
  var NEW_EVENT_VALUE = '__new__';
  var STORAGE_KEY = 'pu_current_event_id';

  var statTotal = document.getElementById('stat-total');
  var statDisponible = document.getElementById('stat-disponible');
  var statEmitido = document.getElementById('stat-emitido');
  var soldOutBanner = document.getElementById('sold-out-banner');
  var statsRow = document.getElementById('stats-row');

  var selectEvent = document.getElementById('select-event');
  var btnDeleteEvent = document.getElementById('btn-delete-event');
  var noEventsHint = document.getElementById('no-events-hint');

  var generateTitle = document.getElementById('generate-title');
  var labelEventName = document.getElementById('label-event-name');
  var inputEventName = document.getElementById('input-event-name');
  var inputQuantity = document.getElementById('input-quantity');
  var btnGenerate = document.getElementById('btn-generate');
  var generateWarning = document.getElementById('generate-warning');

  var dispenseCard = document.getElementById('dispense-card');
  var inputRecipient = document.getElementById('input-recipient');
  var btnDispense = document.getElementById('btn-dispense');

  var poolCard = document.getElementById('pool-card');
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

  // `events` holds lightweight summaries (id, name, createdAt, stats) for
  // every event, used to populate the picker. `currentEvent` holds the full
  // detail (tickets included) for whichever event is currently selected.
  var events = [];
  var currentEventId = null;
  var currentEvent = { id: null, name: '', tickets: [] };

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

  function api(path, method, body, query) {
    var url = '/.netlify/functions/' + path;
    if (query) {
      var qs = Object.keys(query)
        .filter(function (k) { return query[k] != null && query[k] !== ''; })
        .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(query[k]); })
        .join('&');
      if (qs) url += '?' + qs;
    }
    var headers = { 'Content-Type': 'application/json' };
    return fetch(url, {
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

  function readStoredEventId() {
    try { return localStorage.getItem(STORAGE_KEY); } catch (e) { return null; }
  }
  function storeEventId(id) {
    try {
      if (id && id !== NEW_EVENT_VALUE) localStorage.setItem(STORAGE_KEY, id);
      else localStorage.removeItem(STORAGE_KEY);
    } catch (e) { /* ignore */ }
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

  // ---- Event picker ----
  function renderEventOptions() {
    var html = events.map(function (ev) {
      var label = ev.name + ' — ' + ev.stats.disponible + ' disp. / ' + ev.stats.total + ' tot.';
      return '<option value="' + escapeHtml(ev.id) + '">' + escapeHtml(label) + '</option>';
    }).join('');
    html += '<option value="' + NEW_EVENT_VALUE + '">+ Nuevo evento…</option>';
    selectEvent.innerHTML = html;
    selectEvent.value = currentEventId || NEW_EVENT_VALUE;
  }

  function isNewMode() {
    return !currentEventId || currentEventId === NEW_EVENT_VALUE;
  }

  // Show/hide sections and adjust labels for the current selection. Does
  // NOT fetch anything — call loadEventDetail separately when fresh ticket
  // data is needed.
  function syncVisibility() {
    var isNew = isNewMode();
    btnDeleteEvent.hidden = isNew;
    statsRow.hidden = isNew;
    dispenseCard.hidden = isNew;
    poolCard.hidden = isNew;
    noEventsHint.hidden = !(isNew && events.length === 0);
    if (isNew) {
      generateTitle.textContent = 'Crear evento';
      labelEventName.textContent = 'Nombre del evento';
      btnGenerate.textContent = 'Crear evento y generar lote';
      soldOutBanner.hidden = true;
    } else {
      generateTitle.textContent = 'Agregar códigos';
      labelEventName.textContent = 'Renombrar evento (opcional)';
      btnGenerate.textContent = 'Agregar códigos';
    }
  }

  // Switches the selected event. `fetchDetail` (default true) controls
  // whether we go fetch the full ticket list for a real event — callers
  // that already have fresh data (e.g. right after generate) pass false.
  function selectEventById(id, fetchDetail) {
    currentEventId = id;
    storeEventId(id);
    if (isNewMode()) {
      currentEvent = { id: null, name: '', tickets: [] };
      inputEventName.value = '';
    } else {
      var ev = events.find(function (e) { return e.id === id; });
      inputEventName.value = ev ? ev.name : '';
      if (fetchDetail !== false) loadEventDetail(id);
    }
    generateWarning.hidden = true;
    renderEventOptions();
    syncVisibility();
  }

  function loadEventDetail(id) {
    api('state', 'GET', null, { eventId: id }).then(function (result) {
      if (result.data && result.data.ok && result.data.event) {
        currentEvent = result.data.event;
        if (result.data.events) events = result.data.events;
        renderEventOptions();
        refreshDerivedUI();
        renderPoolView();
      } else if (result.status === 404) {
        // The event was deleted from elsewhere; fall back gracefully.
        loadEvents();
      } else {
        toast('No se pudo cargar el evento.');
      }
    }).catch(function () {
      toast('No se pudo actualizar el estado.');
    });
  }

  // If the server says an eventId we were holding doesn't exist (e.g. it
  // was deleted from another tab, or a stale id from before a reconnect),
  // resync the whole panel from the server truth instead of leaving the UI
  // stuck showing something that no longer matches reality.
  function resyncIfEventMissing(result) {
    if (result && result.status === 404 && result.data && result.data.error === 'event_not_found') {
      loadEvents();
      return true;
    }
    return false;
  }

  function loadEvents() {
    api('state', 'GET').then(function (result) {
      if (!(result.data && result.data.ok)) {
        toast('No se pudo actualizar el estado.');
        return;
      }
      events = result.data.events || [];
      var saved = readStoredEventId();
      var initialId;
      if (saved && events.some(function (e) { return e.id === saved; })) {
        initialId = saved;
      } else if (events.length > 0) {
        initialId = events[0].id;
      } else {
        initialId = NEW_EVENT_VALUE;
      }
      selectEventById(initialId);
    }).catch(function () {
      toast('No se pudo conectar con el servidor.');
    });
  }

  function refreshDerivedUI() {
    var tickets = currentEvent.tickets || [];
    var total = tickets.length;
    var disponible = tickets.filter(function (t) { return t.status === 'disponible'; }).length;
    var emitido = tickets.filter(function (t) { return t.status === 'emitido'; }).length;
    statTotal.textContent = total;
    statDisponible.textContent = disponible;
    statEmitido.textContent = emitido;
    soldOutBanner.hidden = isNewMode() || !(total > 0 && disponible === 0);
    btnDispense.disabled = disponible === 0;
  }

  function renderPoolView() {
    var term = searchInput.value.trim().toLowerCase();
    var allTickets = currentEvent.tickets || [];
    var tickets = allTickets.filter(function (t) {
      if (!term) return true;
      return (t.code && t.code.toLowerCase().indexOf(term) !== -1) ||
             (t.recipient && t.recipient.toLowerCase().indexOf(term) !== -1);
    });
    if (tickets.length === 0) {
      poolView.innerHTML = '';
      emptyPoolHint.hidden = allTickets.length > 0 ? true : false;
      if (allTickets.length > 0 && term) {
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
  btnRefresh.addEventListener('click', function () {
    if (isNewMode()) { loadEvents(); return; }
    loadEventDetail(currentEventId);
  });

  selectEvent.addEventListener('change', function () {
    selectEventById(selectEvent.value);
  });

  btnDeleteEvent.addEventListener('click', function () {
    var ev = events.find(function (e) { return e.id === currentEventId; });
    if (!ev) return;
    showConfirm(
      'Eliminar evento',
      'Se eliminará "' + ev.name + '" junto con sus ' + ev.stats.total + ' códigos (incluidos los ya entregados o usados). Esta acción no se puede deshacer. ¿Confirmás?',
      function () {
        api('delete-event', 'POST', { eventId: currentEventId }).then(function (result) {
          if (result.data && result.data.ok) {
            events = result.data.events || [];
            var fallbackId = events.length > 0 ? events[0].id : NEW_EVENT_VALUE;
            selectEventById(fallbackId);
            toast('Evento eliminado.');
          } else if (!resyncIfEventMissing(result)) {
            toast((result.data && result.data.message) || 'No se pudo eliminar el evento.');
          }
        }).catch(function () {
          toast('Sin conexión con el servidor.');
        });
      }
    );
  });

  poolView.addEventListener('click', function (e) {
    var btn = e.target.closest('.btn-cancel-issue');
    if (!btn) return;
    var code = btn.getAttribute('data-code');
    showConfirm('Cancelar entrega', '¿Confirmás que el código ' + code + ' vuelve al pool disponible?', function () {
      api('cancel', 'POST', { code: code }).then(function (result) {
        if (result.data && result.data.ok) {
          if (result.data.eventId === currentEventId) {
            currentEvent.tickets = result.data.tickets;
          }
          var ev = events.find(function (e) { return e.id === result.data.eventId; });
          if (ev) ev.stats = result.data.stats;
          refreshDerivedUI();
          renderPoolView();
          renderEventOptions();
          toast('Entrega cancelada.');
        } else {
          toast((result.data && result.data.message) || 'No se pudo cancelar la entrega.');
        }
      }).catch(function () {
        toast('Sin conexión con el servidor.');
      });
    });
  });

  // ---- Generate / create event ----
  function doGenerate() {
    var isNew = isNewMode();
    var eventName = inputEventName.value.trim();
    var quantity = parseInt(inputQuantity.value, 10);
    if (!quantity || quantity < 1) {
      generateWarning.hidden = false;
      generateWarning.textContent = 'Ingresá una cantidad válida.';
      return;
    }
    if (isNew && !eventName) {
      generateWarning.hidden = false;
      generateWarning.textContent = 'Ingresá un nombre para el nuevo evento.';
      return;
    }
    generateWarning.hidden = true;

    var body = { quantity: quantity };
    if (isNew) {
      body.eventName = eventName;
    } else {
      body.eventId = currentEventId;
      if (eventName && eventName !== (currentEvent.name || '')) body.eventName = eventName;
    }

    btnGenerate.disabled = true;
    btnGenerate.textContent = isNew ? 'Creando…' : 'Generando…';
    api('generate', 'POST', body)
      .then(function (result) {
        if (result.data && result.data.ok) {
          events = result.data.events || [];
          currentEvent = result.data.event;
          currentEventId = currentEvent.id;
          storeEventId(currentEventId);
          renderEventOptions();
          syncVisibility();
          refreshDerivedUI();
          renderPoolView();
          toast(isNew ? 'Evento creado con ' + quantity + ' código' + (quantity === 1 ? '' : 's') + '.' : quantity + ' código' + (quantity === 1 ? '' : 's') + ' agregado' + (quantity === 1 ? '' : 's') + '.');
        } else if (!resyncIfEventMissing(result)) {
          toast((result.data && result.data.message) || 'No se pudo generar el lote.');
        }
      })
      .catch(function () {
        toast('Sin conexión con el servidor.');
      })
      .finally(function () {
        btnGenerate.disabled = false;
        syncVisibility();
      });
  }

  btnGenerate.addEventListener('click', function () {
    if (!isNewMode() && currentEvent.tickets && currentEvent.tickets.length > 0) {
      var quantity = parseInt(inputQuantity.value, 10) || 0;
      showConfirm(
        'Agregar códigos',
        'Este evento ya tiene ' + currentEvent.tickets.length + ' códigos. Se agregarán ' + quantity + ' códigos nuevos (los entregados y usados no se tocan). ¿Continuar?',
        function () { doGenerate(); }
      );
    } else {
      doGenerate();
    }
  });

  // ---- Dispense ----
  btnDispense.addEventListener('click', function () {
    if (isNewMode()) return;
    var recipient = inputRecipient.value.trim();
    btnDispense.disabled = true;
    api('dispense', 'POST', { eventId: currentEventId, recipient: recipient }).then(function (result) {
      if (result.data && result.data.ok) {
        var ticket = result.data.ticket;
        currentEvent.tickets = currentEvent.tickets.map(function (t) {
          return t.code === ticket.code ? ticket : t;
        });
        var ev = events.find(function (e) { return e.id === currentEventId; });
        if (ev) ev.stats = result.data.stats;
        refreshDerivedUI();
        renderPoolView();
        renderEventOptions();
        openDispenseModal(ticket);
        inputRecipient.value = '';
      } else if (result.data && result.data.error === 'pool_empty') {
        toast('No quedan códigos disponibles en el pool.');
      } else if (!resyncIfEventMissing(result)) {
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
    var issued = (currentEvent.tickets || []).filter(function (t) { return t.status === 'emitido' || t.status === 'usado'; });
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
  loadEvents();
})();
