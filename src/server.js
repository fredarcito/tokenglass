'use strict';

/**
 * server.js
 *
 * A minimal, local-only HTTP server. It serves exactly four things:
 *
 *   GET /                 public/index.html (the dashboard)
 *   GET /<file>           any other file inside public/
 *   GET /i18n/<lang>.json the translation files from src/i18n/
 *   GET /api/data         the aggregated data (requires the secret token)
 *
 * Everything else answers 404. Security measures:
 *   - listens on 127.0.0.1 only, never on the network;
 *   - rejects requests whose Host header is not localhost / 127.0.0.1 with the
 *     right port (protection against DNS rebinding);
 *   - sends no CORS headers, so other web pages cannot read the responses;
 *   - /api/data needs a random token that is generated at startup and only
 *     appears in the URL the browser is opened with;
 *   - every file path is resolved and checked to stay inside its folder.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ROOT, isInside } = require('./config');
const i18n = require('./i18n');
const data = require('./data');

const HOST = '127.0.0.1';
const PUBLIC_DIR = path.join(ROOT, 'public');
const TOKEN_HEADER = 'x-dashboard-token';
const MAX_PORT_ATTEMPTS = 100;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

/** Constant-time comparison of two strings. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Headers added to every response. */
function baseHeaders(extra) {
  return Object.assign({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': 'no-store'
  }, extra || {});
}

/** Content-Security-Policy for the dashboard page. Chart.js is the only external script allowed. */
function cspHeader(nonce) {
  return [
    "default-src 'none'",
    "script-src 'nonce-" + nonce + "' https://cdn.jsdelivr.net",
    "style-src 'nonce-" + nonce + "'",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'"
  ].join('; ');
}

function send(req, res, status, headers, body) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body || '');
  res.writeHead(status, baseHeaders(Object.assign({ 'Content-Length': payload.length }, headers)));
  res.end(req.method === 'HEAD' ? undefined : payload);
}

/** Read a file only if it lives inside `root`. Returns a Buffer or null. */
function readInside(root, relativePath) {
  const full = path.resolve(root, relativePath);
  if (!isInside(root, full)) return null;
  try {
    const real = fs.realpathSync(full);
    if (!isInside(fs.realpathSync(root), real)) return null;
    if (!fs.statSync(real).isFile()) return null;
    return fs.readFileSync(real);
  } catch (e) {
    return null;
  }
}

/**
 * Start the server on `options.port` (or the next free port).
 * options = { ctx, port }, where ctx is what data.loadDashboardData needs.
 * Resolves to { server, port, requestedPort, token, url }.
 */
