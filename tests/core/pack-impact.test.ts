import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { measurePackImpact, measurePackDoctrine, validateProject, type ValidationIssue } from '../../src/core/validation.js';
import { projectConfigRepositoryAt } from '../../src/config/project-config.js';
import { upsertPackSelection, removePackSelection, registerPackRef, packManifest } from '../../src/core/index.js';
import { findingChanges, doctrineChanges, packSettings, type DoctrineBaseline, type FindingChanges } from '../../src/models/pack-impact.js';
import { setProjectRoot } from '../../src/utils/fs.js';
import { installPackFromDirectory } from '../../src/core/packstore.js';
import {
  governanceMachine, bindRoot, editConfig, writeSubsystem, writeComponent, acmeBaseYaml, type GovernanceMachine,
} from '../helpers/governance-fixture.js';

// ---------------------------------------------------------------------------
// pack_impact — what one pack write would change, measured before it happens.
// The integration sim for pack_impact: the real validator portal, the real
// pack impact workflow, the real loader, rule registry and owner's gate, over
// real project directories and a redirected pack store. The central property
// is impact-matches-apply: the finding changes the report states equal what
// validation reports after the real write through the registry.
// ---------------------------------------------------------------------------

let machine: GovernanceMachine | undefined;
afterEach(() => {
  machine?.cleanup();
  machine = undefined;
});

/** A project with one subsystem and one draft orchestrator: three findings of its own under wairon's defaults. */
function governedProject(m: GovernanceMachine): string {
  const dir = m.project('shop');
  writeSubsystem(dir, 'core');
  writeComponent(dir, 'core', 'engine');
  return dir;
}

function gate(dir: string) {
  bindRoot(dir);
  const config = projectConfigRepositoryAt(dir).load();
  return validateProject({ rules: config?.rules, projectType: config?.projectType });
}

/** A finding change set as comparable lines. */
function lines(changes: FindingChanges): string[] {
  const l = (mark: string, i: ValidationIssue): string => `${mark} ${i.severity} ${i.code} @${i.specId ?? '-'} ${i.message}`;
  return [
    ...changes.introduced.map((i) => l('+', i)),
    ...changes.resolved.map((i) => l('-', i)),
    ...changes.regraded.map((r) => `~ ${r.from}->${r.finding.severity} ${r.finding.code} @${r.finding.specId ?? '-'}`),
  ].sort();
}

const configBytes = (dir: string): string => fs.readFileSync(path.join(dir, '.wai', 'project.yaml'), 'utf8');

