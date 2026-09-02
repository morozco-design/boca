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
  var inputDispenseQuantity = document.getElementById('input-dispense-quantity');
  var btnDispense = document.getElementById('btn-dispense');
  var btnViewLast = document.getElementById('btn-view-last');

  var imageCard = document.getElementById('image-card');
  var imagePreview = document.getElementById('image-preview');
  var imagePreviewEmpty = document.getElementById('image-preview-empty');
  var inputEventImage = document.getElementById('input-event-image');
  var btnChooseImage = document.getElementById('btn-choose-image');
  var btnRemoveImage = document.getElementById('btn-remove-image');

  var poolCard = document.getElementById('pool-card');
  var searchInput = document.getElementById('search-code');
  var btnRefresh = document.getElementById('btn-refresh');
  var btnPrintAll = document.getElementById('btn-print-all');
  var poolView = document.getElementById('pool-view');
  var emptyPoolHint = document.getElementById('empty-pool-hint');

  var dispenseModal = document.getElementById('dispense-modal');
  var modalTitle = document.getElementById('modal-title');
  var modalTicketsList = document.getElementById('modal-tickets-list');
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
  // The most recently dispensed batch for the current event, so "Ver
  // entrada" next to the dispense button can reopen it without scrolling.
  var lastDispensedTickets = [];

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

  // Renders a QR as a PNG Blob (not a data URL) so it can be attached as a
  // real image file to navigator.share — resolves null if anything goes
  // wrong (older browser, canvas.toBlob unsupported, etc.) so callers can
  // fall back gracefully instead of throwing.
  function qrBlobAsync(text, size) {
    return new Promise(function (resolve) {
      try {
        var qr = window.qrcode(0, 'M');
        qr.addData(text);
        qr.make();
        var moduleCount = qr.getModuleCount();
        var cellSize = Math.max(4, Math.round(size / moduleCount));
        var margin = cellSize * 4;
        var dim = moduleCount * cellSize + margin * 2;
        var canvas = document.createElement('canvas');
        canvas.width = dim;
        canvas.height = dim;
        var ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, dim, dim);
        ctx.fillStyle = '#000';
        for (var r = 0; r < moduleCount; r++) {
          for (var c = 0; c < moduleCount; c++) {
            if (qr.isDark(r, c)) ctx.fillRect(margin + c * cellSize, margin + r * cellSize, cellSize, cellSize);
          }
        }
        if (canvas.toBlob) {
          canvas.toBlob(function (blob) { resolve(blob); }, 'image/png');
        } else {
          resolve(null);
        }
      } catch (e) {
        resolve(null);
      }
    });
  }

  // ---- Ticket-on-background compositing (event has a custom image) ----
  // The uploaded image is normalized client-side (see
  // normalizeImageFileToDataUrl) into a fixed 1080x1920 portrait canvas
  // before it's ever uploaded, so every event's background already has this
  // exact aspect ratio — the composite card below just has to draw on top
  // of it at the same resolution.
  var CARD_W = 1080;
  var CARD_H = 1920;

  // One background <img> per event, loaded once and reused for every ticket
  // composited during this session. Cleared whenever the event's image is
  // replaced or removed so a stale picture never gets drawn. Goes through
  // fetch()+blob (rather than pointing an <img> straight at the URL) so
  // loading it is a plain, mockable HTTP call like every other endpoint in
  // this file, and a 404/500 rejects cleanly instead of only firing the
  // <img> element's onerror.
  var backgroundImageCache = {};
  function loadBackgroundImage(eventId) {
    if (!backgroundImageCache[eventId]) {
      backgroundImageCache[eventId] = fetch('/.netlify/functions/event-image?eventId=' + encodeURIComponent(eventId))
        .then(function (res) {
          if (!res.ok) throw new Error('image_fetch_failed');
          return res.blob();
        })
        .then(function (blob) {
          return new Promise(function (resolve, reject) {
            var url = URL.createObjectURL(blob);
            var img = new Image();
            img.onload = function () { resolve(img); };
            img.onerror = function () { reject(new Error('image_decode_failed')); };
            img.src = url;
          });
        });
    }
    return backgroundImageCache[eventId];
  }

  // Draws QR modules directly with fillRect (no intermediate <img> load
  // needed, unlike drawQR) so it can be composited synchronously onto a
  // canvas that already has other content drawn on it.
  function drawQRModules(ctx, text, x, y, size) {
    var qr = window.qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    var moduleCount = qr.getModuleCount();
    var cell = size / moduleCount;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x, y, size, size);
    ctx.fillStyle = '#111111';
    for (var r = 0; r < moduleCount; r++) {
      for (var c = 0; c < moduleCount; c++) {
        if (qr.isDark(r, c)) ctx.fillRect(x + c * cell, y + r * cell, cell + 0.6, cell + 0.6);
      }
    }
  }

  function roundRectPath(ctx, x, y, w, h, r) {
    if (typeof ctx.roundRect === 'function') {
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, r);
      return;
    }
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function truncateText(s, max) {
    s = String(s || '');
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }

  // Draws the event's background image "cover"-fit into a 1080x1920 canvas,
  // then a white rounded card near the bottom holding the event name, the
  // QR, the code, and (if any) the recipient — the finished result is a
  // self-contained, usable access pass.
  function drawTicketCard(canvas, bgImg, ticket, eventName) {
    canvas.width = CARD_W;
    canvas.height = CARD_H;
    var ctx = canvas.getContext('2d');

    var scale = Math.max(CARD_W / bgImg.naturalWidth, CARD_H / bgImg.naturalHeight);
    var dw = bgImg.naturalWidth * scale;
    var dh = bgImg.naturalHeight * scale;
    var dx = (CARD_W - dw) / 2;
    var dy = (CARD_H - dh) / 2;
    ctx.drawImage(bgImg, dx, dy, dw, dh);

    var padding = 40;
    var titleH = 54;
    var qrSize = 480;
    var gapAfterQr = 30;
    var codeH = 46;
    var recipientH = ticket.recipient ? 36 : 0;
    var cardW = CARD_W - 96;
    var cardH = padding * 2 + titleH + qrSize + gapAfterQr + codeH + recipientH;
    var cardX = (CARD_W - cardW) / 2;
    var cardY = CARD_H - cardH - 96;

    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = 36;
    ctx.shadowOffsetY = 10;
    roundRectPath(ctx, cardX, cardY, cardW, cardH, 28);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.restore();

    var cursorY = cardY + padding;
    ctx.textAlign = 'center';
    ctx.fillStyle = '#413a5c';
    ctx.font = '600 32px Sora, sans-serif';
    ctx.fillText(truncateText(eventName || 'Evento', 30), CARD_W / 2, cursorY + 30);
    cursorY += titleH;

    var qrX = CARD_W / 2 - qrSize / 2;
    drawQRModules(ctx, QR_PREFIX + ticket.code, qrX, cursorY, qrSize);
    cursorY += qrSize + gapAfterQr;

    ctx.fillStyle = '#181325';
    ctx.font = '600 38px "IBM Plex Mono", monospace';
    ctx.fillText(ticket.code, CARD_W / 2, cursorY + 32);
    cursorY += codeH;

    if (ticket.recipient) {
      ctx.fillStyle = '#6a6284';
      ctx.font = '500 28px Sora, sans-serif';
      ctx.fillText(truncateText('A nombre de ' + ticket.recipient, 34), CARD_W / 2, cursorY + 24);
    }
  }

  // Reads a File, decodes it, and center-crops/"cover"-fits it into a
  // canonical portrait canvas so every uploaded image ends up with the same
  // proportions server-side regardless of what the admin picked — the
  // person uploading never has to pre-crop anything themselves.
  function normalizeImageFileToDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('read_failed')); };
      reader.onload = function () {
        var img = new Image();
        img.onerror = function () { reject(new Error('decode_failed')); };
        img.onload = function () {
          try {
            var canvas = document.createElement('canvas');
            canvas.width = CARD_W;
            canvas.height = CARD_H;
            var ctx = canvas.getContext('2d');
            var scale = Math.max(CARD_W / img.naturalWidth, CARD_H / img.naturalHeight);
            var dw = img.naturalWidth * scale;
            var dh = img.naturalHeight * scale;
            var dx = (CARD_W - dw) / 2;
            var dy = (CARD_H - dh) / 2;
            ctx.fillStyle = '#111111';
            ctx.fillRect(0, 0, CARD_W, CARD_H);
            ctx.drawImage(img, dx, dy, dw, dh);
            resolve(canvas.toDataURL('image/jpeg', 0.85));
          } catch (e) {
            reject(e);
          }
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function findTicketByCode(code) {
    return (currentEvent.tickets || []).find(function (t) { return t.code === code; }) || null;
  }

  function buildShareMessage(ticket) {
    var lines = ['🎟️ Entrada para ' + (currentEvent.name || 'el evento')];
    if (ticket.recipient) lines.push('A nombre de: ' + ticket.recipient);
    lines.push('Código: ' + ticket.code);
    lines.push('Mostrá este código QR en la entrada. Es válido para un solo ingreso.');
    return lines.join('\n');
  }

  function fallbackWhatsAppShare(message) {
    window.open('https://wa.me/?text=' + encodeURIComponent(message), '_blank');
  }

  // Shares a single ticket's QR. Prefers the native share sheet with the QR
  // as an actual image file (works on most mobile browsers, lets the person
  // pick WhatsApp from the list); if the browser can't share files (mostly
  // desktop), falls back to opening WhatsApp with the code as text — no
  // browser can attach an arbitrary image to a wa.me link, so the image
  // itself only travels through the native share sheet.
  function shareTicketViaWhatsApp(ticket) {
    if (!ticket) return;
    var message = buildShareMessage(ticket);
    var imgPromise = currentEvent.hasImage
      ? loadBackgroundImage(currentEventId).then(function (bgImg) {
          var canvas = document.createElement('canvas');
          drawTicketCard(canvas, bgImg, ticket, currentEvent.name);
          return new Promise(function (resolve) {
            if (canvas.toBlob) canvas.toBlob(function (blob) { resolve(blob); }, 'image/jpeg', 0.92);
            else resolve(null);
          });
        }).catch(function () { return qrBlobAsync(QR_PREFIX + ticket.code, 600); })
      : qrBlobAsync(QR_PREFIX + ticket.code, 600);

    imgPromise.then(function (blob) {
      var file = null;
      var ext = blob && blob.type === 'image/jpeg' ? '.jpg' : '.png';
      if (blob && typeof File === 'function') {
        try { file = new File([blob], 'entrada-' + ticket.code + ext, { type: blob.type || 'image/png' }); } catch (e) { file = null; }
      }
      if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
        navigator.share({ files: [file], title: 'Entrada', text: message }).catch(function (err) {
          if (!err || err.name !== 'AbortError') fallbackWhatsAppShare(message);
        });
      } else if (navigator.share) {
        navigator.share({ title: 'Entrada', text: message }).catch(function (err) {
          if (!err || err.name !== 'AbortError') fallbackWhatsAppShare(message);
        });
      } else {
        fallbackWhatsAppShare(message);
      }
    });
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
    imageCard.hidden = isNew;
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

  // Reflects currentEvent.hasImage in the upload card's preview/remove
  // button. Called once fresh event data is actually in hand (loadEventDetail,
  // doGenerate, and right after an upload/remove) — selectEventById calls
  // resetImagePreview() instead, since at that point currentEvent may still
  // be the PREVIOUS event's stale data while the fetch is in flight.
  function syncImagePreview() {
    var hasImage = !isNewMode() && !!currentEvent.hasImage;
    btnRemoveImage.hidden = !hasImage;
    if (hasImage) {
      imagePreview.hidden = false;
      imagePreviewEmpty.hidden = true;
      imagePreview.src = '/.netlify/functions/event-image?eventId=' + encodeURIComponent(currentEventId) + '&v=' + Date.now();
    } else {
      imagePreview.hidden = true;
      imagePreview.removeAttribute('src');
      imagePreviewEmpty.textContent = 'Sin imagen';
      imagePreviewEmpty.hidden = false;
    }
  }

  function resetImagePreview(loading) {
    btnRemoveImage.hidden = true;
    imagePreview.hidden = true;
    imagePreview.removeAttribute('src');
    imagePreviewEmpty.textContent = loading ? 'Cargando…' : 'Sin imagen';
    imagePreviewEmpty.hidden = false;
  }

  // Switches the selected event. `fetchDetail` (default true) controls
  // whether we go fetch the full ticket list for a real event — callers
  // that already have fresh data (e.g. right after generate) pass false.
  function selectEventById(id, fetchDetail) {
    currentEventId = id;
    storeEventId(id);
    lastDispensedTickets = [];
    btnViewLast.hidden = true;
    if (isNewMode()) {
      currentEvent = { id: null, name: '', tickets: [] };
      inputEventName.value = '';
      resetImagePreview(false);
    } else {
      var ev = events.find(function (e) { return e.id === id; });
      inputEventName.value = ev ? ev.name : '';
      resetImagePreview(true);
      if (fetchDetail !== false) loadEventDetail(id);
      else syncImagePreview();
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
        syncImagePreview();
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
      var wasIssued = t.status === 'emitido' || t.status === 'usado';
      var viewBtn = wasIssued
        ? '<button class="btn btn-secondary btn-small btn-view-ticket" data-code="' + escapeHtml(t.code) + '">Ver entrada</button>'
        : '';
      var shareBtn = wasIssued
        ? '<button class="btn btn-whatsapp btn-small btn-share-whatsapp" data-code="' + escapeHtml(t.code) + '">Compartir por WhatsApp</button>'
        : '';
      var cancelBtn = t.status === 'emitido'
        ? '<button class="btn btn-secondary btn-small btn-cancel-issue" data-code="' + escapeHtml(t.code) + '">Cancelar entrega</button>'
        : '';
      return '<div class="ticket-card">' +
        '<div>' +
        '<div class="code">' + escapeHtml(t.code) + '</div>' +
        '<div class="meta">' + meta + '</div>' +
        '</div>' +
        '<div class="actions">' +
        '<span class="pill ' + pillClass + '">' + pillLabel + '</span>' +
        viewBtn +
        shareBtn +
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

  // ---- Event background image ----
  btnChooseImage.addEventListener('click', function () {
    if (isNewMode()) return;
    inputEventImage.click();
  });

  inputEventImage.addEventListener('change', function () {
    var file = inputEventImage.files && inputEventImage.files[0];
    inputEventImage.value = '';
    if (!file || isNewMode()) return;
    if (!/^image\//.test(file.type)) {
      toast('Elegí un archivo de imagen (PNG, JPG o WEBP).');
      return;
    }
    var targetEventId = currentEventId;
    btnChooseImage.disabled = true;
    btnChooseImage.textContent = 'Procesando…';
    normalizeImageFileToDataUrl(file)
      .then(function (dataUrl) {
        return api('event-image', 'POST', { eventId: targetEventId, imageDataUrl: dataUrl });
      })
      .then(function (result) {
        if (result.data && result.data.ok) {
          delete backgroundImageCache[targetEventId];
          if (targetEventId === currentEventId) {
            currentEvent.hasImage = true;
            syncImagePreview();
          }
          var ev = events.find(function (e) { return e.id === targetEventId; });
          if (ev) ev.hasImage = true;
          toast('Imagen actualizada.');
        } else if (!resyncIfEventMissing(result)) {
          toast((result.data && result.data.message) || 'No se pudo subir la imagen.');
        }
      })
      .catch(function () {
        toast('No se pudo procesar la imagen.');
      })
      .finally(function () {
        btnChooseImage.disabled = false;
        btnChooseImage.textContent = 'Subir imagen';
      });
  });

  btnRemoveImage.addEventListener('click', function () {
    if (isNewMode()) return;
    var targetEventId = currentEventId;
    showConfirm(
      'Quitar imagen',
      'Se quitará la imagen de fondo de este evento. Las entradas van a mostrarse sólo con el código QR. ¿Confirmás?',
      function () {
        api('event-image', 'DELETE', null, { eventId: targetEventId }).then(function (result) {
          if (result.data && result.data.ok) {
            delete backgroundImageCache[targetEventId];
            if (targetEventId === currentEventId) {
              currentEvent.hasImage = false;
              syncImagePreview();
            }
            var ev = events.find(function (e) { return e.id === targetEventId; });
            if (ev) ev.hasImage = false;
            toast('Imagen eliminada.');
          } else if (!resyncIfEventMissing(result)) {
            toast((result.data && result.data.message) || 'No se pudo quitar la imagen.');
          }
        }).catch(function () {
          toast('Sin conexión con el servidor.');
        });
      }
    );
  });

  poolView.addEventListener('click', function (e) {
    var viewBtn = e.target.closest('.btn-view-ticket');
    if (viewBtn) {
      var viewedTicket = findTicketByCode(viewBtn.getAttribute('data-code'));
      if (viewedTicket) openDispenseModal([viewedTicket], { title: 'Entrada' });
      return;
    }

    var shareBtn = e.target.closest('.btn-share-whatsapp');
    if (shareBtn) {
      shareTicketViaWhatsApp(findTicketByCode(shareBtn.getAttribute('data-code')));
      return;
    }

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

  modalTicketsList.addEventListener('click', function (e) {
    var shareBtn = e.target.closest('.btn-share-whatsapp');
    if (!shareBtn) return;
    shareTicketViaWhatsApp(findTicketByCode(shareBtn.getAttribute('data-code')));
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
          syncImagePreview();
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
    var quantity = parseInt(inputDispenseQuantity.value, 10);
    if (!quantity || quantity < 1) quantity = 1;
    btnDispense.disabled = true;
    api('dispense', 'POST', { eventId: currentEventId, recipient: recipient, quantity: quantity }).then(function (result) {
      if (result.data && result.data.ok) {
        var tickets = result.data.tickets || (result.data.ticket ? [result.data.ticket] : []);
        var byCode = {};
        tickets.forEach(function (t) { byCode[t.code] = t; });
        currentEvent.tickets = currentEvent.tickets.map(function (t) {
          return byCode[t.code] || t;
        });
        var ev = events.find(function (e) { return e.id === currentEventId; });
        if (ev) ev.stats = result.data.stats;
        refreshDerivedUI();
        renderPoolView();
        renderEventOptions();
        lastDispensedTickets = tickets;
        btnViewLast.hidden = tickets.length === 0;
        openDispenseModal(tickets, { title: tickets.length > 1 ? tickets.length + ' entradas entregadas' : 'Entrada entregada' });
        inputRecipient.value = '';
        if (result.data.dispensedCount != null && result.data.requested != null && result.data.dispensedCount < result.data.requested) {
          toast('Sólo quedaban ' + result.data.dispensedCount + ' código(s) disponible(s); se entregaron esos.');
        }
      } else if (result.data && result.data.error === 'pool_empty') {
        toast('No quedan códigos disponibles en el pool.');
      } else if (result.data && result.data.error === 'invalid_quantity') {
        toast('Ingresá una cantidad válida (entre 1 y 500).');
      } else if (!resyncIfEventMissing(result)) {
        toast((result.data && result.data.message) || 'No se pudo entregar entradas.');
      }
    }).catch(function () {
      toast('Sin conexión con el servidor.');
    }).finally(function () {
      // refreshDerivedUI() re-derives btnDispense.disabled from the current
      // disponible count — do not force it back to false here, or a batch
      // that exhausts the pool would leave the button wrongly re-enabled.
      refreshDerivedUI();
    });
  });

  btnViewLast.addEventListener('click', function () {
    if (!lastDispensedTickets.length) return;
    openDispenseModal(lastDispensedTickets, { title: lastDispensedTickets.length > 1 ? lastDispensedTickets.length + ' entradas entregadas' : 'Entrada entregada' });
  });

  // Opens the ticket modal for one or several tickets — used right after a
  // dispense (possibly several at once), from "Ver última entrega", and
  // from each row's own "Ver entrada" button. Every ticket shown gets its
  // own QR (drawn fresh into its own canvas) and its own WhatsApp button.
  function openDispenseModal(tickets, opts) {
    opts = opts || {};
    var list = Array.isArray(tickets) ? tickets : [tickets];
    var useComposite = !!currentEvent.hasImage;
    modalTitle.textContent = opts.title || 'Entrada';
    modalTicketsList.innerHTML = list.map(function (t) {
      if (useComposite) {
        return '<div class="modal-ticket modal-ticket--composite">' +
          '<div class="ticket-visual"><canvas class="modal-ticket-canvas" data-code="' + escapeHtml(t.code) + '" width="' + CARD_W + '" height="' + CARD_H + '"></canvas></div>' +
          '<button class="btn btn-whatsapp btn-share-whatsapp" type="button" data-code="' + escapeHtml(t.code) + '">Compartir por WhatsApp</button>' +
          '</div>';
      }
      return '<div class="modal-ticket">' +
        '<div class="qr-holder"><canvas class="modal-qr-canvas" data-code="' + escapeHtml(t.code) + '" width="200" height="200"></canvas></div>' +
        '<div class="code-text">' + escapeHtml(t.code) + '</div>' +
        '<div class="recipient-text">' + (t.recipient ? 'A nombre de ' + escapeHtml(t.recipient) : '') + '</div>' +
        '<button class="btn btn-whatsapp btn-share-whatsapp" type="button" data-code="' + escapeHtml(t.code) + '">Compartir por WhatsApp</button>' +
        '</div>';
    }).join('');
    dispenseModal.hidden = false;

    if (useComposite) {
      var eventIdForCanvases = currentEventId;
      var ticketCanvases = modalTicketsList.querySelectorAll('canvas.modal-ticket-canvas');
      loadBackgroundImage(eventIdForCanvases).then(function (bgImg) {
        for (var i = 0; i < ticketCanvases.length; i++) {
          var canvas = ticketCanvases[i];
          var ticket = findTicketByCode(canvas.getAttribute('data-code'));
          if (ticket) drawTicketCard(canvas, bgImg, ticket, currentEvent.name);
        }
      }).catch(function () {
        // Background failed to load (e.g. removed mid-session from another
        // tab) — fall back to a plain QR so the modal is never left blank.
        for (var i = 0; i < ticketCanvases.length; i++) {
          var canvas = ticketCanvases[i];
          var ticket = findTicketByCode(canvas.getAttribute('data-code'));
          canvas.width = 200;
          canvas.height = 200;
          if (ticket) drawQR(canvas, QR_PREFIX + ticket.code, 200);
        }
      });
    } else {
      var qrCanvases = modalTicketsList.querySelectorAll('canvas.modal-qr-canvas');
      for (var j = 0; j < qrCanvases.length; j++) {
        drawQR(qrCanvases[j], QR_PREFIX + qrCanvases[j].getAttribute('data-code'), 200);
      }
    }
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
