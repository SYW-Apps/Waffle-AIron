import type { IncomingMessage, ServerResponse } from 'http';

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

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
