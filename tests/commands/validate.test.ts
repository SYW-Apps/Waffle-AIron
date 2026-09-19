import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { carriedDebtSummary, isCiDraftWaivable, validateAsComplete } from '../../src/commands/validate.js';
import type { CarriedDebt } from '../../src/models/project.js';
import { validateSddTree } from '../../src/core/validation.js';
import type { ValidationIssue } from '../../src/core/validation.js';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';

// ---------------------------------------------------------------------------
// --ci draft-tolerance policy (validate command)
//
// SDD has an explicit draft → design → complete lifecycle, so the --ci gate
// must waive warnings that merely reflect declared drafts while keeping the
// gate strict for finished work. `isCiDraftWaivable` encodes exactly which
// warnings are excluded from the --ci failure decision. The warnings are still
// emitted/printed — this only classifies the pass/fail decision.
// ---------------------------------------------------------------------------

function warn(code: string, extra: Partial<ValidationIssue> = {}): ValidationIssue {
  return { severity: 'warning', code, message: `${code} message`, ...extra };
}

// ---------------------------------------------------------------------------
// The conformance debt register's own line, and the one thing an audit can
// never check: whether a `why` is TRUE. A group that admits its classification
// is unsettled says so with `revisit`, and every run counts those findings
// beside the kind totals — a confident-sounding reason that is wrong reads as
// settled, and silence is what lets nobody look again.
// ---------------------------------------------------------------------------

const group = (kind: CarriedDebt['kind'], findings: number, revisit?: string): CarriedDebt => ({
  kind,
  why: `carried because the ${kind} is not paid yet`,
  ...(revisit ? { revisit } : {}),
  findings: Array.from({ length: findings }, (_, i) => ({
    code: 'CALL_STEP_UNREALIZED',
    spec: `billing_orchestrator_impl`,
    at: `settleInvoice${i}`,
    covers: ['1:ledger_store.append', '2:ledger_store.commit'],
  })),
});

describe('carriedDebtSummary (the register said out loud)', () => {
  it('says nothing at all when the register is empty', () => {
    expect(carriedDebtSummary(undefined)).toBeNull();
    expect(carriedDebtSummary([])).toBeNull();
  });

  it('counts findings, units and kinds, and stays silent about re-evaluation when nothing is marked', () => {
    const summary = carriedDebtSummary([group('drift', 2), group('unreadable', 1)]);
    expect(summary?.line).toContain('3 finding(s) over 6 unit(s) carried');
    expect(summary?.line).toContain('2 drift, 0 undecided, 1 unreadable');
    expect(summary?.line).not.toContain('re-evaluation');
    expect(summary?.revisits).toEqual([]);
  });

  it('counts the findings of every group marked provisional, and prints what would settle each', () => {
    const summary = carriedDebtSummary([
      group('drift', 2, 'Prove the adapters are realized by the file that consumes them.'),
      group('unreadable', 1),
      group('undecided', 3, 'Decide whether the alias or the target is wrong.'),
    ]);
    expect(summary?.line).toContain('5 finding(s) in 2 group(s) are marked for re-evaluation');
    expect(summary?.revisits).toEqual([
      '  re-evaluate (drift, 2 finding(s)): Prove the adapters are realized by the file that consumes them.',
      '  re-evaluate (undecided, 3 finding(s)): Decide whether the alias or the target is wrong.',
    ]);
  });
});

