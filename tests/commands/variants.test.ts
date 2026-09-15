import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { listVariants } from '../../src/commands/variants.js';
import { setProjectRoot } from '../../src/utils/fs.js';

// ---------------------------------------------------------------------------
// `wairon variants list` prints the whole registry governing the project:
// wairon's built-in variants as well as the global and project ones.
// ---------------------------------------------------------------------------

const created: string[] = [];

afterEach(() => {
  setProjectRoot(null);
  delete process.env.WAIRON_VARIANTS_DIR;
  vi.restoreAllMocks();
  for (const dir of created.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* win file locks */ }
  }
});

describe('wairon variants list', () => {
  it('lists the built-in variants alongside the project ones', async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-variants-cmd-'));
    const globalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-variants-cmd-global-'));
    created.push(projectDir, globalDir);
    fs.mkdirSync(path.join(projectDir, '.wai', 'variants'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, '.wai', 'variants', 'publisher.yaml'),
      'id: publisher\nbase: Adapter\nguidance: Reuse the shared publisher.\n',
    );
    process.env.WAIRON_VARIANTS_DIR = globalDir;
    setProjectRoot(projectDir);

    const printed: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { printed.push(args.map(String).join(' ')); });
    await listVariants();
    const output = printed.join('\n');

    expect(output).toContain('Component variants (6)');
    for (const id of ['arbiter', 'projector', 'composer', 'codec', 'gateway', 'publisher']) {
      expect(output).toContain(`■ ${id}`);
    }
    expect(output).toContain('(a kind of Portal)');
  });
});
