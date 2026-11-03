import { currencyFlag, formatPreciseRate, formatRate, withCurrencyFlag } from './currency.js';
import { SCHEMES, detectScheme, schemeFromName } from './scheme.js';

const $ = (id) => document.getElementById(id);

const MAX_BIN_LENGTH = 8;
const MIN_BIN_LENGTH = 6;
const LOW_QUOTA_RATIO = 0.1;
const DEFAULT_SEARCH_HINT = '粘贴完整卡号时，只会保留前 8 位。';

const LOOKUP_ERRORS = {
  invalid_bin: 'BIN 需要是 6–8 位数字。',
  not_found: '没有查到这个 BIN 的信息，请核对后再试。',
  quota_exceeded: 'RapidAPI 请求额度已用完，请等额度重置后再试。',
  upstream_auth: 'RapidAPI 拒绝了请求，请检查 RAPIDAPI_KEY 是否正确、是否已订阅此接口。',
  upstream_timeout: '接口响应超时，请稍后再试。',
  upstream_unreachable: '无法连接到查询接口，请检查服务器网络。',
  upstream_error: '查询接口暂时不可用，请稍后再试。',
};

const CARD_TYPES = {
  CREDIT: '信用卡',
  DEBIT: '借记卡',
  PREPAID: '预付卡',
  CHARGE: '签账卡',
};

const CURRENCY_NAMES = {
  USD: '美元',
  CNY: '人民币',
  HKD: '港币',
  JPY: '日元',
  EUR: '欧元',
  GBP: '英镑',
};

const currencyNames = new Intl.DisplayNames('zh-CN', { type: 'currency' });

const views = { login: $('login-view'), app: $('app-view') };
const workspace = $('workspace');
const results = $('results');
const card = $('card');
const cardFlip = $('card-flip');
const cardScene = $('card-scene');
const binInput = $('bin-input');
const searchSubmit = $('search-submit');
const loginSubmit = $('login-submit');
const passwordInput = $('password');

let lookupController = null;
let currentKey = null;
let historyEntries = [];

/* Decorative security-print pattern */

function drawGuilloche(svg, rings) {
  svg.setAttribute('viewBox', '-100 -100 200 200');
  for (const { radius, outer, inner, offset } of rings) {
    const scale = radius / (outer - inner + offset);
    const ratio = (outer - inner) / inner;
    const steps = outer * 40;
    const turns = (2 * Math.PI * inner) / steps;
    const points = [];
    for (let i = 0; i <= steps; i += 1) {
      const t = i * turns;
      const x = (outer - inner) * Math.cos(t) + offset * Math.cos(ratio * t);
      const y = (outer - inner) * Math.sin(t) - offset * Math.sin(ratio * t);
      points.push(`${(x * scale).toFixed(1)} ${(y * scale).toFixed(1)}`);
    }
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', `M${points.join('L')}Z`);
    svg.append(path);
  }
}

const ROSETTE = [
  { radius: 98, outer: 72, inner: 17, offset: 42 },
  { radius: 70, outer: 60, inner: 13, offset: 30 },
  { radius: 42, outer: 48, inner: 11, offset: 22 },
];

drawGuilloche($('login-rosette'), ROSETTE);
drawGuilloche($('card-guilloche'), ROSETTE);

/* Formatting helpers */

function hasValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

function joinParts(parts, separator = ' · ') {
  return parts.filter(hasValue).join(separator);
}

function parseFlag(value) {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return null;
}

function formatFlag(value) {
  const flag = parseFlag(value);
  if (flag === null) return '未知';
  return flag ? '是' : '否';
}

function formatCardType(type) {
  if (!hasValue(type)) return '';
  const label = CARD_TYPES[String(type).toUpperCase()];
  return label ? `${label} ${type}` : String(type);
}

function formatCardNumber(digits, scheme) {
  const groupsByScheme = { amex: [4, 6, 5], diners: [4, 6, 4] };
  const groups = groupsByScheme[scheme] ?? [4, 4, 4, 4];
  const total = groups.reduce((sum, size) => sum + size, 0);
  const masked = digits.slice(0, total).padEnd(total, '•');
  let cursor = 0;
  return groups
    .map((size) => {
      const group = masked.slice(cursor, cursor + size);
      cursor += size;
      return group;
    })
    .join(' ');
}

function formatTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未知时间';
  const pad = (number) => String(number).padStart(2, '0');
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatDuration(seconds) {
  const days = Math.floor(seconds / 86400);
  if (days >= 1) return `${days} 天`;
  const hours = Math.floor(seconds / 3600);
  if (hours >= 1) return `${hours} 小时`;
  return `${Math.max(1, Math.ceil(seconds / 60))} 分钟`;
}

function sanitizeWebsite(value) {
  if (!hasValue(value)) return null;
  const text = String(value).trim();
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(text) ? text : `https://${text}`);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/* View switching */

function showView(name) {
  for (const [key, element] of Object.entries(views)) {
    element.hidden = key !== name;
  }
  if (name === 'login') {
    passwordInput.value = '';
    if (matchMedia('(hover: hover)').matches) passwordInput.focus();
  } else {
    loadHistory();
    if (matchMedia('(hover: hover)').matches) binInput.focus();
  }
}

function setBusy(button, busy) {
  button.classList.toggle('is-busy', busy);
  button.disabled = busy;
  button.setAttribute('aria-busy', String(busy));
}

function setMessage(element, text) {
  element.textContent = text ?? '';
  element.hidden = !text;
}

function restartAnimation(element, className) {
  element.classList.remove(className);
  void element.offsetWidth;
  element.classList.add(className);
}

/* Virtual card */

// The virtual card is always dark, while other surfaces follow the page theme.
function schemeLogo(scheme, { onDark = false } = {}) {
  const info = SCHEMES[scheme];
  if (!info) return null;
  const image = document.createElement('img');
  image.className = 'scheme-logo';
  image.alt = info.label;
  image.src = onDark ? (info.logoOnDark ?? info.logo) : info.logo;
  if (onDark || !info.logoOnDark) return image;

  const source = document.createElement('source');
  source.media = '(prefers-color-scheme: dark)';
  source.srcset = info.logoOnDark;
  const picture = document.createElement('picture');
  picture.append(source, image);
  return picture;
}

function setPageScheme(scheme) {
  if (scheme) {
    document.documentElement.dataset.scheme = scheme;
  } else {
    delete document.documentElement.dataset.scheme;
  }
}

function previewCard(scheme) {
  setPageScheme(scheme);
  $('card-issuer').textContent = 'BIN CHECK';
  $('card-logo').replaceChildren(...[schemeLogo(scheme, { onDark: true })].filter(Boolean));
  $('card-kind').textContent = '—';
  $('card-region').textContent = '—';
  $('card-number').textContent = formatCardNumber(binInput.value, scheme);
}

function renderCardLogo(scheme, label) {
  const logo = schemeLogo(scheme, { onDark: true });
  if (logo) {
    $('card-logo').replaceChildren(logo);
    return;
  }
  const text = document.createElement('span');
  text.className = 'logo-text';
  text.textContent = label;
  $('card-logo').replaceChildren(text);
}

// Reflects the scheme implied by the typed digits, without any network request.
function syncTypedScheme() {
  const scheme = detectScheme(binInput.value);
  const badge = $('search-scheme');
  if (badge.dataset.scheme !== (scheme ?? '')) {
    badge.dataset.scheme = scheme ?? '';
    badge.replaceChildren(...[schemeLogo(scheme)].filter(Boolean));
    badge.hidden = !scheme;
    if (scheme) restartAnimation(badge, 'is-popping');
  }
  $('search-hint').textContent = scheme
    ? `按号段预判为 ${SCHEMES[scheme].label}，以查询结果为准。`
    : DEFAULT_SEARCH_HINT;
  if (workspace.dataset.state === 'idle') previewCard(scheme);
}

function renderCard(bin, digits) {
  const scheme = schemeFromName(bin.scheme);
  const country = bin.country ?? {};
  setPageScheme(scheme);
  $('card-issuer').textContent = bin.issuer?.name || 'UNKNOWN ISSUER';
  renderCardLogo(scheme, String(bin.scheme ?? ''));
  $('card-number').textContent = formatCardNumber(digits, scheme);
  $('card-kind').textContent = joinParts([bin.type, bin.level]) || '—';
  $('card-region').textContent = joinParts([country.flag, country.alpha2], ' ') || '—';
  restartAnimation(cardFlip, 'is-revealing');
}

