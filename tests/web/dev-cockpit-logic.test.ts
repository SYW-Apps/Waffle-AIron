import { describe, it, expect } from 'vitest';
import {
  bannerState, barState, branchChipText, changeCount, changeMarks, groupMoved, inPlaceScope, lockBody, memberName, memberOfScope, membersToLock, movedKind, movedScope,
  offersLockInPlace, parseMoved, pendingReviews, specRoute, subsystemOfRoute, subsystemOfSpec,
  type DevApprovalData, type ScopeNode,
} from '../../web/src/views/devCockpitLogic.js';

const nodes: ScopeNode[] = [
  { id: 'a', kind: 'subsystem' },
  { id: 'b', kind: 'subsystem' },
  { id: 'a_comp', kind: 'component', parentId: 'a' },
  { id: 'a_iface', kind: 'interface', parentId: 'a_comp' },
  { id: 'b_comp', kind: 'component', parentId: 'b' },
];
const drifted = (moved: string[]): DevApprovalData => ({
  approved: true, approvedBy: 'Robbe', approvedAt: '2026-11-01T10:00:00Z', verdict: { text: 'x', drifted: true, moved },
});
const clean: DevApprovalData = { approved: true, verdict: { text: '', drifted: false } };

describe('dev cockpit action bar', () => {
  it('shows nothing for a locked, unmoved design', () => {
    expect(barState(clean, 0).show).toBe(false);
    expect(barState(undefined, 0).show).toBe(false);
  });
  it('offers Review for a pending request, ahead of Lock', () => {
    const s = barState(drifted(['~ .wai/specs/components/a_comp.yaml']), 2, 'lock');
    expect(s).toMatchObject({ show: true, action: 'review' });
    expect(s.line).toContain('2 pending');
  });
  it('offers Lock when the design moved and says who locked and what moved', () => {
    const s = barState(drifted(['~ .wai/specs/components/a_comp.yaml', '+ .wai/specs/types/t.yaml']), 0);
    expect(s).toMatchObject({ show: true, action: 'lock' });
    expect(s.line).toContain('by Robbe');
    expect(s.line).toContain('2 specs changed');
  });
  it('offers Lock when there is no lock at all', () => {
    expect(barState({ approved: false, verdict: { text: '', drifted: false } }, 0)).toMatchObject({ show: true, action: 'lock' });
  });
  it('offers Lock in place only while something is to approve', () => {
    expect(offersLockInPlace(clean)).toBe(false);
    expect(offersLockInPlace(drifted([]))).toBe(true);
    expect(offersLockInPlace({ approved: false, verdict: { text: '', drifted: false } })).toBe(true);
  });
});

describe('dev cockpit lock scoping', () => {
  it('parses moved entries and the new side of a relocation', () => {
    expect(parseMoved(['~ .wai/specs/components/a_comp.yaml', '+ .wai/specs/x/old.yaml -> .wai/specs/types/t.yaml'])).toEqual([
      { mark: '~', path: '.wai/specs/components/a_comp.yaml', folder: 'components', id: 'a_comp' },
      { mark: '+', path: '.wai/specs/types/t.yaml', folder: 'types', id: 't' },
    ]);
  });
  it('places a spec in its subsystem by walking parents', () => {
    expect(subsystemOfSpec('interface', 'a_iface', nodes)).toBe('a');
    expect(subsystemOfSpec('subsystem', 'b', nodes)).toBe('b');
    expect(subsystemOfSpec('type', 'unknown', nodes)).toBeUndefined();
  });
  it('scopes to one subsystem only when every moved spec is in it', () => {
    const one = movedScope(['~ .wai/specs/components/a_comp.yaml', '~ .wai/specs/interfaces/a_iface.yaml'], nodes);
    expect(one.subsystem).toBe('a');
    const two = movedScope(['~ .wai/specs/components/a_comp.yaml', '~ .wai/specs/components/b_comp.yaml'], nodes);
    expect(two.subsystem).toBeUndefined();
    expect(two.subsystems).toEqual(['a', 'b']);
    const unplaced = movedScope(['~ .wai/specs/components/a_comp.yaml', '~ .wai/specs/types/mystery.yaml'], nodes);
    expect(unplaced.subsystem).toBeUndefined();
  });
  it('locks the viewed subsystem in place only when it is the one that moved', () => {
    const scope = movedScope(['~ .wai/specs/components/a_comp.yaml'], nodes);
    expect(inPlaceScope('a', scope)).toBe('a');
    expect(inPlaceScope('b', scope)).toBeUndefined();
    expect(inPlaceScope(undefined, scope)).toBeUndefined();
  });
  it('finds the subsystem a canvas route is inside and builds the lock request body', () => {
    expect(subsystemOfRoute('sub/b/x', nodes)).toBe('b');
    expect(subsystemOfRoute('', nodes)).toBeUndefined();
    expect(lockBody('a')).toEqual({ command: 'lock', subsystem: 'a' });
    expect(lockBody(undefined)).toEqual({ command: 'lock' });
  });
});

