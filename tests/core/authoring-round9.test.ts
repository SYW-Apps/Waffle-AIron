import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { saveSpec, invalidateSpecCache, loadSpec } from '../../src/core/specs.js';
import { deleteSpec, moveMethods, updateSpecGated } from '../../src/core/authoring.js';
import { renameMethod } from '../../src/core/provision.js';

// QA round 9: deleting an owned member releases it, a deletion says whether tests
// were searched, a linkage write says its code findings are not judged, and a
// method rename lists only `<component>.<method>` prose as a mention.

const now = '2026-11-25T00:00:00.000Z';
const projects: string[] = [];
afterEach(() => {
  for (const p of projects.splice(0)) fs.rmSync(p, { recursive: true, force: true });
  setProjectRoot(null);
  invalidateSpecCache();
});

function seed(): string {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-r9-authoring-'));
  projects.push(proj);
  fs.mkdirSync(path.join(proj, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.wai', 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0', name: 'r9', targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }], createdAt: now, updatedAt: now,
  }));
  setProjectRoot(proj);
  invalidateSpecCache();
  saveSpec('system', {
    schemaVersion: '1.0.0', name: 'Shortener', vision: 'Shortens links.',
    boundaries: [{ name: 'first', description: 'a' }], globalRequirements: ['one', 'two', 'three'], databases: [], createdAt: now, updatedAt: now,
  } as never);
  saveSpec('subsystem', {
    schemaVersion: '1.0.0', id: 'links', name: 'links', description: 'links subsystem', parentSystem: 'Shortener',
    publicInterfaces: [], trustedLinks: [], status: 'complete', createdAt: now, updatedAt: now,
  } as never);
  const component = (id: string, componentType: string, extra: Record<string, unknown> = {}): void => {
    saveSpec('component', {
      id, name: id, description: `${id} component`, subsystem: 'links', componentType, owns: [], dependsOn: [],
      status: 'complete', createdAt: now, updatedAt: now, ...extra,
    } as never);
  };
  component('link_store', 'Store', { durability: 'ram-projection' });
  component('link_repository', 'Repository', { owns: ['link_store'], description: 'find the file, then `link_repository.find` it' });
  saveSpec('interface', {
    id: 'ilink_repository', name: 'Repo', description: 'find the file for a code', component: 'link_repository',
    methods: [{ name: 'find', description: 'finds', params: [{ name: 'code', type: 'string' }], returns: 'string' }],
    status: 'draft', createdAt: now, updatedAt: now,
  } as never);
  saveSpec('implementation', {
    id: 'link_repository_impl', name: 'RepoImpl', description: 'repo impl', contract: 'ilink_repository', technologies: ['postgres'],
    methods: [{ name: 'find', narrative: [] }], status: 'draft', createdAt: now, updatedAt: now,
  } as never);
  invalidateSpecCache();
  return proj;
}

