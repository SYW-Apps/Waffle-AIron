import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { routeData } from '../../src/server/http.js';
import { registerLocalDevProject } from '../../src/server/admin.js';
import { bootstrapInstance } from '../../src/server/instance-bootstrap.js';
import { startDevSession } from '../../src/server/web.js';
import { approval, decide, reviews, run } from '../../src/server/dev-commands.js';
import type { DevCommandResult, DevCommands } from '../../src/server/dev-commands.js';
import { runWithProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache, saveSystemSpec, saveSpec, saveComponentSpec } from '../../src/core/specs.js';
import { captureApprovedSpecs } from '../../src/core/approval.js';
import { writeLockRecord } from '../../src/core/lockfile.js';
import type { LockRecord } from '../../src/core/lockfile.js';
import { computeGateStateId } from '../../src/core/validation.js';
import { requestReview } from '../../src/core/index.js';
import { channelsForWebMutation } from '../../src/server/realtime.js';
import type { HostConfig } from '../../src/server/types.js';
import type { SubsystemSpec, ComponentSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// dev_cockpit_orchestrator + the dev routes (sdd_host): reviews, the human's
// decision, and the commands the CLI hands the server. Local development server
// only.
// ---------------------------------------------------------------------------

const now = '2026-09-11T10:00:00Z';

function makeProject(root: string): void {
  fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(root, '.wai', 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0', name: 'cockpit-sys', projectType: 'backend',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {}, createdAt: now, updatedAt: now,
  }));
  runWithProjectRoot(root, () => {
    saveSystemSpec({
      schemaVersion: '1.0.0', name: 'cockpit-sys', vision: 'a cockpit fixture',
      boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now,
    });
    saveSpec('subsystem', {
      id: 'dom', name: 'dom', description: 'the domain', parentSystem: 'cockpit-sys',
      publicInterfaces: [], trustedLinks: [], status: 'draft', createdAt: now, updatedAt: now,
    } as SubsystemSpec);
    saveComponentSpec({
      id: 'worker', name: 'Worker', description: 'a worker component', subsystem: 'dom',
      componentType: 'Orchestrator', dependsOn: [], owns: [], status: 'draft', createdAt: now, updatedAt: now,
    } as ComponentSpec);
  });
  invalidateSpecCache();
}

/** What a successful CLI lock leaves behind: a lock record covering the design. */
function writeLock(root: string): void {
  runWithProjectRoot(root, () => {
    invalidateSpecCache();
    const record: LockRecord = {
      stateId: computeGateStateId(),
      lockedAt: '2026-09-12T08:00:00Z',
      lockedBy: { id: 'locker <l@example.com>', source: 'git' },
      validatorVersion: 'test',
      validationResult: { valid: true, errors: 0, warnings: 0 },
      status: 'ready',
      specs: captureApprovedSpecs(),
      specsReading: 'design',
      format: 3,
      children: {},
    };
    writeLockRecord(record);
  });
}

const ok = (command: string, output: string[] = []): DevCommandResult => ({ command, ok: true, output });

