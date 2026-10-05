// Fetch wrapper — all views talk to the SPEC §4 API through this module only.
export class ApiError extends Error {
  constructor(message, status, data) { super(message); this.status = status; this.data = data; }
}

async function req(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    // status 0 is the "no connection" signal every caller branches on
    throw new ApiError("Can't reach CRM+ — check the app is still running.", 0, null);
  }
  if (res.status === 401) {
    if (!location.hash.startsWith('#/login')) location.hash = '#/login';
    throw new ApiError('unauthorized', 401, null);
  }
  let data = null;
  try { data = await res.json(); } catch { /* empty body ok */ }
  if (!res.ok) throw new ApiError((data && data.error) || `HTTP ${res.status}`, res.status, data);
  return data;
}

/** Raw bytes (a File/Blob), not JSON — used for the LinkedIn export upload. */
async function reqBinary(path, blob) {
  let res;
  try {
    res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: blob });
  } catch {
    throw new ApiError('network error', 0, null);
  }
  if (res.status === 401) {
    if (!location.hash.startsWith('#/login')) location.hash = '#/login';
    throw new ApiError('unauthorized', 401, null);
  }
  let data = null;
  try { data = await res.json(); } catch { /* empty body ok */ }
  if (!res.ok) throw new ApiError((data && data.error) || `HTTP ${res.status}`, res.status, data);
  return data;
}

export const api = {
  postBinary: reqBinary,
  get: (path) => req('GET', path),
  post: (path, body) => req('POST', path, body ?? {}),
  patch: (path, body) => req('PATCH', path, body),
  put: (path, body) => req('PUT', path, body),
  del: (path) => req('DELETE', path),
};

export const qs = (params) => {
  const p = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return p.length ? '?' + p.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&') : '';
};
