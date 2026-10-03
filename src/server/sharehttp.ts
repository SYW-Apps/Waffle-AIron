import type { IncomingMessage, ServerResponse } from 'http';
import { resolveSharedView, downloadArtifact } from './shareaccess.js';
import { sendJson } from './httpio.js';
import { swaggerUiPage } from './swagger.js';
import { safeFilenamePart } from '../utils/filenames.js';
import type { HostConfig, ShareRequestMeta } from './types.js';

// ---------------------------------------------------------------------------
// Share Portal (sdd_host): the PUBLIC, unauthenticated /share HTTP surface.
// Every response sets the hardening headers (Referrer-Policy: no-referrer,
// X-Robots-Tag: noindex, CSP frame-ancestors from the link's allowlist) and
// establishes NO session cookie. Each portal method is a function shaped like
// its contract (the token, the request meta, the selection) answering a
// ShareResponse; handleShareRequest is the transport: it parses the request,
// derives the meta and the `spec` selection, calls the method and writes the
// response. http.ts gates the surface on the exposure policy and hands it /share.
// ---------------------------------------------------------------------------

/** The `spec` query parameter (a portalId) selecting WHICH per-portal OpenAPI
 *  document to serve, or undefined when the request names none. */
function specParam(req: IncomingMessage): string | undefined {
  const url = req.url ?? '';
  const q = url.indexOf('?');
  if (q < 0) return undefined;
  return new URLSearchParams(url.slice(q + 1)).get('spec') || undefined;
}

/** The multi-API INDEX the access orchestrator serves in place of a document when
 *  a share captured several per-portal APIs and the request named none. Parsed
 *  (not imported) so the portal keeps its single dependency on the orchestrator. */
interface SharedOpenApiIndex {
  openapiIndex: true;
  specs: { portalId: string; name: string }[];
}

