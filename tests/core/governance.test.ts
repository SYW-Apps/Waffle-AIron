import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { validateProject, validateFamily, type ValidationIssue, type ValidationResult } from '../../src/core/validation.js';
import { createMember } from '../../src/core/provision.js';
import { projectConfigRepositoryAt } from '../../src/config/project-config.js';
import { admits, rangeProblem, requiredPolicies, withPack, type ProjectConfig } from '../../src/models/project.js';
import { runValidate } from '../../src/commands/validate.js';
import {
  governanceMachine, bindRoot, editConfig, readConfig, writeSubsystem, writeComponent, type GovernanceMachine,
} from '../helpers/governance-fixture.js';

// ---------------------------------------------------------------------------
// Governance stage — parents require packs, members adopt them.
//
// A parent's composition.requirePolicies is judged in the FAMILY run only
// (POLICY_NOT_ADOPTED, POLICY_DEVIATION), from committed files; a member's own
// gate never reads it; a malformed requirement is the requiring project's own
// finding (POLICY_REQUIREMENT_INVALID, fired and controlled in the rule
// matrix); and a pack's loosening of wairon's defaults is never a finding.
// createMember writes the parent's required packs into a new member once.
// Real temp directories and a redirected home throughout; nothing mocked on
// the path under test.
// ---------------------------------------------------------------------------

let machine: GovernanceMachine | undefined;
afterEach(() => {
  machine?.cleanup();
  machine = undefined;
  vi.restoreAllMocks();
});

function newMachine(): GovernanceMachine {
  machine = governanceMachine();
  return machine;
}

/** The family run bound at a root. */
function familyAt(dir: string): ValidationResult {
  bindRoot(dir);
  return validateFamily({});
}

/** A project's own gate at its root, under its own configuration. */
function ownGate(dir: string): ValidationResult {
  bindRoot(dir);
  const config = projectConfigRepositoryAt(dir).load();
  return validateProject({ rules: config?.rules, projectType: config?.projectType });
}

const line = (i: ValidationIssue): string => `${i.severity} ${i.code} @${i.specId ?? '-'} ${i.message}`;
const codes = (r: ValidationResult, code: string, project?: string): ValidationIssue[] =>
  r.issues.filter((i) => i.code === code && (project === undefined || i.project === project));

/** A root that requires acme-base, and a member created under it. */
function family(m: GovernanceMachine, requirement: Record<string, unknown>): { root: string; member: string } {
  const root = m.project('platform');
  editConfig(root, (doc) => { doc.composition = { requirePolicies: [requirement] }; });
  bindRoot(root);
  createMember('svc', 'services/svc', undefined, 'project');
  return { root, member: path.join(root, 'services', 'svc') };
}

/** Set the member's own pack entries (and optionally its projectType) directly in its committed configuration. */
function memberSelects(member: string, packs: unknown[], projectType?: string): void {
  editConfig(member, (doc) => {
    doc.extensions = { useGlobalPacks: false, packs };
    if (projectType) doc.projectType = projectType;
  });
}

