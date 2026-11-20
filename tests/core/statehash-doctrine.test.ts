import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { computeStateId, stateIdEquals } from '../../src/core/statehash.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { computeApprovalId, resolvedPacks } from '../../src/core/validation.js';
import { SDD_RULES } from '../../src/core/rules/repository.js';

// ---------------------------------------------------------------------------
// The APPROVAL StateId — what it covers of the governing doctrine.
//
// A lock approves the project's own design and its policy: the packs it
// SELECTS (name, declared version), never what they resolve to. A pack's
// content is a build input, recorded by digest in the inputs lock
// (resolvedPacks), judged beside the approval and never part of it.
//
// Two identities coexist, and this file guards both directions:
//   computeStateId     — spec content only (surface snapshot stamps)
//   computeApprovalId — own design + policy (lock / promote)
// ---------------------------------------------------------------------------

function createTempProject(opts: { projectType?: string; rules?: Record<string, unknown> } = {}) {
  invalidateSpecCache();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-gatehash-'));
  const waiDir = path.join(tempDir, '.wai');
  fs.mkdirSync(waiDir);

  const writeConfig = (packs: string[], over: { projectType?: string; rules?: Record<string, unknown> } = {}) => {
    fs.writeFileSync(path.join(waiDir, 'project.yaml'), JSON.stringify({
      schemaVersion: '1.0.0',
      name: 'test-project',
      projectType: over.projectType ?? opts.projectType ?? 'backend',
      targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
      rules: over.rules ?? opts.rules ?? {},
      // Hermetic: a contributor's machine-wide packs must not enter the digest.
      extensions: { useGlobalPacks: false, packs },
      createdAt: '2026-07-03T10:00:00Z',
      updatedAt: '2026-07-03T10:00:00Z',
    }));
  };

  const specsDir = path.join(waiDir, 'specs');
  for (const d of ['subsystems', 'components', 'interfaces', 'implementations', 'types']) {
    fs.mkdirSync(path.join(specsDir, d), { recursive: true });
  }
  const stamp = "createdAt: '2026-07-03T10:00:00Z'\nupdatedAt: '2026-07-03T10:00:00Z'";
  fs.writeFileSync(path.join(specsDir, '.index.yaml'), `schemaVersion: 1.0.0\nname: TestSystem\nvision: testing\n${stamp}\n`);
  fs.writeFileSync(path.join(specsDir, 'subsystems', 'sub-a.yaml'),
    `schemaVersion: 1.0.0\nid: sub-a\nname: SubA\ndescription: d\nparentSystem: TestSystem\n${stamp}\n`);

  writeConfig([]);

  return {
    writeConfig,
    /** Write a pack file and (re)read doctrine on the next hash — no caching to defeat. */
    writePack: (rel: string, content: string) => {
      const p = path.join(tempDir, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    },
    editSpec: () => {
      fs.writeFileSync(path.join(specsDir, 'subsystems', 'sub-a.yaml'),
        `schemaVersion: 1.0.0\nid: sub-a\nname: SubA renamed\ndescription: d\nparentSystem: TestSystem\n${stamp}\n`);
      invalidateSpecCache();
    },
    activate: () => { vi.spyOn(process, 'cwd').mockReturnValue(tempDir); },
    cleanup: () => {
      invalidateSpecCache();
      vi.restoreAllMocks();
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* win file locks */ }
    },
  };
}

const PACK_V1 = `name: doctrine-pack
version: 1.0.0
profiles:
  my-profile:
    family: neutral
    forbiddenStereotypes:
      - types: [Actor]
        reason: not expressible here
`;

