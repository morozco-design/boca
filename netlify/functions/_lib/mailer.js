'use strict';

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Manda por mail las entradas de un pedido, con cada QR dentro del mensaje
// (y adjunto, para guardarlo) y un link a la página con el diseño completo.
// Gmail: necesita GMAIL_USER y GMAIL_APP_PASSWORD (contraseña de aplicación,
// que se crea en la cuenta de Google con verificación en dos pasos activa).
async function sendTicketsEmail({ to, name, eventName, codes, link }) {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) throw new Error('GMAIL_USER / GMAIL_APP_PASSWORD no están configurados en Netlify.');

  const nodemailer = require('nodemailer');
  const QRCode = require('qrcode');

  const attachments = [];
  const blocks = [];
  for (let i = 0; i < codes.length; i++) {
    const cid = 'qr' + i + '@entradas';
    const png = await QRCode.toBuffer('PU:' + codes[i], { type: 'png', width: 360, margin: 2, errorCorrectionLevel: 'M' });
    attachments.push({ filename: 'entrada-' + codes[i] + '.png', content: png, cid, contentType: 'image/png' });
    blocks.push(
      '<div style="display:inline-block;margin:8px;padding:12px;border:1px solid #ddd6ee;border-radius:14px;text-align:center;background:#fff">' +
        '<img src="cid:' + cid + '" width="180" height="180" alt="QR ' + escapeHtml(codes[i]) + '" style="display:block;margin:0 auto 8px">' +
        '<div style="font-family:Consolas,monospace;font-size:15px;letter-spacing:.04em;color:#221c35">' + escapeHtml(codes[i]) + '</div>' +
      '</div>'
    );
  }

  const n = codes.length;
  const subject = (n === 1 ? 'Tu entrada' : 'Tus ' + n + ' entradas') + ' para ' + eventName;
  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#221c35">' +
      '<h2 style="margin:0 0 8px">¡Gracias por tu compra' + (name ? ', ' + escapeHtml(name.split(' ')[0]) : '') + '!</h2>' +
      '<p style="margin:0 0 16px">Acá ' + (n === 1 ? 'está tu entrada' : 'están tus ' + n + ' entradas') + ' para <strong>' + escapeHtml(eventName) + '</strong>. ' +
      'Mostrá el código QR en la puerta; cada entrada se valida una sola vez.</p>' +
      '<div style="text-align:center">' + blocks.join('') + '</div>' +
      (link ? '<p style="text-align:center;margin:20px 0"><a href="' + escapeHtml(link) + '" style="background:#6a42e0;color:#fff;text-decoration:none;padding:12px 20px;border-radius:12px;font-weight:bold;display:inline-block">Ver y guardar mis entradas</a></p>' : '') +
      '<p style="font-size:12px;color:#675e82">Guardá este mail: es tu comprobante. Si tenés algún problema, respondelo y te ayudamos.</p>' +
    '</div>';
  const text =
    'Gracias por tu compra! ' + eventName + '\n\nTus códigos:\n' + codes.join('\n') + '\n\n' + (link ? 'Ver y guardar tus entradas: ' + link + '\n' : '');

  const transport = nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
  const fromName = process.env.MAIL_FROM_NAME || 'Coro Rodal';
  await transport.sendMail({
    from: '"' + String(fromName).replace(/"/g, '') + '" <' + user + '>',
    to,
    subject,
    text,
    html,
    attachments,
  });
}

module.exports = { sendTicketsEmail };
