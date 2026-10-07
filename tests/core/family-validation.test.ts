import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot, runWithProjectBinding } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import {
  validateProject, validateFamily, validateAsComplete, type ValidationIssue, type ValidationResult,
  computeGateStateId,
} from '../../src/core/validation.js';
import { pinExternals } from '../../src/core/surfaces.js';
import { readLockRecord } from '../../src/core/lockfile.js';
import { projectConfigRepositoryAt } from '../../src/config/project-config.js';
import { runLock } from '../../src/commands/lock.js';
import {
  buildReferenceFamily, buildContractFamily, type ReferenceFamily, type ContractFamily,
} from '../helpers/reference-family.js';

// ---------------------------------------------------------------------------
// Stage 4, wave B — the family run (validateFamily). Every selected project
// is judged by its own gate, verbatim; the run adds only what needs two
// projects on disk: the composition of each project's externals against its
// live producers, and the family checks. Real temp directories throughout,
// nothing mocked on the path under test.
//
// The family codes are not rule-registry codes (a rule judges one project's
// gate), so the rule matrix cannot express them: their fire and control
// fixtures live here, one describe per code.
// ---------------------------------------------------------------------------

const cleanups: (() => void)[] = [];
afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  vi.restoreAllMocks();
  for (const c of cleanups.splice(0)) {
    try { c(); } catch { /* windows file locks */ }
  }
});

function bind(dir: string): void {
  setProjectRoot(dir);
  invalidateSpecCache();
}

function referenceFamily(): ReferenceFamily {
  const f = buildReferenceFamily();
  cleanups.push(() => f.cleanup());
  return f;
}

function contractFamily(): ContractFamily {
  const f = buildContractFamily();
  cleanups.push(() => f.cleanup());
  return f;
}

/** A copy of one project directory alone, with no family around it. */
function alone(dir: string): string {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-alone-'));
  fs.cpSync(dir, copy, { recursive: true });
  cleanups.push(() => fs.rmSync(copy, { recursive: true, force: true }));
  return copy;
}

/** A finding as a comparable line: severity, code, spec and the whole message. */
const line = (i: ValidationIssue): string => `${i.severity} ${i.code} @${i.specId ?? '-'} ${i.message}`;

/** The owner's gate of a project at its own root, under its own configuration — what `wairon validate` there runs. */
function ownGate(dir: string): ValidationResult {
  bind(dir);
  const config = projectConfigRepositoryAt(dir).load();
  return validateProject({ rules: config?.rules, projectType: config?.projectType });
}

/** The family run bound at `dir`. */
function familyAt(dir: string, family?: boolean): ValidationResult {
  bind(dir);
  return validateFamily(family ? { family: true } : {});
}

/** The findings a family run carries for one project, as lines. */
const of = (res: ValidationResult, project: string): string[] =>
  res.issues.filter((i) => i.project === project).map(line).sort();

/** The composition and family findings (they name no spec) of one code. */
const family = (res: ValidationResult, code: string): ValidationIssue[] =>
  res.issues.filter((i) => i.code === code && i.specId === undefined);

/** Pin the consumer's externals from its own root. */
function pin(dir: string): void {
  bind(dir);
  pinExternals();
}

/** Lock a project at its own root, gated as `wairon lock` gates it. */
async function lock(dir: string): Promise<void> {
  bind(dir);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const config = projectConfigRepositoryAt(dir).load();
  const gate = validateAsComplete({ rules: config?.rules, projectType: config?.projectType });
  await runLock({ yes: true }, gate, computeGateStateId());
}

