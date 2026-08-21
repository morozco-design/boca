'use strict';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-passcode',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function json(statusCode, body, extraHeaders) {
  return {
    statusCode,
    headers: Object.assign(
      { 'Content-Type': 'application/json; charset=utf-8' },
      CORS_HEADERS,
      extraHeaders || {}
    ),
    body: JSON.stringify(body),
  };
}

function noContent() {
  return {
    statusCode: 204,
    headers: CORS_HEADERS,
    body: '',
  };
}

function parseBody(event) {
  if (!event.body) return {};
  try {
    return JSON.parse(event.body);
  } catch (err) {
    return null;
  }
}

module.exports = { json, noContent, parseBody, CORS_HEADERS };
