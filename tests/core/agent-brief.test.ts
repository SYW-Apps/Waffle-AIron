import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { composeAgentBrief, UnknownAgentError } from '../../src/core/agent_resolver.js';
import { loadTemplate, loadAgentOverride } from '../../src/core/templates.js';
import { TemplateNotFoundError } from '../../src/utils/errors.js';

// ---------------------------------------------------------------------------
// Live delegation briefs (composeAgentBrief): composed on demand from the
// CURRENT spec tree — rendered template instructions plus the structured
// scope fields (ownedPaths/readPaths/domainRoot), never a generated file.
// ---------------------------------------------------------------------------

function createTempProject(execution?: Record<string, unknown>) {
  invalidateSpecCache();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-brief-test-'));

  const waiDir = path.join(tempDir, '.wai');
  fs.mkdirSync(waiDir);
  fs.writeFileSync(path.join(waiDir, 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0',
    name: 'test-project',
    projectType: 'backend',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {},
    // Omitted entirely unless a test opts in, so the default path exercises
    // tier `off` exactly as an existing project would.
    ...(execution ? { execution } : {}),
    createdAt: '2026-08-08T10:00:00Z',
    updatedAt: '2026-08-08T10:00:00Z',
  }));

  const specsDir = path.join(waiDir, 'specs');
  for (const d of ['subsystems', 'components', 'interfaces', 'implementations', 'types']) {
    fs.mkdirSync(path.join(specsDir, d), { recursive: true });
  }

  const stamp = "createdAt: '2026-08-08T10:00:00Z'\nupdatedAt: '2026-08-08T10:00:00Z'";
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

