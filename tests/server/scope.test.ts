import { describe, it, expect } from 'vitest';
import { resolveScope, permits } from '../../src/server/scope.js';
import type { OrganizationUnitRecord, ProjectGrant, ProjectPlacement } from '../../src/server/types.js';

const now = '2026-07-10T00:00:00Z';
const sub = { userId: 'admin', kind: 'human', issuer: 'local' };

function unit(id: string, parentId?: string): OrganizationUnitRecord {
  return { id, name: id, kind: 'team', parentId, status: 'active', createdAt: now, createdBy: sub };
}
function placement(projectId: string, unitId: string): ProjectPlacement {
  return { id: `${projectId}@${unitId}`, projectId, unitId, role: 'owner', createdAt: now, createdBy: sub };
}

// A small org: acme(root) → eng → { web, mobile }; sales.
const units = [unit('acme'), unit('eng', 'acme'), unit('web', 'eng'), unit('mobile', 'eng'), unit('sales', 'acme')];
const placements = [
  placement('p-web', 'web'),
  placement('p-mobile', 'mobile'),
  placement('p-eng-shared', 'eng'),
  placement('p-sales', 'sales'),
];

describe('resolveScope', () => {
  it('a "*" grant carrying the permission → super-admin (all=true)', () => {
    const grants: ProjectGrant[] = [{ projectId: '*', permissions: ['*'] }];
    const s = resolveScope(grants, 'audit:read', units, placements);
    expect(s.all).toBe(true);
  });

  it('a "*" grant NOT carrying the permission → not super-admin', () => {
    const grants: ProjectGrant[] = [{ projectId: '*', permissions: ['mcp:read'] }];
    const s = resolveScope(grants, 'audit:read', units, placements);
    expect(s.all).toBe(false);
    expect(s.projectIds).toEqual([]);
  });

  it('a unit-scoped grant covers the recursive subtree of projects and units', () => {
    // Scoped to eng → covers web + mobile + eng itself (descendants), not sales.
    const grants: ProjectGrant[] = [{ projectId: '', orgUnitId: 'eng', permissions: ['audit:read'] }];
    const s = resolveScope(grants, 'audit:read', units, placements);
    expect(s.all).toBe(false);
    expect(new Set(s.projectIds)).toEqual(new Set(['p-web', 'p-mobile', 'p-eng-shared']));
    expect(new Set(s.unitIds)).toEqual(new Set(['eng', 'web', 'mobile']));
    expect(s.projectIds).not.toContain('p-sales');
  });

  it('a root-unit grant covers everything under the root (tenant owner)', () => {
    const grants: ProjectGrant[] = [{ projectId: '', orgUnitId: 'acme', permissions: ['audit:read'] }];
    const s = resolveScope(grants, 'audit:read', units, placements);
    expect(new Set(s.projectIds)).toEqual(new Set(['p-web', 'p-mobile', 'p-eng-shared', 'p-sales']));
  });

  it('a leaf-unit grant covers only that unit (team lead)', () => {
    const grants: ProjectGrant[] = [{ projectId: '', orgUnitId: 'web', permissions: ['audit:read'] }];
    const s = resolveScope(grants, 'audit:read', units, placements);
    expect(s.projectIds).toEqual(['p-web']);
    expect(s.unitIds).toEqual(['web']);
  });

  it('a specific-project grant adds just that project', () => {
    const grants: ProjectGrant[] = [{ projectId: 'p-sales', permissions: ['audit:read'] }];
    const s = resolveScope(grants, 'audit:read', units, placements);
    expect(s.projectIds).toEqual(['p-sales']);
  });

  it('unions and dedups across multiple grants, honoring the wildcard permission', () => {
    const grants: ProjectGrant[] = [
      { projectId: '', orgUnitId: 'web', permissions: ['*'] }, // wildcard carries audit:read
      { projectId: 'p-sales', permissions: ['audit:read'] },
      { projectId: 'p-web', permissions: ['audit:read'] }, // dup of the web-unit project
    ];
    const s = resolveScope(grants, 'audit:read', units, placements);
    expect(new Set(s.projectIds)).toEqual(new Set(['p-web', 'p-sales']));
  });

  it('grants not carrying the permission contribute nothing', () => {
    const grants: ProjectGrant[] = [{ projectId: '', orgUnitId: 'eng', permissions: ['mcp:read'] }];
    const s = resolveScope(grants, 'audit:read', units, placements);
    expect(s.projectIds).toEqual([]);
    expect(s.unitIds).toEqual([]);
  });
});

describe('permits', () => {
  it('super-admin permits any project', () => {
    expect(permits({ all: true, projectIds: [], unitIds: [] }, 'anything')).toBe(true);
  });
  it('scoped permits only in-scope projects', () => {
    const s = { all: false, projectIds: ['p-web'], unitIds: ['web'] };
    expect(permits(s, 'p-web')).toBe(true);
    expect(permits(s, 'p-sales')).toBe(false);
  });
});
