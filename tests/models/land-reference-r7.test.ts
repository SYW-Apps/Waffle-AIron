import { describe, it, expect } from 'vitest';
import { landReference, type ReadableProject } from '../../src/models/project-family.js';

// ---------------------------------------------------------------------------
// Round 7 (QA): `prod::carrier` written in a project that declares no `prod`
// was reported as a wairon 5 reference form with a `wairon upgrade` hint. It
// is the alias form with an alias the project does not declare; only a
// leading `::`, `super::` or a member path of three or more segments is the
// old major's form.
// ---------------------------------------------------------------------------

const cons: ReadableProject = {
  namespace: 'cons', aliases: new Map(), declaredAliases: new Set(), subsystems: new Set(['core']),
};

describe('landReference — an undeclared alias', () => {
  it('reads `name::item` with an undeclared first segment as the alias form, unresolved', () => {
    expect(landReference([cons], 'prod::carrier', 'cons')).toEqual({ kind: 'unresolved', form: 'alias' });
  });

  it('still reads the old major forms as such', () => {
    expect(landReference([cons], '::carrier', 'cons')).toEqual({ kind: 'unresolved', form: 'leading' });
    expect(landReference([cons], 'super::carrier', 'cons')).toEqual({ kind: 'unresolved', form: 'super' });
    expect(landReference([cons], 'prod::sub::carrier', 'cons')).toEqual({ kind: 'unresolved', form: 'path' });
  });

  it('a subsystem segment still qualifies a local item', () => {
    expect(landReference([cons], 'core::carrier', 'cons')).toEqual({ kind: 'project', project: 'cons', name: 'carrier' });
  });
});
