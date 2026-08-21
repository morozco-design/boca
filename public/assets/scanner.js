(function () {
  'use strict';

  var QR_PREFIX = 'PU:';
  var video = document.getElementById('camera-video');
  var canvas = document.getElementById('scan-canvas');
  var ctx = canvas.getContext('2d', { willReadFrequently: true });
  var btnStart = document.getElementById('btn-start-camera');
  var cameraHint = document.getElementById('camera-hint');
  var statusBox = document.getElementById('scan-status');
  var headlineEl = document.getElementById('scan-headline');
  var subEl = document.getElementById('scan-sub');
  var toastRegion = document.getElementById('toast-region');

  var scanning = false;
  var busy = false; // a validate request is in flight
  var lastCode = null;
  var lastTime = 0;
  var COOLDOWN_MS = 2500;
  var audioCtx = null;
  var rafId = null;

  function toast(msg) {
    var el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    toastRegion.appendChild(el);
    setTimeout(function () {
      el.remove();
    }, 3200);
  }

  function beep(freq, dur) {
    try {
      if (!audioCtx) {
        var Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        audioCtx = new Ctx();
      }
      var osc = audioCtx.createOscillator();
      var gain = audioCtx.createGain();
      osc.frequency.value = freq;
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      gain.gain.setValueAtTime(0.18, audioCtx.currentTime);
      osc.start();
      gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + dur / 1000);
      osc.stop(audioCtx.currentTime + dur / 1000 + 0.02);
    } catch (err) {
      /* ignore audio errors, non-critical */
    }
  }

  function setScanStatus(kind, headline, sub) {
    statusBox.hidden = false;
    statusBox.className = 'scan-status scan-status--' + kind;
    headlineEl.textContent = headline;
    subEl.textContent = sub || '';
  }

  function describeError(err) {
    var name = err && err.name;
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      return 'Permiso de cámara denegado. Habilitá el acceso a la cámara para este sitio en la configuración del navegador.';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return 'No se encontró ninguna cámara en este dispositivo.';
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
      return 'La cámara está siendo usada por otra aplicación.';
    }
    if (name === 'SecurityError') {
      return 'El navegador bloqueó el acceso a la cámara (¿estás en HTTPS?).';
    }
    return 'No se pudo acceder a la cámara (' + (name || 'error desconocido') + ').';
  }

  function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      cameraHint.hidden = false;
      cameraHint.textContent = 'Este navegador no soporta acceso a la cámara.';
      return;
    }
    cameraHint.hidden = true;
    var constraintsPrimary = { video: { facingMode: { ideal: 'environment' } }, audio: false };
    navigator.mediaDevices.getUserMedia(constraintsPrimary)
      .catch(function () {
        return navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      })
      .then(function (stream) {
        video.srcObject = stream;
        return video.play();
      })
      .then(function () {
        btnStart.hidden = true;
        scanning = true;
        rafId = requestAnimationFrame(tick);
      })
      .catch(function (err) {
        cameraHint.hidden = false;
        cameraHint.textContent = describeError(err);
      });
  }

  function tick() {
    if (!scanning) return;
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      var vw = video.videoWidth;
      var vh = video.videoHeight;
      if (vw && vh) {
        var targetW = 480;
        var targetH = Math.round((vh / vw) * targetW);
        canvas.width = targetW;
        canvas.height = targetH;
        ctx.drawImage(video, 0, 0, targetW, targetH);
        var imageData = ctx.getImageData(0, 0, targetW, targetH);
        var code = null;
        try {
          code = window.jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'dontInvert' });
        } catch (err) {
          code = null;
        }
        if (code && code.data) {
          handleDecoded(code.data);
        }
      }
    }
    rafId = requestAnimationFrame(tick);
  }

  function handleDecoded(text) {
    if (busy) return;
    var now = Date.now();
    if (text === lastCode && now - lastTime < COOLDOWN_MS) return;
    if (!text.startsWith(QR_PREFIX)) return;
    lastCode = text;
    lastTime = now;
    var rawCode = text.slice(QR_PREFIX.length);
    validateCode(rawCode);
  }

  function validateCode(code) {
    busy = true;
    setScanStatus('unknown', 'Verificando…', code);
    fetch('/.netlify/functions/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code }),
    })
      .then(function (res) {
        return res.json().then(function (data) {
          return { status: res.status, data: data };
        });
      })
      .then(function (result) {
        var data = result.data;
        if (data.ok) {
          beep(880, 140);
          var sub = data.recipient ? 'A nombre de ' + data.recipient : code;
          setScanStatus('valid', 'Ingreso habilitado', sub);
        } else if (data.reason === 'already_used') {
          beep(220, 260);
          setScanStatus('used', 'Código ya utilizado', 'Este pase ya ingresó antes.');
        } else if (data.reason === 'not_issued') {
          beep(220, 260);
          setScanStatus('used', 'Código no entregado', 'Este código todavía no fue entregado a nadie.');
        } else if (data.reason === 'not_found') {
          beep(220, 260);
          setScanStatus('used', 'Código no reconocido', 'Este código no pertenece a este evento.');
        } else {
          setScanStatus('unknown', 'No se pudo validar', data.error || '');
        }
      })
      .catch(function () {
        setScanStatus('unknown', 'Sin conexión', 'No se pudo contactar al servidor. Probá de nuevo.');
      })
      .finally(function () {
        busy = false;
      });
  }

  btnStart.addEventListener('click', startCamera);
})();
