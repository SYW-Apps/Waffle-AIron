import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { setProjectRoot } from '../../src/utils/fs.js';
import { setSecret } from '../../src/utils/secrets.js';
import * as admin from '../../src/server/admin.js';
import { createPlacedProject } from '../server/helpers.js';
import type { HostConfig } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// The producers never ask anyone for a secret by name: whoever runs them
// resolves the token and hands it in.
//
//  - `wairon produce` hands in the token it obtained (--token, the environment
//    or a prompt) and no longer parks it in process.env for the producer to
//    find.
//  - the hosted admin plane resolves the target's token from its own secret
//    repository and passes it to the one call it authorizes.
// ---------------------------------------------------------------------------

const producerCalls: { target: string; diagramUrl: string; token: string }[] = [];

vi.mock('../../src/producers/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/producers/index.js')>();
  return {
    ...actual,
    configure: vi.fn(),
    produce: vi.fn(async (target: string, diagramUrl: string, token: string) => {
      producerCalls.push({ target, diagramUrl, token });
    }),
    list: vi.fn(() => [{ target: 'notion', parentPageId: 'page-1' }]),
  };
});

const savedEnv = { ...process.env };
const MASTER = 'master-credential-secret-value';
let base: string;

beforeEach(() => {
  producerCalls.length = 0;
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-token-injection-'));
});

afterEach(() => {
  process.env = { ...savedEnv };
  setProjectRoot(null);
  invalidateSpecCache();
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* win locks */ }
});

describe('`wairon produce` hands the token in', () => {
  it('passes --token straight to the producer and leaves the environment untouched', async () => {
    delete process.env.WAIRON_NOTION_TOKEN;
    setProjectRoot(process.cwd()); // an initialized project; configure/produce are stubbed
    const { runProduce } = await import('../../src/commands/produce.js');

    await runProduce('notion', { page: 'page-1', token: 'cli_token' });

    expect(producerCalls).toEqual([{ target: 'notion', diagramUrl: '', token: 'cli_token' }]);
    expect(process.env.WAIRON_NOTION_TOKEN).toBeUndefined();
  });

  it('passes the environment token it read, without writing anything back', async () => {
    process.env.WAIRON_MIRO_TOKEN = 'env_token';
    setProjectRoot(process.cwd());
    const { runProduce } = await import('../../src/commands/produce.js');

    await runProduce('miro', { page: 'board-1' });

    expect(producerCalls).toEqual([{ target: 'miro', diagramUrl: '', token: 'env_token' }]);
  });
});

describe('the hosted admin plane resolves the token and hands it in', () => {
  function hosted(): HostConfig {
    const dataDir = path.join(base, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    process.env.WAIRON_ADMIN_TOKEN = MASTER;
    process.env.WAIRON_DATA_DIR = dataDir;
    delete process.env.WAIRON_NOTION_TOKEN;
    const cfg: HostConfig = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true };
    createPlacedProject(cfg, MASTER, 'demo');
    return cfg;
  }

  it('reads the target token from its own secret repository and passes it to the producer', async () => {
    const cfg = hosted();
    setSecret('notion-token', 'host_stored_token');

    await admin.produceProducer(cfg, MASTER, 'demo', 'notion');

    expect(producerCalls).toHaveLength(1);
    expect(producerCalls[0].target).toBe('notion');
    expect(producerCalls[0].token).toBe('host_stored_token');
  });

  it('refuses a configured target with no stored token before the producer runs', async () => {
    const cfg = hosted();

    await expect(admin.produceProducer(cfg, MASTER, 'demo', 'notion')).rejects.toThrow(/^No Notion token/);
    expect(producerCalls).toHaveLength(0);
  });
});