function startServer(options) {
  const ctx = options.ctx;
  const token = crypto.randomBytes(24).toString('hex');
  const requestedPort = options.port;
  let currentPort = requestedPort;

  // Reads are queued so two quick reloads never write history.json at the same time.
  let queue = Promise.resolve();
  function readData() {
    const run = queue.then(function () { return data.loadDashboardData(ctx); });
    queue = run.catch(function () { /* keep the queue alive */ });
    return run;
  }

  /** Language of a plain-text error: the browser's Accept-Language, then config.json, then English. */
  function requestLang(req) {
    const first = String(req.headers['accept-language'] || '').split(',')[0].split(';')[0].trim();
    if (first) {
      const code = first.toLowerCase().slice(0, 2);
      if (i18n.isSupported(code)) return code;
    }
    return i18n.isSupported(ctx.defaultLang) ? ctx.defaultLang : i18n.FALLBACK;
  }

  /** Plain-text error page. `key` is a translation key (http.*). */
  function sendText(req, res, status, key) {
    send(req, res, status, { 'Content-Type': 'text/plain; charset=utf-8' }, i18n.t(requestLang(req), key));
  }

  function hostAllowed(req) {
    const host = String(req.headers.host || '').toLowerCase();
    return host === '127.0.0.1:' + currentPort || host === 'localhost:' + currentPort;
  }

  function serveIndex(req, res) {
    const html = readInside(PUBLIC_DIR, 'index.html');
    if (!html) return sendText(req, res, 404, 'http.notFound');
    const nonce = crypto.randomBytes(16).toString('base64');
    const defaultLang = i18n.isSupported(ctx.defaultLang) ? ctx.defaultLang : '';
    const page = html.toString('utf8')
      .replace(/__CSP_NONCE__/g, nonce)
      .replace(/__DEFAULT_LANG__/g, defaultLang)
      .replace(/__SUPPORTED_LANGS__/g, i18n.SUPPORTED.join(','));
    return send(req, res, 200, {
      'Content-Type': MIME['.html'],
      'Content-Security-Policy': cspHeader(nonce)
    }, page);
  }

  function serveTranslation(req, res, lang) {
    const file = readInside(i18n.I18N_DIR, lang + '.json');
    if (!file) return sendText(req, res, 404, 'http.notFound');
    return send(req, res, 200, { 'Content-Type': MIME['.json'] }, file);
  }

  function servePublicFile(req, res, pathname) {
    const relative = pathname.replace(/^\/+/, '');
    const ext = path.extname(relative).toLowerCase();
    if (!relative || !MIME[ext]) return sendText(req, res, 404, 'http.notFound');
    const file = readInside(PUBLIC_DIR, relative);
    if (!file) return sendText(req, res, 404, 'http.notFound');
    return send(req, res, 200, { 'Content-Type': MIME[ext] }, file);
  }

  function serveData(req, res) {
    const given = req.headers[TOKEN_HEADER];
    if (typeof given !== 'string' || !safeEqual(given, token)) {
      return send(req, res, 401, { 'Content-Type': MIME['.json'] }, JSON.stringify({ error: 'unauthorized' }));
    }
    readData().then(function (payload) {
      send(req, res, 200, { 'Content-Type': MIME['.json'] }, JSON.stringify(payload));
    }).catch(function () {
      send(req, res, 500, { 'Content-Type': MIME['.json'] }, JSON.stringify({ error: 'internal' }));
    });
  }

  function handler(req, res) {
    try {
      if (!hostAllowed(req)) return sendText(req, res, 403, 'http.forbidden');
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(req, res, 405, 'http.methodNotAllowed');

      let pathname;
      try {
        pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      } catch (e) {
        return sendText(req, res, 400, 'http.badRequest');
      }
      if (pathname.indexOf('\0') !== -1) return sendText(req, res, 400, 'http.badRequest');

      if (pathname === '/' || pathname === '/index.html') return serveIndex(req, res);
      if (pathname === '/api/data') return serveData(req, res);

      const translation = /^\/i18n\/([a-z]{2})\.json$/.exec(pathname);
      if (translation) {
        return i18n.isSupported(translation[1])
          ? serveTranslation(req, res, translation[1])
          : sendText(req, res, 404, 'http.notFound');
      }
      return servePublicFile(req, res, pathname);
    } catch (e) {
      return sendText(req, res, 500, 'http.internal');
    }
  }

  return new Promise(function (resolve, reject) {
    const lastPort = Math.min(requestedPort + MAX_PORT_ATTEMPTS - 1, 65535);
    let attempt = requestedPort;

    function tryListen() {
      currentPort = attempt;
      const server = http.createServer(handler);
      server.once('error', function (err) {
        const busy = err.code === 'EADDRINUSE' || err.code === 'EACCES';
        if (busy && attempt < lastPort) {
          attempt += 1;
          tryListen();
          return;
        }
        const failure = new Error('No free port');
        failure.code = busy ? 'ENOPORT' : err.code;
        failure.original = err;
        reject(failure);
      });
      server.listen(attempt, HOST, function () {
        server.removeAllListeners('error');
        server.on('error', function () { /* ignore late socket errors */ });
        resolve({
          server: server,
          port: attempt,
          requestedPort: requestedPort,
          token: token,
          url: 'http://' + HOST + ':' + attempt + '/?token=' + token
        });
      });
    }

    tryListen();
  });
}

module.exports = {
  HOST: HOST,
  TOKEN_HEADER: TOKEN_HEADER,
  startServer: startServer
};