function enableCardTilt() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  cardScene.addEventListener('pointermove', (event) => {
    if (event.pointerType !== 'mouse') return;
    card.classList.add('is-tilting');
    const box = cardScene.getBoundingClientRect();
    const x = (event.clientX - box.left) / box.width;
    const y = (event.clientY - box.top) / box.height;
    card.style.setProperty('--ry', `${((x - 0.5) * 16).toFixed(2)}deg`);
    card.style.setProperty('--rx', `${((0.5 - y) * 12).toFixed(2)}deg`);
    card.style.setProperty('--mx', `${(x * 100).toFixed(1)}%`);
    card.style.setProperty('--my', `${(y * 100).toFixed(1)}%`);
  });
  cardScene.addEventListener('pointerleave', () => {
    card.classList.remove('is-tilting');
    for (const name of ['--rx', '--ry', '--mx', '--my']) card.style.removeProperty(name);
  });
}

/* Result panels */

function setField(name, value) {
  const element = document.querySelector(`[data-field="${name}"]`);
  const present = hasValue(value);
  element.textContent = present ? String(value) : '未提供';
  element.classList.toggle('is-empty', !present);
}

function setContact(element, value, buildLink) {
  const link = buildLink(value);
  element.classList.toggle('is-empty', !hasValue(value));
  if (link) {
    element.replaceChildren(link);
  } else {
    element.textContent = hasValue(value) ? String(value) : '未提供';
  }
}

function websiteLink(value) {
  const url = sanitizeWebsite(value);
  if (!url) return null;
  const link = document.createElement('a');
  link.href = url.href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = url.host + (url.pathname === '/' ? '' : url.pathname);
  return link;
}

function phoneLink(value) {
  if (!hasValue(value)) return null;
  const dial = String(value).replace(/[^\d+]/g, '');
  if (!dial) return null;
  const link = document.createElement('a');
  link.href = `tel:${dial}`;
  link.textContent = String(value);
  return link;
}

function renderScheme(name) {
  setField('scheme', name);
  const logo = schemeLogo(schemeFromName(name));
  if (hasValue(name) && logo) {
    document.querySelector('[data-field="scheme"]').prepend(logo);
  }
}

function currencyName(code) {
  if (CURRENCY_NAMES[code]) return CURRENCY_NAMES[code];
  try {
    const name = currencyNames.of(code);
    return name === code ? '' : name;
  } catch {
    return '';
  }
}

function currencyLabel(code) {
  const label = document.createElement('span');
  label.className = 'rate-currency';

  const symbol = document.createElement('span');
  symbol.className = 'rate-symbol';
  const flag = currencyFlag(code);
  if (flag) {
    const flagMark = document.createElement('span');
    flagMark.className = 'rate-flag';
    flagMark.textContent = flag;
    symbol.append(flagMark);
  }
  const letters = document.createElement('strong');
  letters.textContent = code;
  symbol.append(letters);
  label.append(symbol);

  const fullName = currencyName(code);
  if (fullName) {
    const name = document.createElement('span');
    name.className = 'rate-currency-name';
    name.textContent = fullName;
    label.append(name);
  }
  return label;
}

function swapIcon() {
  const namespace = 'http://www.w3.org/2000/svg';
  const icon = document.createElementNS(namespace, 'svg');
  icon.setAttribute('class', 'icon');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  for (const shape of ['M3 8h18', 'm17 4 4 4-4 4', 'M21 16H3', 'm7 12-4 4 4 4']) {
    const path = document.createElementNS(namespace, 'path');
    path.setAttribute('d', shape);
    icon.append(path);
  }
  return icon;
}