/** The payload as an index, or null when it is an ordinary OpenAPI document. */
function asOpenApiIndex(payload: string): SharedOpenApiIndex | null {
  try {
    const parsed = JSON.parse(payload) as Partial<SharedOpenApiIndex>;
    return parsed && parsed.openapiIndex === true && Array.isArray(parsed.specs)
      ? (parsed as SharedOpenApiIndex)
      : null;
  } catch {
    return null; // not JSON at all ⇒ certainly not the index
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}

/** A self-contained landing page listing every API this share exposes — each a
 *  separate document with its own auth, opened via `?spec=<portalId>` (relative,
 *  so the token never has to be re-embedded). No scripts: it renders under the
 *  share CSP unchanged. */
function sharedOpenApiIndexPage(index: SharedOpenApiIndex): string {
  const items = index.specs
    .map(
      (s) =>
        `<li><a href="?spec=${encodeURIComponent(s.portalId)}">${escapeHtml(s.name)}</a>` +
        `<code>${escapeHtml(s.portalId)}</code></li>`,
    )
    .join('');
  return (
    '<!doctype html><html><head><meta charset="utf-8"><title>Shared APIs</title>' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<style>body{font:15px/1.6 system-ui,sans-serif;max-width:680px;margin:48px auto;padding:0 20px;' +
    'background:#0b1120;color:#e8e8f0}h1{font-size:20px}a{color:#6ea8fe;text-decoration:none}' +
    'a:hover{text-decoration:underline}li{margin:10px 0}code{color:#9a9aab;font-size:12px;margin-left:8px}' +
    'p{color:#9a9aab}</style></head><body><h1>Shared APIs</h1>' +
    `<p>This share exposes ${index.specs.length} separate APIs, each with its own OpenAPI document and auth:</p>` +
    `<ul>${items}</ul></body></html>`
  );
}

/** The attachment name for a served artifact. A SELECTED per-portal API carries
 *  its portal id so several downloads never collide, and the multi-API index is
 *  named for what it is rather than posing as one of the documents. */
function downloadFilename(kind: string, portalId: string | undefined, payload: string): string {
  if (kind !== 'openapi') return `shared-canvas.${safeFilenamePart(kind)}`;
  if (portalId) return `shared-canvas.${safeFilenamePart(portalId)}.openapi.json`;
  return asOpenApiIndex(payload) ? 'shared-canvas.openapi.index.json' : 'shared-canvas.openapi.json';
}

/** Extract the request context recorded on every access. */
function shareRequestMeta(req: IncomingMessage): ShareRequestMeta {
  const fwd = req.headers['x-forwarded-for'];
  const ip =
    (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'unknown';
  const ua = req.headers['user-agent'];
  const ref = req.headers['referer'] ?? req.headers['referrer'];
  const meta: ShareRequestMeta = { ip, userAgent: (Array.isArray(ua) ? ua[0] : ua) ?? '' };
  const referer = Array.isArray(ref) ? ref[0] : ref;
  if (referer) meta.referer = referer;
  return meta;
}

/**
 * What a /share method answers: the status, the body and its content type, the
 * link's embedding allowlist (frame-ancestors; absent forbids framing), and the
 * attachment name of a download. The transport writes it with the hardening
 * headers every /share response carries.
 */
export interface ShareResponse {
  status: number;
  contentType: string;
  body: string;
  frameAncestors?: string[];
  filename?: string;
}

const NOT_FOUND_PAGE =
  '<!doctype html><meta charset="utf-8"><title>Share unavailable</title>' +
  '<body style="font:15px/1.5 system-ui;margin:0;display:grid;place-items:center;height:100vh;background:#0b1120;color:#e8e8f0">' +
  '<div style="text-align:center"><h1 style="font-size:20px">This share link is unavailable</h1>' +
  '<p style="color:#9a9aab">It may have been disabled, expired, or never existed.</p></div></body>';

function notFoundPage(): ShareResponse {
  return { status: 404, contentType: 'text/html; charset=utf-8', body: NOT_FOUND_PAGE };
}

/** GET /share/:token — the read-only shared-view page (the captured self-contained
 *  canvas HTML). */
export function getSharedView(cfg: HostConfig, token: string, meta: ShareRequestMeta): ShareResponse {
  const result = resolveSharedView(cfg, token, meta);
  if (!result.found || !result.link || result.html === undefined) return notFoundPage();
  return { status: 200, contentType: 'text/html; charset=utf-8', body: result.html, frameAncestors: result.link.frameAncestors };
}

/** GET /share/:token/model — the snapshot canvas model JSON + download flags. */
export function getSharedModel(cfg: HostConfig, token: string, meta: ShareRequestMeta): ShareResponse {
  const result = resolveSharedView(cfg, token, meta);
  if (!result.found || !result.link) {
    return { status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'not found', outcome: result.outcome }) };
  }
  return {
    status: 200,
    contentType: 'application/json',
    frameAncestors: result.link.frameAncestors,
    body: JSON.stringify({
      model: result.model ? JSON.parse(result.model) : null,
      allowDownloadHtml: result.allowDownloadHtml,
      allowDownloadOpenapi: result.allowDownloadOpenapi,
    }),
  };
}

/** GET /share/:token/openapi[?spec=<portalId>] — a self-contained viewer page for
 *  a captured OpenAPI document. `portalId` selects WHICH per-portal API to view;
 *  with several captured and none selected the orchestrator hands back the index,
 *  which is rendered as a link list rather than merged into one viewer; with
 *  exactly one that API opens directly. An unknown selection is refused (404),
 *  not substituted. */
export function getSharedOpenApi(
  cfg: HostConfig,
  token: string,
  meta: ShareRequestMeta,
  portalId?: string,
): ShareResponse {
  const result = downloadArtifact(cfg, token, 'openapi', meta, portalId);
  if (!result.found || result.content === undefined) return notFoundPage();
  const index = asOpenApiIndex(result.content);
  // Swagger UI inlines its own scripts + styles, so the frame-ancestors-only CSP
  // (no script-src) leaves them free to run.
  return {
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: index ? sharedOpenApiIndexPage(index) : swaggerUiPage(result.content, 'Shared API'),
  };
}

/** GET /share/:token/download/:kind[?spec=<portalId>] — a permitted artifact
 *  download. For openapi, `portalId` selects one per-portal document (its id lands
 *  in the filename so several downloads never collide); omitted with several
 *  captured specs downloads the index listing them. */
export function downloadSharedArtifact(
  cfg: HostConfig,
  token: string,
  kind: string,
  meta: ShareRequestMeta,
  portalId?: string,
): ShareResponse {
  const result = downloadArtifact(cfg, token, kind, meta, portalId);
  if (!result.found || result.content === undefined) {
    if (result.outcome === 'denied-download') {
      return { status: 403, contentType: 'text/plain', body: 'download not permitted' };
    }
    return notFoundPage();
  }
  return {
    status: 200,
    contentType: result.contentType ?? 'application/octet-stream',
    body: result.content,
    filename: downloadFilename(kind, portalId, result.content),
  };
}

/** Write a share response with the hardening headers every /share response
 *  carries. The embedding allowlist drives frame-ancestors: an empty or absent
 *  allowlist forbids framing entirely. No session cookie is ever set. */
function writeShareResponse(res: ServerResponse, response: ShareResponse): void {
  const frameAncestors = response.frameAncestors?.length ? response.frameAncestors.join(' ') : "'none'";
  res.setHeader('content-type', response.contentType);
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-robots-tag', 'noindex, nofollow');
  res.setHeader('content-security-policy', `frame-ancestors ${frameAncestors}`);
  res.setHeader('cache-control', 'no-store');
  if (response.filename) res.setHeader('content-disposition', `attachment; filename="${response.filename}"`);
  res.statusCode = response.status;
  res.end(response.body);
}

/**
 * The /share router entry: GET /share/:token[/model|/openapi|/download/:kind].
 * Parses the path, derives the request meta and the `spec` selection, calls the
 * portal method the path names and writes its response. An unrecognised path
 * under /share answers a JSON 404.
 */
export function handleShareRequest(cfg: HostConfig, req: IncomingMessage, res: ServerResponse): void {
  const pathname = new URL(req.url ?? '/', 'http://share.invalid').pathname;
  const parts = pathname.split('/').filter(Boolean); // ['share', token, sub?, kind?]
  const token = decodeURIComponent(parts[1] ?? '');
  if (!token) return sendJson(res, 404, { error: 'not found' });
  const meta = shareRequestMeta(req);
  if (req.method === 'GET' && parts.length === 2) {
    return writeShareResponse(res, getSharedView(cfg, token, meta));
  }
  if (req.method === 'GET' && parts[2] === 'model') {
    return writeShareResponse(res, getSharedModel(cfg, token, meta));
  }
  if (req.method === 'GET' && parts[2] === 'openapi') {
    return writeShareResponse(res, getSharedOpenApi(cfg, token, meta, specParam(req)));
  }
  if (req.method === 'GET' && parts[2] === 'download') {
    if (!parts[3]) return sendJson(res, 404, { error: 'not found' });
    return writeShareResponse(res, downloadSharedArtifact(cfg, token, decodeURIComponent(parts[3]), meta, specParam(req)));
  }
  sendJson(res, 404, { error: 'not found' });
}
