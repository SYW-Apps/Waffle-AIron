import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { validateSddTree } from '../../src/core/validation.js';
import { invalidateSpecCache } from '../../src/core/specs.js';

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
});
