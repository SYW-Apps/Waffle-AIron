/**
 * The status report counts a tree's types per home and per type group, nested
 * groups under their parent with the subtree's total — so a shared contracts
 * library with hundreds of types and no component shows what it holds.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { saveSystemSpec, saveSpec, saveGroupSpec, saveTypeSpec, invalidateSpecCache } from '../../src/core/specs.js';
import { getStatusReport } from '../../src/core/status.js';

const now = '2026-01-01T00:00:00.000Z';
const group = (id: string, over: Record<string, unknown> = {}) => saveGroupSpec({ kind: 'group', id, name: id, createdAt: now, updatedAt: now, ...over } as any);
const put = (id: string, over: Record<string, unknown> = {}) => saveTypeSpec({ kind: 'value-object', id, name: id, description: 'd', fields: [], methods: [], createdAt: now, updatedAt: now, ...over } as any);

describe('status counts types per group', () => {
  let proj: string;
  beforeEach(() => {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-status-groups-'));
    fs.mkdirSync(path.join(proj, '.wai', 'specs'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.wai', 'project.yaml'), 'schemaVersion: 1.0.0\nname: contracts\ntargets: []\n');
    setProjectRoot(proj);
    saveSystemSpec({ schemaVersion: '1.0.0', name: 'contracts', vision: 'Shared contracts', boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now } as any);
  });
  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    fs.rmSync(proj, { recursive: true, force: true });
  });

  it('a component-less tree shows its shared types per group, nested, with the ungrouped ones on a line of their own', () => {
    group('platform');
    group('runtime', { parent: 'platform' });
    group('wire');
    put('loose-a');
    put('loose-b');
    put('wire-a', { group: 'wire' });
    put('runtime-a', { group: 'runtime' });
    put('runtime-b', { group: 'runtime' });
    put('platform-a', { group: 'platform' });

    const text = getStatusReport({}).text;
    expect(text).toContain('[Types] 6 types (shared)');
    expect(text).toMatch(/\[Group\] platform \(1 here, 3 in all types\)/);
    expect(text).toMatch(/\[Group\] runtime \(2 types\)/);
    expect(text).toMatch(/\[Group\] wire \(1 type\)/);
    expect(text).toMatch(/\(in no group\) 2 types/);
    // The nested group prints beneath its parent, indented deeper.
    const lines = text.split('\n');
    const at = (needle: string): number => lines.findIndex((l) => l.includes(needle));
    expect(at('[Group] runtime')).toBeGreaterThan(at('[Group] platform'));
    expect(lines[at('[Group] runtime')].indexOf('[Group]')).toBeGreaterThan(lines[at('[Group] platform')].indexOf('[Group]'));
  });

  it('a subsystem counts its own types apart from the shared ones', () => {
    saveSpec('subsystem', { id: 'billing', name: 'Billing', description: 'd', parentSystem: 'contracts', publicInterfaces: [], status: 'draft', createdAt: now, updatedAt: now } as any);
    group('invoices', { subsystem: 'billing' });
    put('invoice-line', { subsystem: 'billing', group: 'invoices' });
    put('plain-shared');
    const text = getStatusReport({}).text;
    expect(text).toContain('[Types] 1 type');
    expect(text).toContain('[Group] invoices (1 type)');
    expect(text).toContain('[Types] 1 type (shared)');
  });

  it('a tree with components and no groups prints no type counts (the report is unchanged)', () => {
    saveSpec('subsystem', { id: 'billing', name: 'Billing', description: 'd', parentSystem: 'contracts', publicInterfaces: [], status: 'draft', createdAt: now, updatedAt: now } as any);
    saveSpec('component', { id: 'billing-store', name: 'Store', description: 'd', subsystem: 'billing', componentType: 'Store', owns: [], dependsOn: [], status: 'draft', createdAt: now, updatedAt: now } as any);
    put('invoice', { subsystem: 'billing' });
    expect(getStatusReport({}).text).not.toContain('[Types]');
  });
});
