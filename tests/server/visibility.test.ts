import { describe, it, expect } from 'vitest';
import { resolveVisibility, isVisible, audienceDistance, audienceCovers } from '../../src/server/visibility.js';
import type { OrganizationUnitRecord, ProjectPlacement } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// visibility_specialist (Phase 7 Stage 2) — pure unit-graph resolution.
//
// Fixture org:
//   acme (tenant root)
//     it (department)
//       web  (team)        ← observer project "p-web" placed here
//       core (team)        ← "p-core" placed here
//         vault (group, closed, exposeTo: [core])   ← "p-secret" placed here
//     mkt (department)     ← "p-mkt" placed here
//   globex (tenant root)   ← "p-globex" placed here
//     labs (department, exposeTo: [it])  ← "p-labs" placed here
// ---------------------------------------------------------------------------

const subject = { kind: 'user', id: 'u1' } as never;
const unit = (id: string, parentId?: string, over: Partial<OrganizationUnitRecord> = {}): OrganizationUnitRecord => ({
  id, name: id, kind: 'group', parentId, status: 'active', createdAt: '', createdBy: subject, ...over,
});
const place = (projectId: string, unitId: string): ProjectPlacement => ({
  id: `${projectId}@${unitId}`, projectId, unitId, role: 'owner', createdAt: '', createdBy: subject,
});

const units: OrganizationUnitRecord[] = [
  unit('acme'),
  unit('it', 'acme'),
  unit('web', 'it'),
  unit('core', 'it'),
  unit('vault', 'core', { visibility: 'closed', exposeTo: ['core'] }),
  unit('mkt', 'acme'),
  unit('globex'),
  unit('labs', 'globex', { exposeTo: ['it'] }),
];
const placements: ProjectPlacement[] = [
  place('p-web', 'web'),
  place('p-core', 'core'),
  place('p-secret', 'vault'),
  place('p-mkt', 'mkt'),
  place('p-globex', 'globex'),
  place('p-labs', 'labs'),
];

describe('resolveVisibility (unit-graph semantics)', () => {
  const webView = resolveVisibility('p-web', units, placements);

  it('same tenant, other branch: visible at instance distance', () => {
    expect(audienceDistance(webView, 'p-core')).toBe('instance');
    expect(audienceDistance(webView, 'p-mkt')).toBe('instance');
  });

  it('a closed group hides its placements from everyone outside it, even same-tenant', () => {
    expect(isVisible(webView, 'p-secret')).toBe(false);
  });

  it('the closed group\'s exposeTo grant opens it exactly for the granted unit', () => {
    const coreView = resolveVisibility('p-core', units, placements);
    // core is granted via exposeTo: [core] — and vault lies on core's branch.
    expect(isVisible(coreView, 'p-secret')).toBe(true);
    expect(audienceDistance(coreView, 'p-secret')).toBe('department');
  });

  it('cross-tenant is closed by default; an exposeTo grant opens it at partner distance', () => {
    // globex root has no grant toward acme → invisible.
    expect(isVisible(webView, 'p-globex')).toBe(false);
    // labs exposes to it (an acme unit): p-web (member of web < it) sees p-labs.
    expect(audienceDistance(webView, 'p-labs')).toBe('partner');
    // The reverse direction has no grant: p-globex sees nothing of acme.
    const globexView = resolveVisibility('p-globex', units, placements);
    expect(globexView.visibleProjects.filter(v => v.projectId.startsWith('p-') && v.distance !== 'partner')
      .every(v => ['p-labs'].includes(v.projectId))).toBe(true);
    expect(isVisible(globexView, 'p-web')).toBe(false);
    expect(isVisible(globexView, 'p-secret')).toBe(false);
  });

  it('same branch is department distance; an unplaced observer sees nothing', () => {
    const coreView = resolveVisibility('p-core', units, placements);
    expect(audienceDistance(coreView, 'p-web')).toBe('instance'); // sibling team = other branch
    const orphanView = resolveVisibility('p-orphan', units, placements);
    expect(orphanView.visibleProjects).toEqual([]);
  });
});

describe('audienceCovers (ceiling ∩ distance)', () => {
  it('intersects entry ceilings with observer distances', () => {
    expect(audienceCovers('department', 'department')).toBe(true);
    expect(audienceCovers('department', 'instance')).toBe(false);
    expect(audienceCovers('instance', 'instance')).toBe(true);
    expect(audienceCovers('instance', 'partner')).toBe(false);
    expect(audienceCovers('partner', 'partner')).toBe(true);
    expect(audienceCovers('external', 'partner')).toBe(true);
  });

  it('legacy "public" aliases external; missing audience defaults to instance; null distance requires external', () => {
    expect(audienceCovers('public', null)).toBe(true);
    expect(audienceCovers('external', null)).toBe(true);
    expect(audienceCovers(undefined, 'instance')).toBe(true);
    expect(audienceCovers(undefined, 'partner')).toBe(false);
    expect(audienceCovers('instance', null)).toBe(false);
  });
});
