import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { detectScheme, schemeFromName } from '../public/scheme.js';

describe('detectScheme', () => {
  const cases = {
    visa: ['4', '448590'],
    mastercard: ['51', '55', '2221', '223', '23', '26', '270', '271', '2720'],
    maestro: ['5018', '5893', '6304', '6761'],
    amex: ['34', '37'],
    diners: ['300', '305', '309', '36', '38', '39'],
    jcb: ['3528', '3589', '353'],
    discover: ['6011', '644', '649', '65'],
    unionpay: ['62', '622126', '81'],
  };

  for (const [scheme, prefixes] of Object.entries(cases)) {
    it(`recognises ${scheme}`, () => {
      for (const prefix of prefixes) assert.equal(detectScheme(prefix), scheme, prefix);
    });
  }

  it('waits for enough digits when a prefix is still ambiguous', () => {
    for (const prefix of ['', '2', '22', '222', '27', '272', '3', '30', '35', '352', '5', '6', '60', '64']) {
      assert.equal(detectScheme(prefix), null, prefix);
    }
  });

  it('returns null outside the known ranges', () => {
    for (const prefix of ['000000', '2220', '2721', '306', '3527', '3590', '50', '90']) {
      assert.equal(detectScheme(prefix), null, prefix);
    }
  });
});

describe('schemeFromName', () => {
  it('normalises API scheme names', () => {
    assert.equal(schemeFromName('VISA'), 'visa');
    assert.equal(schemeFromName('MasterCard'), 'mastercard');
    assert.equal(schemeFromName('MAESTRO'), 'maestro');
    assert.equal(schemeFromName('AMERICAN EXPRESS'), 'amex');
    assert.equal(schemeFromName('CHINA UNION PAY'), 'unionpay');
    assert.equal(schemeFromName('DINERS CLUB'), 'diners');
    assert.equal(schemeFromName('MIR'), 'other');
    assert.equal(schemeFromName(undefined), 'other');
  });
});
