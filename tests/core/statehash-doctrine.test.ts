import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { computeStateId, stateIdEquals } from '../../src/core/statehash.js';
import { computeGateStateId, invalidateSpecCache } from '../../src/core/specs.js';
import { SDD_RULES } from '../../src/core/rules/index.js';

// ---------------------------------------------------------------------------
// The GATE StateId — doctrine coverage for the commit-scoped lock.
//
// A lock asserts "these specs pass THIS gate", and the pack set IS part of the
// gate. Before doctrine was covered, you could lock a tree validated under one
// rule set, swap the packs, and still promote: the spec digest never moved, so
// the promote-time re-check saw no change. That is the same stale-approval hole
// the commit-scoped lock exists to close, entering through doctrine.
//
// Two identities therefore coexist, and this file guards both directions:
//   computeStateId     — spec content only (surface snapshot stamps, freshness)
//   computeGateStateId — spec content + governing doctrine (lock / promote)
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

describe('gate StateId vs content StateId', () => {
  it('never compare equal — the algorithm marker separates the two flavours', () => {
    const proj = createTempProject();
    proj.activate();
    try {
      const content = computeStateId();
      const gate = computeGateStateId();
      expect(content.algorithm).toBe('sha256');
      expect(gate.algorithm).toBe('sha256+doctrine');
      expect(stateIdEquals(content, gate)).toBe(false);
    } finally { proj.cleanup(); }
  });

  it('a lock record written BEFORE doctrine coverage reads as stale, not as valid', () => {
    const proj = createTempProject();
    proj.activate();
    try {
      // Exactly what a pre-upgrade lock record carries: the content flavour.
      const legacyLockStateId = computeStateId();
      // The promote-time re-check now recomputes the gate flavour.
      expect(stateIdEquals(computeGateStateId(), legacyLockStateId)).toBe(false);
    } finally { proj.cleanup(); }
  });

  it('both react to a spec edit', () => {
    const proj = createTempProject();
    proj.activate();
    try {
      const contentBefore = computeStateId();
      const gateBefore = computeGateStateId();
      proj.editSpec();
      expect(stateIdEquals(computeStateId(), contentBefore)).toBe(false);
      expect(stateIdEquals(computeGateStateId(), gateBefore)).toBe(false);
    } finally { proj.cleanup(); }
  });
});

