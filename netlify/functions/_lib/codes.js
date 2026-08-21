'use strict';

const crypto = require('crypto');

// Alphabet excludes 0/1/I/L/O/U to avoid visually-ambiguous characters.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 8;

function randomCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out.slice(0, 4) + '-' + out.slice(4);
}

// Generates `count` codes guaranteed unique against each other AND against
// any codes already present in `existing` (a Set or array of raw codes,
// without the "PU:" prefix).
function generateUniqueCodes(count, existing) {
  const taken = existing instanceof Set ? existing : new Set(existing || []);
  const out = [];
  const seenThisBatch = new Set();
  let attempts = 0;
  const maxAttempts = count * 50 + 1000;
  while (out.length < count) {
    attempts++;
    if (attempts > maxAttempts) {
      throw new Error('No se pudieron generar suficientes códigos únicos.');
    }
    const code = randomCode();
    if (taken.has(code) || seenThisBatch.has(code)) continue;
    seenThisBatch.add(code);
    out.push(code);
  }
  return out;
}

module.exports = { randomCode, generateUniqueCodes, ALPHABET, CODE_LENGTH };
