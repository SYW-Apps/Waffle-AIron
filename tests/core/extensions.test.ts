import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { validateSddTree } from '../../src/core/validation.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { loadProjectExtensions } from '../../src/core/extensions.js';
import { listSkillResources } from '../../src/core/skills.js';

// ---------------------------------------------------------------------------
// Extension packs: declarative YAML packs (custom profiles + language tables),
// programmatic JS packs (injected SddRules), UNKNOWN_PROFILE, and
// EXTENSION_LOAD_ERROR. Loaded from .wai/project.yaml → extensions.packs.
// ---------------------------------------------------------------------------

function createTempProject(packs: string[] = []) {
  invalidateSpecCache();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-ext-test-'));

  const waiDir = path.join(tempDir, '.wai');
  fs.mkdirSync(waiDir);
  // loadProjectExtensions parses the real config schema — all required fields.
  fs.writeFileSync(path.join(waiDir, 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0',
    name: 'test-project',
    projectType: 'backend',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {},
    ...(packs.length ? { extensions: { packs } } : {}),
    createdAt: '2026-07-03T10:00:00Z',
    updatedAt: '2026-07-03T10:00:00Z',
  }));

  const specsDir = path.join(waiDir, 'specs');
  for (const d of ['subsystems', 'components', 'interfaces', 'implementations', 'types']) {
    fs.mkdirSync(path.join(specsDir, d), { recursive: true });
  }

  const stamp = "createdAt: '2026-07-03T10:00:00Z'\nupdatedAt: '2026-07-03T10:00:00Z'";
  const writeSpec = (type: string, name: string, content: string) => {
    const filePath = type === 'system'
      ? path.join(specsDir, '.index.yaml')
      : path.join(specsDir, `${type}s`, `${name}.yaml`);
    fs.writeFileSync(filePath, `${content}\n${stamp}\n`);
  };

  const writeFile = (rel: string, content: string) => {
    const p = path.join(tempDir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };

  writeSpec('system', 'system', 'schemaVersion: 1.0.0\nname: TestSystem\nvision: testing');

  return {
    writeSpec,
    writeFile,
    activate: () => { vi.spyOn(process, 'cwd').mockReturnValue(tempDir); },
    cleanup: () => {
      invalidateSpecCache();
      vi.restoreAllMocks();
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* win file locks */ }
    },
  };
}

const MAKE_PACK = `name: make-automation-pack
profiles:
  make-automation:
    family: neutral
    forbiddenStereotypes:
      - types: [Actor]
        reason: Make scenarios have no long-lived concurrent actors — model async work as scheduled scenarios
languages:
  make:
    unsupportedFlow:
      doWhile: Make has no do-while — model as a repeater with a post-check filter
      switch: model as a router with mutually exclusive filters
`;