describe('composeAgentBrief (live delegation briefs)', () => {
  // Point the global template/variant tiers at an empty dir so a developer's
  // ~/.wairon overrides cannot leak into the assertions.
  let isolatedGlobalDir: string;
  beforeEach(() => {
    isolatedGlobalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-brief-global-'));
    process.env.WAIRON_TEMPLATES_DIR = isolatedGlobalDir;
    process.env.WAIRON_VARIANTS_DIR = isolatedGlobalDir;
  });
  afterEach(() => {
    delete process.env.WAIRON_TEMPLATES_DIR;
    delete process.env.WAIRON_VARIANTS_DIR;
    try { fs.rmSync(isolatedGlobalDir, { recursive: true, force: true }); } catch { /* win */ }
  });

  it('renders a subsystem owner brief with ownedPaths substituted into the template', () => {
    const proj = createTempProject();
    proj.writeSpec('subsystem', 'alpha', 'schemaVersion: 1.0.0\nid: alpha\nname: Alpha\ndescription: d\nparentSystem: TestSystem');
    proj.activate();
    try {
      const brief = composeAgentBrief('alpha-owner');
      expect(brief.agentId).toBe('alpha-owner');
      expect(brief.name).toBe('Alpha Owner');
      expect(brief.template).toBe('domain-owner');
      expect(brief.domainRoot).toBe('alpha');
      expect(brief.ownedPaths).toContain('.wai/specs/subsystems/alpha.yaml');
      // The {{agentName}} / {{ownedPaths}} placeholders are substituted.
      expect(brief.instructions).toContain('**Alpha Owner**');
      expect(brief.instructions).toContain('.wai/specs/subsystems/alpha.yaml');
      expect(brief.instructions).not.toContain('{{ownedPaths}}');
    } finally { proj.cleanup(); }
  });


  // -------------------------------------------------------------------------
  // Execution budget on the brief
  //
  // The brief is the delivery path that actually runs in a default wairon
  // project (materializeAgentFiles is off), so the budget has to reach it —
  // advisory there, since the CALLER spawning from the brief is what applies
  // it. Absent unless the project opted in, which is the MCP opt-in.
  // -------------------------------------------------------------------------

  const SUB = [
    'schemaVersion: 1.0.0',
    'id: alpha',
    'name: Alpha',
    'description: d',
    'parentSystem: TestSystem',
  ].join('\n');

  it('carries no budget or profile when the project has not opted in', () => {
    const proj = createTempProject();
    proj.writeSpec('subsystem', 'alpha', SUB);
    proj.activate();
    try {
      const brief = composeAgentBrief('alpha-owner');
      expect(brief.budget).toBeUndefined();
      expect(brief.profile).toBeUndefined();
    } finally { proj.cleanup(); }
  });

  it('carries budget and profile once the project sets an execution tier', () => {
    const proj = createTempProject({ tier: 'default', overrides: {} });
    proj.writeSpec('subsystem', 'alpha', SUB);
    proj.activate();
    try {
      const brief = composeAgentBrief('alpha-owner');
      expect(brief.profile?.delegates).toBe(true);
      expect(brief.budget?.modelTier).toBe('large');
      expect(brief.budget?.toolClass).toBe('implement');
      expect(brief.profile?.rationale).toBeTruthy();
    } finally { proj.cleanup(); }
  });

  it('never derives the frontier tier — it is reachable only by explicit override', () => {
    const proj = createTempProject({ tier: 'aggressive', overrides: {} });
    proj.writeSpec('subsystem', 'alpha', SUB);
    proj.activate();
    try {
      expect(composeAgentBrief('alpha-owner').budget?.modelTier).not.toBe('frontier');
      expect(composeAgentBrief('system-architect').budget?.modelTier).not.toBe('frontier');
    } finally { proj.cleanup(); }
  });

  it('honours a per-agent override from project config', () => {
    const proj = createTempProject({
      tier: 'default',
      overrides: { 'alpha-owner': { modelTier: 'frontier' } },
    });
    proj.writeSpec('subsystem', 'alpha', SUB);
    proj.activate();
    try {
      expect(composeAgentBrief('alpha-owner').budget?.modelTier).toBe('frontier');
      // Siblings are untouched by another agent's override.
      expect(composeAgentBrief('system-architect').budget?.modelTier).toBe('large');
    } finally { proj.cleanup(); }
  });

  it('an unknown agentId throws an error naming the known agent ids', () => {
    const proj = createTempProject();
    proj.writeSpec('subsystem', 'alpha', 'schemaVersion: 1.0.0\nid: alpha\nname: Alpha\ndescription: d\nparentSystem: TestSystem');
    proj.activate();
    try {
      expect(() => composeAgentBrief('nope')).toThrowError(UnknownAgentError);
      expect(() => composeAgentBrief('nope'))
        .toThrowError(/Known agent ids: system-architect, alpha-owner/);
    } finally { proj.cleanup(); }
  });

  it('populates readPaths from the resolved record', () => {
    const proj = createTempProject();
    proj.writeSpec('subsystem', 'alpha', 'schemaVersion: 1.0.0\nid: alpha\nname: Alpha\ndescription: d\nparentSystem: TestSystem');
    proj.activate();
    try {
      const brief = composeAgentBrief('alpha-owner');
      expect(brief.readPaths).toEqual(['**']);
    } finally { proj.cleanup(); }
  });

  it('folds a variant-tagged component guidance into variantGuidance AND the rendered instructions', () => {
    const proj = createTempProject();
    proj.writeFile('.wai/variants/publisher.yaml', 'id: publisher\nbase: Specialist\nguidance: Fan-out emitter; reuse the shared publisher helper.\n');
    proj.writeSpec('subsystem', 'alpha', 'schemaVersion: 1.0.0\nid: alpha\nname: Alpha\ndescription: d\nparentSystem: TestSystem');
    proj.writeSpec('component', 'pub-a', 'schemaVersion: 1.0.0\nid: pub-a\nname: pub-a\ndescription: d\nsubsystem: alpha\ncomponentType: Specialist\nvariant: publisher');
    proj.activate();
    try {
      const brief = composeAgentBrief('alpha-owner');
      expect(brief.variantGuidance).toContain('Fan-out emitter; reuse the shared publisher helper.');
      expect(brief.instructions).toContain('Fan-out emitter; reuse the shared publisher helper.');
      expect(brief.instructions).not.toContain('{{variantGuidance}}');
    } finally { proj.cleanup(); }
  });

  it('an unknown template name throws instead of silently falling past the built-in tier', () => {
    const proj = createTempProject();
    proj.activate();
    try {
      expect(() => loadTemplate('no-such-template')).toThrowError(TemplateNotFoundError);
    } finally { proj.cleanup(); }
  });

  // -------------------------------------------------------------------------
  // Per-agent project guidance (.wai/agents/<agentId>.md): user-owned markdown
  // folded LIVE into the brief under an attributed '## Project guidance' section.
  // -------------------------------------------------------------------------

  it('folds .wai/agents/<agentId>.md into the instructions under a Project guidance section', () => {
    const proj = createTempProject();
    proj.writeSpec('subsystem', 'alpha', 'schemaVersion: 1.0.0\nid: alpha\nname: Alpha\ndescription: d\nparentSystem: TestSystem');
    proj.writeFile('.wai/agents/alpha-owner.md', 'Prefer the shared retry helper over ad-hoc loops.\n');
    proj.activate();
    try {
      const brief = composeAgentBrief('alpha-owner');
      expect(brief.instructions).toContain('## Project guidance');
      expect(brief.instructions).toContain('Prefer the shared retry helper over ad-hoc loops.');
      // Attributed exactly once, guidance under the section, clean trailing newline.
      expect(brief.instructions.match(/## Project guidance/g)).toHaveLength(1);
      expect(brief.instructions.indexOf('Prefer the shared retry helper'))
        .toBeGreaterThan(brief.instructions.indexOf('## Project guidance'));
      expect(brief.instructions.endsWith('Prefer the shared retry helper over ad-hoc loops.\n')).toBe(true);
    } finally { proj.cleanup(); }
  });

  it('emits no Project guidance section when the project defines no guidance file', () => {
    const proj = createTempProject();
    proj.writeSpec('subsystem', 'alpha', 'schemaVersion: 1.0.0\nid: alpha\nname: Alpha\ndescription: d\nparentSystem: TestSystem');
    proj.activate();
    try {
      expect(composeAgentBrief('alpha-owner').instructions).not.toContain('## Project guidance');
    } finally { proj.cleanup(); }
  });

  it('reflects a guidance edit on the NEXT composeAgentBrief call (live read, no cache)', () => {
    const proj = createTempProject();
    proj.writeSpec('subsystem', 'alpha', 'schemaVersion: 1.0.0\nid: alpha\nname: Alpha\ndescription: d\nparentSystem: TestSystem');
    proj.writeFile('.wai/agents/alpha-owner.md', 'First revision.\n');
    proj.activate();
    try {
      expect(composeAgentBrief('alpha-owner').instructions).toContain('First revision.');
      proj.writeFile('.wai/agents/alpha-owner.md', 'Second revision.\n');
      const brief = composeAgentBrief('alpha-owner');
      expect(brief.instructions).toContain('Second revision.');
      expect(brief.instructions).not.toContain('First revision.');
    } finally { proj.cleanup(); }
  });

  it('loadAgentOverride returns null when absent and the markdown verbatim when present', () => {
    const proj = createTempProject();
    proj.writeFile('.wai/agents/some-agent.md', '# Notes\n\nverbatim body\n');
    proj.activate();
    try {
      expect(loadAgentOverride('some-agent')).toBe('# Notes\n\nverbatim body\n');
      expect(loadAgentOverride('no-such-agent')).toBeNull();
    } finally { proj.cleanup(); }
  });

  it('loadAgentOverride treats a directory at the guidance path as absent', () => {
    const proj = createTempProject();
    proj.writeFile('.wai/agents/dir-agent.md/nested.txt', 'x'); // makes dir-agent.md a directory
    proj.activate();
    try {
      expect(loadAgentOverride('dir-agent')).toBeNull();
    } finally { proj.cleanup(); }
  });
});