describe('pack_requirement — an npm-style semver subset over the store comparator', () => {
  const cases: [string, string | undefined, boolean][] = [
    ['1.2.0', '1.2.0', true],
    ['1.2.0', '1.2.1', false],
    ['=1.2.0', '1.2.0', true],
    ['^1.2', '1.2.0', true],
    ['^1.2', '1.9.3', true],
    ['^1.2', '2.0.0', false],
    ['^1.2', '1.1.9', false],
    ['^0.2.3', '0.2.9', true],
    ['^0.2.3', '0.3.0', false],
    ['^0.0.3', '0.0.4', false],
    ['~1.2.3', '1.2.9', true],
    ['~1.2.3', '1.3.0', false],
    ['~1.2', '1.2.0', true],
    ['1.x', '1.7.0', true],
    ['1.x', '2.0.0', false],
    ['1.2.*', '1.2.5', true],
    ['1.2.*', '1.3.0', false],
    ['*', '9.9.9', true],
    ['>=1.2.0 <2.0.0', '1.5.0', true],
    ['>=1.2.0 <2.0.0', '2.0.0', false],
    ['>= 1.2.0', '1.2.0', true],
    ['>1.2', '1.2.9', false],
    ['>1.2', '1.3.0', true],
    ['<=1.2', '1.2.9', true],
    ['<=1.2', '1.3.0', false],
    ['^1.0.0 || ^3.0.0', '3.1.0', true],
    ['^1.0.0 || ^3.0.0', '2.1.0', false],
    ['^1.2', '1.3.0-beta.1', false],
    ['>=1.3.0-beta.1 <2.0.0', '1.3.0-beta.2', true],
    ['*', undefined, true],
    ['^1.2', undefined, false],
    ['^1.2', 'not-a-version', false],
    ['latest', '1.2.0', false],
  ];
  it.each(cases)('"%s" admits %s: %s', (range, version, expected) => {
    expect(admits({ version: range }, version)).toBe(expected);
  });

  it('names the first unreadable token, and nothing for a range that parses', () => {
    expect(rangeProblem({ version: '^1.2' })).toBeNull();
    expect(rangeProblem({ version: '>=1.2.0 <2.0.0 || 3.x' })).toBeNull();
    expect(rangeProblem({ version: '' })).toMatch(/empty/);
    expect(rangeProblem({ version: '>=1.2.0 banana' })).toMatch(/"banana"/);
    expect(rangeProblem({ version: '1.2-beta' })).toMatch(/"1.2-beta"/);
  });

  it('reads the requirements in order, a second one for the same pack dropped', () => {
    const config = { composition: { requirePolicies: [
      { pack: 'a', version: '^1' }, { pack: 'b', version: '*' }, { pack: 'a', version: '^2' },
    ] } } as Pick<ProjectConfig, 'composition'>;
    expect(requiredPolicies(config).map((r) => `${r.pack} ${r.version}`)).toEqual(['a ^1', 'b *']);
    expect(requiredPolicies({})).toEqual([]);
  });

  it('withPack reads a pack write as the registry writes it', () => {
    const base = { extensions: { useGlobalPacks: false, packs: ['.wai/packs/x.yaml', { name: 'a', version: '1.0.0' }, { name: 'b' }] } } as unknown as ProjectConfig;
    expect(withPack(base, { name: 'a', version: '2.0.0' }).extensions!.packs).toEqual(['.wai/packs/x.yaml', { name: 'b' }, { name: 'a', version: '2.0.0' }]);
    expect(withPack(base, { name: 'a' }, true).extensions!.packs).toEqual(['.wai/packs/x.yaml', { name: 'b' }]);
    expect(withPack(base, '.wai/packs/x.yaml').extensions!.packs).toHaveLength(3);
    expect(withPack(base, '.wai/packs/y.yaml').extensions!.packs.at(-1)).toBe('.wai/packs/y.yaml');
    expect(withPack(base, '.wai/packs/x.yaml', true).extensions!.packs).toHaveLength(2);
  });
});

