export class ApiError extends Error {
  constructor(message, {retryable = false, retryAfter = 0} = {}) {
    super(message);
    this.retryable = retryable;
    this.retryAfter = retryAfter;
  }
}

function retryAfter(value) {
  if (!value) return 0;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Math.max(0, seconds)
    : Math.max(0, (Date.parse(value) - Date.now()) / 1000) || 0;
}

// Do not include URLs, response bodies or fetch errors in logs: they can contain keys.
export async function request(url, {timeout = 30, limit = 1024 * 1024, label = 'API', ...options} = {}) {
  try {
    const response = await fetch(url, {...options, redirect: options.redirect ?? 'error', signal: AbortSignal.timeout(timeout * 1000)});
    if (!response.ok) {
      await response.body?.cancel();
      throw new ApiError(`${label}: HTTP ${response.status}`, {
        retryable: [408, 425, 429].includes(response.status) || response.status >= 500,
        retryAfter: retryAfter(response.headers.get('retry-after')),
      });
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > limit) throw new ApiError(`${label}: response exceeds size limit`);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(`${label}: network request failed or timed out`, {retryable: true});
  }
}

async function json(url, options) {
  const data = await request(url, options);
  try { return JSON.parse(data.toString()); }
  catch { throw new ApiError(`${options.label}: invalid JSON response`); }
}

export async function getScreen(config) {
  const data = await json(`${config.trmnlBaseUrl}/api/${config.mode}`, {
    headers: {'access-token': config.trmnlApiKey}, timeout: config.timeout, label: 'TRMNL',
  });
  if (!data || ![0, 200].includes(data.status)) throw new ApiError('TRMNL: unsuccessful or missing status');
  if (typeof data.image_url !== 'string' || !data.image_url.trim()) throw new ApiError('TRMNL: missing image_url');
  let url;
  try { url = new URL(data.image_url, `${config.trmnlBaseUrl}/`); }
  catch { throw new ApiError('TRMNL: invalid image_url'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new ApiError('TRMNL: invalid image_url');
  const refresh = Number(data.refresh_rate);
  return {
    imageUrl: url.href,
    delay: Math.max(config.interval, Number.isSafeInteger(Math.ceil(refresh) * 1000) && refresh > 0 ? Math.ceil(refresh) : 0),
  };
}

export function downloadImage(config, imageUrl) {
  // Image hosts may redirect to signed CDN URLs. Never send either API key here.
  return request(imageUrl, {timeout: config.timeout, label: 'Image', limit: 10 * 1024 * 1024, redirect: 'follow'});
}

async function zectrix(config, path, options = {}) {
  const data = await json(`${config.zectrixBaseUrl}/open/v1/${path}`, {
    ...options, headers: {'X-API-Key': config.zectrixApiKey}, timeout: config.timeout, label: 'ZecTrix',
  });
  if (!data || data.code !== 0) throw new ApiError('ZecTrix: unsuccessful or missing code');
  return data.data;
}

export async function listDevices(config) {
  const data = await zectrix(config, 'devices');
  if (!Array.isArray(data)) throw new ApiError('ZecTrix: invalid device list');
  return data;
}

export async function pushImage(config, png) {
  if (png.length > 2 * 1024 * 1024) throw new ApiError('ZecTrix: image exceeds 2 MB');
  const body = new FormData();
  body.append('images', new Blob([png], {type: 'image/png'}), 'trmnl.png');
  body.append('dither', String(config.dither));
  body.append('pageId', String(config.pageId));
  const data = await zectrix(config, `devices/${encodeURIComponent(config.deviceId)}/display/image`, {method: 'POST', body});
  // pageId is already specified by the request. Some responses may omit the echo;
  // an explicit different page must still be treated as a failure.
  const pushed = data?.pushedPages;
  const page = data?.pageId;
  const safeValue = value => value === undefined ? 'missing'
    : typeof value === 'number' && Number.isFinite(value) ? String(value)
      : typeof value === 'string' && /^\d{1,6}$/.test(value) ? JSON.stringify(value) : 'invalid';
  if (pushed !== 1 && pushed !== '1') {
    throw new ApiError(`ZecTrix: upload accepted, but no single-page push was confirmed (pushedPages=${safeValue(pushed)}). Check device connectivity and firmware compatibility`);
  }
  if (page !== undefined && String(page) !== String(config.pageId)) {
    throw new ApiError(`ZecTrix: upload confirmed a different page (expected=${config.pageId}, pageId=${safeValue(page)})`);
  }
  return data;
}