// The value above the arrows converts left to right, and the one below right to left.
function ratePair(base, quote, rate, inverse) {
  const forward = `1 ${base} ≈ ${formatPreciseRate(rate)} ${quote}`;
  const reverse = `1 ${quote} ≈ ${formatPreciseRate(inverse)} ${base}`;

  const pair = document.createElement('span');
  pair.className = 'rate-pair';
  pair.setAttribute('role', 'group');
  pair.setAttribute('aria-label', `${forward}，${reverse}`);

  const cell = (className, content) => {
    const element = document.createElement('span');
    element.className = className;
    element.append(content);
    return element;
  };
  const value = (className, amount, unit, title) => {
    const element = cell(`rate-value ${className}`, amount);
    element.append(cell('rate-unit', unit));
    element.title = title;
    return element;
  };

  pair.append(
    cell('rate-from', currencyLabel(base)),
    cell('rate-swap', swapIcon()),
    value('rate-value-forward', formatRate(rate), quote, forward),
    cell('rate-to', currencyLabel(quote)),
    value('rate-value-reverse', formatRate(inverse), base, reverse),
  );
  return pair;
}

function setRatePanelOpen(open) {
  $('rate-toggle').setAttribute('aria-expanded', String(open));
  $('rate-panel').hidden = !open;
}

function renderRate(currency, rate) {
  $('rates').hidden = !rate;
  $('rate-source').hidden = !rate;
  $('currency-rate').hidden = !hasValue(currency) || Boolean(rate);
  setRatePanelOpen(false);
  if (!rate) return;

  $('rate-summary').replaceChildren(
    rate.currency === 'CNY'
      ? '人民币，无需换算'
      : ratePair(rate.currency, 'CNY', rate.cny, 1 / rate.cny),
  );
  $('rate-panel').replaceChildren(
    ...rate.quotes
      .filter(({ currency }) => currency !== 'CNY')
      .map(({ currency, rate: value, inverse }) => {
        const item = document.createElement('li');
        item.append(ratePair(rate.currency, currency, value, inverse));
        return item;
      }),
  );
  $('rate-date').textContent = rate.updatedAt.slice(0, 10);
}

function renderResults(bin, rate) {
  const issuer = bin.issuer ?? {};
  const country = bin.country ?? {};

  setField('number', bin.number);
  renderScheme(bin.scheme);
  setField('brand', bin.brand);
  setField('type', formatCardType(bin.type));
  setField('level', bin.level);
  setField('currency', withCurrencyFlag(bin.currency));
  renderRate(bin.currency, rate);
  setField('length', hasValue(bin.length) ? `${bin.length} 位` : '');

  setField('commercial', formatFlag(bin.is_commercial));
  setField('prepaid', formatFlag(bin.is_prepaid));
  $('switch-commercial').dataset.on = String(parseFlag(bin.is_commercial) === true);
  $('switch-prepaid').dataset.on = String(parseFlag(bin.is_prepaid) === true);

  setField('issuerName', issuer.name);
  setContact($('issuer-website'), issuer.website, websiteLink);
  setContact($('issuer-phone'), issuer.phone, phoneLink);

  const native = hasValue(country.native) ? country.native : country.name;
  const showsEnglish =
    hasValue(country.name) && String(country.name).toLowerCase() !== String(native).toLowerCase();
  setField('flag', country.flag);
  setField('countryTitle', native);
  setField('countrySubtitle', joinParts([showsEnglish ? country.name : '', country.alpha2]));
  setField('capital', country.capital);
  setField('region', joinParts([country.region, country.subregion]));
  setField('language', joinParts([country.language, country.language_code]));
  setField(
    'countryCurrency',
    joinParts([joinParts([country.currency_symbol, country.currency], ' '), country.currency_name]),
  );
  setField('idd', hasValue(country.idd) ? `+${country.idd}` : '');
  setField('iso', joinParts([country.alpha2, country.alpha3, country.numeric], ' / '));

  $('raw-json').textContent = JSON.stringify(bin, null, 2);
  results.querySelector('.raw').open = false;
}

