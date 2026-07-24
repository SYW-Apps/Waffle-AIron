import type { IncomingMessage, ServerResponse } from 'http';
import { resolveSharedView, downloadArtifact } from './shareaccess.js';
import { swaggerUiPage } from './swagger.js';
import { safeFilenamePart } from '../utils/filenames.js';
import type { HostConfig, ShareLink, ShareRequestMeta } from './types.js';

// ---------------------------------------------------------------------------
// Share Portal (sdd_host): the PUBLIC, unauthenticated /share HTTP surface.
// Every response sets the hardening headers (Referrer-Policy: no-referrer,
// X-Robots-Tag: noindex, CSP frame-ancestors from the link's allowlist) and
// establishes NO session cookie. Routing is done in http.ts; these are the
// handlers.
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

/** Neither a portalId nor a request's artifact kind is filename-safe by
/** The attachment name for a served artifact. A SELECTED per-portal API carries
 *  its portal id so several downloads never collide, and the multi-API index is
 *  named for what it is rather than posing as one of the documents. */
function downloadFilename(kind: string, portalId: string | undefined, payload: string): string {
  if (kind !== 'openapi') return `shared-canvas.${safeFilenamePart(kind)}`;
  if (portalId) return `shared-canvas.${safeFilenamePart(portalId)}.openapi.json`;
  return asOpenApiIndex(payload) ? 'shared-canvas.openapi.index.json' : 'shared-canvas.openapi.json';
}

/** Extract the request context recorded on every access. */
export function shareRequestMeta(req: IncomingMessage): ShareRequestMeta {
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

/** Common hardening headers for every /share response. The embedding allowlist
 *  drives frame-ancestors: an empty allowlist forbids framing entirely. */
function harden(res: ServerResponse, link: ShareLink | undefined, contentType: string): void {
  const frameAncestors = link && link.frameAncestors.length ? link.frameAncestors.join(' ') : "'none'";
  res.setHeader('content-type', contentType);
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-robots-tag', 'noindex, nofollow');
  res.setHeader('content-security-policy', `frame-ancestors ${frameAncestors}`);
  res.setHeader('cache-control', 'no-store');
}

function notFoundPage(res: ServerResponse): void {
  harden(res, undefined, 'text/html; charset=utf-8');
  res.statusCode = 404;
  res.end(
    '<!doctype html><meta charset="utf-8"><title>Share unavailable</title>' +
      '<body style="font:15px/1.5 system-ui;margin:0;display:grid;place-items:center;height:100vh;background:#0b1120;color:#e8e8f0">' +
      '<div style="text-align:center"><h1 style="font-size:20px">This share link is unavailable</h1>' +
      '<p style="color:#9a9aab">It may have been disabled, expired, or never existed.</p></div></body>',
  );
}

/** GET /share/:token — the read-only shared-view page (the captured self-contained
 *  canvas HTML). */
export function serveSharedView(cfg: HostConfig, token: string, req: IncomingMessage, res: ServerResponse): void {
  const result = resolveSharedView(cfg, token, shareRequestMeta(req));
  if (!result.found || !result.link || result.html === undefined) return notFoundPage(res);
  harden(res, result.link, 'text/html; charset=utf-8');
  res.statusCode = 200;
  res.end(result.html);
}

/** GET /share/:token/model — the snapshot canvas model JSON + download flags. */
export function serveSharedModel(cfg: HostConfig, token: string, req: IncomingMessage, res: ServerResponse): void {
  const result = resolveSharedView(cfg, token, shareRequestMeta(req));
  if (!result.found || !result.link) {
    harden(res, undefined, 'application/json');
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found', outcome: result.outcome }));
    return;
  }
  harden(res, result.link, 'application/json');
  res.statusCode = 200;
  res.end(
    JSON.stringify({
      model: result.model ? JSON.parse(result.model) : null,
      allowDownloadHtml: result.allowDownloadHtml,
      allowDownloadOpenapi: result.allowDownloadOpenapi,
    }),
  );
}

/** GET /share/:token/openapi[?spec=<portalId>] — a self-contained viewer page for
 *  a captured OpenAPI document. `spec` selects WHICH per-portal API to view; with
 *  several captured and no `spec` the orchestrator hands back the index, which is
 *  rendered as a link list rather than merged into one viewer; with exactly one
 *  that API opens directly. An unknown `spec` is refused (404), not substituted. */
export function serveSharedOpenApi(cfg: HostConfig, token: string, req: IncomingMessage, res: ServerResponse): void {
  const result = downloadArtifact(cfg, token, 'openapi', shareRequestMeta(req), specParam(req));
  if (!result.found || result.content === undefined) return notFoundPage(res);
  const index = asOpenApiIndex(result.content);
  // Swagger UI inlines its own scripts + styles, so the frame-ancestors-only CSP
  // (no script-src) leaves them free to run.
  harden(res, undefined, 'text/html; charset=utf-8');
  res.statusCode = 200;
  res.end(index ? sharedOpenApiIndexPage(index) : swaggerUiPage(result.content, 'Shared API'));
}

/** GET /share/:token/download/:kind[?spec=<portalId>] — a permitted artifact
 *  download. For openapi, `spec` selects one per-portal document (its id lands in
 *  the filename so several downloads never collide); omitted with several
 *  captured specs downloads the index listing them. */
export function serveSharedDownload(
  cfg: HostConfig,
  token: string,
  kind: string,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const portalId = specParam(req);
  const result = downloadArtifact(cfg, token, kind, shareRequestMeta(req), portalId);
  if (!result.found || result.content === undefined) {
    if (result.outcome === 'denied-download') {
      harden(res, undefined, 'text/plain');
      res.statusCode = 403;
      res.end('download not permitted');
      return;
    }
    return notFoundPage(res);
  }
  harden(res, undefined, result.contentType ?? 'application/octet-stream');
  res.setHeader(
    'content-disposition',
    `attachment; filename="${downloadFilename(kind, portalId, result.content)}"`,
  );
  res.statusCode = 200;
  res.end(result.content);
}
