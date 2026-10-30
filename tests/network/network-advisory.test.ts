import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { stripVTControlCharacters } from 'util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { runWithProjectBinding, setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { adviseNetwork, validateFamily, validateProject } from '../../src/core/validation.js';
import { runValidate } from '../../src/commands/validate.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { materializeFixtureProject } from '../rules-matrix/harness.js';
import { platformFamily } from '../helpers/network-family.js';

// ---------------------------------------------------------------------------
// A member validated on its own hears its family root's network findings,
// advisory. The member's verdict is the same with or without its family on
// disk: the findings are printed and counted beside the verdict, whatever
// their severity, and never decide the exit code, --ci or the MCP `valid`.
// Real projects on disk (the platform family: an `orders` member whose entry
// the root alone proves); nothing on the path under test is mocked.
// ---------------------------------------------------------------------------

const roots: string[] = [];
afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  vi.restoreAllMocks();
  for (const dir of roots.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* windows locks */ }
  }
});

function bind(dir: string): void {
  setProjectRoot(dir);
  invalidateSpecCache();
}

/** The platform family on disk; `ordersSeverity` tunes ENTRY_UNPROVEN in the orders member's own configuration (it owns the spec the finding sits on). */
function platform(ordersSeverity?: 'error' | 'warning' | 'notice'): { root: string; orders: string; billing: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-advisory-')));
  roots.push(root);
  materializeFixtureProject(root, platformFamily());
  const orders = path.join(root, 'services', 'orders');
  if (ordersSeverity) {
    const file = path.join(orders, '.wai', 'project.yaml');
    const doc = yaml.load(fs.readFileSync(file, 'utf8')) as Record<string, any>;
    doc.rules = { ...(doc.rules ?? {}), sddRuleSeverity: { ...(doc.rules?.sddRuleSeverity ?? {}), ENTRY_UNPROVEN: ordersSeverity } };
    fs.writeFileSync(file, yaml.dump(doc));
  }
  return { root, orders, billing: path.join(root, 'services', 'billing') };
}

/** Run `wairon validate` at `dir`, capturing what it prints and whether it exits non-zero. */
async function validateAt(dir: string, options: Parameters<typeof runValidate>[0] = {}): Promise<{ out: string; failed: boolean }> {
  bind(dir);
  const lines: string[] = [];
  const capture = (...args: unknown[]): void => { lines.push(args.map(String).join(' ')); };
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);
  vi.spyOn(console, 'error').mockImplementation(capture);
  let failed = false;
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { failed = (code ?? 0) !== 0; }) as never);
  await runValidate(options);
  vi.restoreAllMocks();
  return { out: stripVTControlCharacters(lines.join('\n')), failed };
}

/** The member copied away from its family: the same project with no root on disk. */
function aloneCopy(member: string): string {
  const alone = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-advisory-alone-')));
  roots.push(alone);
  fs.cpSync(member, alone, { recursive: true });
  return alone;
}

const HEADING = 'Network proofs, judged at the family root (advisory: the root gates)';

describe('family_validator.adviseNetwork', () => {
  it('lists the root\'s network findings on a member judged alone, each advisory at the severity the root gives it, keyed to the bound root', () => {
    const f = platform();
    bind(f.orders);
    const own = validateProject({ memberDepth: 0 } as never);
    invalidateSpecCache();
    const advised = adviseNetwork({ memberDepth: 0 }, own.issues);
    const unproven = advised.filter((i) => i.code === 'ENTRY_UNPROVEN');
    expect(unproven).toHaveLength(1);
    expect(unproven[0]).toMatchObject({ severity: 'warning', advisory: true, project: '' });
    expect(unproven[0].specId).toBe('orders_api');
    expect(advised.every((i) => i.advisory === true)).toBe(true);
  });

  it('keeps an error the root gives (tuned by the owning project) as an error, still advisory', () => {
    const f = platform('error');
    bind(f.orders);
    const advised = adviseNetwork({ memberDepth: 0 });
    expect(advised.find((i) => i.code === 'ENTRY_UNPROVEN')).toMatchObject({ severity: 'error', advisory: true });
  });

  it('does not repeat a finding the member\'s own gate carried', () => {
    const f = platform();
    bind(f.orders);
    const first = adviseNetwork({ memberDepth: 0 });
    expect(first.length).toBeGreaterThan(0);
    invalidateSpecCache();
    expect(adviseNetwork({ memberDepth: 0 }, first.map(({ advisory: _a, ...rest }) => rest))).toEqual([]);
  });

  it('answers nothing at the family root, at a member with nothing of the root\'s to say, and where no chaining parent is in reach', () => {
    const f = platform();
    bind(f.root);
    expect(adviseNetwork({ memberDepth: 0 })).toEqual([]);
    bind(f.billing);
    expect(adviseNetwork({ memberDepth: 0 })).toEqual([]);
    // The root is on disk but outside the request's reach: no walk to it.
    bind(f.orders);
    const narrowed = runWithProjectBinding(f.orders, { topRoot: f.orders, parentReach: false }, () => adviseNetwork({ memberDepth: 0 }));
    expect(narrowed).toEqual([]);
    // The member copied away from its family: no root at all.
    const alone = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-advisory-alone-')));
    roots.push(alone);
    fs.cpSync(f.orders, alone, { recursive: true });
    bind(alone);
    expect(adviseNetwork({ memberDepth: 0 })).toEqual([]);
  });

  it('answers nothing for a hosted request: the credential\'s reach is the grant, and this read never widens it', () => {
    const f = platform();
    bind(f.orders);
    const hosted = runWithProjectBinding(f.orders, { topRoot: f.root, parentReach: true, hostedLookup: () => null }, () => adviseNetwork({ memberDepth: 0 }));
    expect(hosted).toEqual([]);
    // The same binding without the lookup does reach the root.
    const local = runWithProjectBinding(f.orders, { topRoot: f.root, parentReach: true }, () => adviseNetwork({ memberDepth: 0 }));
    expect(local.some((i) => i.code === 'ENTRY_UNPROVEN')).toBe(true);
  });
});

