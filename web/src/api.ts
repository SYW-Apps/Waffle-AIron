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

/**
 * Call an MCP data-plane tool for one project directly from the browser.
 *
 * POSTs a single JSON-RPC `tools/call` to `/mcp`, scoping it to `projectId` via
 * the `X-Wairon-Project` header (the same header the host's projectSelector
 * reads) and riding the session cookie + the `X-Wairon-Web` CSRF header that
 * `request()` always attaches. Returns the tool's payload:
 *
 * The host answers with a JSON-RPC envelope
 *   `{ jsonrpc, id, result: { content: [{ type:'text', text }], isError? } }`.
 * We parse `result.content[0].text` — the sdd_* read tools serialize their
 * payload there as JSON (via the server's `json()` helper), so we JSON.parse it;
 * a tool that returns plain prose (e.g. sdd_update_spec's "Successfully
 * updated…") is handed back as the raw string. Errors are thrown as Error:
 *   - transport/auth failures (HTTP 401/403/400 with `{ error }`),
 *   - JSON-RPC protocol errors (`payload.error`),
 *   - tool-level failures (`result.isError`, message in content[0].text).
 */
export async function mcpCall<T = unknown>(projectId: string, name: string, args: object): Promise<T> {
  const res = await request('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Wairon-Project': projectId },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });

  const bodyText = await res.text();
  let payload: {
    error?: unknown;
    result?: { content?: { type: string; text?: string }[]; isError?: boolean };
  };
  try {
    payload = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    throw new Error(`${name}: unexpected non-JSON response (${res.status})`);
  }

  // Transport/auth failures come back non-2xx with a bare `{ error }` (401
  // unauthorized, 403 project-not-authorized, 400 batched) — never a tool result.
  if (!res.ok) {
    const e = payload.error as { message?: string } | string | undefined;
    const msg = typeof e === 'string' ? e : e?.message ?? `${name} failed (${res.status})`;
    throw new ApiError(msg, res.status);
  }
  // JSON-RPC protocol-level error (malformed request, unknown method).
  if (payload.error !== undefined && payload.error !== null) {
    const e = payload.error as { message?: string } | string;
    throw new Error(typeof e === 'string' ? e : e.message ?? `${name} failed`);
  }

  const result = payload.result;
  const first = result?.content?.[0];
  const rawTool = first && first.type === 'text' ? first.text ?? '' : '';
  // Tool-level failure (Forbidden gate, not-found, validation) — HTTP is still 200.
  if (result?.isError) {
    throw new Error(rawTool || `${name} failed`);
  }
  if (!first) return undefined as T;
  try {
    return JSON.parse(rawTool) as T;
  } catch {
    // Prose result (update/delete confirmations) — hand back the raw text.
    return rawTool as unknown as T;
  }
}

/** Normalize a list response that may arrive as a bare array OR wrapped as
 *  `{ <key>: [...] }`. Some /web list endpoints wrap (e.g. `{ packs: [...] }`),
 *  others return the array directly; this keeps callers robust to either shape. */
export function asList<T>(data: unknown, key: string): T[] {
  if (Array.isArray(data)) return data as T[];
  const wrapped = (data as Record<string, unknown> | null | undefined)?.[key];
  return Array.isArray(wrapped) ? (wrapped as T[]) : [];
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
