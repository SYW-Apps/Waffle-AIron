import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { composeAgentBrief, UnknownAgentError } from '../../src/core/agent_resolver.js';
import { loadTemplate } from '../../src/core/templates.js';
import { TemplateNotFoundError } from '../../src/utils/errors.js';

// ---------------------------------------------------------------------------
// Live delegation briefs (composeAgentBrief): composed on demand from the
// CURRENT spec tree — rendered template instructions plus the structured
// scope fields (ownedPaths/readPaths/domainRoot), never a generated file.
// ---------------------------------------------------------------------------

function createTempProject() {
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
});