describe('property: not-adopted-is-reported — the family run judges each member from its committed files', () => {
  it('fires for a member that does not select the pack', () => {
    const m = newMachine();
    m.install('1.2.0');
    const { root, member } = family(m, { pack: 'acme-base', version: '^1.2' });
    memberSelects(member, []);
    const run = familyAt(root);
    const found = codes(run, 'POLICY_NOT_ADOPTED', 'svc');
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe('error');
    expect(found[0].message).toMatch(/does not select the pack "acme-base" \^1\.2, required by the family root/);
    expect(run.valid).toBe(false);
  });

  it('fires for a floating selection: a family cannot judge it', () => {
    const m = newMachine();
    m.install('1.2.0');
    const { root, member } = family(m, { pack: 'acme-base', version: '^1.2' });
    memberSelects(member, [{ name: 'acme-base' }]);
    const found = codes(familyAt(root), 'POLICY_NOT_ADOPTED', 'svc');
    expect(found).toHaveLength(1);
    expect(found[0].message).toMatch(/unpinned — a family cannot judge a floating selection; pin a version/);
  });

  it('fires for a pinned version outside the range', () => {
    const m = newMachine();
    m.install('1.2.0');
    m.install('2.0.0');
    const { root, member } = family(m, { pack: 'acme-base', version: '^1.2' });
    memberSelects(member, [{ name: 'acme-base', version: '2.0.0' }]);
    const found = codes(familyAt(root), 'POLICY_NOT_ADOPTED', 'svc');
    expect(found).toHaveLength(1);
    expect(found[0].message).toMatch(/version 2\.0\.0 is not admitted by "\^1\.2"/);
  });

  it('fires when the required profile does not govern the member', () => {
    const m = newMachine();
    m.install('1.2.0');
    const { root, member } = family(m, { pack: 'acme-base', version: '^1.2', profile: 'strict' });
    memberSelects(member, [{ name: 'acme-base', version: '1.2.0' }], 'backend');
    const found = codes(familyAt(root), 'POLICY_NOT_ADOPTED', 'svc');
    expect(found).toHaveLength(1);
    expect(found[0].message).toMatch(/governed by "backend", not the required profile "strict"/);
  });

  it('control: a pinned, in-range selection under the required profile is adopted', () => {
    const m = newMachine();
    m.install('1.2.0');
    const { root, member } = family(m, { pack: 'acme-base', version: '^1.2', profile: 'strict' });
    memberSelects(member, [{ name: 'acme-base', version: '1.2.0' }], 'strict');
    const run = familyAt(root);
    expect(codes(run, 'POLICY_NOT_ADOPTED')).toEqual([]);
  });

  it('control: a legacy path reference whose committed manifest carries the pack in range is adopted', () => {
    const m = newMachine();
    const { root, member } = family(m, { pack: 'acme-base', version: '~1.2.0' });
    fs.mkdirSync(path.join(member, '.wai', 'packs'), { recursive: true });
    fs.writeFileSync(path.join(member, '.wai', 'packs', 'acme-base.yaml'), 'name: acme-base\nversion: 1.2.4\n');
    memberSelects(member, ['.wai/packs/acme-base.yaml']);
    expect(codes(familyAt(root), 'POLICY_NOT_ADOPTED')).toEqual([]);
  });

  it('is judged at the requiring project\'s sddRuleSeverity, and a requirement above the bound root is not judged', () => {
    const m = newMachine();
    m.install('1.2.0');
    const { root, member } = family(m, { pack: 'acme-base', version: '^1.2' });
    memberSelects(member, []);
    editConfig(root, (doc) => { (doc.rules as Record<string, unknown>).sddRuleSeverity = { POLICY_NOT_ADOPTED: 'warning' }; });
    expect(codes(familyAt(root), 'POLICY_NOT_ADOPTED')[0].severity).toBe('warning');
    // Bound at the member, the parent is not in the selection.
    expect(codes(familyAt(member), 'POLICY_NOT_ADOPTED')).toEqual([]);
    bindRoot(member);
    expect(codes(validateFamily({ family: true }), 'POLICY_NOT_ADOPTED')).toEqual([]);
  });

  it('is location-independent: the verdict does not read the machine\'s store', () => {
    const m = newMachine();
    m.install('1.2.0');
    const { root, member } = family(m, { pack: 'acme-base', version: '^1.2' });
    memberSelects(member, [{ name: 'acme-base', version: '2.0.0' }]);
    const before = codes(familyAt(root), 'POLICY_NOT_ADOPTED').map(line);
    // A machine that also has 2.0.0 installed judges the same committed pin the same way.
    m.install('2.0.0');
    expect(codes(familyAt(root), 'POLICY_NOT_ADOPTED').map(line)).toEqual(before);
  });
});

