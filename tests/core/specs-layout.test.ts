import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import {
  saveSubsystemSpec,
  saveComponentSpec,
  getComponentPath,
  invalidateSpecCache,
  saveGroupSpec,
  saveTypeSpec,
  getTypePath,
} from '../../src/core/specs.js';

const now = new Date().toISOString();

function sub() {
  return { id: 'billing', name: 'Billing', description: 'd', parentSystem: 'gk', publicInterfaces: [], status: 'draft' as const, createdAt: now, updatedAt: now };
}
function comp(over: Record<string, unknown>) {
  return { id: '', name: 'n', description: 'd', subsystem: 'billing', componentType: 'Store' as const, owns: [] as string[], dependsOn: [] as string[], status: 'draft' as const, createdAt: now, updatedAt: now, ...over };
}

describe('ownership-driven component layout', () => {
  let proj: string;
  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    if (proj) fs.rmSync(proj, { recursive: true, force: true });
  });

  it('nests owned members under their pattern and keeps interface-referenced blocks flat', () => {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-nest-'));
    fs.mkdirSync(path.join(proj, '.wai', 'specs'), { recursive: true });
    setProjectRoot(proj);

    saveSubsystemSpec(sub());
    // members + a shared adapter created FIRST (flat), then the owning repository
    saveComponentSpec(comp({ id: 'subscription-store', componentType: 'Store' }));
    saveComponentSpec(comp({ id: 'database-adapter', componentType: 'Adapter' }));
    saveComponentSpec(comp({
      id: 'subscription-repository',
      componentType: 'Repository',
      owns: ['subscription-store'],
      dependsOn: ['database-adapter'],
    }));

    // Owned member (owns) → nested under the repository.
    const storePath = getComponentPath('subscription-store').replace(/\\/g, '/');
    expect(storePath).toContain('billing/subscription-repository/subscription-store/.index.yaml');

    // Shared block (dependsOn / interface reference) → flat sibling, NOT nested.
    const adapterPath = getComponentPath('database-adapter').replace(/\\/g, '/');
    expect(adapterPath).toContain('billing/database-adapter/.index.yaml');
    expect(adapterPath).not.toContain('subscription-repository');
  });

  it('nests types under their group directory when a group is specified', () => {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-nest-group-'));
    fs.mkdirSync(path.join(proj, '.wai', 'specs'), { recursive: true });
    setProjectRoot(proj);

    saveSubsystemSpec(sub());
    saveGroupSpec({
      kind: 'group',
      id: 'billing::invoices',
      name: 'Invoices Group',
      description: 'Group for invoice types',
      createdAt: now,
      updatedAt: now,
    });

    saveTypeSpec({
      kind: 'entity',
      id: 'billing::invoice-event',
      name: 'Invoice Event',
      description: 'Test type',
      subsystem: 'billing',
      group: 'billing::invoices',
      fields: [],
      methods: [],
      createdAt: now,
      updatedAt: now,
    });

    const typePath = getTypePath('billing::invoice-event').replace(/\\/g, '/');
    expect(typePath).toContain('billing/types/invoices/invoice-event.yaml');
  });
});