describe('deleteSpec releases an owned member and says whether tests were searched', () => {
  it('a dry run reports the owns entry it would drop, and refuses nothing', () => {
    seed();
    const plan = deleteSpec('component', 'link_store', true);
    expect(plan.references).toEqual([]);
    expect(plan.released).toEqual([{ kind: 'component', id: 'link_repository', position: 'owns', target: { kind: 'component', id: 'link_store' } }]);
    expect((loadSpec('component', 'link_repository') as { owns: string[] }).owns).toEqual(['link_store']);
  });

  it('deleting an owned member drops it from its owner', () => {
    seed();
    const deletion = deleteSpec('component', 'link_store');
    expect(deletion.deleted).toBe(true);
    expect(deletion.released?.map((r) => `${r.id}->${r.target.id}`)).toEqual(['link_repository->link_store']);
    invalidateSpecCache();
    expect(loadSpec('component', 'link_store')).toBeNull();
    expect((loadSpec('component', 'link_repository') as { owns: string[] }).owns).toEqual([]);
  });

  it('an owner owning other members keeps them; the release and the rehearsal agree', () => {
    seed();
    const base = { subsystem: 'links', dependsOn: [], status: 'complete', createdAt: now, updatedAt: now };
    saveSpec('component', { ...base, id: 'link_index', name: 'link_index', description: 'link_index component', componentType: 'Index', owns: [] } as never);
    const owner = loadSpec('component', 'link_repository') as Record<string, unknown>;
    saveSpec('component', { ...owner, owns: ['link_store', 'link_index'] } as never);
    invalidateSpecCache();
    const deletion = deleteSpec('component', 'link_store');
    expect(deletion.deleted).toBe(true);
    expect(deletion.findings ?? []).not.toEqual(expect.arrayContaining([expect.stringContaining('INVALID_OWNED_MEMBER')]));
    invalidateSpecCache();
    expect((loadSpec('component', 'link_repository') as { owns: string[] }).owns).toEqual(['link_index']);
  });

  it('testsSearched is false when the project declares no test roots, and absent when no contract, implementation or type went', () => {
    seed();
    expect(deleteSpec('interface', 'ilink_repository', true).testsSearched).toBe(false);
    expect(deleteSpec('component', 'link_store', true).testsSearched).toBeUndefined();
  });

  it('testsSearched is set for a contract with no method left', () => {
    seed();
    saveSpec('interface', {
      id: 'iempty', name: 'Empty', description: 'empty contract', component: 'link_store', methods: [],
      status: 'draft', createdAt: now, updatedAt: now,
    } as never);
    invalidateSpecCache();
    expect(deleteSpec('interface', 'iempty', true).testsSearched).toBe(false);
  });
});

describe('a method move names the code findings it does not judge', () => {
  it('carries the notice on the dry run and the move', () => {
    seed();
    const base = { subsystem: 'links', dependsOn: [], status: 'complete', createdAt: now, updatedAt: now };
    saveSpec('component', { ...base, id: 'link_lookup', name: 'link_lookup', description: 'resolves codes', componentType: 'Orchestrator', owns: [] } as never);
    saveSpec('interface', {
      id: 'ilink_lookup', name: 'Lookup', description: 'resolves codes', component: 'link_lookup',
      methods: [{ name: 'resolve', description: 'resolves', params: [{ name: 'code', type: 'string' }], returns: 'string' }],
      status: 'draft', createdAt: now, updatedAt: now,
    } as never);
    saveSpec('implementation', {
      id: 'link_lookup_impl', name: 'LookupImpl', description: 'lookup impl', contract: 'ilink_lookup',
      methods: [{ name: 'resolve', narrative: [] }], status: 'draft', createdAt: now, updatedAt: now,
    } as never);
    invalidateSpecCache();
    const unjudged = (notices: string[]): boolean => notices.some((n) => n.includes('UNREALIZED_METHOD') && n.includes('sdd_validate_tree'));
    const dry = moveMethods('link_repository', 'link_lookup', ['find'], true);
    expect(dry.refusals).toEqual([]);
    expect(unjudged(dry.notices)).toBe(true);
    const real = moveMethods('link_repository', 'link_lookup', ['find']);
    expect(real.moved).toBe(true);
    expect(unjudged(real.notices)).toBe(true);
  });
});

describe('updateSpecGated names the code findings a linkage write does not judge', () => {
  it('carries a notice for a sourcePath change, none for a prose change', () => {
    seed();
    const linked = updateSpecGated('implementation', 'link_repository_impl', { sourcePath: 'src/links/repository.ts' });
    expect(linked.notices.some((n) => /code linkage/.test(n) && /sdd_validate_tree/.test(n))).toBe(true);
    const prose = updateSpecGated('implementation', 'link_repository_impl', { description: 'another description' });
    expect(prose.notices.some((n) => /code linkage/.test(n))).toBe(false);
  });
});

describe('a method rename lists only the qualified prose as a mention', () => {
  it('"find the file" is not a mention of find; `link_repository.find` is', () => {
    seed();
    const dry = renameMethod('link_repository', 'find', 'lookup', undefined, true);
    // The component's description names `link_repository.find`; the contract's says only "find the file".
    expect(dry.mentions).toContain('link_repository');
    expect(dry.mentions).not.toContain('ilink_repository');
  });
});
