export const SCHEMES = {
  visa: { label: 'Visa', logo: 'logos/visa.svg', logoOnDark: 'logos/visa-on-dark.svg' },
  mastercard: { label: 'Mastercard', logo: 'logos/mastercard.svg' },
  maestro: { label: 'Maestro', logo: 'logos/maestro.svg' },
  amex: { label: 'American Express', logo: 'logos/amex.svg', logoOnDark: 'logos/amex-on-dark.svg' },
  discover: { label: 'Discover', logo: 'logos/discover.svg', logoOnDark: 'logos/discover-on-dark.svg' },
  jcb: { label: 'JCB', logo: 'logos/jcb.svg' },
  unionpay: { label: '银联 UnionPay', logo: 'logos/unionpay.svg' },
  diners: { label: 'Diners Club', logo: 'logos/diners.svg' },
};

// Each pattern only matches once enough digits are typed to rule out other schemes.
const PREFIX_RULES = [
  ['visa', /^4/],
  ['mastercard', /^(5[1-5]|222[1-9]|22[3-9]|2[3-6]|27[01]|2720)/],
  ['maestro', /^(5018|5020|5038|5893|6304|6759|676[1-3])/],
  ['amex', /^3[47]/],
  ['diners', /^(30[0-59]|36|3[89])/],
  ['jcb', /^35(2[89]|[3-8])/],
  ['discover', /^(6011|64[4-9]|65)/],
  ['unionpay', /^(62|81)/],
];

export function detectScheme(digits) {
  return PREFIX_RULES.find(([, pattern]) => pattern.test(digits))?.[0] ?? null;
}

// Maps the scheme name returned by the API to a known scheme, or 'other'.
export function schemeFromName(name) {
  const text = String(name ?? '').toUpperCase().replace(/[^A-Z]/g, '');
  if (text.includes('VISA')) return 'visa';
  if (text.includes('MAESTRO')) return 'maestro';
  if (text.includes('MASTER')) return 'mastercard';
  if (text.includes('AMEX') || text.includes('AMERICANEXPRESS')) return 'amex';
  if (text.includes('DISCOVER')) return 'discover';
  if (text.includes('JCB')) return 'jcb';
  if (text.includes('UNION')) return 'unionpay';
  if (text.includes('DINERS')) return 'diners';
  return 'other';
}
