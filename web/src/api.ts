// Same-origin API bridge to the host server. Every request rides the HttpOnly
// session cookie (attached automatically) plus the X-Wairon-Web header the CSRF
// gate requires on cookie-authenticated mutations — identical to the contract
// the previous embedded client used, so no server change is needed.

const WEB_HEADER = { 'X-Wairon-Web': '1' };

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: { ...WEB_HEADER, ...(init.headers ?? {}) },
  });
}

/** GET → parsed JSON. Throws ApiError(status) on a non-2xx, preferring the
 *  server's { error } message. */
export async function get<T = unknown>(path: string): Promise<T> {
  const res = await request(path);
  return parse<T>(res, path);
}

/** POST JSON → parsed JSON, same error handling. */
export async function post<T = unknown>(path: string, body?: unknown): Promise<T> {
  const res = await request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return parse<T>(res, path);
}

/** POST raw bytes (a .wpack upload) → parsed JSON, same error handling. Sends
 *  application/zip with the CSRF header; extra headers (e.g. X-Wairon-Pack-Name)
 *  merge in. */
export async function postBinary<T = unknown>(
  path: string,
  body: Blob | ArrayBuffer | Uint8Array,
  headers: Record<string, string> = {},
): Promise<T> {
  const res = await request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/zip', ...headers },
    body: body as BodyInit,
  });
  return parse<T>(res, path);
}

/** Raw GET (no parse) — for status probes where the caller inspects res.status. */
export function raw(path: string): Promise<Response> {
  return request(path);
}

async function parse<T>(res: Response, path: string): Promise<T> {
  if (res.ok) {
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
  let message = `${path} failed (${res.status})`;
  try {
    const t = await res.text();
    const j = t ? JSON.parse(t) : null;
    if (j && typeof j.error === 'string') message = j.error;
    else if (t) message = t;
  } catch {
    /* keep the default */
  }
  throw new ApiError(message, res.status);
}