describe('dev cockpit (sdd_host)', () => {
  let dataDir: string;
  let root: string;
  let cfg: HostConfig;
  let session: string;
  let calls: { name: string; subsystem?: string | null }[];
  let lockImpl: (subsystem?: string | null) => Promise<DevCommandResult>;
  let gate: Promise<void> | null;

  const commands = (): DevCommands => ({
    lock: (s) => { calls.push({ name: 'lock', subsystem: s }); return lockImpl(s); },
    generate: async () => { calls.push({ name: 'generate' }); if (gate) await gate; return ok('generate', ['generated']); },
    doctor: async () => { calls.push({ name: 'doctor' }); return ok('doctor', ['\u001b[32mhealthy\u001b[39m']); },
  });

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-cockpit-data-'));
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-cockpit-proj-'));
    makeProject(root);
    cfg = {
      host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir,
      authEnabled: false, devMode: true, devCommands: commands(),
    };
    registerLocalDevProject(cfg, 'local', root);
    bootstrapInstance(cfg);
    session = startDevSession(cfg);
    calls = [];
    gate = null;
    lockImpl = async () => { writeLock(root); return ok('lock', ['Specs locked']); };
  });
  afterEach(() => {
    for (const d of [dataDir, root]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* windows file locks */ }
    }
  });

  const ask = (kind: string, subsystem?: string) =>
    runWithProjectRoot(root, () => requestReview(kind, 'please look', subsystem).request);

  describe('reviews', () => {
    it('lists the pending requests of the served project', () => {
      const r = ask('review');
      const listed = reviews(cfg, session);
      expect(listed.map((x) => x.id)).toEqual([r.id]);
    });

    it('is refused outside the local development server', () => {
      const hosted = { ...cfg, devMode: false };
      expect(() => reviews(hosted, session)).toThrow(/not the local development server/);
    });
  });

  describe('decide', () => {
    it('records a requested change with its comment and notes, running no command', async () => {
      const r = ask('review');
      const out = await decide(cfg, session, r.id, 'changes_requested', 'tighten this', [{ specId: 'worker', note: 'rename it' }]);
      expect(out.request.status).toBe('changes_requested');
      expect(out.request.decision?.comment).toBe('tighten this');
      expect(out.request.decision?.notes).toEqual([{ specId: 'worker', note: 'rename it' }]);
      expect(out.lock).toBeUndefined();
      expect(calls).toEqual([]);
    });

    it('approves a review request', async () => {
      const r = ask('review');
      const out = await decide(cfg, session, r.id, 'approved');
      expect(out.request.status).toBe('approved');
    });

    it('runs the CLI lock for a lock request and answers the request locked with the lock output', async () => {
      const r = ask('lock');
      const out = await decide(cfg, session, r.id, 'locked');
      expect(calls).toEqual([{ name: 'lock', subsystem: undefined }]);
      expect(out.lock).toEqual({ command: 'lock', ok: true, output: ['Specs locked'] });
      expect(out.request.status).toBe('locked');
    });

    it('keeps the comment and notes on a lock request the lock answered', async () => {
      const r = ask('lock');
      const out = await decide(cfg, session, r.id, 'locked', 'looks right', [{ specId: 'worker', note: 'nice split' }]);
      expect(out.request.status).toBe('locked');
      expect(out.request.decision?.comment).toBe('looks right');
      expect(out.request.decision?.notes).toEqual([{ specId: 'worker', note: 'nice split' }]);
    });

    it('hands the lock the request\'s subsystem', async () => {
      const r = ask('lock', 'dom');
      await decide(cfg, session, r.id, 'locked');
      expect(calls).toEqual([{ name: 'lock', subsystem: 'dom' }]);
    });

    it('leaves the request pending and answers the lock output when the lock failed', async () => {
      lockImpl = async () => ({ command: 'lock', ok: false, output: ['Cannot lock: 2 errors'] });
      const r = ask('lock');
      const out = await decide(cfg, session, r.id, 'locked');
      expect(out.lock).toEqual({ command: 'lock', ok: false, output: ['Cannot lock: 2 errors'] });
      expect(out.request.status).toBe('pending');
      expect(reviews(cfg, session).map((x) => x.id)).toEqual([r.id]);
    });

    it('turns a lock that throws into a failed result and keeps the request pending', async () => {
      lockImpl = async () => { throw new Error('boom'); };
      const r = ask('lock');
      const out = await decide(cfg, session, r.id, 'locked');
      expect(out.lock?.ok).toBe(false);
      expect(out.lock?.output).toEqual(['boom']);
      expect(out.request.status).toBe('pending');
    });

    it('refuses to lock a request that only asked for a review, before running anything', async () => {
      const r = ask('review');
      await expect(decide(cfg, session, r.id, 'locked')).rejects.toThrow(/asks for a review/);
      expect(calls).toEqual([]);
    });

    it('is refused without dev commands', async () => {
      const r = ask('review');
      const bare = { ...cfg, devCommands: undefined };
      await expect(decide(bare, session, r.id, 'approved')).rejects.toThrow(/not the local development server/);
    });
  });

  describe('run', () => {
    it('runs a handed command and answers its output with colour codes removed', async () => {
      const out = await run(cfg, session, 'doctor');
      expect(out).toEqual({ command: 'doctor', ok: true, output: ['healthy'] });
    });

    it('hands a lock the subsystem', async () => {
      await run(cfg, session, 'lock', 'dom');
      expect(calls).toEqual([{ name: 'lock', subsystem: 'dom' }]);
    });

    it('refuses an unknown command', async () => {
      await expect(run(cfg, session, 'rm-rf')).rejects.toThrow(/cannot run/);
    });

    it('refuses a second command while one runs, then runs again', async () => {
      let release!: () => void;
      gate = new Promise<void>((r) => { release = r; });
      const first = run(cfg, session, 'generate');
      await expect(run(cfg, session, 'doctor')).rejects.toThrow(/cannot run/);
      release();
      expect((await first).ok).toBe(true);
      expect((await run(cfg, session, 'doctor')).ok).toBe(true);
    });

    it('is refused outside the local development server and without handed commands', async () => {
      await expect(run({ ...cfg, devMode: false }, session, 'generate')).rejects.toThrow(/cannot run/);
      await expect(run({ ...cfg, devCommands: undefined }, session, 'generate')).rejects.toThrow(/cannot run/);
    });
  });

  describe('approval', () => {
    it('answers an unlocked project as not approved', () => {
      const state = approval(cfg, session);
      expect(state.approved).toBe(false);
      expect(state.approvedAt).toBeUndefined();
      expect(state.verdict.drifted).toBe(false);
    });

    it('answers who locked when, and the specs that moved since', () => {
      writeLock(root);
      const locked = approval(cfg, session);
      expect(locked.approved).toBe(true);
      expect(locked.approvedAt).toBe('2026-09-12T08:00:00Z');
      expect(locked.approvedBy).toContain('locker');
      expect(locked.verdict.drifted).toBe(false);
      runWithProjectRoot(root, () => {
        saveComponentSpec({
          id: 'worker', name: 'Worker', description: 'a worker component that changed', subsystem: 'dom',
          componentType: 'Orchestrator', dependsOn: [], owns: [], status: 'draft', createdAt: now, updatedAt: now,
        } as ComponentSpec);
      });
      invalidateSpecCache();
      const moved = approval(cfg, session);
      expect(moved.verdict.drifted).toBe(true);
      expect((moved.verdict.moved ?? []).some((m) => m.includes('worker'))).toBe(true);
    });

    it('is refused outside the local development server', () => {
      expect(() => approval({ ...cfg, devMode: false }, session)).toThrow(/not the local development server/);
    });
  });

  describe('routes', () => {
    let server: http.Server;
    let base: string;

    const startServer = async (c: HostConfig): Promise<void> => {
      server = http.createServer((req, res) => { void routeData(c, req, res); });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    };
    afterEach(async () => {
      if (server) await new Promise<void>((r) => server.close(() => r()));
    });

    const call = async (method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> => {
      const res = await fetch(base + p, {
        method,
        headers: { cookie: `wairon_session=${session}`, 'content-type': 'application/json', origin: base },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let json: any = null;
      try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: res.status, json };
    };

    it('serves the pending reviews, decides one and runs a command in dev mode', async () => {
      await startServer(cfg);
      const r = ask('review');

      const listed = await call('GET', '/web/dev/reviews');
      expect(listed.status).toBe(200);
      expect(listed.json.map((x: { id: string }) => x.id)).toEqual([r.id]);

      const decided = await call('POST', '/web/dev/reviews/decide', {
        id: r.id, outcome: 'changes_requested', comment: 'no', notes: [{ specId: 'worker', note: 'n' }],
      });
      expect(decided.status).toBe(200);
      expect(decided.json.request.status).toBe('changes_requested');
      expect(decided.json.request.decision.notes).toEqual([{ specId: 'worker', note: 'n' }]);

      const cmd = await call('POST', '/web/dev/commands', { command: 'generate' });
      expect(cmd.status).toBe(200);
      expect(cmd.json).toEqual({ command: 'generate', ok: true, output: ['generated'] });
    });

    it('serves the approval state in dev mode only', async () => {
      await startServer(cfg);
      const state = await call('GET', '/web/dev/approval');
      expect(state.status).toBe(200);
      expect(state.json.approved).toBe(false);
      expect(state.json.verdict).toBeDefined();
      server.close();
      await startServer({ ...cfg, devMode: false, devCommands: undefined, authEnabled: true });
      expect((await call('GET', '/web/dev/approval')).status).not.toBe(200);
    });

    it('locks through the decide route and answers the lock result', async () => {
      await startServer(cfg);
      const r = ask('lock', 'dom');
      const decided = await call('POST', '/web/dev/reviews/decide', { id: r.id, outcome: 'locked' });
      expect(decided.status).toBe(200);
      expect(decided.json.request.status).toBe('locked');
      expect(decided.json.lock.ok).toBe(true);
      expect(calls).toEqual([{ name: 'lock', subsystem: 'dom' }]);
    });

    it('does not mount the routes outside dev mode', async () => {
      const hosted: HostConfig = { ...cfg, devMode: false, devCommands: undefined, authEnabled: true };
      await startServer(hosted);
      const listed = await call('GET', '/web/dev/reviews');
      expect(listed.status).not.toBe(200);
      const cmd = await call('POST', '/web/dev/commands', { command: 'generate' });
      expect(cmd.status).not.toBe(200);
    });
  });

  it('nudges the reviews channel and the served project after a decision or command', () => {
    expect(channelsForWebMutation('/web/dev/reviews/decide', {})).toEqual(['reviews', 'project:local']);
    expect(channelsForWebMutation('/web/dev/commands', {})).toEqual(['project:local']);
  });
});