describe('branch chip text', () => {
  it('shows the branch, else a short commit, else nothing', () => {
    expect(branchChipText({ branch: 'feat/x', commit: 'abcdef0123' })).toBe('feat/x');
    expect(branchChipText({ commit: 'abcdef0123' })).toBe('abcdef0');
    expect(branchChipText({})).toBeUndefined();
    expect(branchChipText(undefined)).toBeUndefined();
  });
});

describe('dev cockpit changes and member projects', () => {
  const member = (state: 'approved' | 'drifted' | 'never', extra = {}) => ({ key: 'svc', alias: 'svc', state, ...extra });
  const withMembers = (a: DevApprovalData, members: any[]): DevApprovalData => ({ ...a, members });
  const movedList = ['~ .wai/specs/components/a_comp.yaml', '~ .wai/specs/interfaces/a_iface.yaml', '+ .wai/specs/types/t.yaml', '- .wai/specs/components/gone.yaml'];

  it('lists the members that are owed a lock', () => {
    expect(membersToLock(withMembers(clean, [member('approved'), member('drifted'), { ...member('never'), key: 'x', alias: undefined, approvable: false }]))).toHaveLength(1);
    expect(membersToLock(undefined)).toEqual([]);
    expect(memberName({ key: 'k' })).toBe('k');
  });
  it('shows the bar for a drifted member of an approved design', () => {
    const s = barState(withMembers(clean, [member('drifted')]), 0);
    expect(s).toMatchObject({ show: true, action: 'lock' });
    expect(s.line).toContain('svc');
    expect(barState(withMembers(clean, [member('approved')]), 0).show).toBe(false);
  });
  it('shows no banner for an approved, unchanged design and one row when anything changed', () => {
    expect(bannerState(clean).show).toBe(false);
    expect(bannerState(withMembers(clean, [member('approved')])).show).toBe(false);
    expect(bannerState(undefined).show).toBe(false);
    const b = bannerState(drifted(movedList));
    expect(b).toMatchObject({ show: true, never: false, specs: 4 });
    expect(b.text).toBe('4 specs changed');
    const both = bannerState(withMembers(drifted(['~ .wai/specs/components/a_comp.yaml']), [member('drifted')]));
    expect(both.text).toBe('1 spec changed · member project svc changed');
    expect(bannerState(withMembers(clean, [member('drifted')])).text).toBe('Member project svc changed');
    expect(bannerState({ approved: false, verdict: { text: '', drifted: false } })).toMatchObject({ show: true, never: true });
  });
  it('counts moved specs plus members owed a lock', () => {
    expect(changeCount(withMembers(drifted(movedList), [member('drifted')]))).toBe(5);
    expect(changeCount(clean)).toBe(0);
  });
  it('marks changed tree nodes, rolling interfaces up to their component and skipping removals', () => {
    const typeNodes: ScopeNode[] = [...nodes, { id: 't', kind: 'type' }];
    const marks = changeMarks(parseMoved(movedList), typeNodes);
    expect(Object.fromEntries(marks)).toEqual({ a_comp: '~', t: '+' });
  });
  it('groups moved specs by subsystem with unplaced and removed ones last', () => {
    const groups = groupMoved(parseMoved(movedList), nodes);
    expect(groups.map((g) => g.subsystem)).toEqual(['a', '']);
    expect(groups[0].items.map((i) => i.id)).toEqual(['a_comp', 'a_iface']);
    expect(groups[1].items.map((i) => `${i.mark}${i.id}`)).toEqual(['-gone', '+t']);
  });
  it('builds spec routes, member scopes, lock bodies and pending reviews', () => {
    expect(specRoute('component', 'x::y z')).toBe('/specs/component/x/y%20z');
    expect(movedKind({ folder: 'interfaces' })).toBe('interface');
    expect(memberOfScope('member:svc')).toBe('svc');
    expect(memberOfScope('a')).toBeUndefined();
    expect(lockBody(undefined, 'svc')).toEqual({ command: 'lock', member: 'svc' });
    const r = [{ request: { status: 'pending' }, member: 'svc' }, { request: { status: 'locked' } }];
    expect(pendingReviews(r)).toHaveLength(1);
    expect(pendingReviews(undefined)).toEqual([]);
  });
});
