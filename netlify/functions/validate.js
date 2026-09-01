'use strict';

const { json, noContent, parseBody } = require('./_lib/http');
const { updateState, MutationRejected, initFromEvent, blobsDebugInfo } = require('./_lib/store');

const QR_PREFIX = 'PU:';

function normalizeCode(raw) {
  if (typeof raw !== 'string') return '';
  let code = raw.trim().toUpperCase();
  if (code.startsWith(QR_PREFIX)) code = code.slice(QR_PREFIX.length);
  return code;
}

// PUBLIC endpoint (no admin passcode) — this is what the door-scanning page
// calls. It deliberately never returns the full ticket list or any other
// codes: only the outcome for the single code it was given.
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return noContent();
  if (event.httpMethod !== 'POST') {
    return json(405, { ok: false, error: 'method_not_allowed' });
  }

  initFromEvent(event);

  const body = parseBody(event);
  if (!body) return json(400, { ok: false, error: 'invalid_json' });

  const code = normalizeCode(body.code);
  if (!code) return json(400, { ok: false, error: 'missing_code' });

  let outcome = null;

  try {
    await updateState((state) => {
      const events = state.events || [];
      let ticket = null;
      for (const ev of events) {
        const t = (ev.tickets || []).find((tt) => tt.code === code);
        if (t) { ticket = t; break; }
      }

      if (!ticket) {
        outcome = { ok: false, reason: 'not_found' };
        throw new MutationRejected('not_found');
      }
      if (ticket.status === 'usado') {
        outcome = { ok: false, reason: 'already_used', usedAt: ticket.usedAt };
        throw new MutationRejected('already_used');
      }
      if (ticket.status === 'disponible') {
        outcome = { ok: false, reason: 'not_issued' };
        throw new MutationRejected('not_issued');
      }

      // status === 'emitido' -> valid first entry, mark it used now.
      ticket.status = 'usado';
      ticket.usedAt = new Date().toISOString();
      outcome = { ok: true, recipient: ticket.recipient || null, usedAt: ticket.usedAt };
      return state;
    });
  } catch (err) {
    if (!(err instanceof MutationRejected)) {
      return json(500, { ok: false, error: 'server_error', message: String((err && err.message) || err), debug: blobsDebugInfo() });
    }
    // else: outcome was already set above before the throw, fall through.
  }

  const statusCode = outcome.ok ? 200 : outcome.reason === 'already_used' ? 409 : 404;
  return json(statusCode, outcome);
};
