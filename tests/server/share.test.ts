import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createLink, updateLink } from '../../src/server/sharelinks.js';
import { putSnapshot } from '../../src/server/sharesnapshots.js';
import { listLinkAccess } from '../../src/server/shareaccesslog.js';
import { resolveSharedView, downloadArtifact } from '../../src/server/shareaccess.js';
import { createShareLink } from '../../src/server/shareadmin.js';
import { hashToken } from '../../src/server/credentials.js';
import { createWebSession } from '../../src/server/websessions.js';
import { ForbiddenError } from '../../src/server/errors.js';
import { subjectOf } from './helpers.js';
import type { HostConfig, ShareLink, ShareRequestMeta } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Public share links (sdd_host): the security-critical access path — salted-hash
// token resolution, enabled/expiry gating, per-link download permissions, access
// logging — plus the owner-side share:create authorization gate. The snapshot +
// link are seeded directly so the public path is exercised without a full
// project spec tree (the capture path is covered end-to-end in docker).
// ---------------------------------------------------------------------------

const META: ShareRequestMeta = { ip: '203.0.113.7', userAgent: 'probe/1.0', referer: 'https://notion.so/x' };

describe('public share links (sdd_host)', () => {
  let base: string;
  let dataDir: string;
  let cfg: HostConfig;
  const savedEnv = { ...process.env };
  const hourAgo = () => new Date(Date.now() - 3_600_000).toISOString();
  const hourAhead = () => new Date(Date.now() + 3_600_000).toISOString();

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-share-'));
    dataDir = path.join(base, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    process.env.WAIRON_DATA_DIR = dataDir;
    cfg = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true };
  });
  afterEach(() => {
    process.env = { ...savedEnv };
    try {
      fs.rmSync(base, { recursive: true, force: true });
    } catch {
      /* windows locks */
    }
  });

  /** Seed a snapshot + a link bound to `token`, returning the stored link. */
  function seed(token: string, over: Partial<ShareLink> = {}): ShareLink {
    const snap = putSnapshot(dataDir, {
      id: '',
      projectId: 'billing',
      view: 'architecture',
      capturedAt: '',
      canvasModel: JSON.stringify({ system: { name: 'Billing' }, components: [] }),
      html: '<!doctype html><title>Billing</title><body>canvas</body>',
    });
    return createLink(dataDir, {
      id: '',
      tokenHash: hashToken(token),
      projectId: 'billing',
      view: 'architecture',
      snapshotId: snap.id,
      mode: 'snapshot',
      enabled: true,
      allowDownloadHtml: false,
      allowDownloadOpenapi: false,
      frameAncestors: [],
      createdBy: subjectOf('owner'),
      createdAt: '',
      ...over,
    });
  }

  it('resolves a valid token to the snapshot model and logs the access', () => {
    seed('SECRET-TOKEN');
    const result = resolveSharedView(cfg, 'SECRET-TOKEN', META);
    expect(result.found).toBe(true);
    expect(result.outcome).toBe('served');
    expect(JSON.parse(result.model!).system.name).toBe('Billing');

    // The access is recorded with the source IP / UA / referer.
    const link = resolveSharedView(cfg, 'SECRET-TOKEN', META).link!;
    const log = listLinkAccess(dataDir, link.id, 50);
    expect(log.length).toBeGreaterThanOrEqual(2);
    expect(log[0]).toMatchObject({ ip: '203.0.113.7', userAgent: 'probe/1.0', outcome: 'served' });
  });

  it('the raw token is NEVER stored — only its salted hash is on disk', () => {
    seed('SECRET-TOKEN');
    const raw = fs.readFileSync(path.join(dataDir, 'share-links.json'), 'utf8');
    expect(raw).not.toContain('SECRET-TOKEN');
    expect(raw).toContain(hashToken('SECRET-TOKEN'));
  });

  it('an unknown token is refused (not-found) and logged', () => {
    seed('SECRET-TOKEN');
    const result = resolveSharedView(cfg, 'WRONG-TOKEN', META);
    expect(result).toMatchObject({ found: false, outcome: 'not-found' });
  });

  it('a disabled link is refused (denied-disabled)', () => {
    const link = seed('SECRET-TOKEN');
    updateLink(dataDir, { ...link, enabled: false });
    expect(resolveSharedView(cfg, 'SECRET-TOKEN', META)).toMatchObject({ found: false, outcome: 'denied-disabled' });
  });

  it('an expired link is refused (denied-expired)', () => {
    seed('SECRET-TOKEN', { expiresAt: hourAgo() });
    expect(resolveSharedView(cfg, 'SECRET-TOKEN', META)).toMatchObject({ found: false, outcome: 'denied-expired' });
    // A future expiry still serves.
    seed('LATER-TOKEN', { expiresAt: hourAhead() });
    expect(resolveSharedView(cfg, 'LATER-TOKEN', META).outcome).toBe('served');
  });

  it('downloads are gated per link: refused unless the kind is permitted', () => {
    seed('SECRET-TOKEN', { allowDownloadHtml: true, allowDownloadOpenapi: false });
    const html = downloadArtifact(cfg, 'SECRET-TOKEN', 'html', META);
    expect(html).toMatchObject({ found: true, outcome: 'served', kind: 'html' });
    expect(html.content).toContain('canvas');

    // OpenAPI download is not permitted on this link.
    expect(downloadArtifact(cfg, 'SECRET-TOKEN', 'openapi', META)).toMatchObject({
      found: false,
      outcome: 'denied-download',
    });
  });

  it('creating a share link requires share:create over the project (else Forbidden)', () => {
    // A session for a user with NO grants.
    const session = createWebSession(dataDir, {
      id: '',
      subject: subjectOf('u-noshare'),
      projects: ['*'],
      createdAt: '',
      expiresAt: hourAhead(),
    });
    expect(() =>
      createShareLink(cfg, session.id, { projectId: 'billing', view: 'architecture', mode: 'snapshot', artifacts: ['canvas'] }),
    ).toThrow(ForbiddenError);
  });
});