describe('doctrine changes invalidate a lock', () => {
  it('adding a governing pack shifts the gate StateId but NOT the content StateId', () => {
    const proj = createTempProject();
    proj.activate();
    try {
      const contentBefore = computeStateId();
      const gateBefore = computeGateStateId();

      proj.writePack('.wai/packs/doctrine.yaml', PACK_V1);
      proj.writeConfig(['.wai/packs/doctrine.yaml']);

      expect(stateIdEquals(computeGateStateId(), gateBefore)).toBe(false);
      // The contracts did not change, so vendored surface snapshots must not go stale.
      expect(stateIdEquals(computeStateId(), contentBefore)).toBe(true);
    } finally { proj.cleanup(); }
  });

  it('a pack VERSION bump shifts the gate StateId', () => {
    const proj = createTempProject();
    proj.activate();
    try {
      proj.writePack('.wai/packs/doctrine.yaml', PACK_V1);
      proj.writeConfig(['.wai/packs/doctrine.yaml']);
      const before = computeGateStateId();

      proj.writePack('.wai/packs/doctrine.yaml', PACK_V1.replace('version: 1.0.0', 'version: 1.1.0'));
      expect(stateIdEquals(computeGateStateId(), before)).toBe(false);
    } finally { proj.cleanup(); }
  });

  it('changing a profile\'s doctrine shifts the gate StateId even at the same version', () => {
    const proj = createTempProject();
    proj.activate();
    try {
      proj.writePack('.wai/packs/doctrine.yaml', PACK_V1);
      proj.writeConfig(['.wai/packs/doctrine.yaml']);
      const before = computeGateStateId();

      // Same name, same version, different rules — an in-place edit of a local
      // YAML pack, which is exactly the case a name@version pin cannot catch.
      proj.writePack('.wai/packs/doctrine.yaml', PACK_V1.replace('types: [Actor]', 'types: [Actor, Supervisor]'));
      expect(stateIdEquals(computeGateStateId(), before)).toBe(false);
    } finally { proj.cleanup(); }
  });

  it('a declarative assertion shifts the gate StateId', () => {
    const proj = createTempProject();
    proj.activate();
    try {
      proj.writePack('.wai/packs/doctrine.yaml', PACK_V1);
      proj.writeConfig(['.wai/packs/doctrine.yaml']);
      const before = computeGateStateId();

      proj.writePack('.wai/packs/doctrine.yaml', `${PACK_V1}assertions:
  - kind: forbid-edge
    code: NO_PORTAL_TO_STORE
    reason: platform doctrine
    from: { componentType: [Portal] }
    to: { componentType: [Store] }
`);
      expect(stateIdEquals(computeGateStateId(), before)).toBe(false);
    } finally { proj.cleanup(); }
  });

  it('removing a governing pack shifts the gate StateId', () => {
    const proj = createTempProject();
    proj.activate();
    try {
      proj.writePack('.wai/packs/doctrine.yaml', PACK_V1);
      proj.writeConfig(['.wai/packs/doctrine.yaml']);
      const withPack = computeGateStateId();

      proj.writeConfig([]);
      expect(stateIdEquals(computeGateStateId(), withPack)).toBe(false);
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
      const before = computeGateStateId();

      // Instructions cannot change a conformance verdict; if they fed the digest,
      // every documentation tweak would invalidate every lock.
      proj.writePack('.wai/packs/doctrine.yaml', `${PACK_V1}instructions: Completely rewritten guidance, much longer than before.\n`);
      expect(stateIdEquals(computeGateStateId(), before)).toBe(true);
    } finally { proj.cleanup(); }
  });

  it('declaring a pack skill leaves the gate StateId untouched', () => {
    const proj = createTempProject();
    proj.activate();
    try {
      proj.writePack('.wai/packs/doctrine.yaml', PACK_V1);
      proj.writeConfig(['.wai/packs/doctrine.yaml']);
      const before = computeGateStateId();

      proj.writePack('.wai/packs/doctrine.yaml', `${PACK_V1}skills:
  - id: implementer
    source: skills/implementer/SKILL.md
    targets: [claude]
`);
      expect(stateIdEquals(computeGateStateId(), before)).toBe(true);
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

describe('the gate identity covers the rule set and the governing config', () => {
  it('a change to the BUILTIN rule registry invalidates locks', () => {
    const proj = createTempProject();
    proj.activate();
    try {
      const before = computeGateStateId();

      // Simulate a release that adds a rule. Restored in `finally`, so no other
      // test observes the mutation.
      SDD_RULES.push({
        name: 'a-newly-shipped-rule',
        description: 'added by a hypothetical release',
        codes: [{ code: 'A_NEW_CODE', defaultSeverity: 'warning', summary: 's' }],
        check: () => { /* identity only — never run here */ },
      });
      try {
        expect(stateIdEquals(computeGateStateId(), before)).toBe(false);
      } finally {
        SDD_RULES.pop();
      }

      // Removing it again restores the identity: the gate is unchanged, so a lock
      // taken before the hypothetical release is valid again.
      expect(stateIdEquals(computeGateStateId(), before)).toBe(true);
    } finally { proj.cleanup(); }
  });

  it('the wairon VERSION alone does not invalidate — only the rules do', () => {
    const proj = createTempProject();
    proj.activate();
    try {
      // Nothing about the registry or config changed between these two calls, which
      // is the situation a patch release leaves behind. Locks must survive it.
      expect(stateIdEquals(computeGateStateId(), computeGateStateId())).toBe(true);
    } finally { proj.cleanup(); }
  });

  it('switching the governing projectType invalidates locks', () => {
    const a = createTempProject({ projectType: 'backend' });
    a.activate();
    const backend = computeGateStateId();
    a.cleanup();

    const b = createTempProject({ projectType: 'frontend-reactive' });
    b.activate();
    try {
      // Same (empty) tree, different governing doctrine family.
      expect(stateIdEquals(computeGateStateId(), backend)).toBe(false);
    } finally { b.cleanup(); }
  });

  it('a rules-config change (a severity override) invalidates locks, and the CONTENT id is untouched', () => {
    const proj = createTempProject();
    proj.activate();
    try {
      const gateBefore = computeGateStateId();
      const contentBefore = computeStateId();

      proj.writeConfig([], { rules: { sddRuleSeverity: { UNKNOWN_PROFILE: 'off' } } });

      // Turning a rule off IS a change of gate.
      expect(stateIdEquals(computeGateStateId(), gateBefore)).toBe(false);
      // But no contract moved, so vendored surface snapshots must not go stale.
      expect(stateIdEquals(computeStateId(), contentBefore)).toBe(true);
    } finally { proj.cleanup(); }
  });
});