describe('extension packs', () => {
  it('enforces a pack-defined profile (forbidden stereotype) and registers the profile name', () => {
    const proj = createTempProject(['.wai/packs/make.yaml']);
    proj.writeFile('.wai/packs/make.yaml', MAKE_PACK);
    proj.writeSpec('subsystem', 'sub-a', 'schemaVersion: 1.0.0\nid: sub-a\nname: SubA\ndescription: d\nparentSystem: TestSystem\nprofile: make-automation');
    proj.writeSpec('component', 'worker-a', 'schemaVersion: 1.0.0\nid: worker-a\nname: worker-a\ndescription: d\nsubsystem: sub-a\ncomponentType: Actor');
    proj.activate();
    try {
      const res = validateSddTree();
      expect(res.issues.some(i => i.code === 'PROFILE_FORBIDDEN_STEREOTYPE' && i.specId === 'worker-a')).toBe(true);
      expect(res.issues.some(i => i.code === 'UNKNOWN_PROFILE')).toBe(false);
    } finally { proj.cleanup(); }
  });

  it('gates narrative flow constructs via a pack language table', () => {
    const proj = createTempProject(['.wai/packs/make.yaml']);
    proj.writeFile('.wai/packs/make.yaml', MAKE_PACK);
    proj.writeSpec('system', 'system', 'schemaVersion: 1.0.0\nname: TestSystem\nvision: testing\ntargetLanguage: make');
    proj.writeSpec('subsystem', 'sub-a', 'schemaVersion: 1.0.0\nid: sub-a\nname: SubA\ndescription: d\nparentSystem: TestSystem');
    proj.writeSpec('component', 'orch-a', 'schemaVersion: 1.0.0\nid: orch-a\nname: orch-a\ndescription: d\nsubsystem: sub-a\ncomponentType: Orchestrator');
    proj.writeSpec('interface', 'iorch-a', `schemaVersion: 1.0.0
id: iorch-a
name: IOrch
description: d
component: orch-a
methods:
  - name: dispatch
    description: Routes an incoming bundle to its handler.
    signature: "dispatch(bundle: string): string"
    returns: "string"`);
    proj.writeSpec('implementation', 'impl-orch-a', `schemaVersion: 1.0.0
id: impl-orch-a
name: ImplOrch
description: d
contract: iorch-a
methods:
  - name: dispatch
    narrative:
      - { stepNumber: 1, description: receive the bundle, type: local }
      - { stepNumber: 2, description: dispatch by kind, type: switch, on: bundle.kind, cases: [{ value: invoice, step: 3 }], defaultStep: 4 }
      - { stepNumber: 3, description: handle the invoice, type: local }
      - { stepNumber: 4, description: done, type: return, outcome: success }`);
    proj.activate();
    try {
      const res = validateSddTree();
      const flow = res.issues.filter(i => i.code === 'LANGUAGE_FOREIGN_FLOW');
      expect(flow.some(i => i.specId === 'impl-orch-a' && i.message.includes('router'))).toBe(true);
    } finally { proj.cleanup(); }
  });

  it('flags an unregistered profile name with UNKNOWN_PROFILE', () => {
    const proj = createTempProject();
    proj.writeSpec('subsystem', 'sub-a', 'schemaVersion: 1.0.0\nid: sub-a\nname: SubA\ndescription: d\nparentSystem: TestSystem\nprofile: make-automation');
    proj.activate();
    try {
      const res = validateSddTree();
      expect(res.issues.some(i => i.code === 'UNKNOWN_PROFILE' && i.specId === 'sub-a')).toBe(true);
    } finally { proj.cleanup(); }
  });

  it('runs programmatic pack rules and recognizes their codes in lint.allow', () => {
    const proj = createTempProject(['./packs/js-pack.cjs']);
    proj.writeFile('packs/js-pack.cjs', `module.exports = {
  name: 'js-pack',
  rules: [{
    name: 'pack-rule',
    description: 'always fires once on sub-a',
    codes: [{ code: 'PACK_RULE_FIRED', defaultSeverity: 'warning', summary: 'test' }],
    check(ctx) { ctx.addIssue('warning', 'PACK_RULE_FIRED', 'injected rule fired', 'sub-a'); },
  }],
};
`);
    proj.writeSpec('subsystem', 'sub-a', 'schemaVersion: 1.0.0\nid: sub-a\nname: SubA\ndescription: d\nparentSystem: TestSystem');
    proj.activate();
    try {
      const res = validateSddTree();
      expect(res.issues.some(i => i.code === 'PACK_RULE_FIRED' && i.specId === 'sub-a')).toBe(true);
      expect(res.issues.some(i => i.code === 'UNKNOWN_LINT_ALLOW_CODE')).toBe(false);
    } finally { proj.cleanup(); }
  });

  it('suppresses a pack rule warning via lint.allow on the flagged spec', () => {
    const proj = createTempProject(['./packs/js-pack.cjs']);
    proj.writeFile('packs/js-pack.cjs', `module.exports = {
  name: 'js-pack',
  rules: [{
    name: 'pack-rule',
    description: 'always fires once on sub-a',
    codes: [{ code: 'PACK_RULE_FIRED', defaultSeverity: 'warning', summary: 'test' }],
    check(ctx) { ctx.addIssue('warning', 'PACK_RULE_FIRED', 'injected rule fired', 'sub-a'); },
  }],
};
`);
    proj.writeSpec('subsystem', 'sub-a', `schemaVersion: 1.0.0
id: sub-a
name: SubA
description: d
parentSystem: TestSystem
lint:
  allow:
    - code: PACK_RULE_FIRED
      reason: acknowledged for the test`);
    proj.activate();
    try {
      const res = validateSddTree();
      expect(res.issues.some(i => i.code === 'PACK_RULE_FIRED')).toBe(false);
      expect(res.issues.some(i => i.code === 'UNKNOWN_LINT_ALLOW_CODE')).toBe(false);
      expect(res.issues.some(i => i.code === 'UNUSED_LINT_ALLOW')).toBe(false);
    } finally { proj.cleanup(); }
  });

  it('auto-loads global packs (WAIRON_PACKS_DIR) and honors useGlobalPacks: false', () => {
    const globalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-global-packs-'));
    fs.writeFileSync(path.join(globalDir, 'org.yaml'), `name: org-doctrine
profiles:
  org-profile:
    family: neutral
`);
    process.env.WAIRON_PACKS_DIR = globalDir;
    // Project references the globally-provided profile.
    const proj = createTempProject();
    proj.writeSpec('subsystem', 'sub-a', 'schemaVersion: 1.0.0\nid: sub-a\nname: SubA\ndescription: d\nparentSystem: TestSystem\nprofile: org-profile');
    proj.activate();
    try {
      expect(validateSddTree().issues.some(i => i.code === 'UNKNOWN_PROFILE')).toBe(false);
    } finally {
      proj.cleanup();
      delete process.env.WAIRON_PACKS_DIR;
      try { fs.rmSync(globalDir, { recursive: true, force: true }); } catch { /* win */ }
    }

    // Same setup, but the project opts out of global packs.
    const globalDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-global-packs-'));
    fs.writeFileSync(path.join(globalDir2, 'org.yaml'), `name: org-doctrine
profiles:
  org-profile:
    family: neutral
`);
    process.env.WAIRON_PACKS_DIR = globalDir2;
    const proj2 = createTempProject();
    proj2.writeFile('.wai/project.yaml', JSON.stringify({
      schemaVersion: '1.0.0',
      name: 'test-project',
      projectType: 'backend',
      targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
      rules: {},
      extensions: { packs: [], useGlobalPacks: false },
      createdAt: '2026-07-03T10:00:00Z',
      updatedAt: '2026-07-03T10:00:00Z',
    }));
    proj2.writeSpec('subsystem', 'sub-a', 'schemaVersion: 1.0.0\nid: sub-a\nname: SubA\ndescription: d\nparentSystem: TestSystem\nprofile: org-profile');
    proj2.activate();
    try {
      expect(validateSddTree().issues.some(i => i.code === 'UNKNOWN_PROFILE' && i.specId === 'sub-a')).toBe(true);
    } finally {
      proj2.cleanup();
      delete process.env.WAIRON_PACKS_DIR;
      try { fs.rmSync(globalDir2, { recursive: true, force: true }); } catch { /* win */ }
    }
  });

  it('surfaces a broken pack as EXTENSION_LOAD_ERROR (error severity)', () => {
    const proj = createTempProject(['.wai/packs/missing.yaml']);
    proj.writeSpec('subsystem', 'sub-a', 'schemaVersion: 1.0.0\nid: sub-a\nname: SubA\ndescription: d\nparentSystem: TestSystem');
    proj.activate();
    try {
      const res = validateSddTree();
      const err = res.issues.find(i => i.code === 'EXTENSION_LOAD_ERROR');
      expect(err).toBeDefined();
      expect(err!.severity).toBe('error');
      expect(res.valid).toBe(false);
    } finally { proj.cleanup(); }
  });

  it('resolves a component pattern reference to a pack-declared pattern and flags an unknown one', () => {
    const proj = createTempProject(['.wai/packs/patterns.yaml']);
    proj.writeFile('.wai/packs/patterns.yaml', `name: pattern-pack
patterns:
  - id: org/domain-pattern
    version: 1.0.0
    description: The canonical domain shape.
`);
    proj.writeSpec('subsystem', 'sub-a', 'schemaVersion: 1.0.0\nid: sub-a\nname: SubA\ndescription: d\nparentSystem: TestSystem');
    proj.writeSpec('component', 'known-a', `schemaVersion: 1.0.0
id: known-a
name: known-a
description: d
subsystem: sub-a
componentType: Specialist
patterns:
  - id: org/domain-pattern
    version: 1.0.0`);
    proj.writeSpec('component', 'unknown-a', `schemaVersion: 1.0.0
id: unknown-a
name: unknown-a
description: d
subsystem: sub-a
componentType: Specialist
patterns:
  - id: org/missing-pattern`);
    proj.activate();
    try {
      const res = validateSddTree();
      expect(res.issues.some(i => i.code === 'UNKNOWN_PATTERN_REF' && i.specId === 'unknown-a')).toBe(true);
      expect(res.issues.some(i => i.code === 'UNKNOWN_PATTERN_REF' && i.specId === 'known-a')).toBe(false);
    } finally { proj.cleanup(); }
  });

  it('warns PATTERN_VERSION_MISMATCH for a pinned version no pack provides', () => {
    const proj = createTempProject(['.wai/packs/patterns.yaml']);
    proj.writeFile('.wai/packs/patterns.yaml', `name: pattern-pack
patterns:
  - id: org/domain-pattern
    version: 1.0.0
`);
    proj.writeSpec('subsystem', 'sub-a', 'schemaVersion: 1.0.0\nid: sub-a\nname: SubA\ndescription: d\nparentSystem: TestSystem');
    proj.writeSpec('component', 'comp-a', `schemaVersion: 1.0.0
id: comp-a
name: comp-a
description: d
subsystem: sub-a
componentType: Specialist
patterns:
  - id: org/domain-pattern
    version: 2.0.0`);
    proj.activate();
    try {
      const res = validateSddTree();
      expect(res.issues.some(i => i.code === 'PATTERN_VERSION_MISMATCH' && i.specId === 'comp-a')).toBe(true);
    } finally { proj.cleanup(); }
  });

  it('loads pack-provided skills with provenance and a resolved SKILL.md path', () => {
    const proj = createTempProject(['.wai/packs/skillpack']);
    proj.writeFile('.wai/packs/skillpack/pack.yaml', `name: skillpack
version: 2.1.0
skills:
  - id: domain-implementer
    source: skills/domain-implementer/SKILL.md
    targets: [claude, gemini]
`);
    proj.writeFile('.wai/packs/skillpack/skills/domain-implementer/SKILL.md', '---\nname: Domain Implementer\ndescription: platform guidance\n---\nbody');
    proj.activate();
    try {
      const skills = loadProjectExtensions().skills;
      expect(skills.length).toBe(1);
      expect(skills[0].id).toBe('domain-implementer');
      expect(skills[0].pack).toBe('skillpack');
      expect(skills[0].packVersion).toBe('2.1.0');
      expect(skills[0].targets).toEqual(['claude', 'gemini']);
      expect(fs.existsSync(skills[0].sourcePath)).toBe(true);
    } finally { proj.cleanup(); }
  });

  it('publishes pack skills as namespaced <pack-id>-<skill-id> MCP resources', () => {
    const proj = createTempProject(['.wai/packs/skillpack']);
    proj.writeFile('.wai/packs/skillpack/pack.yaml', `name: skillpack
version: 2.1.0
skills:
  - id: domain-implementer
    source: skills/domain-implementer/SKILL.md
    targets: [claude]
`);
    proj.writeFile('.wai/packs/skillpack/skills/domain-implementer/SKILL.md', '---\nname: Domain Implementer\ndescription: platform guidance\n---\nbody');
    proj.activate();
    try {
      const packRes = listSkillResources().find(r => r.id === 'skillpack-domain-implementer');
      expect(packRes).toBeDefined();
      expect(packRes!.version).toBe('2.1.0');
      expect(packRes!.name).toBe('Domain Implementer');
    } finally { proj.cleanup(); }
  });
});
