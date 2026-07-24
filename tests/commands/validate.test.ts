import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isCiDraftWaivable, validateAsComplete } from '../../src/commands/validate.js';
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

describe('isCiDraftWaivable (--ci draft tolerance)', () => {
  it('waives DRAFT_COMPONENT_WARNING (it only exists to surface a draft)', () => {
    expect(isCiDraftWaivable(warn('DRAFT_COMPONENT_WARNING', { draftContext: true }))).toBe(true);
    // Robust even if the draftContext flag were ever absent for this code.
    expect(isCiDraftWaivable(warn('DRAFT_COMPONENT_WARNING'))).toBe(true);
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
