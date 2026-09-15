import {resolve} from 'node:path';

function integer(env, name, fallback, min, max) {
  const value = Number(env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function baseUrl(value, name) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${name} must be an HTTP(S) URL`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must be an HTTP(S) URL without credentials, query or fragment`);
  }
  return url.href.replace(/\/$/, '');
}

export function loadConfig(env = process.env, command = 'run') {
  const required = command === 'devices' ? ['ZECTRIX_API_KEY']
    : command === 'preview' ? ['TRMNL_API_KEY']
      : ['TRMNL_API_KEY', 'ZECTRIX_API_KEY', 'ZECTRIX_DEVICE_ID'];
  for (const name of required) {
    if (!env[name]?.trim()) throw new Error(`${name} is required; configure .env first`);
  }
  const mode = env.TRMNL_MODE ?? 'display';
  const fit = env.IMAGE_FIT ?? 'contain';
  const dither = env.ZECTRIX_DITHER ?? 'true';
  if (!['display', 'current_screen'].includes(mode)) throw new Error('TRMNL_MODE must be display or current_screen');
  if (!['contain', 'cover', 'fill'].includes(fit)) throw new Error('IMAGE_FIT must be contain, cover or fill');
  if (!['true', 'false'].includes(dither)) throw new Error('ZECTRIX_DITHER must be true or false');
  return {
    trmnlBaseUrl: baseUrl(env.TRMNL_BASE_URL ?? 'https://trmnl.com', 'TRMNL_BASE_URL'),
    trmnlApiKey: env.TRMNL_API_KEY?.trim(), mode,
    zectrixBaseUrl: baseUrl(env.ZECTRIX_BASE_URL ?? 'https://cloud.zectrix.com', 'ZECTRIX_BASE_URL'),
    zectrixApiKey: env.ZECTRIX_API_KEY?.trim(), deviceId: env.ZECTRIX_DEVICE_ID?.trim(),
    pageId: integer(env, 'ZECTRIX_PAGE_ID', 1, 1, 5), dither: dither === 'true', fit,
    interval: integer(env, 'REFRESH_INTERVAL', 300, 30, 86400),
    timeout: integer(env, 'REQUEST_TIMEOUT', 30, 1, 300),
    retryMaxDelay: integer(env, 'RETRY_MAX_DELAY', 3600, 30, 86400),
    stateDir: resolve(env.STATE_DIR ?? './data'),
  };
}
