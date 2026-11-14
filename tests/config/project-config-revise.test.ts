import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { projectConfigRepositoryAt } from '../../src/config/project-config.js';

// ---------------------------------------------------------------------------
// The configuration revisions: reviseRules (a lowering below a code's default
// needs its reason), reviseDebt (the conformance debt register, its comments
// kept) and reviseProject (the project's own settings and the approval parts
// they move). Each answers before and after, and writes only when asked to and
// something changed.
// ---------------------------------------------------------------------------

const roots: string[] = [];
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

const lines = (...l: string[]): string => `${l.join('\n')}\n`;

/** A minimal configuration plus extra `rules` text. */
function project(extra = ''): string {
  return lines(
    "schemaVersion: '1.0.0'",
    'name: ledger',
    'projectType: backend',
    'targets: []',
    extra.replace(/\n$/, ''),
    "createdAt: '2026-01-01T00:00:00.000Z'",
    "updatedAt: '2026-01-01T00:00:00.000Z'",
  ).replace(/\n\n/g, '\n');
}

function tempProject(text: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-revise-'));
  roots.push(dir);
  fs.mkdirSync(path.join(dir, '.wai'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.wai', 'project.yaml'), text);
  return dir;
}

const fileOf = (root: string): string => path.join(root, '.wai', 'project.yaml');
const textOf = (root: string): string => fs.readFileSync(fileOf(root), 'utf8');
const docOf = (root: string): Record<string, any> => yaml.load(textOf(root)) as Record<string, any>;

const DEFAULTS = { UNUSED_COMPONENT: 'warning', CIRCULAR_DEPENDENCY: 'error', ORPHAN_NOTE: 'notice' };

describe('reviseRules', () => {
  it('sets, unsets, adds to and removes from the paths it names', () => {
    const root = tempProject(project('rules:\n  conformance:\n    sourceRoots:\n      - src\n'));
    const repo = projectConfigRepositoryAt(root);
    const set = repo.reviseRules({ set: { 'conformance.requireCode': true, designDepth: 'interfaces' } }, DEFAULTS, false);
    expect(set.wrote).toBe(true);
    expect(set.before.conformance?.requireCode).toBeUndefined();
    expect(set.after.conformance?.requireCode).toBe(true);
    expect(docOf(root).rules.conformance.requireCode).toBe(true);
    expect(docOf(root).rules.designDepth).toBe('interfaces');
    expect(docOf(root).rules.conformance.sourceRoots).toEqual(['src']);

    const added = repo.reviseRules({ add: { 'conformance.sourceRoots': ['lib', 'src'], 'conformance.testRoots': ['tests'] } }, DEFAULTS, false);
    expect(added.after.conformance?.sourceRoots).toEqual(['src', 'lib']);
    expect(docOf(root).rules.conformance.testRoots).toEqual(['tests']);

    const removed = repo.reviseRules({ remove: { 'conformance.sourceRoots': ['src'] }, unset: ['designDepth'] }, DEFAULTS, false);
    expect(removed.after.conformance?.sourceRoots).toEqual(['lib']);
    expect(docOf(root).rules.designDepth).toBeUndefined();
    expect(removed.wrote).toBe(true);

    const same = repo.reviseRules({ add: { 'conformance.sourceRoots': ['lib'] } }, DEFAULTS, false);
    expect(same.wrote).toBe(false);
  });

  it('refuses a lowering without why, and writes the reason beside a lowering that has one', () => {
    const root = tempProject(project());
    const repo = projectConfigRepositoryAt(root);
    const before = textOf(root);
    expect(() => repo.reviseRules({ set: { 'sddRuleSeverity.UNUSED_COMPONENT': 'notice' } }, DEFAULTS, false)).toThrow(/UNUSED_COMPONENT.*lowers it.*why/s);
    expect(textOf(root)).toBe(before);

    const lowered = repo.reviseRules({ set: { 'sddRuleSeverity.UNUSED_COMPONENT': 'notice' }, why: 'Components arrive before their callers here.' }, DEFAULTS, false);
    expect(lowered.lowered).toEqual([{ code: 'UNUSED_COMPONENT', from: 'warning', to: 'notice', why: 'Components arrive before their callers here.' }]);
    expect(docOf(root).rules.sddRuleSeverity).toEqual({ UNUSED_COMPONENT: 'notice' });
    expect(docOf(root).rules.severityReasons).toEqual({ UNUSED_COMPONENT: 'Components arrive before their callers here.' });

    // Raising a code is no lowering and needs no reason.
    const raised = repo.reviseRules({ set: { 'sddRuleSeverity.ORPHAN_NOTE': 'warning' } }, DEFAULTS, false);
    expect(raised.lowered).toEqual([]);
    expect(raised.wrote).toBe(true);
  });

  it('drops the reason when the severity is set back to its default or unset', () => {
    const root = tempProject(project());
    const repo = projectConfigRepositoryAt(root);
    repo.reviseRules({ set: { 'sddRuleSeverity.UNUSED_COMPONENT': 'off', 'sddRuleSeverity.ORPHAN_NOTE': 'off' }, why: 'Known noise.' }, DEFAULTS, false);
    expect(Object.keys(docOf(root).rules.severityReasons).sort()).toEqual(['ORPHAN_NOTE', 'UNUSED_COMPONENT']);

    repo.reviseRules({ set: { 'sddRuleSeverity.UNUSED_COMPONENT': 'warning' } }, DEFAULTS, false);
    expect(docOf(root).rules.severityReasons).toEqual({ ORPHAN_NOTE: 'Known noise.' });

    const unset = repo.reviseRules({ unset: ['sddRuleSeverity.ORPHAN_NOTE'] }, DEFAULTS, false);
    expect(unset.after.severityReasons).toBeUndefined();
    expect(docOf(root).rules.severityReasons).toBeUndefined();
  });

  it('reports only the codes this change newly lowers', () => {
    const root = tempProject(project());
    const repo = projectConfigRepositoryAt(root);
    repo.reviseRules({ set: { 'sddRuleSeverity.UNUSED_COMPONENT': 'notice' }, why: 'First reason.' }, DEFAULTS, false);
    const second = repo.reviseRules({ set: { 'sddRuleSeverity.CIRCULAR_DEPENDENCY': 'warning' }, why: 'Second reason.' }, DEFAULTS, false);
    expect(second.lowered.map((l) => l.code)).toEqual(['CIRCULAR_DEPENDENCY']);
    expect(docOf(root).rules.severityReasons.UNUSED_COMPONENT).toBe('First reason.');
  });

  it('refuses a path under conformance.carried, an unknown path and a value the schema rejects, naming it', () => {
    const root = tempProject(project());
    const repo = projectConfigRepositoryAt(root);
    const before = textOf(root);
    expect(() => repo.reviseRules({ set: { 'conformance.carried': [] } }, DEFAULTS, false)).toThrow(/conformance\.carried.*debt register/s);
    expect(() => repo.reviseRules({ add: { 'conformance.carried.0.findings': ['x'] } }, DEFAULTS, false)).toThrow(/conformance\.carried/);
    expect(() => repo.reviseRules({ set: { 'conformance.nonsense': 1 } }, DEFAULTS, false)).toThrow(/"conformance\.nonsense".*"nonsense" is not a rules field/s);
    expect(() => repo.reviseRules({ set: { 'conformance.requireCode': 'yes' } }, DEFAULTS, false)).toThrow(/rules\.conformance\.requireCode/);
    expect(() => repo.reviseRules({ set: { 'sddRuleSeverity.UNUSED_COMPONENT': 'loud' } }, DEFAULTS, false)).toThrow(/rules\.sddRuleSeverity\.UNUSED_COMPONENT/);
    expect(() => repo.reviseRules({ add: { designDepth: ['x'] } }, DEFAULTS, false)).toThrow(/not a list/);
    expect(textOf(root)).toBe(before);
  });

  it('writes nothing on a dry run, and answers what it would do', () => {
    const root = tempProject(project());
    const repo = projectConfigRepositoryAt(root);
    const before = textOf(root);
    const dry = repo.reviseRules({ set: { 'sddRuleSeverity.UNUSED_COMPONENT': 'off' }, why: 'Noise.' }, DEFAULTS, true);
    expect(dry.wrote).toBe(false);
    expect(dry.lowered).toHaveLength(1);
    expect(dry.after.sddRuleSeverity).toEqual({ UNUSED_COMPONENT: 'off' });
    expect(dry.before.sddRuleSeverity).toEqual({});
    expect(textOf(root)).toBe(before);
  });

  it('is refused for a project without a configuration', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-revise-'));
    roots.push(dir);
    expect(() => projectConfigRepositoryAt(dir).reviseRules({ unset: ['designDepth'] }, DEFAULTS, false)).toThrow();
  });
});

const DEBT = lines(
  'rules:',
  '  conformance:',
  '    carried:',
  '      # 2 findings, 2 units.',
  '      - kind: drift',
  '        why: The adapter is modelled as three components but written as one file.',
  '        findings:',
  '          - code: UNDECLARED_COLOCATED_CALL',
  '            spec: order_adapter_impl',
  '            at: place',
  '            covers:',
  '              - a -> b',
  '          - code: CALL_STEP_UNREALIZED',
  '            spec: order_adapter_impl',
  '            at: cancel',
  '      # 1 finding.',
  '      - kind: undecided',
  '        why: Waiting on the payments boundary decision.',
  '        revisit: Is payments its own project?',
  '        findings:',
  '          - code: CALL_STEP_UNREALIZED',
  '            spec: payment_flow_impl',
  '            at: charge',
);

const CARRYABLE = ['UNDECLARED_COLOCATED_CALL', 'CALL_STEP_UNREALIZED'];

describe('reviseDebt', () => {
  const setup = (): { root: string; repo: ReturnType<typeof projectConfigRepositoryAt> } => {
    const root = tempProject(project(DEBT));
    return { root, repo: projectConfigRepositoryAt(root) };
  };

  it('adds a reason group, extends it, revises it and removes findings and groups', () => {
    const { root, repo } = setup();
    const added = repo.reviseDebt({
      action: 'add', kind: 'unreadable', why: 'The router is a dispatch table the reader cannot follow.', revisit: 'Teach the reader the table shape.',
      findings: [{ code: 'CALL_STEP_UNREALIZED', spec: 'router_impl', at: 'route' }],
    }, CARRYABLE, false);
    expect(added.before).toHaveLength(2);
    expect(added.after).toHaveLength(3);
    expect(added.wrote).toBe(true);
    expect(docOf(root).rules.conformance.carried[2]).toMatchObject({ kind: 'unreadable', revisit: 'Teach the reader the table shape.' });

    const extended = repo.reviseDebt({ action: 'extend', group: 2, findings: [{ code: 'CALL_STEP_UNREALIZED', spec: 'router_impl', at: 'reroute' }] }, CARRYABLE, false);
    expect(extended.after[2].findings.map((f) => f.at)).toEqual(['route', 'reroute']);

    const revised = repo.reviseDebt({ action: 'revise', group: 2, kind: 'drift', why: 'Now understood.', revisit: null }, CARRYABLE, false);
    expect(revised.after[2]).toMatchObject({ kind: 'drift', why: 'Now understood.' });
    expect(revised.after[2].revisit).toBeUndefined();
    expect(docOf(root).rules.conformance.carried[2].revisit).toBeUndefined();

    const some = repo.reviseDebt({ action: 'remove', group: 2, findings: [{ code: 'CALL_STEP_UNREALIZED', spec: 'router_impl', at: 'route' }] }, CARRYABLE, false);
    expect(some.after[2].findings.map((f) => f.at)).toEqual(['reroute']);
    // Removing the last finding drops the group.
    const last = repo.reviseDebt({ action: 'remove', group: 2, findings: [{ code: 'CALL_STEP_UNREALIZED', spec: 'router_impl', at: 'reroute' }] }, CARRYABLE, false);
    expect(last.after).toHaveLength(2);
    // Removing with no findings drops the whole group.
    const whole = repo.reviseDebt({ action: 'remove', group: 1 }, CARRYABLE, false);
    expect(whole.after).toHaveLength(1);
    expect(docOf(root).rules.conformance.carried).toHaveLength(1);
  });

  it('keeps the register\'s comments and every other line when it changes', () => {
    const { root, repo } = setup();
    repo.reviseDebt({ action: 'extend', group: 1, findings: [{ code: 'CALL_STEP_UNREALIZED', spec: 'payment_flow_impl', at: 'refund' }] }, CARRYABLE, false);
    const text = textOf(root);
    expect(text).toContain('# 2 findings, 2 units.');
    expect(text).toContain('# 1 finding.');
    expect(text).toContain('at: refund');
    expect(text).toContain('name: ledger');
  });

  it('removes the register when its last group goes', () => {
    const { root, repo } = setup();
    repo.reviseDebt({ action: 'remove', group: 1 }, CARRYABLE, false);
    repo.reviseDebt({ action: 'remove', group: 0 }, CARRYABLE, false);
    expect(docOf(root).rules?.conformance?.carried).toBeUndefined();
  });

  it('refuses an uncarryable code, a position the register does not hold and an add without kind and why', () => {
    const { root, repo } = setup();
    const before = textOf(root);
    expect(() => repo.reviseDebt({ action: 'extend', group: 0, findings: [{ code: 'CIRCULAR_DEPENDENCY', spec: 'a', at: 'b' }] }, CARRYABLE, false))
      .toThrow(/CIRCULAR_DEPENDENCY.*not a code a rule declares carryable/s);
    expect(() => repo.reviseDebt({ action: 'revise', group: 5, why: 'x' }, CARRYABLE, false)).toThrow(/position 5.*holds 2 reason groups/s);
    expect(() => repo.reviseDebt({ action: 'remove', group: -1 }, CARRYABLE, false)).toThrow(/position -1/);
    expect(() => repo.reviseDebt({ action: 'extend', findings: [] }, CARRYABLE, false)).toThrow(/position/);
    expect(() => repo.reviseDebt({ action: 'add', why: 'no kind' }, CARRYABLE, false)).toThrow(/kind and its why/);
    expect(() => repo.reviseDebt({ action: 'add', kind: 'drift' }, CARRYABLE, false)).toThrow(/kind and its why/);
    expect(textOf(root)).toBe(before);
  });

  it('writes nothing on a dry run, and nothing when the register already reads that way', () => {
    const { root, repo } = setup();
    const before = textOf(root);
    const dry = repo.reviseDebt({ action: 'remove', group: 0 }, CARRYABLE, true);
    expect(dry.wrote).toBe(false);
    expect(dry.after).toHaveLength(1);
    expect(textOf(root)).toBe(before);
    const same = repo.reviseDebt({ action: 'extend', group: 0, findings: [{ code: 'CALL_STEP_UNREALIZED', spec: 'order_adapter_impl', at: 'cancel' }] }, CARRYABLE, false);
    expect(same.wrote).toBe(false);
    expect(textOf(root)).toBe(before);
  });
});

describe('reviseDebt keeps each comment above its own group', () => {
  const THREE = lines(
    'rules:',
    '  conformance:',
    '    carried:',
    '      # first group note',
    '      - kind: drift',
    '        why: First reason.',
    '        findings:',
    '          - code: CALL_STEP_UNREALIZED',
    '            spec: first_impl',
    '            at: one',
    '      # middle group note',
    '      - kind: undecided',
    '        why: Middle reason.',
    '        findings:',
    '          - code: CALL_STEP_UNREALIZED',
    '            spec: middle_impl',
    '            at: two',
    '      # last group note',
    '      - kind: unreadable',
    '        why: Last reason.',
    '        findings:',
    '          - code: CALL_STEP_UNREALIZED',
    '            spec: last_impl',
    '            at: three',
  );

  /** The line holding each note must be followed directly by the group with that reason. */
  const expectNoteAbove = (text: string, note: string, why: string): void => {
    const rows = text.split(/\r?\n/);
    const at = rows.findIndex((r) => r.trim() === note);
    expect(at, `${note} is kept`).toBeGreaterThan(-1);
    expect(rows[at + 1].trim()).toMatch(/^- kind:/);
    expect(rows[at + 2].trim()).toBe(`why: ${why}`);
  };

  it('removing a middle group takes its own comment and leaves the others where they were', () => {
    const root = tempProject(project(THREE));
    projectConfigRepositoryAt(root).reviseDebt({ action: 'remove', group: 1 }, CARRYABLE, false);
    const text = textOf(root);
    expect(text).not.toContain('middle group note');
    expect(text).not.toContain('Middle reason');
    expectNoteAbove(text, '# first group note', 'First reason.');
    expectNoteAbove(text, '# last group note', 'Last reason.');
    expect(docOf(root).rules.conformance.carried.map((g: { why: string }) => g.why)).toEqual(['First reason.', 'Last reason.']);
  });

  it('removing the first group takes its comment too', () => {
    const root = tempProject(project(THREE));
    projectConfigRepositoryAt(root).reviseDebt({ action: 'remove', group: 0 }, CARRYABLE, false);
    const text = textOf(root);
    expect(text).not.toContain('first group note');
    expectNoteAbove(text, '# middle group note', 'Middle reason.');
    expectNoteAbove(text, '# last group note', 'Last reason.');
  });

  it('emptying a middle group by removing its findings drops the group with its comment', () => {
    const root = tempProject(project(THREE));
    projectConfigRepositoryAt(root).reviseDebt(
      { action: 'remove', group: 1, findings: [{ code: 'CALL_STEP_UNREALIZED', spec: 'middle_impl', at: 'two' }] }, CARRYABLE, false,
    );
    const text = textOf(root);
    expect(text).not.toContain('middle group note');
    expectNoteAbove(text, '# first group note', 'First reason.');
    expectNoteAbove(text, '# last group note', 'Last reason.');
  });
});

describe('reviseProject', () => {
  it('writes each stated field and keeps the others', () => {
    const root = tempProject(project());
    const repo = projectConfigRepositoryAt(root);
    const revision = repo.reviseProject({ name: 'ledger-core', description: 'The ledger.', executionTier: 'trade' }, false);
    expect(revision.wrote).toBe(true);
    expect(revision.before.name).toBe('ledger');
    expect(revision.after).toMatchObject({ name: 'ledger-core', description: 'The ledger.' });
    expect(revision.after.execution.tier).toBe('trade');
    expect(docOf(root)).toMatchObject({ name: 'ledger-core', description: 'The ledger.', projectType: 'backend' });
    expect(revision.approvalMoves).toEqual([]);
  });

  it('names the approval parts a change moves', () => {
    const root = tempProject(project());
    const repo = projectConfigRepositoryAt(root);
    const packs = repo.reviseProject({ selectPacks: [{ name: 'house-doctrine' }] }, false);
    expect(packs.approvalMoves).toEqual(['packs']);
    expect(docOf(root).extensions.packs).toEqual([{ name: 'house-doctrine' }]);
    expect(docOf(root).extensions.useGlobalPacks).toBe(false);

    const global = repo.reviseProject({ useGlobalPacks: true }, false);
    expect(global.approvalMoves).toEqual(['packs']);

    const deselected = repo.reviseProject({ deselectPacks: ['house-doctrine'] }, false);
    expect(deselected.approvalMoves).toEqual(['packs']);
    expect(docOf(root).extensions.packs).toEqual([]);

    const composition = repo.reviseProject({ composition: { requireApprovedMembers: true } }, false);
    expect(composition.approvalMoves).toEqual(['composition']);
    expect(docOf(root).composition).toEqual({ requireApprovedMembers: true });

    const type = repo.reviseProject({ projectType: 'frontend' }, false);
    expect(type.approvalMoves).toEqual(['rules']);
    expect(docOf(root).projectType).toBe('frontend');
  });

  it('moves a re-selected pack last and replaces the targets', () => {
    const root = tempProject(project());
    const repo = projectConfigRepositoryAt(root);
    repo.reviseProject({ selectPacks: [{ name: 'a-pack' }, { name: 'b-pack' }] }, false);
    const again = repo.reviseProject({ selectPacks: [{ name: 'a-pack', version: '1.0.0' }], targets: [{ type: 'claude', outputDir: '.claude/agents' }] }, false);
    expect(docOf(root).extensions.packs).toEqual([{ name: 'b-pack' }, { name: 'a-pack', version: '1.0.0' }]);
    expect(again.after.targets).toEqual([{ type: 'claude', outputDir: '.claude/agents' }]);
  });

  it('refuses a value the schema rejects, naming it, and writes nothing on a dry run or an equal change', () => {
    const root = tempProject(project());
    const repo = projectConfigRepositoryAt(root);
    const before = textOf(root);
    expect(() => repo.reviseProject({ executionTier: 'turbo' }, false)).toThrow(/execution\.tier/);
    expect(() => repo.reviseProject({ selectPacks: [{ name: '' }] }, false)).toThrow(/extensions\.packs/);
    expect(textOf(root)).toBe(before);
    const dry = repo.reviseProject({ name: 'other' }, true);
    expect(dry.wrote).toBe(false);
    expect(dry.after.name).toBe('other');
    expect(textOf(root)).toBe(before);
    expect(repo.reviseProject({ name: 'ledger' }, false).wrote).toBe(false);
  });
});
