(function () {
  'use strict';

  var QR_PREFIX = 'PU:';
  var NEW_EVENT_VALUE = '__new__';
  var STORAGE_KEY = 'pu_current_event_id';

  var statTotal = document.getElementById('stat-total');
  var statDisponible = document.getElementById('stat-disponible');
  var statVendidas = document.getElementById('stat-vendidas');
  var statUsadas = document.getElementById('stat-usadas');
  var soldOutBanner = document.getElementById('sold-out-banner');
  var statsRow = document.getElementById('stats-row');

  var selectEvent = document.getElementById('select-event');
  var btnDeleteEvent = document.getElementById('btn-delete-event');
  var noEventsHint = document.getElementById('no-events-hint');
  var btnEditEvent = document.getElementById('btn-edit-event');
  var panelView = document.getElementById('panel-view');
  var loginOverlay = document.getElementById('login-overlay');
  var loginForm = document.getElementById('login-form');
  var loginPassword = document.getElementById('login-password');
  var loginError = document.getElementById('login-error');
  var editModal = document.getElementById('edit-modal');
  var editForm = document.getElementById('edit-form');
  var editName = document.getElementById('edit-name');
  var editCapacity = document.getElementById('edit-capacity');
  var editHint = document.getElementById('edit-hint');
  var editOrder = document.getElementById('edit-order');
  var securityCard = document.getElementById('security-card');
  var btnLogout = document.getElementById('btn-logout');

  var generateCard = document.getElementById('generate-card');
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

  var saleImageCard = document.getElementById('sale-image-card');
  var salePreview = document.getElementById('sale-preview');
  var salePreviewEmpty = document.getElementById('sale-preview-empty');
  var inputSaleImage = document.getElementById('input-sale-image');
  var btnChooseSaleImage = document.getElementById('btn-choose-sale-image');
  var btnRemoveSaleImage = document.getElementById('btn-remove-sale-image');
  var SALE_W = 1200;
  var SALE_H = 800;

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
  var btnShareAll = document.getElementById('btn-share-all');
  // Tickets currently listed in the modal, so "Compartir todas" shares
  // exactly what the user is looking at (a fresh batch or "Ver entrada").
  var modalTickets = [];

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

  // Clave de administrador (opcional, ver ADMIN_PASSCODE en el README). Se
  // pide una sola vez por sesión del navegador, cuando el servidor responde
  // 401, y se manda en cada llamada.
  var PASSCODE_KEY = 'pu_admin_passcode';
  function readPasscode() {
    try { return sessionStorage.getItem(PASSCODE_KEY) || ''; } catch (e) { return ''; }
  }
  function storePasscode(v) {
    try {
      if (v) sessionStorage.setItem(PASSCODE_KEY, v);
      else sessionStorage.removeItem(PASSCODE_KEY);
    } catch (e) { /* ignore */ }
  }

  function api(path, method, body, query, retried) {
    var url = '/.netlify/functions/' + path;
    if (query) {
      var qs = Object.keys(query)
        .filter(function (k) { return query[k] != null && query[k] !== ''; })
        .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(query[k]); })
        .join('&');
      if (qs) url += '?' + qs;
    }
    var headers = { 'Content-Type': 'application/json' };
    var passcode = readPasscode();
    if (passcode) headers['x-admin-passcode'] = passcode;
    return fetch(url, {
      method: method || 'GET',
      headers: headers,
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (res) {
      return res.json().then(function (data) {
        if (res.status === 401) {
          // La clave no sirve (o cambió): se vuelve a pedir en la pantalla de acceso.
          storePasscode('');
          showLogin(passcode ? 'La contraseña ya no es válida. Ingresala de nuevo.' : '');
        }
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

  // Looks for a big white rectangle in the uploaded background (a "slot"
  // the designer left for the QR). If the image has one, the QR is drawn
  // INSIDE it instead of on a separate card, so it never spills outside the
  // artwork. Works on a quarter-size copy for speed and caches the result
  // on the image object. Returns {x, y, w, h} in card coordinates, or null
  // when the image has no such slot (then the default card is used).
  function detectQrSlot(bgImg) {
    if (bgImg.__qrSlot !== undefined) return bgImg.__qrSlot;
    var slot = null;
    try {
      var S = 4;
      var w = CARD_W / S;
      var h = CARD_H / S;
      var c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      var cctx = c.getContext('2d');
      var scale = Math.max(w / bgImg.naturalWidth, h / bgImg.naturalHeight);
      var dw = bgImg.naturalWidth * scale;
      var dh = bgImg.naturalHeight * scale;
      cctx.drawImage(bgImg, (w - dw) / 2, (h - dh) / 2, dw, dh);
      var data = cctx.getImageData(0, 0, w, h).data;

      // Longest run of (nearly) white pixels on each row.
      var minRun = w * 0.25;
      var rowRun = [];
      for (var y = 0; y < h; y++) {
        var best = 0, bestEnd = 0, cur = 0;
        for (var x = 0; x < w; x++) {
          var i = (y * w + x) * 4;
          if (data[i] >= 240 && data[i + 1] >= 240 && data[i + 2] >= 240 && data[i + 3] > 200) {
            cur++;
            if (cur > best) { best = cur; bestEnd = x; }
          } else {
            cur = 0;
          }
        }
        rowRun.push({ len: best, end: bestEnd });
      }

      // Tallest band of consecutive rows that contain such a run.
      var bandStart = -1, bestStart = 0, bestLen = 0;
      for (var yy = 0; yy <= h; yy++) {
        var ok = yy < h && rowRun[yy].len >= minRun;
        if (ok && bandStart < 0) bandStart = yy;
        if (!ok && bandStart >= 0) {
          if (yy - bandStart > bestLen) { bestLen = yy - bandStart; bestStart = bandStart; }
          bandStart = -1;
        }
      }
      if (bestLen >= h * 0.1) {
        var mid = rowRun[bestStart + Math.floor(bestLen / 2)];
        slot = {
          x: (mid.end - mid.len + 1) * S,
          y: bestStart * S,
          w: mid.len * S,
          h: bestLen * S,
        };
      }
    } catch (e) {
      slot = null;
    }
    bgImg.__qrSlot = slot;
    return slot;
  }

  // Draws the event's background image "cover"-fit into a 1080x1920 canvas,
  // then puts the QR and — the only text on the card — the ticket number
  // underneath it. If the image has a white slot for the QR it goes inside
  // that slot; otherwise a white rounded card is drawn near the bottom.
  function drawTicketCard(canvas, bgImg, ticket) {
    canvas.width = CARD_W;
    canvas.height = CARD_H;
    var ctx = canvas.getContext('2d');

    var scale = Math.max(CARD_W / bgImg.naturalWidth, CARD_H / bgImg.naturalHeight);
    var dw = bgImg.naturalWidth * scale;
    var dh = bgImg.naturalHeight * scale;
    var dx = (CARD_W - dw) / 2;
    var dy = (CARD_H - dh) / 2;
    ctx.drawImage(bgImg, dx, dy, dw, dh);

    var slot = detectQrSlot(bgImg);
    if (slot) {
      var sPad = Math.round(Math.min(slot.w, slot.h) * 0.06);
      var textH = 60;
      var sQr = Math.floor(Math.min(slot.w - sPad * 2, slot.h - sPad * 2 - textH));
      var sQrX = slot.x + (slot.w - sQr) / 2;
      var sQrY = slot.y + sPad;
      drawQRModules(ctx, QR_PREFIX + ticket.code, sQrX, sQrY, sQr);
      ctx.textAlign = 'center';
      ctx.fillStyle = '#181325';
      ctx.font = '600 34px "IBM Plex Mono", monospace';
      ctx.fillText(ticket.code, slot.x + slot.w / 2, sQrY + sQr + 46);
      return;
    }

    var padding = 40;
    var qrSize = 480;
    var gapAfterQr = 30;
    var codeH = 46;
    var cardW = CARD_W - 96;
    var cardH = padding * 2 + qrSize + gapAfterQr + codeH;
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
    var qrX = CARD_W / 2 - qrSize / 2;
    drawQRModules(ctx, QR_PREFIX + ticket.code, qrX, cursorY, qrSize);
    cursorY += qrSize + gapAfterQr;

    ctx.textAlign = 'center';
    ctx.fillStyle = '#181325';
    ctx.font = '600 38px "IBM Plex Mono", monospace';
    ctx.fillText(ticket.code, CARD_W / 2, cursorY + 32);
  }

  // Reads a File, decodes it, and center-crops/"cover"-fits it into a
  // canonical portrait canvas so every uploaded image ends up with the same
  // proportions server-side regardless of what the admin picked — the
  // person uploading never has to pre-crop anything themselves.
  function normalizeImageFileToDataUrl(file, outW, outH) {
    var W = outW || CARD_W;
    var H = outH || CARD_H;
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('read_failed')); };
      reader.onload = function () {
        var img = new Image();
        img.onerror = function () { reject(new Error('decode_failed')); };
        img.onload = function () {
          try {
            var canvas = document.createElement('canvas');
            canvas.width = W;
            canvas.height = H;
            var ctx = canvas.getContext('2d');
            var scale = Math.max(W / img.naturalWidth, H / img.naturalHeight);
            var dw = img.naturalWidth * scale;
            var dh = img.naturalHeight * scale;
            var dx = (W - dw) / 2;
            var dy = (H - dh) / 2;
            ctx.fillStyle = '#111111';
            ctx.fillRect(0, 0, W, H);
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

  // No caption/title is ever attached to the share — just the ticket image
  // (composited with the event's background when it has one, or the plain
  // QR otherwise) — per explicit request: WhatsApp should receive only the
  // image and nothing else.
  function ticketImageBlob(ticket) {
    return currentEvent.hasImage
      ? loadBackgroundImage(currentEventId).then(function (bgImg) {
          var canvas = document.createElement('canvas');
          drawTicketCard(canvas, bgImg, ticket);
          return new Promise(function (resolve) {
            if (canvas.toBlob) canvas.toBlob(function (blob) { resolve(blob); }, 'image/jpeg', 0.92);
            else resolve(null);
          });
        }).catch(function () { return qrBlobAsync(QR_PREFIX + ticket.code, 600); })
      : qrBlobAsync(QR_PREFIX + ticket.code, 600);
  }

  // No browser can attach an arbitrary file to a wa.me link — that only
  // works through the native share sheet. So when file sharing isn't
  // available (mostly desktop), the closest honest equivalent to "share
  // only the image" is: download the image (nothing else) and open
  // WhatsApp with a blank chat so it can be attached by hand.
  function downloadImageAndOpenWhatsApp(blob, ticket) {
    if (blob) {
      var url = URL.createObjectURL(blob);
      var ext = blob.type === 'image/jpeg' ? '.jpg' : '.png';
      var a = document.createElement('a');
      a.href = url;
      a.download = 'entrada-' + ticket.code + ext;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      toast('Se descargó la imagen de la entrada — adjuntala en WhatsApp.');
    }
    window.open('https://wa.me/', '_blank');
  }

  // Shares a single ticket's image (QR, or QR-on-background when the event
  // has one) via the native share sheet, preferring a real image file so
  // WhatsApp receives just the picture with no accompanying text.
  function shareTicketViaWhatsApp(ticket) {
    if (!ticket) return;
    ticketImageBlob(ticket).then(function (blob) {
      var file = null;
      if (blob && typeof File === 'function') {
        var ext = blob.type === 'image/jpeg' ? '.jpg' : '.png';
        try { file = new File([blob], 'entrada-' + ticket.code + ext, { type: blob.type || 'image/png' }); } catch (e) { file = null; }
      }
      if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
        navigator.share({ files: [file] }).catch(function (err) {
          if (!err || err.name !== 'AbortError') downloadImageAndOpenWhatsApp(blob, ticket);
        });
      } else {
        downloadImageAndOpenWhatsApp(blob, ticket);
      }
    });
  }

  // Shares a whole batch in one go: every ticket image is attached to a
  // single native share sheet, so WhatsApp receives them together in one
  // message. Without file sharing (mostly desktop) it downloads all the
  // images and opens WhatsApp so they can be attached at once.
  function shareAllViaWhatsApp(tickets) {
    if (!tickets || !tickets.length) return;
    btnShareAll.disabled = true;
    var originalLabel = btnShareAll.textContent;
    btnShareAll.textContent = 'Preparando ' + tickets.length + ' entradas…';

    Promise.all(tickets.map(function (t) { return ticketImageBlob(t); }))
      .then(function (blobs) {
        var files = [];
        blobs.forEach(function (blob, i) {
          if (!blob || typeof File !== 'function') return;
          var ext = blob.type === 'image/jpeg' ? '.jpg' : '.png';
          try { files.push(new File([blob], 'entrada-' + tickets[i].code + ext, { type: blob.type || 'image/png' })); } catch (e) { /* skip */ }
        });

        function fallbackDownloadAll() {
          blobs.forEach(function (blob, i) {
            if (!blob) return;
            setTimeout(function () {
              var url = URL.createObjectURL(blob);
              var a = document.createElement('a');
              a.href = url;
              a.download = 'entrada-' + tickets[i].code + (blob.type === 'image/jpeg' ? '.jpg' : '.png');
              document.body.appendChild(a);
              a.click();
              a.remove();
              setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
            }, i * 350);
          });
          toast('Se descargaron ' + tickets.length + ' imágenes — adjuntalas en WhatsApp.');
          window.open('https://wa.me/', '_blank');
        }

        if (files.length === tickets.length && navigator.canShare && navigator.canShare({ files: files })) {
          return navigator.share({ files: files }).catch(function (err) {
            if (!err || err.name !== 'AbortError') fallbackDownloadAll();
          });
        }
        fallbackDownloadAll();
      })
      .catch(function () {
        toast('No se pudieron preparar las entradas.');
      })
      .finally(function () {
        btnShareAll.disabled = false;
        btnShareAll.textContent = originalLabel;
      });
  }

  btnShareAll.addEventListener('click', function () {
    shareAllViaWhatsApp(modalTickets);
  });

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
    btnEditEvent.hidden = isNew;
    statsRow.hidden = isNew;
    dispenseCard.hidden = isNew;
    poolCard.hidden = isNew;
    imageCard.hidden = isNew;
    saleImageCard.hidden = isNew;
    // Agregar códigos a un evento existente se hace desde "Editar" (aforo).
    generateCard.hidden = !isNew;
    noEventsHint.hidden = !(isNew && events.length === 0);
    if (isNew) {
      generateTitle.textContent = 'Crear evento';
      labelEventName.textContent = 'Nombre del evento';
      btnGenerate.textContent = 'Crear evento y generar lote';
      soldOutBanner.hidden = true;
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

  function syncSalePreview() {
    var has = !isNewMode() && !!currentEvent.hasSaleImage;
    btnRemoveSaleImage.hidden = !has;
    if (has) {
      salePreview.hidden = false;
      salePreviewEmpty.hidden = true;
      salePreview.src = '/.netlify/functions/event-image?kind=sale&eventId=' + encodeURIComponent(currentEventId) + '&v=' + Date.now();
    } else {
      salePreview.hidden = true;
      salePreview.removeAttribute('src');
      salePreviewEmpty.hidden = false;
    }
  }

  function resetImagePreview(loading) {
    btnRemoveSaleImage.hidden = true;
    salePreview.hidden = true;
    salePreview.removeAttribute('src');
    salePreviewEmpty.hidden = false;
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
        syncSalePreview();
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
    var vendidas = tickets.filter(function (t) { return t.status === 'emitido'; }).length;
    var usadas = tickets.filter(function (t) { return t.status === 'usado'; }).length;
    statTotal.textContent = total;
    statDisponible.textContent = disponible;
    statVendidas.textContent = vendidas;
    statUsadas.textContent = usadas;
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
      var pillLabel = t.status === 'disponible' ? 'Disponible' : t.status === 'emitido' ? 'Entregado' : t.status === 'reservado' ? 'Reservado (pagando)' : 'Usado';
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

  // ---- Imagen de la página de venta ----
  btnChooseSaleImage.addEventListener('click', function () {
    if (isNewMode()) return;
    inputSaleImage.click();
  });

  inputSaleImage.addEventListener('change', function () {
    var file = inputSaleImage.files && inputSaleImage.files[0];
    inputSaleImage.value = '';
    if (!file || isNewMode()) return;
    if (!/^image\//.test(file.type)) {
      toast('Elegí un archivo de imagen (PNG, JPG o WEBP).');
      return;
    }
    var targetEventId = currentEventId;
    btnChooseSaleImage.disabled = true;
    btnChooseSaleImage.textContent = 'Procesando…';
    normalizeImageFileToDataUrl(file, SALE_W, SALE_H)
      .then(function (dataUrl) {
        return api('event-image', 'POST', { eventId: targetEventId, imageDataUrl: dataUrl, kind: 'sale' });
      })
      .then(function (result) {
        if (result.data && result.data.ok) {
          if (targetEventId === currentEventId) {
            currentEvent.hasSaleImage = true;
            syncSalePreview();
          }
          var ev = events.find(function (e) { return e.id === targetEventId; });
          if (ev) ev.hasSaleImage = true;
          toast('Imagen de la página de venta actualizada.');
        } else if (!resyncIfEventMissing(result)) {
          toast((result.data && result.data.message) || 'No se pudo subir la imagen.');
        }
      })
      .catch(function () { toast('No se pudo procesar la imagen.'); })
      .finally(function () {
        btnChooseSaleImage.disabled = false;
        btnChooseSaleImage.textContent = 'Subir imagen';
      });
  });

  btnRemoveSaleImage.addEventListener('click', function () {
    if (isNewMode()) return;
    var targetEventId = currentEventId;
    showConfirm('Quitar imagen', 'Se quitará la imagen de la página de venta de este evento. ¿Confirmás?', function () {
      api('event-image', 'DELETE', null, { eventId: targetEventId, kind: 'sale' }).then(function (result) {
        if (result.data && result.data.ok) {
          if (targetEventId === currentEventId) {
            currentEvent.hasSaleImage = false;
            syncSalePreview();
          }
          var ev = events.find(function (e) { return e.id === targetEventId; });
          if (ev) ev.hasSaleImage = false;
          toast('Imagen eliminada.');
        } else if (!resyncIfEventMissing(result)) {
          toast((result.data && result.data.message) || 'No se pudo quitar la imagen.');
        }
      }).catch(function () { toast('Sin conexión con el servidor.'); });
    });
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
    modalTickets = list;
    btnShareAll.hidden = list.length < 2;
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
          if (ticket) drawTicketCard(canvas, bgImg, ticket);
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
        '</div>';
    }).join('');
    printArea.innerHTML = html;
    printArea.hidden = false;
    setTimeout(function () {
      window.print();
      printArea.hidden = true;
    }, 80);
  });

  // ---- Editar evento (nombre y aforo) ----
  function openEdit() {
    var ev = events.find(function (e) { return e.id === currentEventId; });
    if (!ev) return;
    var tickets = currentEvent.tickets || [];
    var locked = tickets.filter(function (t) { return t.status !== 'disponible'; }).length;
    editName.value = ev.name;
    editOrder.value = ev.saleOrder ? String(ev.saleOrder) : '';
    editCapacity.value = String(tickets.length || (ev.stats && ev.stats.total) || 1);
    editCapacity.min = String(Math.max(1, locked));
    editHint.textContent = locked > 0
      ? 'No se puede bajar de ' + locked + ' porque ya hay ' + locked + ' entradas reservadas, entregadas o usadas. Al subir el aforo se agregan códigos nuevos; al bajarlo se quitan solo códigos disponibles.'
      : 'Al subir el aforo se agregan códigos nuevos; al bajarlo se quitan códigos disponibles.';
    editModal.hidden = false;
    editName.focus();
  }
  btnEditEvent.addEventListener('click', openEdit);
  document.getElementById('btn-edit-cancel').addEventListener('click', function () { editModal.hidden = true; });
  editForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var name = editName.value.trim();
    var cap = parseInt(editCapacity.value, 10);
    if (!name) { toast('Poné un nombre para el evento.'); return; }
    if (!(cap >= 1)) { toast('Ingresá un aforo válido.'); return; }
    api('edit-event', 'POST', { eventId: currentEventId, name: name, capacity: cap, saleOrder: editOrder.value.trim() === '' ? null : parseInt(editOrder.value, 10) }).then(function (result) {
      if (result.data && result.data.ok) {
        editModal.hidden = true;
        currentEvent = result.data.event;
        events = result.data.events || events;
        renderEventOptions();
        refreshDerivedUI();
        renderPoolView();
        syncSalePreview();
        toast('Evento actualizado.');
      } else if (!resyncIfEventMissing(result) && result.status !== 401) {
        toast((result.data && result.data.message) || 'No se pudo guardar los cambios.');
      }
    }).catch(function () { toast('Sin conexión con el servidor.'); });
  });

  // ---- Acceso y contraseña del panel ----
  function showLogin(msg) {
    panelView.hidden = true;
    loginOverlay.hidden = false;
    loginError.hidden = !msg;
    loginError.textContent = msg || '';
    loginPassword.value = '';
    loginPassword.focus();
  }

  function renderSecurity(info) {
    securityCard.hidden = !info.protected;
  }

  function enterPanel(info) {
    loginOverlay.hidden = true;
    panelView.hidden = false;
    renderSecurity(info);
    loadEvents();
  }

  function tryLogin(pass) {
    var headers = { 'Content-Type': 'application/json' };
    if (pass) headers['x-admin-passcode'] = pass;
    return fetch('/.netlify/functions/admin-auth', { method: 'POST', headers: headers, body: JSON.stringify({ action: 'login' }) })
      .then(function (res) { return res.json().then(function (data) { return { status: res.status, data: data }; }); });
  }

  loginForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var pass = loginPassword.value;
    if (!pass) return;
    tryLogin(pass).then(function (r) {
      if (r.status === 200 && r.data.ok) {
        storePasscode(pass);
        enterPanel(r.data);
      } else {
        loginError.hidden = false;
        loginError.textContent = 'Contraseña incorrecta.';
        loginPassword.value = '';
        loginPassword.focus();
      }
    }).catch(function () {
      loginError.hidden = false;
      loginError.textContent = 'No se pudo conectar con el servidor.';
    });
  });

  btnLogout.addEventListener('click', function () {
    storePasscode('');
    showLogin('');
  });

  // ---- Boot ----
  fetch('/.netlify/functions/admin-auth').then(function (res) { return res.json(); }).then(function (info) {
    if (!info || !info.ok) throw new Error('auth');
    if (!info.protected) { enterPanel(info); return; }
    var saved = readPasscode();
    if (!saved) { showLogin(''); return; }
    tryLogin(saved).then(function (r) {
      if (r.status === 200 && r.data.ok) enterPanel(r.data);
      else { storePasscode(''); showLogin(''); }
    });
  }).catch(function () {
    // Si no se puede consultar, se muestra el panel y se ve el error normal.
    panelView.hidden = false;
    loadEvents();
  });
})();
