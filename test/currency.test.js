import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  currencyFlag,
  formatPreciseRate,
  formatRate,
  withCurrencyFlag,
} from '../public/currency.js';

describe('currencyFlag', () => {
  it('derives the flag from the country prefix', () => {
    assert.equal(currencyFlag('USD'), '🇺🇸');
    assert.equal(currencyFlag('CNY'), '🇨🇳');
    assert.equal(currencyFlag('HKD'), '🇭🇰');
    assert.equal(currencyFlag('JPY'), '🇯🇵');
    assert.equal(currencyFlag('GBP'), '🇬🇧');
    assert.equal(currencyFlag(' idr '), '🇮🇩');
  });

  it('handles codes that do not start with a country code', () => {
    assert.equal(currencyFlag('EUR'), '🇪🇺');
    assert.equal(currencyFlag('ANG'), '🇨🇼');
  });

  it('returns nothing for codes without a single country or malformed input', () => {
    for (const code of ['XAF', 'XOF', 'XAU', 'XXX', '', 'US', 'USDT', '123', null, undefined]) {
      assert.equal(currencyFlag(code), '', String(code));
    }
  });
});

describe('withCurrencyFlag', () => {
  it('prefixes the code when a flag exists', () => {
    assert.equal(withCurrencyFlag('JPY'), '🇯🇵 JPY');
    assert.equal(withCurrencyFlag('XAF'), 'XAF');
    assert.equal(withCurrencyFlag(''), '');
    assert.equal(withCurrencyFlag(undefined), '');
  });
});

describe('formatRate', () => {
  it('stops tiny values at their first non-zero digit, rounded', () => {
    assert.equal(formatRate(0.00005506), '0.00006');
    assert.equal(formatRate(0.00004924), '0.00005');
    assert.equal(formatRate(0.000367), '0.0004');
    assert.equal(formatRate(0.008699), '0.009');
    assert.equal(formatRate(0.001), '0.001');
    assert.equal(formatRate(0.0000001234), '0.0000001');
  });

  it('keeps four decimals for mid-range values', () => {
    assert.equal(formatRate(0.04219), '0.0422');
    assert.equal(formatRate(0.15), '0.1500');
    assert.equal(formatRate(6.6653), '6.6653');
    assert.equal(formatRate(23.70335), '23.7034');
  });

  it('keeps two decimals for large values', () => {
    assert.equal(formatRate(157.9897), '157.99');
    assert.equal(formatRate(18161.5509), '18161.55');
  });
});

describe('formatPreciseRate', () => {
  it('keeps full precision for tooltips', () => {
    assert.equal(formatPreciseRate(0.00005506), '0.00005506');
    assert.equal(formatPreciseRate(18161.5509), '18161.5509');
  });
});
