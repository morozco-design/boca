'use strict';

// Arma, en el servidor, la imagen de cada entrada: la imagen de fondo del
// evento con el QR dentro del recuadro blanco (el mismo criterio que usa el
// panel al compartir por WhatsApp). Es JavaScript puro (jpeg-js / pngjs), así
// que corre en Netlify sin librerías nativas.
const jpeg = require('jpeg-js');
const { PNG } = require('pngjs');
const QRCode = require('qrcode');

const OUT_W = 720;
const OUT_H = 1280;

function decodeImage(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) {
    const img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 512 });
    return { width: img.width, height: img.height, data: img.data };
  }
  if (buf.length > 8 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    const img = PNG.sync.read(buf);
    return { width: img.width, height: img.height, data: img.data };
  }
  throw new Error('unsupported_image_format');
}

// Escala "cover" (recorta al centro) a OUT_W x OUT_H con interpolación bilineal.
function coverResize(src, W, H) {
  const out = new Uint8Array(W * H * 4);
  const scale = Math.max(W / src.width, H / src.height);
  const sw = W / scale;
  const sh = H / scale;
  const ox = (src.width - sw) / 2;
  const oy = (src.height - sh) / 2;
  const step = 1 / scale;
  for (let y = 0; y < H; y++) {
    const fy = oy + (y + 0.5) * step - 0.5;
    const y0 = Math.max(0, Math.min(src.height - 1, Math.floor(fy)));
    const y1 = Math.min(src.height - 1, y0 + 1);
    const wy = Math.max(0, Math.min(1, fy - y0));
    for (let x = 0; x < W; x++) {
      const fx = ox + (x + 0.5) * step - 0.5;
      const x0 = Math.max(0, Math.min(src.width - 1, Math.floor(fx)));
      const x1 = Math.min(src.width - 1, x0 + 1);
      const wx = Math.max(0, Math.min(1, fx - x0));
      const i00 = (y0 * src.width + x0) * 4;
      const i10 = (y0 * src.width + x1) * 4;
      const i01 = (y1 * src.width + x0) * 4;
      const i11 = (y1 * src.width + x1) * 4;
      const o = (y * W + x) * 4;
      for (let k = 0; k < 4; k++) {
        const top = src.data[i00 + k] * (1 - wx) + src.data[i10 + k] * wx;
        const bot = src.data[i01 + k] * (1 - wx) + src.data[i11 + k] * wx;
        out[o + k] = top * (1 - wy) + bot * wy;
      }
    }
  }
  return { width: W, height: H, data: out };
}

// Busca un recuadro blanco grande (el lugar que el diseñador dejó para el QR).
// Misma lógica que detectQrSlot de public/assets/ticket-card.js.
function detectQrSlot(img) {
  const { width: w, height: h, data } = img;
  const minRun = w * 0.25;
  const rowRun = [];
  for (let y = 0; y < h; y++) {
    let best = 0, bestEnd = 0, cur = 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (data[i] >= 240 && data[i + 1] >= 240 && data[i + 2] >= 240) {
        cur++;
        if (cur > best) { best = cur; bestEnd = x; }
      } else {
        cur = 0;
      }
    }
    rowRun.push({ len: best, end: bestEnd });
  }
  let bandStart = -1, bestStart = 0, bestLen = 0;
  for (let y = 0; y <= h; y++) {
    const ok = y < h && rowRun[y].len >= minRun;
    if (ok && bandStart < 0) bandStart = y;
    if (!ok && bandStart >= 0) {
      if (y - bandStart > bestLen) { bestLen = y - bandStart; bestStart = bandStart; }
      bandStart = -1;
    }
  }
  if (bestLen < h * 0.1) return null;
  const mid = rowRun[bestStart + Math.floor(bestLen / 2)];
  return { x: mid.end - mid.len + 1, y: bestStart, w: mid.len, h: bestLen };
}

function fillRect(img, x0, y0, x1, y1, r, g, b) {
  const { width, height, data } = img;
  x0 = Math.max(0, x0); y0 = Math.max(0, y0);
  x1 = Math.min(width, x1); y1 = Math.min(height, y1);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
    }
  }
}

function drawQr(img, text, x, y, size) {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const cell = size / n;
  fillRect(img, Math.round(x), Math.round(y), Math.round(x + size), Math.round(y + size), 255, 255, 255);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.modules.get(r, c)) {
        fillRect(
          img,
          Math.round(x + c * cell), Math.round(y + r * cell),
          Math.round(x + (c + 1) * cell), Math.round(y + (r + 1) * cell),
          17, 17, 17
        );
      }
    }
  }
}

// Prepara el fondo una sola vez (decodifica, escala y busca el recuadro) para
// poder generar muchas entradas del mismo evento sin repetir ese trabajo.
// Devuelve null si la imagen no se puede usar o no tiene recuadro blanco.
function prepareBackground(buffer) {
  try {
    const bg = coverResize(decodeImage(buffer), OUT_W, OUT_H);
    const slot = detectQrSlot(bg);
    return slot ? { bg, slot } : null;
  } catch (e) {
    return null;
  }
}

// Devuelve el JPEG de una entrada (Buffer).
function renderTicketJpeg(prepared, code) {
  const { bg, slot } = prepared;
  const img = { width: bg.width, height: bg.height, data: Uint8Array.from(bg.data) };
  const pad = Math.round(Math.min(slot.w, slot.h) * 0.06);
  const size = Math.floor(Math.min(slot.w - pad * 2, slot.h - pad * 2));
  drawQr(img, 'PU:' + code, slot.x + (slot.w - size) / 2, slot.y + (slot.h - size) / 2, size);
  return Buffer.from(jpeg.encode({ data: img.data, width: img.width, height: img.height }, 88).data);
}

module.exports = { prepareBackground, renderTicketJpeg, detectQrSlot, decodeImage, OUT_W, OUT_H };