describe('property: deviation-is-visible-not-blocking', () => {
  /** A member that adopted acme-base under `lenient` and overrides every setting kind once. */
  function deviatingFamily(m: GovernanceMachine): { root: string; member: string } {
    m.install('1.2.0');
    const { root, member } = family(m, { pack: 'acme-base', version: '^1.2', profile: 'lenient' });
    editConfig(member, (doc) => {
      doc.projectType = 'lenient';
      doc.extensions = { useGlobalPacks: false, packs: [{ name: 'acme-base', version: '1.2.0', source: 'https://packs.example.test/acme-base-{version}.wpack' }] };
      const rules = doc.rules as Record<string, unknown>;
      // UNUSED_LINT_ALLOW is a code the pack does not set: the member's own business.
      rules.sddRuleSeverity = { UNUSED_COMPONENT: 'warning', UNUSED_LINT_ALLOW: 'off' };
      rules.designDepth = 'narratives';
      rules.naming = { components: 'kebab-case', stereotypes: { Orchestrator: { suffix: 'workflow' } } };
      rules.complexity = { maxMethodParams: 9 };
      rules.documentation = { minDescriptionLength: 3 };
    });
    // The root has not locked its member yet; that is not what this family is about.
    editConfig(root, (doc) => { (doc.rules as Record<string, unknown>).sddRuleSeverity = { MEMBER_UNAPPROVED: 'off' }; });
    writeSubsystem(member, 'billing', ['designDepth: interfaces']);
    writeSubsystem(member, 'reporting', ['profile: backend', 'lint:', '  allow:', '    - code: GENERIC_COMPONENT_NAME', '      reason: reporting names follow the report catalogue']);
    return { root, member };
  }

  it('reports every profile-overridable setting kind once, as a notice naming the setting, the pack\'s value and the member\'s', () => {
    const m = newMachine();
    const { root } = deviatingFamily(m);
    const found = codes(familyAt(root), 'POLICY_DEVIATION', 'svc');
    const settings = found.map((i) => /changes (.+?): the pack sets/.exec(i.message)?.[1]).sort();
    expect(settings).toEqual([
      'a lint.allow of GENERIC_COMPONENT_NAME on "reporting"',
      'rules.complexity.maxMethodParams',
      'rules.designDepth',
      'rules.documentation.minDescriptionLength',
      'rules.naming.components',
      'rules.naming.stereotypes.Orchestrator',
      'rules.sddRuleSeverity.UNUSED_COMPONENT',
      'the designDepth of subsystem "billing"',
      'the profile of subsystem "reporting"',
    ]);
    expect(found.every((i) => i.severity === 'notice')).toBe(true);
    const severity = found.find((i) => i.message.includes('rules.sddRuleSeverity.UNUSED_COMPONENT'))!;
    expect(severity.message).toMatch(/the pack sets "notice" under its profile "lenient", the member "warning"/);
  });

  it('never fails the run or --ci', async () => {
    const m = newMachine();
    const { root } = deviatingFamily(m);
    const run = familyAt(root);
    expect(codes(run, 'POLICY_DEVIATION').length).toBeGreaterThan(0);
    expect(run.issues.filter((i) => i.code.startsWith('POLICY_') && i.severity !== 'notice')).toEqual([]);
    // `wairon validate --ci` at the root: the deviations are notices and fail nothing.
    bindRoot(root);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
    const blocking = run.issues.filter((i) => i.severity === 'error' || (i.severity === 'warning' && !i.draftContext));
    // Nothing else in this family blocks, so the run below is decided by the deviations alone.
    expect(blocking).toEqual([]);
    await runValidate({ ci: true });
    expect(exit).not.toHaveBeenCalled();
  });

  it('control: a member that changes nothing the pack sets deviates from nothing', () => {
    const m = newMachine();
    m.install('1.2.0');
    const { root, member } = family(m, { pack: 'acme-base', version: '^1.2', profile: 'lenient' });
    editConfig(member, (doc) => {
      doc.projectType = 'lenient';
      doc.extensions = { useGlobalPacks: false, packs: [{ name: 'acme-base', version: '1.2.0' }] };
      // A key the profile does not set is the member's own business, not a deviation.
      (doc.rules as Record<string, unknown>).sddRuleSeverity = { DRAFT_COMPONENT_WARNING: 'notice', UNUSED_COMPONENT: 'notice' };
    });
    expect(codes(familyAt(root), 'POLICY_DEVIATION')).toEqual([]);
  });
});

describe('property: pack-loosening-is-never-a-finding', () => {
  it('a member governed by a profile that loosens wairon\'s defaults adopts it cleanly — no governance finding says so', () => {
    const m = newMachine();
    m.install('1.2.0');
    const { root, member } = family(m, { pack: 'acme-base', version: '^1.2', profile: 'lenient' });
    memberSelects(member, [{ name: 'acme-base', version: '1.2.0' }], 'lenient');
    writeSubsystem(member, 'core');
    writeComponent(member, 'core', 'engine');
    const run = familyAt(root);
    // The loosening takes effect in the member's own gate...
    const own = ownGate(member);
    // (UNUSED_COMPONENT to notice — and below the profile's shallower design depth, not asked at all.)
    expect(own.issues.filter((i) => i.code === 'UNUSED_COMPONENT' && i.severity !== 'notice')).toEqual([]);
    expect(own.issues.some((i) => i.code === 'GENERIC_COMPONENT_NAME')).toBe(false);
    // ...and nothing in the family run reports it: the governance codes stay silent.
    expect(run.issues.filter((i) => i.code.startsWith('POLICY_'))).toEqual([]);
    expect(run.issues.filter((i) => /loosen/i.test(i.message))).toEqual([]);
  });
});