describe('property: impact-matches-apply', () => {
  it('selecting a pack: the report\'s finding changes equal what validation reports after the write', () => {
    const m = (machine = governanceMachine());
    m.install('1.2.0');
    const dir = governedProject(m);
    const before = gate(dir);
    const selection = { name: 'acme-base', source: 'https://packs.example.test/acme-base-{version}.wpack' };
    bindRoot(dir);
    const written = configBytes(dir);
    const impact = measurePackImpact({ entry: selection });
    expect(configBytes(dir)).toBe(written);
    expect(impact.direction).toBe('apply');
    expect(impact.version).toBe('1.2.0');
    // The pack redefines `backend`, which governs this project.
    expect(impact.governing).toEqual(['backend']);
    // The real write, then the real gate.
    bindRoot(dir);
    upsertPackSelection(selection);
    const after = gate(dir);
    expect(lines(impact.findings)).toEqual(lines(findingChanges(before, after)));
    expect(lines(impact.findings).length).toBeGreaterThan(0);
    expect(impact.after.warnings).toBe(after.issues.filter((i) => i.severity === 'warning').length);
    expect(impact.before.warnings).toBe(before.issues.filter((i) => i.severity === 'warning').length);
  });

  it('updating a pinned selection reports the replaced version and its doctrine, and still matches the write', () => {
    const m = (machine = governanceMachine());
    m.install('1.2.0');
    const dir = governedProject(m);
    bindRoot(dir);
    upsertPackSelection({ name: 'acme-base', version: '1.2.0' });
    fs.mkdirSync(path.join(m.home, 'v2'));
    fs.writeFileSync(path.join(m.home, 'v2', 'pack.yaml'), acmeBaseYaml('2.0.0').replace('GENERIC_COMPONENT_NAME: notice', 'GENERIC_COMPONENT_NAME: error'));
    installPackFromDirectory(path.join(m.home, 'v2'));
    const before = gate(dir);
    bindRoot(dir);
    const impact = measurePackImpact({ entry: { name: 'acme-base', version: '2.0.0' } });
    expect(impact.replaces).toBe('1.2.0');
    expect(impact.previousDoctrine).toBeDefined();
    expect(impact.doctrine.find((c) => c.subject === 'GENERIC_COMPONENT_NAME' && c.profile === 'backend')?.change).toBe('raised');
    expect(impact.previousDoctrine!.find((c) => c.subject === 'GENERIC_COMPONENT_NAME' && c.profile === 'backend')?.change).toBe('loosened');
    bindRoot(dir);
    upsertPackSelection({ name: 'acme-base', version: '2.0.0' });
    expect(lines(impact.findings)).toEqual(lines(findingChanges(before, gate(dir))));
  });

  it('removing a pack: the findings read as what the pack accounts for, and match the deselection', () => {
    const m = (machine = governanceMachine());
    m.install('1.2.0');
    const dir = governedProject(m);
    bindRoot(dir);
    upsertPackSelection({ name: 'acme-base', version: '1.2.0' });
    const before = gate(dir);
    bindRoot(dir);
    const impact = measurePackImpact({ entry: { name: 'acme-base', version: '1.2.0' }, remove: true });
    expect(impact.direction).toBe('remove');
    expect(impact.replaces).toBeUndefined();
    bindRoot(dir);
    removePackSelection('acme-base');
    expect(lines(impact.findings)).toEqual(lines(findingChanges(before, gate(dir))));
  });

  it('a supplied manifest not on disk yet (a legacy add) is merged at its entry\'s position, and matches the vendored write', () => {
    const m = (machine = governanceMachine());
    const dir = governedProject(m);
    const source = path.join(m.home, 'loose-pack');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'pack.yaml'), acmeBaseYaml('1.3.0'));
    const manifest = packManifest(source)!;
    const before = gate(dir);
    bindRoot(dir);
    const impact = measurePackImpact({ entry: '.wai/packs/loose-pack', manifest });
    expect(fs.existsSync(path.join(dir, '.wai', 'packs', 'loose-pack'))).toBe(false);
    fs.cpSync(source, path.join(dir, '.wai', 'packs', 'loose-pack'), { recursive: true });
    bindRoot(dir);
    registerPackRef('.wai/packs/loose-pack');
    expect(lines(impact.findings)).toEqual(lines(findingChanges(before, gate(dir))));
  });

  it('a projectType-only write measures the profile change with an empty doctrine half', () => {
    const m = (machine = governanceMachine());
    m.install('1.2.0');
    const dir = governedProject(m);
    bindRoot(dir);
    upsertPackSelection({ name: 'acme-base', version: '1.2.0' });
    const before = gate(dir);
    bindRoot(dir);
    const impact = measurePackImpact({ projectType: 'strict' });
    expect(impact.doctrine).toEqual([]);
    editConfig(dir, (doc) => { doc.projectType = 'strict'; });
    expect(lines(impact.findings)).toEqual(lines(findingChanges(before, gate(dir))));
  });
});

describe('validation_result.changesTo — findings matched by identity, never position', () => {
  it('splits introduced, resolved and regraded, ignores order and the severity word, and matches duplicates as a multiset', () => {
    const issue = (severity: 'error' | 'warning' | 'notice', code: string, message: string, specId?: string): ValidationIssue => ({ severity, code, message, ...(specId ? { specId } : {}) });
    const before = { valid: true, issues: [
      issue('warning', 'A', 'a warning about x', 'x'),
      issue('warning', 'B', 'twice'), issue('warning', 'B', 'twice'),
      issue('warning', 'C', 'gone'),
    ] };
    const after = { valid: true, issues: [
      issue('notice', 'B', 'twice'),
      issue('error', 'A', 'a error about x', 'x'),
      issue('warning', 'D', 'new'),
    ] };
    const changes = findingChanges(before, after);
    expect(changes.introduced.map((i) => i.code)).toEqual(['D']);
    expect(changes.resolved.map((i) => `${i.code} ${i.message}`).sort()).toEqual(['B twice', 'C gone']);
    expect(changes.regraded.map((r) => `${r.finding.code} ${r.from}->${r.finding.severity}`).sort()).toEqual(['A warning->error', 'B warning->notice']);
    expect(findingChanges(after, after)).toEqual({ introduced: [], resolved: [], regraded: [] });
  });
});