describe('isCiDraftWaivable (--ci draft tolerance)', () => {
  it('waives DRAFT_COMPONENT_WARNING (it only exists to surface a draft)', () => {
    expect(isCiDraftWaivable(warn('DRAFT_COMPONENT_WARNING', { draftContext: true }))).toBe(true);
    // Robust even if the draftContext flag were ever absent for this code.
    expect(isCiDraftWaivable(warn('DRAFT_COMPONENT_WARNING'))).toBe(true);
  });

  it('waives DRAFT_SUBSYSTEM_WARNING exactly like the component variant', () => {
    // integrity/hierarchy-integrity.ts emits it with the same unconditional
    // draftContext as DRAFT_COMPONENT_WARNING — it is a pure status notice, so
    // a fresh draft tree must not fail --ci on it.
    expect(isCiDraftWaivable(warn('DRAFT_SUBSYSTEM_WARNING', { draftContext: true }))).toBe(true);
    // Robust even if the draftContext flag were ever absent for this code.
    expect(isCiDraftWaivable(warn('DRAFT_SUBSYSTEM_WARNING'))).toBe(true);
  });

  it('waives UNUSED_COMPONENT only when the referenced component is draft/design', () => {
    // Draft/design component → non-fatal.
    expect(isCiDraftWaivable(warn('UNUSED_COMPONENT', { specId: 'draft_store', draftContext: true }))).toBe(true);
    // Complete component (no draftContext) → stays fatal.
    expect(isCiDraftWaivable(warn('UNUSED_COMPONENT', { specId: 'complete_store' }))).toBe(false);
    expect(isCiDraftWaivable(warn('UNUSED_COMPONENT', { specId: 'complete_store', draftContext: false }))).toBe(false);
  });

  it('keeps every other warning fatal in --ci mode, even in a draft context', () => {
    expect(isCiDraftWaivable(warn('MISSING_ENDPOINT', { draftContext: true }))).toBe(false);
    expect(isCiDraftWaivable(warn('UNUSED_METHOD', { draftContext: true }))).toBe(false);
    expect(isCiDraftWaivable(warn('CIRCULAR_DEPENDENCY'))).toBe(false);
  });

  it('never waives an error, regardless of code or draft context', () => {
    expect(isCiDraftWaivable({ severity: 'error', code: 'UNUSED_COMPONENT', message: 'x', draftContext: true })).toBe(false);
    expect(isCiDraftWaivable({ severity: 'error', code: 'DRAFT_COMPONENT_WARNING', message: 'x', draftContext: true })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// cli_validator_adapter.validateAsComplete — the forwarder `wairon lock` gates
// on. A draft tree can hide completeness errors (they downgrade to warnings
// while draft); the as-complete gate must surface them as errors WITHOUT
// touching anything on disk.
// ---------------------------------------------------------------------------

const META = `createdAt: '2026-06-10T22:00:00Z'\nupdatedAt: '2026-06-10T22:00:00Z'`;

/** Draft HTTP portal whose interface method has NO endpoint — a warning while
 *  draft, a hard error once treated as complete. */
function createDraftPortalProject(): { tempDir: string; specsDir: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-va-complete-'));
  const waiDir = path.join(tempDir, '.wai');
  fs.mkdirSync(waiDir);
  fs.writeFileSync(path.join(waiDir, 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0',
    name: 'va-complete',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {},
  }));
  const specsDir = path.join(waiDir, 'specs');
  for (const d of ['subsystems', 'components', 'interfaces']) {
    fs.mkdirSync(path.join(specsDir, d), { recursive: true });
  }
  fs.writeFileSync(path.join(specsDir, '.index.yaml'),
    `schemaVersion: 1.0.0\nname: VaSystem\nvision: A system for the gate\n${META}\n`);
  fs.writeFileSync(path.join(specsDir, 'subsystems', 'sub-a.yaml'),
    `schemaVersion: 1.0.0\nid: sub-a\nname: SubA\ndescription: Subsystem A\nparentSystem: VaSystem\nstatus: draft\n${META}\n`);
  fs.writeFileSync(path.join(specsDir, 'components', 'comp-a.yaml'),
    `schemaVersion: 1.0.0\nid: comp-a\nname: CompA\ndescription: HTTP portal\nsubsystem: sub-a\ncomponentType: Portal\nportalType: HTTP_API\ndependsOn: []\nstatus: draft\n${META}\n`);
  fs.writeFileSync(path.join(specsDir, 'interfaces', 'icomp-a.yaml'),
    `schemaVersion: 1.0.0\nid: icomp-a\nname: ICompA\ndescription: Interface A\ncomponent: comp-a\nstatus: draft\nmethods:\n  - name: callApi\n    description: Api method\n    signature: "callApi(): Promise<void>"\n    returns: "Promise<void>"\n${META}\n`);
  setProjectRoot(tempDir);
  invalidateSpecCache();
  return { tempDir, specsDir };
}

/** Minimal draft tree: system + one draft subsystem, nothing else. The only
 *  issue it can raise is the pure status notice DRAFT_SUBSYSTEM_WARNING. */
function createDraftSubsystemOnlyProject(): { tempDir: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-ci-draft-'));
  const waiDir = path.join(tempDir, '.wai');
  fs.mkdirSync(waiDir);
  fs.writeFileSync(path.join(waiDir, 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0',
    name: 'ci-draft',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {},
  }));
  const specsDir = path.join(waiDir, 'specs');
  fs.mkdirSync(path.join(specsDir, 'subsystems'), { recursive: true });
  fs.writeFileSync(path.join(specsDir, '.index.yaml'),
    `schemaVersion: 1.0.0\nname: CiDraftSystem\nvision: A freshly initialized system still being designed\n${META}\n`);
  fs.writeFileSync(path.join(specsDir, 'subsystems', 'sub-a.yaml'),
    `schemaVersion: 1.0.0\nid: sub-a\nname: SubA\ndescription: The first subsystem of the draft design\nparentSystem: CiDraftSystem\nstatus: draft\n${META}\n`);
  setProjectRoot(tempDir);
  invalidateSpecCache();
  return { tempDir };
}

/** The --ci failure decision as runValidate computes it over tree issues:
 *  any error, or any warning that is not draft-waivable, fails the gate. */
function ciFails(issues: ValidationIssue[]): boolean {
  return issues.some((i) => i.severity === 'error' || (i.severity === 'warning' && !isCiDraftWaivable(i)));
}

describe('--ci failure decision over a real tree (draft-waiver end to end)', () => {
  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
  });

  it('a fresh draft tree passes --ci: DRAFT_SUBSYSTEM_WARNING fires but is waived', () => {
    const proj = createDraftSubsystemOnlyProject();
    try {
      const result = validateSddTree();
      const draftWarn = result.issues.find((i) => i.code === 'DRAFT_SUBSYSTEM_WARNING');
      // The rule still fires and is still surfaced — the waiver only
      // classifies the failure decision, it does not silence the rule.
      expect(draftWarn?.severity).toBe('warning');
      expect(draftWarn?.draftContext).toBe(true);
      expect(ciFails(result.issues)).toBe(false);
    } finally {
      fs.rmSync(proj.tempDir, { recursive: true, force: true });
    }
  });

  it('control: a draft-downgraded completeness warning (MISSING_ENDPOINT) still fails --ci', () => {
    // DRAFT_SUBSYSTEM_WARNING cannot be emitted without draftContext
    // (integrity/hierarchy-integrity.ts hardcodes it), so the control is a
    // different draft-context warning that the waiver must NOT cover: an
    // unbound Portal method, downgraded to a warning while the tree is draft,
    // is real unfinished work — the gate stays strict.
    const proj = createDraftPortalProject();
    try {
      const result = validateSddTree();
      const missing = result.issues.find((i) => i.code === 'MISSING_ENDPOINT');
      expect(missing?.severity).toBe('warning');
      expect(missing?.draftContext).toBe(true);
      expect(ciFails(result.issues)).toBe(true);
    } finally {
      fs.rmSync(proj.tempDir, { recursive: true, force: true });
    }
  });
});

describe('validateAsComplete (the lock gate forwarder)', () => {
  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
  });

  it('surfaces draft-hidden completeness errors that a normal validate does not', () => {
    const proj = createDraftPortalProject();
    try {
      const asDraft = validateSddTree();
      expect(asDraft.issues.some((i) => i.code === 'MISSING_ENDPOINT' && i.severity === 'error')).toBe(false);

      const asComplete = validateAsComplete();
      expect(asComplete.issues.some((i) => i.code === 'MISSING_ENDPOINT' && i.severity === 'error')).toBe(true);
      expect(asComplete.valid).toBe(false);
    } finally {
      fs.rmSync(proj.tempDir, { recursive: true, force: true });
    }
  });

  it('leaves every spec file byte-for-byte unchanged (the flip is in-memory only)', () => {
    const proj = createDraftPortalProject();
    try {
      const before = fs.readFileSync(path.join(proj.specsDir, 'components', 'comp-a.yaml'), 'utf8');
      validateAsComplete();
      const after = fs.readFileSync(path.join(proj.specsDir, 'components', 'comp-a.yaml'), 'utf8');
      expect(after).toBe(before);
      expect(after).toContain('status: draft');

      // Later reads still see the tree at its real statuses.
      invalidateSpecCache();
      expect(validateSddTree().issues.some((i) => i.code === 'MISSING_ENDPOINT' && i.severity === 'error')).toBe(false);
    } finally {
      fs.rmSync(proj.tempDir, { recursive: true, force: true });
    }
  });
});