describe('property: member-gate-unchanged-by-requirements', () => {
  it('a member\'s own verdict is identical with and without a parent requirement — even an unreadable one', () => {
    const m = newMachine();
    m.install('1.2.0');
    const { root, member } = family(m, { pack: 'acme-base', version: '^1.2', profile: 'strict' });
    memberSelects(member, []);
    writeSubsystem(member, 'core');
    writeComponent(member, 'core', 'engine');
    const withRequirement = ownGate(member).issues.map(line).sort();
    editConfig(root, (doc) => { doc.composition = { requirePolicies: [{ pack: 'acme-base', version: 'latest' }] }; });
    const withUnreadable = ownGate(member).issues.map(line).sort();
    editConfig(root, (doc) => { delete doc.composition; });
    const without = ownGate(member).issues.map(line).sort();
    expect(withRequirement).toEqual(without);
    expect(withUnreadable).toEqual(without);
    // The family run carries the member's own gate verbatim either way.
    expect(familyAt(root).issues.filter((i) => i.project === 'svc' && !i.code.startsWith('POLICY_')).map(line).sort())
      .toEqual(expect.arrayContaining(without));
  });

  it('an unreadable requirement is the requiring project\'s own error, and the family run skips it', () => {
    const m = newMachine();
    const { root, member } = family(m, { pack: 'acme-base', version: 'latest' });
    memberSelects(member, []);
    const own = ownGate(root);
    expect(codes(own, 'POLICY_REQUIREMENT_INVALID')).toHaveLength(1);
    const run = familyAt(root);
    expect(codes(run, 'POLICY_REQUIREMENT_INVALID', '')).toHaveLength(1);
    expect(codes(run, 'POLICY_NOT_ADOPTED')).toEqual([]);
  });
});

describe('property: scaffold-once — createMember writes the parent\'s required packs into a new member, once', () => {
  it('pins each requirement to the highest installed version its range admits, with digest and source, and sets the one required profile', () => {
    const m = newMachine();
    m.install('1.0.0');
    const newest = m.install('1.4.0');
    m.install('2.0.0');
    const root = m.project('platform');
    editConfig(root, (doc) => {
      doc.composition = { requirePolicies: [{ pack: 'acme-base', version: '^1.0', profile: 'strict' }, { pack: 'audit-trail', version: '^3' }] };
    });
    bindRoot(root);
    const creation = createMember('svc', 'services/svc', undefined, 'project');
    expect(creation.configCreated).toBe(true);
    expect(creation.adopted).toEqual([{ name: 'acme-base', version: '1.4.0', integrity: newest.digest, source: 'https://packs.example.test/acme-base-1.4.0.wpack' }]);
    expect(creation.unadopted).toEqual([{ pack: 'audit-trail', version: '^3' }]);
    expect(creation.projectType).toBe('strict');
    const member = readConfig(path.join(root, 'services', 'svc'));
    expect(member.projectType).toBe('strict');
    expect((member.extensions as { packs: unknown[] }).packs).toEqual(creation.adopted);
    // The family run then judges it adopted, and reports the unsatisfiable one.
    const run = familyAt(root);
    expect(codes(run, 'POLICY_NOT_ADOPTED').map((i) => i.message)).toEqual([expect.stringMatching(/"audit-trail" \^3/)]);
  });

  it('writes nothing into a configuration that already exists, and nothing the second time', () => {
    const m = newMachine();
    m.install('1.2.0');
    const root = m.project('platform');
    editConfig(root, (doc) => { doc.composition = { requirePolicies: [{ pack: 'acme-base', version: '^1.2' }] }; });
    bindRoot(root);
    const first = createMember('svc', 'services/svc', undefined, 'project');
    expect(first.adopted).toHaveLength(1);
    const memberDir = path.join(root, 'services', 'svc');
    // The member drops the selection; a second create must not bring it back.
    memberSelects(memberDir, []);
    bindRoot(root);
    const again = createMember('svc', 'services/svc', undefined, 'project');
    expect(again).toEqual({ configCreated: false, adopted: [], unadopted: [], as: 'project', storage: 'contained' });
    expect((readConfig(memberDir).extensions as { packs: unknown[] }).packs).toEqual([]);
    // A directory that already had its own configuration is completed, never given selections.
    const existing = m.project('ledger', path.join(root, 'services'));
    bindRoot(root);
    const adoptedExisting = createMember('ledger', 'services/ledger', undefined, 'project');
    expect(adoptedExisting.configCreated).toBe(false);
    expect(readConfig(existing).extensions).toBeUndefined();
  });

  it('a project that requires nothing scaffolds a member with no selections', () => {
    const m = newMachine();
    m.install('1.2.0');
    const root = m.project('platform');
    bindRoot(root);
    expect(createMember('svc', 'services/svc', undefined, 'project')).toEqual({ configCreated: true, adopted: [], unadopted: [], as: 'project', storage: 'contained' });
    expect(readConfig(path.join(root, 'services', 'svc')).extensions).toBeUndefined();
  });
});
