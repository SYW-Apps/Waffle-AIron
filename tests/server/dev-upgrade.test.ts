import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { registerLocalDevProject } from '../../src/server/admin.js';
import { bootstrapInstance } from '../../src/server/instance-bootstrap.js';
import { startDevSession } from '../../src/server/web.js';
import { editorCommand, openSource, upgrade, upgradeNeed } from '../../src/server/dev-commands.js';
import type { DevCommandResult, DevCommands } from '../../src/server/dev-commands.js';
import { WAIRON_MAJOR } from '../../src/config/defaults.js';
import type { HostConfig } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// dev_cockpit_orchestrator (sdd_host): upgradeNeed, upgrade, openSource.
// ---------------------------------------------------------------------------

const stamp = (major: number): string =>
  `schemaVersion: 1.0.0\nid: oldfam\nwaironMajor: ${major}\nname: oldfam\ncreatedAt: '2026-01-01T00:00:00.000Z'\nupdatedAt: '2026-01-01T00:00:00.000Z'\n`;

describe('dev upgrade and open-source (sdd_host)', () => {
  let base: string;
  let root: string;
  let cfg: HostConfig;
  let session: string;
  let upgradeCalls: boolean[];
  const projectYaml = (): string => path.join(root, '.wai', 'project.yaml');

  const handed = (): DevCommands => {
    const no = async (): Promise<DevCommandResult> => ({ command: 'x', ok: true, output: [] });
    return {
      lock: no, generate: no, doctor: no, family: no, invocation: 'node /opt/wairon/cli.js',
      upgrade: async (report) => {
        upgradeCalls.push(report);
        if (!report) fs.writeFileSync(projectYaml(), stamp(WAIRON_MAJOR));
        return { command: 'upgrade', ok: true, output: ['\u001b[32mupgraded\u001b[39m'] };
      },
    };
  };

  const startAt = (major: number): void => {
    fs.mkdirSync(path.join(root, '.wai'), { recursive: true });
    fs.writeFileSync(projectYaml(), stamp(major));
    registerLocalDevProject(cfg, 'local', root);
    bootstrapInstance(cfg);
    session = startDevSession(cfg);
  };

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-devupgrade-'));
    root = path.join(base, 'proj');
    fs.mkdirSync(root, { recursive: true });
    cfg = {
      host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir: path.join(base, 'data'),
      authEnabled: false, devMode: true, devCommands: handed(),
    };
    upgradeCalls = [];
  });
  afterEach(() => {
    try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* windows file locks */ }
  });

  describe('upgradeNeed', () => {
    it('is null on a current tree', () => {
      startAt(WAIRON_MAJOR);
      expect(upgradeNeed(cfg, session)).toBeNull();
    });

    it('names the tree an older major wrote, with the running major and the command', () => {
      startAt(WAIRON_MAJOR - 1);
      const need = upgradeNeed(cfg, session);
      expect(need).not.toBeNull();
      expect(need!.trees).toEqual([{ root: path.resolve(root), writtenMajor: WAIRON_MAJOR - 1 }]);
      expect(need!.runningMajor).toBe(WAIRON_MAJOR);
      expect(typeof need!.uncommitted).toBe('boolean');
      expect(need!.command).toBe('node /opt/wairon/cli.js upgrade');
    });

    it('is refused outside the development server', () => {
      startAt(WAIRON_MAJOR - 1);
      expect(() => upgradeNeed({ ...cfg, devMode: false }, session)).toThrow(/development server/);
    });
  });

  describe('upgrade', () => {
    it('a report writes nothing and registers nothing again', async () => {
      startAt(WAIRON_MAJOR - 1);
      const out = await upgrade(cfg, session, true);
      expect(out.ok).toBe(true);
      expect(upgradeCalls).toEqual([true]);
      expect(upgradeNeed(cfg, session)).not.toBeNull();
    });

    it('applies, strips colour codes, registers the family again and the need then answers null', async () => {
      startAt(WAIRON_MAJOR - 1);
      const out = await upgrade(cfg, session, false);
      expect(out).toEqual({ command: 'upgrade', ok: true, output: ['upgraded'] });
      expect(upgradeCalls).toEqual([false]);
      expect(upgradeNeed(cfg, session)).toBeNull();
    });

    it('a thrown error is a failed result', async () => {
      startAt(WAIRON_MAJOR - 1);
      cfg.devCommands = { ...handed(), upgrade: async () => { throw new Error('boom'); } };
      expect(await upgrade(cfg, session, false)).toEqual({ command: 'upgrade', ok: false, output: ['boom'] });
    });

    it('is refused when nothing is behind, without handed commands, or outside dev', async () => {
      startAt(WAIRON_MAJOR);
      await expect(upgrade(cfg, session, false)).rejects.toThrow(/running major/);
      startAt(WAIRON_MAJOR - 1);
      await expect(upgrade({ ...cfg, devCommands: undefined }, session, false)).rejects.toThrow(/cannot run/);
      await expect(upgrade({ ...cfg, devMode: false }, session, false)).rejects.toThrow(/cannot run/);
    });
  });

  describe('openSource', () => {
    beforeEach(() => {
      startAt(WAIRON_MAJOR);
      fs.mkdirSync(path.join(root, 'src'), { recursive: true });
      fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'x');
      fs.writeFileSync(path.join(base, 'outside.ts'), 'x');
    });

    it('refuses an escaping path, an absolute path, a directory and a missing file', async () => {
      expect((await openSource(cfg, session, '../outside.ts')).opened).toBe(false);
      expect((await openSource(cfg, session, path.join(root, 'src', 'a.ts'))).opened).toBe(false);
      expect((await openSource(cfg, session, 'src')).opened).toBe(false);
      const missing = await openSource(cfg, session, 'src/nope.ts');
      expect(missing.opened).toBe(false);
      expect(missing.reason).toBeTruthy();
    });

    it('is refused outside the development server', async () => {
      await expect(openSource({ ...cfg, devMode: false }, session, 'src/a.ts')).rejects.toThrow(/development server/);
    });

    it('answers no editor found when the editor program is not there', async () => {
      const saved = process.env.WAIRON_EDITOR;
      process.env.WAIRON_EDITOR = 'wairon-no-such-editor-program';
      try {
        const out = await openSource(cfg, session, 'src/a.ts', 3);
        expect(out).toEqual({ opened: false, reason: 'no editor was found: set WAIRON_EDITOR to your editor command' });
      } finally {
        if (saved === undefined) delete process.env.WAIRON_EDITOR; else process.env.WAIRON_EDITOR = saved;
      }
    });
  });

  describe('editorCommand', () => {
    it('splits WAIRON_EDITOR on whitespace', () => {
      expect(editorCommand({ WAIRON_EDITOR: 'subl  --goto' }, 'linux')).toEqual(['subl', '--goto']);
    });
    it('defaults to code -g, as code.cmd on Windows', () => {
      expect(editorCommand({}, 'linux')).toEqual(['code', '-g']);
      expect(editorCommand({ WAIRON_EDITOR: '  ' }, 'win32')).toEqual(['code.cmd', '-g']);
    });
  });
});