function renderQuota(quota) {
  if (!quota) return;
  const element = $('quota');
  const ratio = quota.limit > 0 ? quota.remaining / quota.limit : 0;
  $('quota-count').textContent = `${quota.remaining}/${quota.limit}`;
  $('quota-fill').style.setProperty('--fill', `${Math.min(100, ratio * 100).toFixed(1)}%`);
  element.classList.toggle('is-low', ratio <= LOW_QUOTA_RATIO);
  if (quota.estimated) {
    $('quota-tip-title').textContent = '额度周期已重置';
    $('quota-tip-detail').textContent = '暂按满额显示，下次查询后更新';
  } else if (quota.resetSeconds) {
    $('quota-tip-title').textContent = `${formatTimestamp(Date.now() + quota.resetSeconds * 1000)} 重置`;
    $('quota-tip-detail').textContent = `还有 ${formatDuration(quota.resetSeconds)}`;
  } else {
    $('quota-tip-title').textContent = '重置时间未知';
    $('quota-tip-detail').textContent = '下次查询后更新';
  }
  element.hidden = false;
}

function clearResults() {
  currentKey = null;
  workspace.dataset.state = 'idle';
  results.hidden = true;
  results.classList.remove('is-entering');
  syncTypedScheme();
  renderHistory();
}

function showResult({ key, bin, rate, cache }, digits) {
  currentKey = key;
  renderCard(bin, digits);
  renderResults(bin, rate);
  const source = cache.hit ? 'cache' : 'live';
  $('cache-source').textContent = cache.hit ? '来自缓存' : '实时查询';
  $('cache-source').dataset.source = source;
  $('cache-time').textContent = formatTimestamp(cache.cachedAt);
  $('cache-time').dateTime = cache.cachedAt;
  setMessage($('cache-message'), null);
  workspace.dataset.state = 'result';
  results.hidden = false;
  restartAnimation(results, 'is-entering');
}

/* Query history */

function historyRow(entry) {
  const scheme = schemeFromName(entry.scheme);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'history-row';
  button.dataset.key = entry.key;
  if (entry.key === currentKey) button.setAttribute('aria-current', 'true');

  const logo = schemeLogo(scheme);
  const mark = document.createElement('span');
  mark.className = 'history-mark';
  if (logo) mark.append(logo);
  else mark.textContent = hasValue(entry.scheme) ? String(entry.scheme) : '—';

  const number = document.createElement('span');
  number.className = 'history-bin';
  number.textContent = entry.key;

  const issuer = document.createElement('span');
  issuer.className = 'history-issuer';
  issuer.textContent = entry.issuer || '未知发卡机构';

  const region = document.createElement('span');
  region.className = 'history-region';
  region.textContent = joinParts([entry.flag, entry.alpha2], ' ') || '—';

  const time = document.createElement('time');
  time.className = 'history-time';
  time.dateTime = entry.viewedAt;
  time.textContent = formatTimestamp(entry.viewedAt);

  button.append(mark, number, issuer, region, time);
  const item = document.createElement('li');
  item.append(button);
  return item;
}

function renderHistory(total = historyEntries.length) {
  $('history').hidden = historyEntries.length === 0;
  $('history-count').textContent = String(total);
  $('history-list').replaceChildren(...historyEntries.map(historyRow));
}

function applyHistory({ entries, total, quota }) {
  historyEntries = entries;
  renderHistory(total);
  renderQuota(quota);
}

async function loadHistory() {
  try {
    const response = await fetch('/api/history');
    if (response.status === 401) {
      expireSession();
      return;
    }
    if (response.ok) applyHistory(await response.json());
  } catch {
    // The list simply stays as it was until the next successful lookup.
  }
}

/* Actions */

function expireSession() {
  lookupController?.abort();
  clearResults();
  showView('login');
  setMessage($('login-message'), '登录已过期，请重新输入密码。');
}