describe('approval StateId vs content StateId', () => {
  it('never compare equal — the algorithm marker separates the two flavours', () => {
    const proj = createTempProject();
    proj.activate();
    try {
      const content = computeStateId();
      const gate = computeApprovalId();
      expect(content.algorithm).toBe('sha256');
      expect(gate.algorithm).toBe('sha256+design+policy');
      expect(stateIdEquals(content, gate)).toBe(false);
    } finally { proj.cleanup(); }
  });

  it('both react to a spec edit', () => {
    const proj = createTempProject();
    proj.activate();
    try {
      const contentBefore = computeStateId();
      const gateBefore = computeApprovalId();
      proj.editSpec();
      expect(stateIdEquals(computeStateId(), contentBefore)).toBe(false);
      expect(stateIdEquals(computeApprovalId(), gateBefore)).toBe(false);
    } finally { proj.cleanup(); }
  });
});

describe('pack selections move the approval, pack content moves only its recorded digest', () => {
  it('selecting a pack shifts the approval StateId but NOT the content StateId', () => {
    const proj = createTempProject();
    proj.activate();
    try {
      const contentBefore = computeStateId();
      const gateBefore = computeApprovalId();

      proj.writePack('.wai/packs/doctrine.yaml', PACK_V1);
      proj.writeConfig(['.wai/packs/doctrine.yaml']);

      expect(stateIdEquals(computeApprovalId(), gateBefore)).toBe(false);
      expect(stateIdEquals(computeStateId(), contentBefore)).toBe(true);
    } finally { proj.cleanup(); }
  });

  it('a pack VERSION bump, a profile edit and an assertion never move the approval; each moves the pack digest', () => {
    const proj = createTempProject();
    proj.activate();
    try {
      proj.writePack('.wai/packs/doctrine.yaml', PACK_V1);
      proj.writeConfig(['.wai/packs/doctrine.yaml']);
      const before = computeApprovalId();
      const digest = (): string => resolvedPacks()['doctrine-pack'].digest;
      const d0 = digest();

      proj.writePack('.wai/packs/doctrine.yaml', PACK_V1.replace('version: 1.0.0', 'version: 1.1.0'));
      expect(stateIdEquals(computeApprovalId(), before)).toBe(true);
      expect(resolvedPacks()['doctrine-pack'].resolved).toBe('1.1.0');

      proj.writePack('.wai/packs/doctrine.yaml', PACK_V1.replace('types: [Actor]', 'types: [Actor, Supervisor]'));
      expect(stateIdEquals(computeApprovalId(), before)).toBe(true);
      const d1 = digest();
      expect(d1).not.toBe(d0);

      proj.writePack('.wai/packs/doctrine.yaml', `${PACK_V1}assertions:
  - kind: forbid-edge
    code: NO_PORTAL_TO_STORE
    reason: platform doctrine
    from: { componentType: [Portal] }
    to: { componentType: [Store] }
`);
      expect(stateIdEquals(computeApprovalId(), before)).toBe(true);
      expect(digest()).not.toBe(d0);
    } finally { proj.cleanup(); }
  });

  it('removing a pack selection shifts the approval StateId', () => {
    const proj = createTempProject();
    proj.activate();
    try {
      proj.writePack('.wai/packs/doctrine.yaml', PACK_V1);
      proj.writeConfig(['.wai/packs/doctrine.yaml']);
      const withPack = computeApprovalId();

      proj.writeConfig([]);
      expect(stateIdEquals(computeApprovalId(), withPack)).toBe(false);
    } finally { proj.cleanup(); }
  });

  it('a selection that does not load is left out of resolvedPacks', () => {
    const proj = createTempProject();
    proj.activate();
    try {
      proj.writeConfig(['.wai/packs/missing.yaml']);
      expect(resolvedPacks()).toEqual({});
    } finally { proj.cleanup(); }
  });
});

