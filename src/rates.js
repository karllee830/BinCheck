const RATES_URL = 'https://open.er-api.com/v6/latest/CNY';
const RATES_TIMEOUT_MS = 4000;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 60 * 1000;

const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const QUOTE_CURRENCIES = ['USD', 'CNY', 'HKD', 'JPY', 'EUR', 'GBP'];

export function createRateProvider(fetchImpl) {
  let table = null;
  let nextFetchAt = 0;
  let pending = null;

  async function refresh() {
    try {
      const response = await fetchImpl(RATES_URL, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(RATES_TIMEOUT_MS),
      });
      const body = await response.json();
      if (!response.ok || body?.result !== 'success' || typeof body.rates !== 'object') {
        throw new Error('unexpected rates response');
      }
      table = {
        rates: body.rates,
        updatedAt: new Date(body.time_last_update_unix * 1000).toISOString(),
      };
      nextFetchAt = Date.now() + CACHE_TTL_MS;
    } catch {
      // Keep serving the previous table, if any, and avoid hammering the provider.
      nextFetchAt = Date.now() + RETRY_AFTER_FAILURE_MS;
    }
  }

  function unitsPerCny(code) {
    const units = table && Object.hasOwn(table.rates, code) ? table.rates[code] : null;
    return typeof units === 'number' && units > 0 ? units : null;
  }

  // Resolves to the currency's CNY value and two-way quotes, or null when unavailable.
  async function ratesFor(currency) {
    const code = String(currency ?? '').trim().toUpperCase();
    if (!CURRENCY_PATTERN.test(code)) return null;

    if (Date.now() >= nextFetchAt) {
      pending ??= refresh().finally(() => {
        pending = null;
      });
      await pending;
    }

    const base = unitsPerCny(code);
    if (base === null) return null;

    const quotes = QUOTE_CURRENCIES.filter((quote) => quote !== code).flatMap((quote) => {
      const units = unitsPerCny(quote);
      return units === null ? [] : [{ currency: quote, rate: units / base, inverse: base / units }];
    });
    return { currency: code, cny: 1 / base, updatedAt: table.updatedAt, quotes };
  }

  return { ratesFor };
}
