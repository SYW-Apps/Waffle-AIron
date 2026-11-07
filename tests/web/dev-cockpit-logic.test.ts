import { describe, it, expect } from 'vitest';
import {
  barState, inPlaceScope, lockBody, movedScope, offersLockInPlace, parseMoved, subsystemOfRoute, subsystemOfSpec,
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
