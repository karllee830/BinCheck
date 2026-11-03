import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createRateProvider } from '../src/rates.js';

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

function ratesReply(rates = { USD: 0.125, JPY: 20, CNY: 1, HKD: 1, EUR: 0.1, GBP: 0.1 }) {
  return new Response(
    JSON.stringify({ result: 'success', time_last_update_unix: 1_700_000_000, rates }),
  );
}

describe('createRateProvider', () => {
  it('converts a currency to its CNY value', async () => {
    const provider = createRateProvider(async () => ratesReply());
    const usd = await provider.ratesFor('usd');
    assert.equal(usd.currency, 'USD');
    assert.equal(usd.cny, 8);
    assert.equal(usd.updatedAt, '2023-11-14T22:13:20.000Z');
    assert.equal((await provider.ratesFor('JPY')).cny, 0.05);
    assert.equal((await provider.ratesFor('CNY')).cny, 1);
  });

  it('quotes both directions against the other major currencies', async () => {
    const provider = createRateProvider(async () => ratesReply());

    const usd = await provider.ratesFor('USD');
    assert.deepEqual(usd.quotes.map((quote) => quote.currency), ['CNY', 'HKD', 'JPY', 'EUR', 'GBP']);
    const jpy = usd.quotes.find((quote) => quote.currency === 'JPY');
    assert.equal(jpy.rate, 160);
    assert.equal(jpy.inverse, 0.00625);

    const idr = await createRateProvider(async () =>
      ratesReply({ IDR: 2000, USD: 0.125, CNY: 1 }),
    ).ratesFor('IDR');
    assert.deepEqual(idr.quotes, [
      { currency: 'USD', rate: 0.0000625, inverse: 16000 },
      { currency: 'CNY', rate: 0.0005, inverse: 2000 },
    ]);
  });

  it('returns null for unknown or malformed currencies', async () => {
    const provider = createRateProvider(async () => ratesReply());
    for (const currency of ['XXX', '', null, undefined, 'US', 'toString', '__proto__']) {
      assert.equal(await provider.ratesFor(currency), null, String(currency));
    }
  });

  it('shares one request between concurrent and later lookups', async () => {
    let calls = 0;
    const provider = createRateProvider(async () => {
      calls += 1;
      return ratesReply();
    });
    await Promise.all([provider.ratesFor('USD'), provider.ratesFor('JPY')]);
    await provider.ratesFor('USD');
    assert.equal(calls, 1);
  });

  it('returns null on failure and throttles retries', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] });
    let calls = 0;
    const provider = createRateProvider(async () => {
      calls += 1;
      throw new TypeError('network');
    });
    assert.equal(await provider.ratesFor('USD'), null);
    assert.equal(await provider.ratesFor('USD'), null);
    assert.equal(calls, 1);

    t.mock.timers.tick(60_000);
    await provider.ratesFor('USD');
    assert.equal(calls, 2);
  });

  it('keeps serving the last table when a refresh fails', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] });
    let healthy = true;
    const provider = createRateProvider(async () => {
      if (!healthy) return new Response('{"result":"error"}');
      return ratesReply();
    });
    assert.equal((await provider.ratesFor('USD')).cny, 8);

    healthy = false;
    t.mock.timers.tick(SIX_HOURS_MS);
    assert.equal((await provider.ratesFor('USD')).cny, 8);
  });
});