describe('the family run — what it carries', () => {
  it('property: one-judge — a member\'s findings in the family run are its own gate\'s, verbatim', () => {
    const f = referenceFamily();
    const run = familyAt(f.top);
    expect(run.projects!.map((p) => p.key)).toEqual(['', 'core', 'transpiler', 'shared']);
    for (const [key, dir] of [['core', f.core], ['transpiler', f.transpiler], ['shared', f.shared]] as const) {
      const own = ownGate(dir);
      const carried = run.issues.filter((i) => i.project === key && i.specId !== undefined).map(line).sort();
      // Every finding of the member's own gate is carried under its key, unchanged…
      expect(carried).toEqual(own.issues.filter((i) => i.specId !== undefined).map(line).sort());
      // …including the ones that name no spec (the run adds its own beside them).
      expect(of(run, key)).toEqual(expect.arrayContaining(own.issues.map(line)));
      // …and its totals are its own gate's.
      const verdict = run.projects!.find((p) => p.key === key)!;
      expect([verdict.errors, verdict.warnings, verdict.notices]).toEqual(
        ['error', 'warning', 'notice'].map((s) => own.issues.filter((i) => i.severity === s).length));
    }
    // The root's own gate is carried too.
    const rootOwn = ownGate(f.top);
    expect(run.issues.filter((i) => i.project === '').map(line).sort()).toEqual(expect.arrayContaining(rootOwn.issues.map(line)));
  });

  it('property: unrelated-failure-changes-nothing — breaking one member leaves every other member\'s verdict as it was', () => {
    const f = referenceFamily();
    const before = familyAt(f.top);
    // shared grows an error of its own: a component depending on nothing that exists.
    fs.mkdirSync(path.join(f.shared, '.wai', 'specs', 'glossary', 'glossary-portal'), { recursive: true });
    fs.writeFileSync(path.join(f.shared, '.wai', 'specs', 'glossary', '.index.yaml'), [
      'id: glossary', 'name: glossary', 'description: The glossary', 'parentSystem: Shared', 'publicInterfaces: []', 'trustedLinks: []',
      'status: complete', "createdAt: '2026-09-27T00:00:00.000Z'", "updatedAt: '2026-09-27T00:00:00.000Z'", ''].join('\n'));
    fs.writeFileSync(path.join(f.shared, '.wai', 'specs', 'glossary', 'glossary-portal', '.index.yaml'), [
      'id: glossary-portal', 'name: glossary-portal', 'description: The glossary portal', 'subsystem: glossary', 'componentType: Portal',
      'portalType: Custom', 'owns: []', 'dependsOn:', '  - vanished-term-index', 'status: complete',
      "createdAt: '2026-09-27T00:00:00.000Z'", "updatedAt: '2026-09-27T00:00:00.000Z'", ''].join('\n'));
    const after = familyAt(f.top);
    expect(after.issues.some((i) => i.project === 'shared' && i.code === 'INVALID_DEPENDENCY_REFERENCE')).toBe(true);
    for (const key of ['', 'core', 'transpiler']) expect(of(after, key)).toEqual(of(before, key));
  });

  it('runs from the top, and with --family at a member; a plain run at a member leaves its sibling producer out, with the hint', () => {
    const f = contractFamily();
    pin(f.billing);
    const fromTop = familyAt(f.top);
    expect(fromTop.projects!.map((p) => [p.key, p.id])).toEqual([['', 'house'], ['ledger', 'ledger'], ['billing', 'billing']]);
    expect(fromTop.hint).toBeUndefined();
    // From the member, a plain family run reads nothing above it: the sibling is not composed.
    const plain = familyAt(f.billing);
    expect(plain.projects!.map((p) => p.key)).toEqual(['']);
    expect(plain.hint).toMatch(/1 external of the bound project \("ledger"\) has its producer outside this run's reach/);
    // --family makes the walk up explicit: the sibling is composed.
    f.setLedgerContract('record');
    const composed = familyAt(f.billing, true);
    expect(composed.hint).toBeUndefined();
    expect(family(composed, 'EXTERNAL_INCOMPATIBLE').map((i) => i.project)).toEqual(['']);
  });

  it('hosted: the family run keeps the credential\'s reach and never widens it', () => {
    const f = contractFamily();
    pin(f.billing);
    f.setLedgerContract('record');
    invalidateSpecCache();
    // A credential narrowed to billing: --family composes nothing above it.
    const narrowed = runWithProjectBinding(f.billing, { topRoot: f.top, parentReach: false }, () => validateFamily({ family: true }));
    expect(family(narrowed, 'EXTERNAL_INCOMPATIBLE')).toEqual([]);
    expect(narrowed.hint).toMatch(/outside this run's reach/);
    // The same member under a credential for the whole family: composed.
    invalidateSpecCache();
    const whole = runWithProjectBinding(f.billing, { topRoot: f.top, parentReach: true }, () => validateFamily({ family: true }));
    expect(family(whole, 'EXTERNAL_INCOMPATIBLE')).toHaveLength(1);
    // And the member's own verdict is the same under both.
    expect(of(narrowed, '').filter((l) => !l.includes('could not be compared'))).toEqual(of(whole, '').filter((l) => !l.includes('EXTERNAL_INCOMPATIBLE')));
  });
});

describe('the family run — composition', () => {
  it('property: renamed-method-seen-from-parent — the consumer\'s gate stays clean against its pin, the family run reports EXTERNAL_INCOMPATIBLE', () => {
    const f = contractFamily();
    pin(f.billing);
    const ownBefore = ownGate(f.billing).issues.map(line).sort();
    f.setLedgerContract('record');
    // billing's own gate judges against its pin: nothing moved for it.
    expect(ownGate(f.billing).issues.map(line).sort()).toEqual(ownBefore);
    const run = familyAt(f.top);
    const incompatible = family(run, 'EXTERNAL_INCOMPATIBLE');
    expect(incompatible.map((i) => [i.project, i.severity])).toEqual([['billing', 'error']]);
    expect(incompatible[0].message).toMatch(/"ledger-portal\.post" of the external "ledger"/);
    expect(run.valid).toBe(false);
  });
});

describe('family codes — fire and control', () => {
  it('EXTERNAL_INCOMPATIBLE fires on a used method that vanished; quiet while it is there', () => {
    const f = contractFamily();
    pin(f.billing);
    expect(family(familyAt(f.top), 'EXTERNAL_INCOMPATIBLE')).toEqual([]);
    f.setLedgerContract('record');
    expect(family(familyAt(f.top), 'EXTERNAL_INCOMPATIBLE')).toHaveLength(1);
  });

  it('EXTERNAL_DRIFTED fires when only an unused member changed; quiet when nothing changed', () => {
    const f = contractFamily();
    pin(f.billing);
    expect(family(familyAt(f.top), 'EXTERNAL_DRIFTED')).toEqual([]);
    f.setLedgerContract('post', 'string');
    const run = familyAt(f.top);
    expect(family(run, 'EXTERNAL_DRIFTED').map((i) => [i.project, i.severity])).toEqual([['billing', 'notice']]);
    expect(family(run, 'EXTERNAL_INCOMPATIBLE')).toEqual([]);
  });

  it('EXTERNAL_UNPINNED fires on a use of an external never pinned (an error: never a pass); quiet once pinned', () => {
    const f = contractFamily();
    expect(family(familyAt(f.top), 'EXTERNAL_UNPINNED').map((i) => [i.project, i.severity])).toEqual([['billing', 'error']]);
    expect(family(familyAt(f.top), 'EXTERNAL_CHECK_UNAVAILABLE')).toEqual([]);
    pin(f.billing);
    expect(family(familyAt(f.top), 'EXTERNAL_UNPINNED')).toEqual([]);
  });

  it('MEMBER_NOT_FOUND fires on a declared member with no project on disk; quiet when it is there', () => {
    const f = contractFamily();
    expect(family(familyAt(f.top), 'MEMBER_NOT_FOUND')).toEqual([]);
    f.setConfig(f.top, ['id: house', 'name: House', 'members:', '  ledger: ledger', '  billing: billing', '  archive: archive']);
    const run = familyAt(f.top);
    expect(family(run, 'MEMBER_NOT_FOUND').map((i) => [i.project, i.severity])).toEqual([['', 'error']]);
    expect(run.valid).toBe(false);
  });

  it('PROJECT_ID_COLLISION fires on two members answering to one id; quiet when their ids differ', () => {
    const f = contractFamily();
    expect(family(familyAt(f.top), 'PROJECT_ID_COLLISION')).toEqual([]);
    f.setConfig(f.billing, ['id: ledger', 'name: Billing']);
    expect(family(familyAt(f.top), 'PROJECT_ID_COLLISION').map((i) => i.severity)).toEqual(['error']);
  });

  it('PROJECT_DEPENDENCY_CYCLE fires on each project of a loop; quiet on a one-way dependency', () => {
    expect(family(familyAt(contractFamily().top), 'PROJECT_DEPENDENCY_CYCLE')).toEqual([]);
    const f = referenceFamily();
    const loops = family(familyAt(f.top), 'PROJECT_DEPENDENCY_CYCLE');
    expect(loops.map((i) => i.project).sort()).toEqual(['core', 'shared', 'transpiler']);
    expect(loops.every((i) => i.severity === 'warning')).toBe(true);
  });

  it('MEMBER_UNAPPROVED fires on a member never locked; quiet once it is', async () => {
    const f = contractFamily();
    expect(family(familyAt(f.top), 'MEMBER_UNAPPROVED').map((i) => i.project).sort()).toEqual(['billing', 'ledger']);
    await lock(f.ledger);
    expect(family(familyAt(f.top), 'MEMBER_UNAPPROVED').map((i) => i.project)).toEqual(['billing']);
  });

  it('MEMBER_DRIFTED fires on a member whose lock no longer matches its own gate; quiet while it does', async () => {
    const f = contractFamily();
    await lock(f.ledger);
    expect(family(familyAt(f.top), 'MEMBER_DRIFTED')).toEqual([]);
    f.setLedgerContract('record');
    expect(family(familyAt(f.top), 'MEMBER_DRIFTED').map((i) => [i.project, i.severity])).toEqual([['ledger', 'warning']]);
  });

  it('PROJECT_ID_DEFAULTED (member) fires on a member declaring no id, naming its alias; quiet when it declares one', () => {
    const f = contractFamily();
    expect(family(familyAt(f.top), 'PROJECT_ID_DEFAULTED')).toEqual([]);
    f.setConfig(f.ledger, ['name: Ledger']);
    // The member's own gate reports its own id too; the family check is the one naming its alias.
    const defaulted = family(familyAt(f.top), 'PROJECT_ID_DEFAULTED').filter((i) => i.message.includes('member project keyed'));
    expect(defaulted.map((i) => [i.project, i.severity])).toEqual([['ledger', 'notice']]);
    expect(defaulted[0].message).toMatch(/Declare `id: ledger` there — its alias/);
  });

  it('PROJECT_ID_AMBIGUOUS (member) fires on a member with no usable id; quiet when it declares one', () => {
    const f = contractFamily();
    expect(family(familyAt(f.top), 'PROJECT_ID_AMBIGUOUS')).toEqual([]);
    f.setConfig(f.ledger, ["name: '!!!'"]);
    // The member's own gate reports its own id too; the family check is the one naming it as a member.
    const ambiguous = family(familyAt(f.top), 'PROJECT_ID_AMBIGUOUS').filter((i) => i.message.startsWith('The member'));
    expect(ambiguous.map((i) => [i.project, i.severity])).toEqual([['ledger', 'warning']]);
  });

  it('a family code is tuned by the owning project\'s sddRuleSeverity', () => {
    const f = contractFamily();
    // The root owns the member checks.
    f.setConfig(f.top, ['id: house', 'name: House', 'members:', '  ledger: ledger', '  billing: billing',
      'rules:', '  sddRuleSeverity:', '    MEMBER_UNAPPROVED: error', '    PROJECT_DEPENDENCY_CYCLE: "off"']);
    expect(family(familyAt(f.top), 'MEMBER_UNAPPROVED').map((i) => i.severity)).toEqual(['error', 'error']);
    // The consumer owns the composition of its externals; the root's word does not reach it.
    f.setConfig(f.top, ['id: house', 'name: House', 'members:', '  ledger: ledger', '  billing: billing',
      'rules:', '  sddRuleSeverity:', '    EXTERNAL_UNPINNED: "off"']);
    expect(family(familyAt(f.top), 'EXTERNAL_UNPINNED')).toHaveLength(1);
    f.setConfig(f.billing, ['id: billing', 'name: Billing', 'externals:', '  ledger: {}',
      'rules:', '  sddRuleSeverity:', '    EXTERNAL_UNPINNED: "off"']);
    expect(family(familyAt(f.top), 'EXTERNAL_UNPINNED')).toEqual([]);
  });
});

describe('approval context', () => {
  it('property: approval-context-both-roots — locking a member at its own root and inside the family gives the same record', async () => {
    const f = contractFamily();
    const fields = (): unknown => {
      const r = readLockRecord()!;
      return { stateId: r.stateId, validationResult: r.validationResult, specs: r.specs, projectId: r.projectId, children: r.children };
    };
    await lock(f.ledger);
    bind(f.ledger);
    const atOwnRoot = fields();
    fs.rmSync(path.join(f.ledger, '.wai', 'lock.json'));
    // Inside the family: the request bound to the member under a credential for the whole family.
    invalidateSpecCache();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await runWithProjectBinding(f.ledger, { topRoot: f.top, parentReach: true }, async () => {
      const config = projectConfigRepositoryAt(f.ledger).load();
      await runLock({ yes: true }, validateAsComplete({ rules: config?.rules, projectType: config?.projectType }), computeGateStateId());
    });
    bind(f.ledger);
    expect(fields()).toEqual(atOwnRoot);
    // A copy of the member alone computes the same gate identity: nothing of an ancestor is in it.
    const copy = alone(f.ledger);
    await lock(copy);
    bind(copy);
    expect((fields() as { stateId: unknown }).stateId).toEqual((atOwnRoot as { stateId: unknown }).stateId);
    // And the family run reads the lock as current.
    expect(family(familyAt(f.top), 'MEMBER_DRIFTED')).toEqual([]);
    expect(family(familyAt(f.top), 'MEMBER_UNAPPROVED').map((i) => i.project)).toEqual(['billing']);
  });
});