async function lookup(digits, { refreshing = false } = {}) {
  lookupController?.abort();
  const controller = new AbortController();
  lookupController = controller;

  setMessage($('search-message'), null);
  setMessage($('cache-message'), null);
  setBusy(searchSubmit, true);
  setBusy($('refresh'), refreshing);
  card.classList.add('is-loading');

  // A failed refresh leaves the cached result on screen.
  const fail = (text) => {
    if (refreshing) {
      setMessage($('cache-message'), text);
    } else {
      clearResults();
      setMessage($('search-message'), text);
    }
  };

  try {
    const url = `/api/bin/${digits}${refreshing ? '?refresh=1' : ''}`;
    const response = await fetch(url, { signal: controller.signal });
    if (response.status === 401) {
      expireSession();
      return;
    }

    const body = await response.json().catch(() => ({}));
    renderQuota(body.quota);

    if (!response.ok) {
      fail(LOOKUP_ERRORS[body.error] ?? '查询失败，请稍后再试。');
      return;
    }

    showResult(body, digits);
    loadHistory();
  } catch (error) {
    if (error.name === 'AbortError') return;
    fail('网络异常，请检查连接后再试。');
  } finally {
    if (lookupController === controller) {
      setBusy(searchSubmit, false);
      setBusy($('refresh'), false);
      card.classList.remove('is-loading');
    }
  }
}

function formatRetryAfter(seconds) {
  return Number.isFinite(seconds) && seconds > 0 ? formatDuration(seconds) : '几分钟';
}

async function login(password) {
  setMessage($('login-message'), null);
  setBusy(loginSubmit, true);
  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (response.ok) {
      showView('app');
      return;
    }
    const message =
      response.status === 429
        ? `尝试次数过多，请 ${formatRetryAfter(Number(response.headers.get('Retry-After')))}后再试。`
        : response.status === 401
          ? '密码不正确。'
          : '登录失败，请稍后再试。';
    setMessage($('login-message'), message);
    restartAnimation($('password-field'), 'is-shaking');
    passwordInput.select();
  } catch {
    setMessage($('login-message'), '网络异常，请检查连接后再试。');
  } finally {
    setBusy(loginSubmit, false);
  }
}

async function logout() {
  lookupController?.abort();
  await fetch('/api/logout', { method: 'POST' }).catch(() => {});
  binInput.value = '';
  setMessage($('search-message'), null);
  $('quota').hidden = true;
  clearResults();
  showView('login');
}

/* Wiring */

$('login-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!loginSubmit.disabled) login(passwordInput.value);
});

$('password-toggle').addEventListener('click', (event) => {
  const toggle = event.currentTarget;
  const reveal = passwordInput.type === 'password';
  passwordInput.type = reveal ? 'text' : 'password';
  toggle.setAttribute('aria-pressed', String(reveal));
  toggle.setAttribute('aria-label', reveal ? '隐藏密码' : '显示密码');
});

$('logout').addEventListener('click', logout);

binInput.addEventListener('input', () => {
  binInput.value = binInput.value.replace(/\D/g, '').slice(0, MAX_BIN_LENGTH);
  setMessage($('search-message'), null);
  syncTypedScheme();
});

binInput.addEventListener('focus', () => {
  if (workspace.dataset.state === 'result') binInput.select();
});

$('search-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const digits = binInput.value;
  if (digits.length < MIN_BIN_LENGTH) {
    setMessage($('search-message'), LOOKUP_ERRORS.invalid_bin);
    binInput.focus();
    return;
  }
  if (!searchSubmit.disabled) lookup(digits);
});

$('rate-toggle').addEventListener('click', () => {
  setRatePanelOpen($('rate-panel').hidden);
});

$('refresh').addEventListener('click', () => {
  if (currentKey) lookup(currentKey, { refreshing: true });
});

$('history-list').addEventListener('click', (event) => {
  const row = event.target.closest('.history-row');
  if (!row) return;
  binInput.value = row.dataset.key;
  syncTypedScheme();
  lookup(row.dataset.key);
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

$('history-clear').addEventListener('click', async () => {
  if (!window.confirm('清空后，再次查询这些 BIN 会重新消耗额度。确定清空吗？')) return;
  try {
    const response = await fetch('/api/history', { method: 'DELETE' });
    if (response.status === 401) {
      expireSession();
    } else if (response.ok) {
      applyHistory(await response.json());
    }
  } catch {
    // The list stays as it was, which shows nothing was cleared.
  }
});

enableCardTilt();

try {
  const response = await fetch('/api/session');
  const { authenticated } = await response.json();
  showView(authenticated ? 'app' : 'login');
} catch {
  showView('login');
  setMessage($('login-message'), '无法连接到服务器，请刷新重试。');
}
