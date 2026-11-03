import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRateProvider } from './rates.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const UPSTREAM_HOST = 'bin-ip-checker.p.rapidapi.com';
const UPSTREAM_TIMEOUT_MS = 10_000;

const COOKIE_NAME = 'bincheck_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 4096;

const LOGIN_MAX_FAILURES = 8;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_TRACKED_CLIENTS = 10_000;

const BIN_PATTERN = /^\d{6,8}$/;

const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/scheme.js': ['scheme.js', 'text/javascript; charset=utf-8'],
  '/currency.js': ['currency.js', 'text/javascript; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};

for (const logo of [
  'visa',
  'visa-on-dark',
  'mastercard',
  'maestro',
  'amex',
  'amex-on-dark',
  'discover',
  'discover-on-dark',
  'jcb',
  'unionpay',
  'diners',
]) {
  STATIC_FILES[`/logos/${logo}.svg`] = [`logos/${logo}.svg`, 'image/svg+xml'];
}

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; " +
    "connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

function sha256(value) {
  return createHash('sha256').update(value).digest();
}

function parseCookies(header = '') {
  const cookies = new Map();
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > 0) cookies.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  return cookies;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function sendError(res, status, code, headers) {
  sendJson(res, status, { error: code }, headers);
}

function parseQuota(headers) {
  const number = (name) => {
    const value = headers.get(name);
    if (value === null || value.trim() === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const limit = number('x-ratelimit-requests-limit');
  const remaining = number('x-ratelimit-requests-remaining');
  if (limit === null || remaining === null) return null;
  return { limit, remaining, resetSeconds: number('x-ratelimit-requests-reset') };
}

function historySummary({ key, bin, viewedAt }) {
  return {
    key,
    scheme: bin.scheme ?? '',
    issuer: bin.issuer?.name ?? '',
    flag: bin.country?.flag ?? '',
    alpha2: bin.country?.alpha2 ?? '',
    viewedAt,
  };
}

export function createApp({ password, apiKey, store, trustProxy = false, fetchImpl = fetch }) {
  const passwordHash = sha256(password);
  const loginFailures = new Map();
  const rates = createRateProvider(fetchImpl);
  const staticFiles = new Map(
    Object.entries(STATIC_FILES).map(([route, [file, type]]) => [
      route,
      { body: readFileSync(join(PUBLIC_DIR, file)), type },
    ]),
  );

  // Mixing in the password signs everyone out when it changes.
  function sessionId(token) {
    return sha256(`${password}:${token}`).toString('hex');
  }

  function clientKey(req) {
    if (trustProxy) {
      // The rightmost entry is the one appended by the trusted proxy itself.
      const forwarded = req.headers['x-forwarded-for']?.split(',').pop()?.trim();
      if (forwarded) return forwarded;
    }
    return req.socket.remoteAddress ?? 'unknown';
  }

  function isSecureRequest(req) {
    return req.socket.encrypted === true || req.headers['x-forwarded-proto'] === 'https';
  }

  function sessionCookie(req, value, maxAgeSeconds) {
    const secure = isSecureRequest(req) ? '; Secure' : '';
    return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure}`;
  }

  function isAuthenticated(req) {
    const token = parseCookies(req.headers.cookie).get(COOKIE_NAME);
    return Boolean(token) && store.hasSession(sessionId(token));
  }

  function pruneExpired(now) {
    store.pruneSessions(now);
    for (const [client, entry] of loginFailures) {
      if (entry.resetAt <= now) loginFailures.delete(client);
    }
  }

  async function handleLogin(req, res) {
    const now = Date.now();
    pruneExpired(now);

    const client = clientKey(req);
    const failure = loginFailures.get(client);
    if (failure && failure.count >= LOGIN_MAX_FAILURES) {
      const retryAfter = Math.ceil((failure.resetAt - now) / 1000);
      sendError(res, 429, 'too_many_attempts', { 'Retry-After': String(retryAfter) });
      return;
    }

    if (!req.headers['content-type']?.startsWith('application/json')) {
      sendError(res, 415, 'unsupported_media_type');
      return;
    }

    let submitted;
    try {
      submitted = JSON.parse(await readBody(req))?.password;
    } catch {
      sendError(res, 400, 'bad_request');
      return;
    }
    if (typeof submitted !== 'string') {
      sendError(res, 400, 'bad_request');
      return;
    }

    if (!timingSafeEqual(sha256(submitted), passwordHash)) {
      if (failure) {
        failure.count += 1;
      } else if (loginFailures.size < LOGIN_MAX_TRACKED_CLIENTS) {
        loginFailures.set(client, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
      }
      sendError(res, 401, 'invalid_password');
      return;
    }

    loginFailures.delete(client);
    const token = randomBytes(32).toString('base64url');
    store.addSession(sessionId(token), now + SESSION_TTL_MS);
    res.writeHead(204, {
      ...SECURITY_HEADERS,
      'Cache-Control': 'no-store',
      'Set-Cookie': sessionCookie(req, token, SESSION_TTL_MS / 1000),
    });
    res.end();
  }

  function handleLogout(req, res) {
    const token = parseCookies(req.headers.cookie).get(COOKIE_NAME);
    if (token) store.removeSession(sessionId(token));
    res.writeHead(204, {
      ...SECURITY_HEADERS,
      'Cache-Control': 'no-store',
      'Set-Cookie': sessionCookie(req, '', 0),
    });
    res.end();
  }

  async function sendLookupResult(res, entry, quota, fromCache) {
    sendJson(res, 200, {
      key: entry.key,
      bin: entry.bin,
      quota,
      rate: await rates.ratesFor(entry.bin.currency),
      cache: { hit: fromCache, cachedAt: entry.cachedAt },
    });
  }

  async function handleLookup(res, bin, refresh) {
    if (!BIN_PATTERN.test(bin)) {
      sendError(res, 400, 'invalid_bin');
      return;
    }

    if (!refresh) {
      const cached = store.findBin(bin);
      if (cached) {
        store.markBinViewed(cached.key);
        await sendLookupResult(res, cached, store.loadQuota(), true);
        return;
      }
    }

    let upstream;
    let payload = null;
    try {
      upstream = await fetchImpl(`https://${UPSTREAM_HOST}/?bin=${bin}`, {
        headers: {
          accept: 'application/json',
          'x-rapidapi-host': UPSTREAM_HOST,
          'x-rapidapi-key': apiKey,
        },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      payload = await upstream.json().catch(() => null);
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError';
      sendError(res, timedOut ? 504 : 502, timedOut ? 'upstream_timeout' : 'upstream_unreachable');
      return;
    }

    const quota = parseQuota(upstream.headers);
    if (quota) store.saveQuota(quota);
    if (upstream.status === 429) {
      sendJson(res, 429, { error: 'quota_exceeded', quota });
    } else if (upstream.status === 401 || upstream.status === 403) {
      sendJson(res, 502, { error: 'upstream_auth', quota });
    } else if (upstream.status >= 500) {
      sendJson(res, 502, { error: 'upstream_error', quota });
    } else if (payload?.success === true && payload.BIN?.valid === true) {
      await sendLookupResult(res, store.saveBin(bin, payload.BIN), quota, false);
    } else if (upstream.ok && payload === null) {
      sendJson(res, 502, { error: 'upstream_error', quota });
    } else {
      sendJson(res, 404, { error: 'not_found', quota });
    }
  }

  function serveStatic(req, res, pathname) {
    const file = staticFiles.get(pathname);
    if (!file) {
      sendError(res, 404, 'not_found');
      return;
    }
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Cache-Control': 'no-cache',
      'Content-Type': file.type,
      'Content-Length': file.body.length,
    });
    res.end(req.method === 'HEAD' ? undefined : file.body);
  }

  async function route(req, res) {
    const { pathname, searchParams } = new URL(req.url, 'http://localhost');
    const { method } = req;
    const isRead = method === 'GET' || method === 'HEAD';

    if (pathname === '/healthz' && isRead) {
      sendJson(res, 200, { status: 'ok' });
    } else if (pathname === '/api/login' && method === 'POST') {
      await handleLogin(req, res);
    } else if (pathname === '/api/logout' && method === 'POST') {
      handleLogout(req, res);
    } else if (pathname === '/api/session' && method === 'GET') {
      sendJson(res, 200, { authenticated: isAuthenticated(req) });
    } else if (pathname.startsWith('/api/bin/') && method === 'GET') {
      if (!isAuthenticated(req)) {
        sendError(res, 401, 'unauthorized');
        return;
      }
      const bin = pathname.slice('/api/bin/'.length);
      await handleLookup(res, bin, searchParams.get('refresh') === '1');
    } else if (pathname === '/api/history' && (method === 'GET' || method === 'DELETE')) {
      if (!isAuthenticated(req)) {
        sendError(res, 401, 'unauthorized');
        return;
      }
      if (method === 'DELETE') store.clearHistory();
      const { entries, total } = store.history();
      sendJson(res, 200, {
        entries: entries.map(historySummary),
        total,
        quota: store.loadQuota(),
      });
    } else if (pathname.startsWith('/api/')) {
      sendError(res, 404, 'not_found');
    } else if (isRead) {
      serveStatic(req, res, pathname);
    } else {
      sendError(res, 405, 'method_not_allowed');
    }
  }

  return createServer((req, res) => {
    route(req, res).catch(() => {
      if (res.headersSent) {
        res.destroy();
      } else {
        sendError(res, 500, 'internal_error');
      }
    });
  });
}