describe('wairon validate at a member run alone', () => {
  it('lists the root\'s findings in their own section, and the member line says they are the root\'s', async () => {
    const f = platform();
    const { out, failed } = await validateAt(f.orders, { recursive: false });
    expect(out).toContain(HEADING);
    expect(out).toMatch(/\[ENTRY_UNPROVEN\]/);
    expect(out).toContain('orders_api');
    expect(out).toMatch(/1 advisory finding\(s\)/);
    expect(out).toContain('its network proofs are judged at the family root');
    expect(out).toContain('The root\'s findings on this member are listed above, advisory');
    // The member's verdict is the one it has with no family on disk.
    expect(failed).toBe((await validateAt(aloneCopy(f.orders), { recursive: false })).failed);
  });

  it('never fails the exit code or --ci, whatever the severity: an advisory error changes nothing', async () => {
    const ordinary = platform();
    const tuned = platform('error');
    for (const ci of [false, true]) {
      const a = await validateAt(ordinary.orders, { recursive: false, ci });
      const b = await validateAt(tuned.orders, { recursive: false, ci });
      expect(a.out).toContain(HEADING);
      expect(b.out).toContain(HEADING);
      // The advisory error is printed as an error, and the verdict is the one without it.
      expect(b.out).toMatch(/\[ENTRY_UNPROVEN\]/);
      expect(b.failed).toBe(a.failed);
      expect(b.out.includes('Validation failed')).toBe(a.out.includes('Validation failed'));
    }
    // ... and the same verdict as the member copied away from its family.
    const withRoot = await validateAt(tuned.orders, { recursive: false });
    const without = await validateAt(aloneCopy(tuned.orders), { recursive: false });
    expect(withRoot.failed).toBe(without.failed);
    expect(withRoot.out.includes('Validation failed')).toBe(without.out.includes('Validation failed'));
  });

  it('prints only the member line when no family root lies in reach', async () => {
    const f = platform();
    const alone = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-advisory-alone-')));
    roots.push(alone);
    fs.cpSync(f.orders, alone, { recursive: true });
    const { out } = await validateAt(alone, { recursive: false });
    expect(out).not.toContain(HEADING);
    expect(out).not.toContain('listed above');
  });

  it('adds nothing to a family run: it already holds the enclosing family\'s findings as its own gate\'s', async () => {
    const f = platform();
    const { out } = await validateAt(f.orders, { family: true });
    expect(out).not.toContain(HEADING);
    expect(out).toMatch(/\[ENTRY_UNPROVEN\]/);
  });
});

describe('sdd_validate_tree at a member run alone', () => {
  async function connect(): Promise<Client> {
    const server = createMcpServer();
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    const client = new Client({ name: 'advisory-test', version: '0.0.1' });
    await client.connect(a);
    return client;
  }

  it('merges the root\'s findings marked advisory, and an advisory error never makes the tree invalid', async () => {
    for (const severity of [undefined, 'error'] as const) {
      const f = platform(severity);
      const client = await connect();
      try {
        bind(f.orders);
        const r = (await client.callTool({ name: 'sdd_validate_tree', arguments: { recursive: false } })).structuredContent as {
          valid: boolean; errors: { code: string; advisory?: boolean }[]; warnings: { code: string; advisory?: boolean }[]; hint?: string;
        };
        const found = [...r.errors, ...r.warnings].find((i) => i.code === 'ENTRY_UNPROVEN');
        expect(found).toMatchObject({ advisory: true });
        expect(r.errors.filter((e) => !e.advisory)).toEqual([]);
        expect(r.valid).toBe(true);
        expect(r.hint).toContain("The root's findings on this member are listed with the findings, advisory");
      } finally {
        await client.close();
      }
    }
  });

  it('lists none where the family root is absent, and none for a family run (which holds them as its gate)', async () => {
    const f = platform();
    const alone = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-advisory-alone-')));
    roots.push(alone);
    fs.cpSync(f.orders, alone, { recursive: true });
    const client = await connect();
    try {
      bind(alone);
      const r = (await client.callTool({ name: 'sdd_validate_tree', arguments: { recursive: false } })).structuredContent as { warnings: { code: string }[]; hint?: string };
      expect(r.warnings.some((w) => w.code === 'ENTRY_UNPROVEN')).toBe(false);
      expect(r.hint ?? '').not.toContain('listed with the findings');
      bind(f.orders);
      const fam = (await client.callTool({ name: 'sdd_validate_tree', arguments: { family: true } })).structuredContent as { warnings: { code: string; advisory?: boolean }[]; hint?: string };
      const unproven = fam.warnings.filter((w) => w.code === 'ENTRY_UNPROVEN');
      expect(unproven.length).toBeGreaterThan(0);
      expect(unproven.every((w) => !w.advisory)).toBe(true);
    } finally {
      await client.close();
    }
  });
});

describe('the family run takes the enclosing findings as a gate', () => {
  it('is unchanged: validateFamily at the member carries ENTRY_UNPROVEN as its own finding, not advisory', () => {
    const f = platform();
    bind(f.orders);
    const result = validateFamily({ family: true });
    const unproven = result.issues.find((i) => i.code === 'ENTRY_UNPROVEN');
    expect(unproven).toBeDefined();
    expect(unproven!.advisory).toBeUndefined();
  });
});