describe('pack_impact.measure — refusals, writing nothing', () => {
  it('refuses a pack that does not resolve with the reason the gate would give', () => {
    const m = (machine = governanceMachine());
    const dir = governedProject(m);
    bindRoot(dir);
    expect(() => measurePackImpact({ entry: { name: 'acme-base', version: '9.9.9' } })).toThrow(/PACK_NOT_INSTALLED/);
    m.install('1.2.0');
    bindRoot(dir);
    expect(() => measurePackImpact({ entry: { name: 'acme-base', version: '9.9.9' } })).toThrow(/PACK_VERSION_UNSATISFIED/);
  });

  it('refuses outside a wairon project', () => {
    machine = governanceMachine();
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-noproj-'));
    try {
      setProjectRoot(empty);
      expect(() => measurePackImpact({ entry: { name: 'acme-base' } })).toThrow(/Not inside a wairon project/);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('property: pack-loosening-is-never-a-finding — the doctrine half states changes, neutrally', () => {
  it('states loosened, raised, off, depth, redefined, removed and added against wairon\'s defaults', () => {
    const m = (machine = governanceMachine());
    const dir = governedProject(m);
    const source = path.join(m.home, 'probe');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'pack.yaml'), acmeBaseYaml('1.0.0') + [
      'guarantees: [replayable]',
      'languages:',
      '  flowscript:',
      '    unsupportedFlow:',
      '      parallel: model it as two flows',
      'patterns:',
      '  - id: saga',
      "    version: '1'",
      '',
    ].join(String.fromCharCode(10)));
    bindRoot(dir);
    const report = measurePackDoctrine(packManifest(source)!);
    const find = (change: string, subject: string, profile?: string) =>
      report.changes.find((c) => c.change === change && c.subject === subject && c.profile === profile);
    expect(find('loosened', 'UNUSED_COMPONENT', 'lenient')).toMatchObject({ axis: 'rule', from: 'warning', to: 'notice' });
    expect(find('off', 'GENERIC_COMPONENT_NAME', 'lenient')).toBeDefined();
    expect(find('raised', 'UNUSED_COMPONENT', 'strict')).toMatchObject({ from: 'warning', to: 'error' });
    expect(find('depth', 'designDepth', 'lenient')).toMatchObject({ from: 'narratives', to: 'components' });
    expect(find('redefined', 'backend', 'backend')).toBeDefined();
    expect(find('added', 'lenient', 'lenient')).toBeDefined();
    expect(find('removed', 'Supervisor', 'lenient')?.reason).toMatch(/no long-lived actors/);
    expect(find('added', 'ACME_BASE_NEEDS_DEPENDENCY_CLASS')).toMatchObject({ to: 'warning' });
    expect(find('added', 'guarantee replayable')).toBeDefined();
    expect(find('added', 'language flowscript')).toBeDefined();
    expect(find('gated', 'flowscript: parallel')).toBeDefined();
    expect(find('added', 'pattern saga@1')).toBeDefined();
    expect(report.version).toBe('1.0.0');
  });

  it('an entry equal to the default is no change, and a profile severity for a code nothing reports is inert', () => {
    const baseline: DoctrineBaseline = {
      ruleDefaults: { UNUSED_COMPONENT: 'warning' }, profiles: ['backend'], projectKinds: [], stereotypes: [], guarantees: [], designDepth: 'narratives',
    };
    const manifest = {
      name: 'p', profiles: { x: { family: 'neutral', forbiddenStereotypes: [], discouragedStereotypes: [], allowedEdges: [], rules: { sddRuleSeverity: { UNUSED_COMPONENT: 'warning', POLICY_DEVIATION: 'error' } } } },
      languages: {}, skills: [], patterns: [], assertions: [], guarantees: [], instructions: [], applyByDefault: false, rules: [],
    } as unknown as Parameters<typeof doctrineChanges>[0];
    const changes = doctrineChanges(manifest, baseline);
    expect(changes.filter((c) => c.subject === 'UNUSED_COMPONENT')).toEqual([]);
    expect(changes.find((c) => c.subject === 'POLICY_DEVIATION')?.change).toBe('inert');
    // What a member can deviate from: the profile's entries win over the pack's own codes.
    expect(packSettings(manifest, 'x').severities).toEqual({ UNUSED_COMPONENT: 'warning', POLICY_DEVIATION: 'error' });
    expect(packSettings(manifest, null)).toEqual({ pack: 'p', severities: {} });
  });
});
