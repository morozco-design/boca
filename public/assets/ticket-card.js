(function () {
  'use strict';
  // Dibujo del pase (QR sobre la imagen del evento). Es el mismo código que
  // usa el panel para armar la imagen de cada entrada, para que el comprador
  // reciba exactamente el mismo diseño.
  var QR_PREFIX = 'PU:';

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


  // Pase sin imagen de fondo: tarjeta blanca con el QR y el código.
  function drawPlainCard(canvas, ticket) {
    var size = 900;
    canvas.width = size;
    canvas.height = size + 120;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    drawQRModules(ctx, QR_PREFIX + ticket.code, 90, 70, size - 180);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#181325';
    ctx.font = '600 52px "IBM Plex Mono", monospace';
    ctx.fillText(ticket.code, size / 2, size - 20 + 70);
  }

  window.TicketCard = {
    CARD_W: CARD_W,
    CARD_H: CARD_H,
    loadBackgroundImage: loadBackgroundImage,
    drawTicketCard: drawTicketCard,
    drawPlainCard: drawPlainCard,
  };
})();
