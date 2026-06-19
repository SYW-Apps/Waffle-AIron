import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { validateSddTree } from '../../src/core/validation.js';
import {
  collectPromotableSpecs,
  applySpecStatus,
  snapshotSpecFiles,
  restoreSpecFiles,
  invalidateSpecCache,
} from '../../src/core/specs.js';

const META = `createdAt: '2026-06-10T22:00:00Z'\nupdatedAt: '2026-06-10T22:00:00Z'`;

// Minimal on-disk SDD project with everything in `draft`.
function createDraftProject() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-lock-test-'));
  const waiDir = path.join(tempDir, '.wai');
  fs.mkdirSync(waiDir);
  fs.writeFileSync(path.join(waiDir, 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0',
    name: 'test-project',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: { noOverlappingOwnership: true, requireOwnedPaths: true, metaAgentTags: ['meta'], enforceReproducibility: true },
  }));
  const specsDir = path.join(waiDir, 'specs');
  for (const d of ['subsystems', 'components', 'interfaces', 'implementations']) {
    fs.mkdirSync(path.join(specsDir, d), { recursive: true });
  }

  fs.writeFileSync(path.join(specsDir, 'system.yaml'),
    `schemaVersion: 1.0.0\nname: TestSystem\nvision: A system for testing\n${META}\n`);
  fs.writeFileSync(path.join(specsDir, 'subsystems', 'sub-a.yaml'),
    `schemaVersion: 1.0.0\nid: sub-a\nname: SubA\ndescription: Subsystem A\nparentSystem: TestSystem\nstatus: draft\n${META}\n`);
  // Portal HTTP_API whose interface method has NO endpoint: a warning while draft,
  // a hard error once complete — the exact case `wairon lock` must catch.
  fs.writeFileSync(path.join(specsDir, 'components', 'comp-a.yaml'),
    `schemaVersion: 1.0.0\nid: comp-a\nname: CompA\ndescription: HTTP portal\nsubsystem: sub-a\ncomponentType: Portal\nportalType: HTTP_API\ndependsOn: []\nstatus: draft\n${META}\n`);
  fs.writeFileSync(path.join(specsDir, 'interfaces', 'icomp-a.yaml'),
    `schemaVersion: 1.0.0\nid: icomp-a\nname: ICompA\ndescription: Interface A\ncomponent: comp-a\nstatus: draft\nmethods:\n  - name: callApi\n    description: Api method\n    signature: "callApi(): Promise<void>"\n    returns: "Promise<void>"\n${META}\n`);

  vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
  invalidateSpecCache();
  return { tempDir, specsDir };
}

describe('spec status promotion (wairon lock core)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    invalidateSpecCache();
  });

  it('collects every non-complete spec', () => {
    const proj = createDraftProject();
    try {
      const promotable = collectPromotableSpecs();
      const ids = promotable.map((p) => `${p.kind}:${p.id}`).sort();
      expect(ids).toEqual(['component:comp-a', 'interface:icomp-a', 'subsystem:sub-a']);
      expect(promotable.every((p) => p.status === 'draft')).toBe(true);
    } finally {
      fs.rmSync(proj.tempDir, { recursive: true, force: true });
    }
  });

  it('validate-as-complete catches what a draft tree hides (and the dry-run restores cleanly)', () => {
    const proj = createDraftProject();
    try {
      // Draft tree: missing endpoint is downgraded to a warning → no errors.
      const asDraft = validateSddTree();
      expect(asDraft.issues.some((i) => i.code === 'MISSING_ENDPOINT' && i.severity === 'error')).toBe(false);

      // Dry-run promotion: snapshot → set all complete → validate → restore.
      const snapshot = snapshotSpecFiles();
      const promotable = collectPromotableSpecs();
      for (const p of promotable) applySpecStatus(p.kind, p.id, 'complete');
      invalidateSpecCache();
      const asComplete = validateSddTree();
      restoreSpecFiles(snapshot);
      invalidateSpecCache();

      // As complete, the hidden completeness error surfaces.
      expect(asComplete.issues.some((i) => i.code === 'MISSING_ENDPOINT' && i.severity === 'error')).toBe(true);

      // Restore is byte-exact: files are back to draft, unchanged.
      const compAfter = fs.readFileSync(path.join(proj.specsDir, 'components', 'comp-a.yaml'), 'utf8');
      expect(compAfter).toContain('status: draft');
      expect(collectPromotableSpecs()).toHaveLength(3);
    } finally {
      fs.rmSync(proj.tempDir, { recursive: true, force: true });
    }
  });

  it('committing the promotion flips every spec to complete', () => {
    const proj = createDraftProject();
    try {
      for (const p of collectPromotableSpecs()) applySpecStatus(p.kind, p.id, 'complete');
      invalidateSpecCache();
      expect(collectPromotableSpecs()).toHaveLength(0);
      const compAfter = fs.readFileSync(path.join(proj.specsDir, 'components', 'comp-a.yaml'), 'utf8');
      expect(compAfter).toContain('status: complete');
    } finally {
      fs.rmSync(proj.tempDir, { recursive: true, force: true });
    }
  });
});
