import type { IncomingMessage, ServerResponse } from 'http';
import { resolveSharedView, downloadArtifact } from './shareaccess.js';
import { swaggerUiPage } from './swagger.js';
import type { HostConfig, ShareLink, ShareRequestMeta } from './types.js';

// ---------------------------------------------------------------------------
// Share Portal (sdd_host): the PUBLIC, unauthenticated /share HTTP surface.
// Every response sets the hardening headers (Referrer-Policy: no-referrer,
// X-Robots-Tag: noindex, CSP frame-ancestors from the link's allowlist) and
// establishes NO session cookie. Routing is done in http.ts; these are the
// handlers.
// ---------------------------------------------------------------------------

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

/** GET /share/:token/openapi — a self-contained viewer page for the captured
 *  OpenAPI document (pretty-printed; a full Swagger UI bundle is a follow-up). */
export function serveSharedOpenApi(cfg: HostConfig, token: string, req: IncomingMessage, res: ServerResponse): void {
  const result = downloadArtifact(cfg, token, 'openapi', shareRequestMeta(req));
  if (!result.found || result.content === undefined) return notFoundPage(res);
  // Swagger UI inlines its own scripts + styles, so the frame-ancestors-only CSP
  // (no script-src) leaves them free to run.
  harden(res, undefined, 'text/html; charset=utf-8');
  res.statusCode = 200;
  res.end(swaggerUiPage(result.content, 'Shared API'));
}

/** GET /share/:token/download/:kind — a permitted artifact download. */
export function serveSharedDownload(
  cfg: HostConfig,
  token: string,
  kind: string,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const result = downloadArtifact(cfg, token, kind, shareRequestMeta(req));
  if (!result.found || result.content === undefined) {
    if (result.outcome === 'denied-download') {
      harden(res, undefined, 'text/plain');
      res.statusCode = 403;
      res.end('download not permitted');
      return;
    }
    return notFoundPage(res);
  }
  const ext = kind === 'html' ? 'html' : kind === 'openapi' ? 'openapi.json' : kind;
  harden(res, undefined, result.contentType ?? 'application/octet-stream');
  res.setHeader('content-disposition', `attachment; filename="shared-canvas.${ext}"`);
  res.statusCode = 200;
  res.end(result.content);
}
