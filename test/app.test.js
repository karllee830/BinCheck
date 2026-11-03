import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createApp } from '../src/app.js';
import { createStore } from '../src/store.js';

const SAMPLE_BIN = {
  valid: true,
  number: 448590,
  length: 6,
  scheme: 'VISA',
  currency: 'USD',
  issuer: { name: 'TEST BANK', website: '', phone: '' },
  country: { name: 'UNITED STATES', alpha2: 'US' },
};

const QUOTA_HEADERS = {
  'x-ratelimit-requests-limit': '100',
  'x-ratelimit-requests-remaining': '97',
  'x-ratelimit-requests-reset': '3600',
};

function upstreamReply(status, body, headers = QUOTA_HEADERS) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, { status, headers });
}

describe('BIN Check server', () => {
  let server;
  let baseUrl;
  let upstreamCalls;
  let nextUpstream;
  let nextRates;
  const store = createStore(':memory:');

  const fetchImpl = async (url, options) => {
    if (url.startsWith('https://open.er-api.com/')) return nextRates();
    upstreamCalls.push({ url, options });
    return nextUpstream();
  };

  const login = (password = 'correct horse') =>
    fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });

  async function sessionCookie() {
    const res = await login();
    assert.equal(res.status, 204);
    return res.headers.get('set-cookie').split(';')[0];
  }

  before(async () => {
    server = createApp({ password: 'correct horse', apiKey: 'secret-key', store, fetchImpl });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => {
    server.closeAllConnections();
    server.close();
  });

  beforeEach(() => {
    store.clearHistory();
    upstreamCalls = [];
    nextUpstream = () => upstreamReply(200, { success: true, code: 200, BIN: SAMPLE_BIN });
    nextRates = () =>
      new Response(
        JSON.stringify({
          result: 'success',
          time_last_update_unix: 1_700_000_000,
          rates: { USD: 0.125 },
        }),
      );
  });

  it('rejects lookups without a session and never calls upstream', async () => {
    const res = await fetch(`${baseUrl}/api/bin/448590`);
    assert.equal(res.status, 401);
    assert.equal(upstreamCalls.length, 0);
  });

  it('rejects a wrong password', async () => {
    const res = await login('wrong');
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('set-cookie'), null);
  });

  it('issues an HttpOnly, SameSite=Strict session cookie', async () => {
    const res = await login();
    assert.equal(res.status, 204);
    const cookie = res.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.doesNotMatch(cookie, /Secure/);
  });

  it('marks the cookie Secure behind an HTTPS proxy', async () => {
    const res = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' },
      body: JSON.stringify({ password: 'correct horse' }),
    });
    assert.match(res.headers.get('set-cookie'), /Secure/);
  });

  it('requires a JSON login body', async () => {
    const res = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'password=correct+horse',
    });
    assert.equal(res.status, 415);
  });

  it('proxies a lookup with the key server-side and returns quota', async () => {
    const cookie = await sessionCookie();
    const res = await fetch(`${baseUrl}/api/bin/448590`, { headers: { cookie } });
    assert.equal(res.status, 200);

    const text = await res.text();
    assert.doesNotMatch(text, /secret-key/);
    const body = JSON.parse(text);
    assert.deepEqual(body.bin, SAMPLE_BIN);
    assert.deepEqual(body.quota, { limit: 100, remaining: 97, resetSeconds: 3600 });
    assert.equal(body.rate.currency, 'USD');
    assert.equal(body.rate.cny, 8);

    const [call] = upstreamCalls;
    assert.equal(call.url, 'https://bin-ip-checker.p.rapidapi.com/?bin=448590');
    assert.equal(call.options.headers['x-rapidapi-key'], 'secret-key');
  });

  it('answers repeat lookups from the cache without calling the BIN API', async () => {
    const cookie = await sessionCookie();
    const first = await (await fetch(`${baseUrl}/api/bin/448590`, { headers: { cookie } })).json();
    assert.equal(first.cache.hit, false);
    assert.equal(first.key, '448590');

    const second = await (await fetch(`${baseUrl}/api/bin/448590`, { headers: { cookie } })).json();
    assert.equal(second.cache.hit, true);
    assert.equal(second.cache.cachedAt, first.cache.cachedAt);
    assert.deepEqual(second.bin, SAMPLE_BIN);
    assert.equal(second.rate.cny, 8);
    assert.equal(second.quota.remaining, 97);

    assert.equal(upstreamCalls.length, 1);
  });

  it('asks the API about a longer BIN once, then remembers what it resolved to', async () => {
    const cookie = await sessionCookie();
    await fetch(`${baseUrl}/api/bin/448590`, { headers: { cookie } });

    const first = await (await fetch(`${baseUrl}/api/bin/44859012`, { headers: { cookie } })).json();
    assert.equal(first.cache.hit, false);
    assert.equal(first.key, '448590');
    assert.equal(upstreamCalls.at(-1).url.endsWith('?bin=44859012'), true);
    assert.equal(upstreamCalls.length, 2);

    const second = await (await fetch(`${baseUrl}/api/bin/44859012`, { headers: { cookie } })).json();
    assert.equal(second.cache.hit, true);
    assert.equal(second.key, '448590');
    assert.equal(upstreamCalls.length, 2);

    const refreshed = await fetch(`${baseUrl}/api/bin/44859012?refresh=1`, { headers: { cookie } });
    assert.equal(refreshed.status, 200);
    assert.equal(upstreamCalls.at(-1).url.endsWith('?bin=44859012'), true);
    assert.equal(upstreamCalls.length, 3);

    const history = await (await fetch(`${baseUrl}/api/history`, { headers: { cookie } })).json();
    assert.equal(history.total, 1);
  });

  it('saves notes and deletes single history entries for signed-in clients', async () => {
    const patch = (key, body, headers = {}) =>
      fetch(`${baseUrl}/api/history/${key}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });

    assert.equal((await patch('448590', { note: 'x' })).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/history/448590`, { method: 'DELETE' })).status, 401);

    const cookie = await sessionCookie();
    await fetch(`${baseUrl}/api/bin/448590`, { headers: { cookie } });

    const saved = await patch('448590', { note: '  corporate card  ' }, { cookie });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).entries[0].note, 'corporate card');
    const lookup = await (await fetch(`${baseUrl}/api/bin/448590`, { headers: { cookie } })).json();
    assert.equal(lookup.note, 'corporate card');

    assert.equal((await patch('448590', { note: 'x'.repeat(201) }, { cookie })).status, 400);
    assert.equal((await patch('448590', { note: 5 }, { cookie })).status, 400);
    assert.equal((await patch('999999', { note: 'x' }, { cookie })).status, 404);
    assert.equal((await patch('abc', { note: 'x' }, { cookie })).status, 400);
    const wrongType = await fetch(`${baseUrl}/api/history/448590`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'text/plain', cookie },
      body: '{"note":"x"}',
    });
    assert.equal(wrongType.status, 415);

    const removed = await fetch(`${baseUrl}/api/history/448590`, { method: 'DELETE', headers: { cookie } });
    assert.equal((await removed.json()).total, 0);
    const after = await (await fetch(`${baseUrl}/api/bin/448590`, { headers: { cookie } })).json();
    assert.equal(after.cache.hit, false);
    assert.equal(after.note, '');
  });

  it('calls the BIN API again on refresh', async () => {
    const cookie = await sessionCookie();
    await fetch(`${baseUrl}/api/bin/448590`, { headers: { cookie } });
    const updated = { ...SAMPLE_BIN, level: 'PLATINUM' };
    nextUpstream = () => upstreamReply(200, { success: true, BIN: updated });

    const refreshed = await fetch(`${baseUrl}/api/bin/448590?refresh=1`, { headers: { cookie } });
    const body = await refreshed.json();
    assert.equal(body.cache.hit, false);
    assert.equal(body.bin.level, 'PLATINUM');
    assert.equal(upstreamCalls.length, 2);

    const cached = await (await fetch(`${baseUrl}/api/bin/448590`, { headers: { cookie } })).json();
    assert.equal(cached.bin.level, 'PLATINUM');
    assert.equal(upstreamCalls.length, 2);
  });

  it('keeps the cached entry when a refresh fails', async () => {
    const cookie = await sessionCookie();
    await fetch(`${baseUrl}/api/bin/448590`, { headers: { cookie } });
    nextUpstream = () => upstreamReply(429, { message: 'quota' });

    const refreshed = await fetch(`${baseUrl}/api/bin/448590?refresh=1`, { headers: { cookie } });
    assert.equal(refreshed.status, 429);

    const cached = await (await fetch(`${baseUrl}/api/bin/448590`, { headers: { cookie } })).json();
    assert.equal(cached.cache.hit, true);
    assert.deepEqual(cached.bin, SAMPLE_BIN);
  });

  it('does not cache failed lookups', async () => {
    const cookie = await sessionCookie();
    nextUpstream = () => upstreamReply(200, { success: false, code: 404 });
    await fetch(`${baseUrl}/api/bin/000000`, { headers: { cookie } });
    await fetch(`${baseUrl}/api/bin/000000`, { headers: { cookie } });
    assert.equal(upstreamCalls.length, 2);

    const history = await (await fetch(`${baseUrl}/api/history`, { headers: { cookie } })).json();
    assert.equal(history.total, 0);
  });

  it('lists and clears the query history for signed-in clients', async () => {
    assert.equal((await fetch(`${baseUrl}/api/history`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/history`, { method: 'DELETE' })).status, 401);

    const cookie = await sessionCookie();
    await fetch(`${baseUrl}/api/bin/448590`, { headers: { cookie } });

    const listed = await (await fetch(`${baseUrl}/api/history`, { headers: { cookie } })).json();
    assert.equal(listed.total, 1);
    assert.equal(listed.quota.remaining, 97);
    const [row] = listed.entries;
    assert.equal(row.key, '448590');
    assert.equal(row.issuer, 'TEST BANK');
    assert.equal(row.alpha2, 'US');

    const cleared = await fetch(`${baseUrl}/api/history`, { method: 'DELETE', headers: { cookie } });
    assert.equal((await cleared.json()).total, 0);
    const lookup = await (await fetch(`${baseUrl}/api/bin/448590`, { headers: { cookie } })).json();
    assert.equal(lookup.cache.hit, false);
  });

  it('shares the query history between sessions', async () => {
    const firstCookie = await sessionCookie();
    const secondCookie = await sessionCookie();
    assert.notEqual(firstCookie, secondCookie);

    await fetch(`${baseUrl}/api/bin/448590`, { headers: { cookie: firstCookie } });
    const seen = await (await fetch(`${baseUrl}/api/history`, { headers: { cookie: secondCookie } })).json();
    assert.deepEqual(seen.entries.map((entry) => entry.key), ['448590']);

    const lookup = await (await fetch(`${baseUrl}/api/bin/448590`, { headers: { cookie: secondCookie } })).json();
    assert.equal(lookup.cache.hit, true);
    assert.equal(upstreamCalls.length, 1);
  });

  it('keeps sessions across restarts until the password changes', async () => {
    const shared = createStore(':memory:');
    const start = async (password) => {
      const instance = createApp({ password, apiKey: 'k', store: shared, fetchImpl });
      await new Promise((resolve) => instance.listen(0, '127.0.0.1', resolve));
      return { instance, origin: `http://127.0.0.1:${instance.address().port}` };
    };
    const stop = ({ instance }) => {
      instance.closeAllConnections();
      instance.close();
    };
    const isSignedIn = async ({ origin }, cookie) =>
      (await (await fetch(`${origin}/api/session`, { headers: { cookie } })).json()).authenticated;

    const first = await start('old');
    const signedIn = await fetch(`${first.origin}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'old' }),
    });
    const cookie = signedIn.headers.get('set-cookie').split(';')[0];
    stop(first);

    const restarted = await start('old');
    assert.equal(await isSignedIn(restarted, cookie), true);
    stop(restarted);

    const changed = await start('new');
    assert.equal(await isSignedIn(changed, cookie), false);
    stop(changed);
  });

  it('still answers a lookup when exchange rates are unavailable', async () => {
    const isolated = createApp({
      password: 'pw',
      apiKey: 'k',
      store: createStore(':memory:'),
      fetchImpl: async (url) => {
        if (url.startsWith('https://open.er-api.com/')) throw new TypeError('network');
        return upstreamReply(200, { success: true, BIN: SAMPLE_BIN });
      },
    });
    await new Promise((resolve) => isolated.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${isolated.address().port}`;

    try {
      const signedIn = await fetch(`${origin}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'pw' }),
      });
      const cookie = signedIn.headers.get('set-cookie').split(';')[0];
      const res = await fetch(`${origin}/api/bin/448590`, { headers: { cookie } });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body.bin, SAMPLE_BIN);
      assert.equal(body.rate, null);
    } finally {
      isolated.closeAllConnections();
      isolated.close();
    }
  });

  it('rejects malformed BINs without calling upstream', async () => {
    const cookie = await sessionCookie();
    for (const bin of ['12345', '123456789', 'abcdef', '123456%26x=1']) {
      const res = await fetch(`${baseUrl}/api/bin/${bin}`, { headers: { cookie } });
      assert.equal(res.status, 400, bin);
    }
    assert.equal(upstreamCalls.length, 0);
  });

  it('maps upstream outcomes to client errors', async () => {
    const cookie = await sessionCookie();
    const cases = [
      [() => upstreamReply(200, { success: false, code: 404 }), 404, 'not_found'],
      [() => upstreamReply(200, { success: true, BIN: { valid: false } }), 404, 'not_found'],
      [() => upstreamReply(404, { message: 'nope' }), 404, 'not_found'],
      [() => upstreamReply(429, { message: 'quota' }), 429, 'quota_exceeded'],
      [() => upstreamReply(403, { message: 'denied' }), 502, 'upstream_auth'],
      [() => upstreamReply(500, 'oops'), 502, 'upstream_error'],
      [() => upstreamReply(200, 'not json'), 502, 'upstream_error'],
      [() => { throw new TypeError('network'); }, 502, 'upstream_unreachable'],
      [() => { throw new DOMException('slow', 'TimeoutError'); }, 504, 'upstream_timeout'],
    ];
    for (const [reply, status, error] of cases) {
      nextUpstream = reply;
      const res = await fetch(`${baseUrl}/api/bin/448590`, { headers: { cookie } });
      assert.equal(res.status, status, error);
      assert.equal((await res.json()).error, error);
    }
  });

  it('invalidates the session on logout', async () => {
    const cookie = await sessionCookie();
    const logout = await fetch(`${baseUrl}/api/logout`, { method: 'POST', headers: { cookie } });
    assert.equal(logout.status, 204);

    const session = await fetch(`${baseUrl}/api/session`, { headers: { cookie } });
    assert.deepEqual(await session.json(), { authenticated: false });
    const lookup = await fetch(`${baseUrl}/api/bin/448590`, { headers: { cookie } });
    assert.equal(lookup.status, 401);
  });

  it('serves only whitelisted static files with security headers', async () => {
    const page = await fetch(`${baseUrl}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);

    for (const path of ['/scheme.js', '/currency.js', '/logos/visa.svg', '/logos/visa-on-dark.svg', '/logos/unionpay.svg']) {
      assert.equal((await fetch(`${baseUrl}${path}`)).status, 200, path);
    }

    for (const path of ['/package.json', '/src/app.js', '/..%2fpackage.json', '/.env', '/logos/LICENSE']) {
      const res = await fetch(`${baseUrl}${path}`);
      assert.equal(res.status, 404, path);
    }
  });

  it('locks out a client after repeated failures, even for the right password', async () => {
    const isolated = createApp({ password: 'pw', apiKey: 'k', store: createStore(':memory:'), fetchImpl });
    await new Promise((resolve) => isolated.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${isolated.address().port}/api/login`;
    const attempt = (password) =>
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });

    try {
      for (let i = 0; i < 8; i += 1) {
        assert.equal((await attempt('wrong')).status, 401);
      }
      const blocked = await attempt('pw');
      assert.equal(blocked.status, 429);
      assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    } finally {
      isolated.closeAllConnections();
      isolated.close();
    }
  });
});
