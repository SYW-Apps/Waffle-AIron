import type { IncomingMessage, ServerResponse } from 'http';
import { createHash } from 'crypto';

// ---------------------------------------------------------------------------
// Shared HTTP I/O helpers for the hosted server's route modules. These are
// transport plumbing, not any component's workflow — they live outside the
// component-mapped files so importing them never couples two components.
// ---------------------------------------------------------------------------

export function bearerToken(req: IncomingMessage): string | null {
  const h = req.headers['authorization'];
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(Array.isArray(h) ? h[0] : h);
  return m ? m[1].trim() : null;
}

/** The text a response may carry for a caught value: an Error's own message,
 *  never its stack or its string form; anything else is not shown. */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : 'request failed';
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** The text and entity tag of a body answered before: a kept view is answered as the same object, so it is serialized once. */
const taggedTexts = new WeakMap<object, { text: string; etag: string }>();

/**
 * A body's JSON text and its entity tag, serialized once. The tag hashes the text
 * without a top-level `generatedAt` (a rebuild of unchanged content still answers
 * 304), and the stamp is appended to that same text, so the body is stringified
 * one time, not twice.
 */
function taggedText(body: unknown): { text: string; etag: string } {
  const isObject = body !== null && typeof body === 'object';
  const known = isObject ? taggedTexts.get(body) : undefined;
  if (known) return known;
  const stamped = isObject && !Array.isArray(body) && 'generatedAt' in body;
  let text: string;
  let etag: string;
  if (stamped) {
    const generatedAt = (body as Record<string, unknown>).generatedAt;
    const tagged = JSON.stringify({ ...(body as Record<string, unknown>), generatedAt: undefined });
    etag = `"${createHash('sha1').update(tagged).digest('base64url')}"`;
    const stamp = generatedAt === undefined ? undefined : JSON.stringify(generatedAt);
    text = stamp === undefined ? tagged : tagged === '{}' ? `{"generatedAt":${stamp}}` : `${tagged.slice(0, -1)},"generatedAt":${stamp}}`;
  } else {
    text = JSON.stringify(body);
    etag = `"${createHash('sha1').update(text).digest('base64url')}"`;
  }
  const answer = { text, etag };
  if (isObject) taggedTexts.set(body, answer);
  return answer;
}

/**
 * A 200 JSON read the browser revalidates: tagged by its content, with the
 * top-level `generatedAt` stamp left out of the tag, and answered 304 with no
 * body when the request already holds that tag. An unchanged model is then
 * neither sent again nor parsed again by the page.
 */
export function sendJsonTagged(req: IncomingMessage, res: ServerResponse, body: unknown): void {
  const { text, etag } = taggedText(body);
  const headers = { 'content-type': 'application/json', etag, 'cache-control': 'private, no-cache' };
  const held = req.headers['if-none-match'];
  if (typeof held === 'string' && held.split(',').some((t) => t.trim().replace(/^W\//, '') === etag)) {
    res.writeHead(304, { etag, 'cache-control': 'private, no-cache' });
    res.end();
    return;
  }
  res.writeHead(200, headers);
  res.end(text);
}

// ── The web session cookie ─────────────────────────────────────────────────
// How the hosted handlers read and write the browser session cookie: wire
// format, shared by the web portal, the HTTP router and the realtime upgrade.

/** The browser cookie carrying the session id (a first-class credential). It is
 *  HttpOnly, so client JS cannot read it — the server reads it from the Cookie
 *  header as the auth bridge. */
const WEB_SESSION_COOKIE = 'wairon_session';

/** Read the wairon_session cookie (a ws_-prefixed session id) from the request's
 *  Cookie header, or null when absent. */
export function sessionCookieValue(req: IncomingMessage): string | null {
  const header = req.headers['cookie'];
  if (!header) return null;
  const raw = Array.isArray(header) ? header.join(';') : header;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === WEB_SESSION_COOKIE) return part.slice(eq + 1).trim();
  }
  return null;
}

/** The Set-Cookie value that installs the session cookie: HttpOnly + SameSite=Lax +
 *  Path=/, plus Secure when the effective exposure requires TLS. */
export function setSessionCookie(sessionId: string, secure: boolean): string {
  return `${WEB_SESSION_COOKIE}=${sessionId}; HttpOnly; SameSite=Lax; Path=/${secure ? '; Secure' : ''}`;
}

/** The Set-Cookie value that clears the session cookie (Max-Age=0). */
export function clearSessionCookie(secure: boolean): string {
  return `${WEB_SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;
}