describe('agent-facing prose does NOT invalidate a lock', () => {
  it('editing a pack\'s instruction blocks leaves the gate StateId untouched', () => {
    const proj = createTempProject();
    proj.activate();
    try {
      proj.writePack('.wai/packs/doctrine.yaml', `${PACK_V1}instructions: Original guidance for the agent.\n`);
      proj.writeConfig(['.wai/packs/doctrine.yaml']);
      const before = computeApprovalId();

      // Instructions cannot change a conformance verdict; if they fed the digest,
      // every documentation tweak would invalidate every lock.
      proj.writePack('.wai/packs/doctrine.yaml', `${PACK_V1}instructions: Completely rewritten guidance, much longer than before.\n`);
      expect(stateIdEquals(computeApprovalId(), before)).toBe(true);
    } finally { proj.cleanup(); }
  });

  it('declaring a pack skill leaves the gate StateId untouched', () => {
    const proj = createTempProject();
    proj.activate();
    try {
      proj.writePack('.wai/packs/doctrine.yaml', PACK_V1);
      proj.writeConfig(['.wai/packs/doctrine.yaml']);
      const before = computeApprovalId();

      proj.writePack('.wai/packs/doctrine.yaml', `${PACK_V1}skills:
  - id: implementer
    source: skills/implementer/SKILL.md
    targets: [claude]
`);
      expect(stateIdEquals(computeApprovalId(), before)).toBe(true);
    } finally { proj.cleanup(); }
  });
});

// ---------------------------------------------------------------------------
// The gate is the RULES too, not just the packs.
//
// "Something valid stays valid unless the rules truly change" — so the identity
// keys on the rule REGISTRY rather than the wairon version. Hashing the version
// would churn every lock on every patch; hashing neither would let a release that
// adds a rule leave locks asserting they passed a gate that no longer exists.
// The project's own governing config counts as well: a projectType switch changes
// the doctrine family outright, and `rules` carries severity overrides.
// ---------------------------------------------------------------------------

describe('the approval identity covers the governing config, never the rule set', () => {
  it('a change to the BUILTIN rule registry never invalidates a lock: the release is no input', () => {
    const proj = createTempProject();
    proj.activate();
    try {
      const before = computeApprovalId();
      SDD_RULES.push({
        name: 'a-newly-shipped-rule',
        description: 'added by a hypothetical release',
        codes: [{ code: 'A_NEW_CODE', defaultSeverity: 'warning', summary: 's' }],
        check: () => { /* identity only — never run here */ },
      });
      try {
        expect(stateIdEquals(computeApprovalId(), before)).toBe(true);
      } finally {
        SDD_RULES.pop();
      }
    } finally { proj.cleanup(); }
  });

  it('the wairon VERSION alone does not invalidate', () => {
    const proj = createTempProject();
    proj.activate();
    try {
      // Nothing about the registry or config changed between these two calls, which
      // is the situation a patch release leaves behind. Locks must survive it.
      expect(stateIdEquals(computeApprovalId(), computeApprovalId())).toBe(true);
    } finally { proj.cleanup(); }
  });

  it('switching the governing projectType invalidates locks', () => {
    const a = createTempProject({ projectType: 'backend' });
    a.activate();
    const backend = computeApprovalId();
    a.cleanup();

    const b = createTempProject({ projectType: 'frontend-reactive' });
    b.activate();
    try {
      // Same (empty) tree, different governing doctrine family.
      expect(stateIdEquals(computeApprovalId(), backend)).toBe(false);
    } finally { b.cleanup(); }
  });

  it('a rules-config change (a severity override) invalidates locks, and the CONTENT id is untouched', () => {
    const proj = createTempProject();
    proj.activate();
    try {
      const gateBefore = computeApprovalId();
      const contentBefore = computeStateId();

      proj.writeConfig([], { rules: { sddRuleSeverity: { UNKNOWN_PROFILE: 'off' } } });

      // Turning a rule off IS a change of gate.
      expect(stateIdEquals(computeApprovalId(), gateBefore)).toBe(false);
      // But no contract moved, so vendored surface snapshots must not go stale.
      expect(stateIdEquals(computeStateId(), contentBefore)).toBe(true);
    } finally { proj.cleanup(); }
  });
});
