// Most ISO 4217 codes start with the issuing country's ISO 3166 code; these do not.
const REGION_OVERRIDES = { EUR: 'EU', ANG: 'CW' };

function regionalIndicator(letter) {
  return String.fromCodePoint(0x1f1e6 + letter.charCodeAt(0) - 65);
}

export function currencyFlag(code) {
  const currency = String(code ?? '').trim().toUpperCase();
  // X-prefixed codes cover several countries or are not tied to one, such as XAF and XAU.
  if (!/^[A-Z]{3}$/.test(currency) || currency.startsWith('X')) return '';
  const region = REGION_OVERRIDES[currency] ?? currency.slice(0, 2);
  return [...region].map(regionalIndicator).join('');
}

export function withCurrencyFlag(code) {
  const flag = currencyFlag(code);
  return flag ? `${flag} ${code}` : String(code ?? '');
}

// Compact form for display: tiny values stop at their first non-zero digit.
export function formatRate(value) {
  if (value >= 100) return value.toFixed(2);
  if (value >= 0.01) return value.toFixed(4);
  return value.toFixed(Math.ceil(-Math.log10(value)));
}

export function formatPreciseRate(value) {
  return value >= 1 ? value.toFixed(4) : value.toPrecision(4);
}
