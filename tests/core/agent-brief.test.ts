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

  it('carries the type mapping of the language its implementations are written in, folded into the instructions', () => {
    const proj = createTempProject();
    proj.writeSpec('subsystem', 'alpha', SUB);
    proj.writeSpec('component', 'billing', 'id: billing\nname: Billing\ndescription: d\nsubsystem: alpha\ncomponentType: Orchestrator');
    proj.writeSpec('interface', 'ibilling', 'id: ibilling\nname: IBilling\ndescription: d\ncomponent: billing\nmethods: []');
    proj.writeSpec('implementation', 'billing_impl', 'id: billing_impl\nname: Billing\ndescription: d\ncontract: ibilling\nsourcePath: src/billing.ts\nmethods: []');
    proj.activate();
    try {
      const brief = composeAgentBrief('alpha-owner');
      expect(brief.typeMapping).toEqual(expect.arrayContaining(['list<T> → T[]', 'T? → T | null', 'async T → Promise<T>']));
      expect(brief.instructions).toContain('## Types in typescript');
      expect(brief.instructions).toContain('- list<T> → T[]');
    } finally { proj.cleanup(); }
  });

  it('carries no type mapping when the agent implements nothing, or no dialect reads its language', () => {
    const proj = createTempProject();
    proj.writeSpec('subsystem', 'alpha', SUB);
    proj.writeSpec('subsystem', 'beta', SUB.replace(/alpha/g, 'beta').replace('Alpha', 'Beta'));
    proj.writeSpec('component', 'engine', 'id: engine\nname: Engine\ndescription: d\nsubsystem: beta\ncomponentType: Orchestrator');
    proj.writeSpec('interface', 'iengine', 'id: iengine\nname: IEngine\ndescription: d\ncomponent: engine\nmethods: []');
    proj.writeSpec('implementation', 'engine_impl', 'id: engine_impl\nname: Engine\ndescription: d\ncontract: iengine\nsourcePath: src/engine.go\nmethods: []');
    proj.activate();
    try {
      expect(composeAgentBrief('alpha-owner').typeMapping).toBeUndefined();
      const beta = composeAgentBrief('beta-owner');
      expect(beta.typeMapping).toBeUndefined();
      expect(beta.instructions).not.toContain('## Types in');
      expect(composeAgentBrief('system-architect').typeMapping).toBeUndefined();
    } finally { proj.cleanup(); }
  });

  it('a Rust implementer gets a mapping-only table that says code conformance does not read it', () => {
    const proj = createTempProject();
    proj.writeSpec('subsystem', 'beta', SUB.replace(/alpha/g, 'beta').replace('Alpha', 'Beta'));
    proj.writeSpec('component', 'engine', 'id: engine\nname: Engine\ndescription: d\nsubsystem: beta\ncomponentType: Orchestrator');
    proj.writeSpec('interface', 'iengine', 'id: iengine\nname: IEngine\ndescription: d\ncomponent: engine\nmethods: []');
    proj.writeSpec('implementation', 'engine_impl', 'id: engine_impl\nname: Engine\ndescription: d\ncontract: iengine\nsourcePath: src/engine.rs\nmethods: []');
    proj.activate();
    try {
      const beta = composeAgentBrief('beta-owner');
      expect(beta.instructions).toContain('## Types in rust');
      expect(beta.typeMapping).toContain('T? → Option<T>');
      expect(beta.typeMapping!.at(-1)).toContain('mapping only');
    } finally { proj.cleanup(); }
  });

  it('a Python design with no code yet takes its mapping from the L0 targetLanguage', () => {
    const proj = createTempProject();
    proj.writeSpec('system', 'system', 'schemaVersion: 1.0.0\nname: TestSystem\nvision: testing\ntargetLanguage: python');
    proj.writeSpec('subsystem', 'beta', SUB.replace(/alpha/g, 'beta').replace('Alpha', 'Beta'));
    proj.writeSpec('component', 'engine', 'id: engine\nname: Engine\ndescription: d\nsubsystem: beta\ncomponentType: Orchestrator');
    proj.writeSpec('interface', 'iengine', 'id: iengine\nname: IEngine\ndescription: d\ncomponent: engine\nmethods: []');
    proj.writeSpec('implementation', 'engine_impl', 'id: engine_impl\nname: Engine\ndescription: d\ncontract: iengine\nmethods: []');
    proj.activate();
    try {
      const brief = composeAgentBrief('engine');
      expect(brief.instructions).toContain('## Types in python');
      expect(brief.typeMapping).toContain('T? → T | None (Optional[T])');
    } finally { proj.cleanup(); }
  });

  it("a subsystem owner's fence holds the project's shared setup files; a consumer's brief names the externals it uses", () => {
    const proj = createTempProject();
    proj.writeSpec('subsystem', 'beta', SUB.replace(/alpha/g, 'beta').replace('Alpha', 'Beta'));
    proj.writeSpec('component', 'planner', 'id: planner\nname: Planner\ndescription: d\nsubsystem: beta\ncomponentType: Orchestrator\ndependsOn: [geo::distance]');
    proj.writeSpec('interface', 'iplanner', 'id: iplanner\nname: IPlanner\ndescription: d\ncomponent: planner\nmethods: []');
    proj.writeSpec('implementation', 'planner_impl', 'id: planner_impl\nname: Planner\ndescription: d\ncontract: iplanner\nsourcePath: src/beta/planner.ts\nmethods: []');
    proj.writeFile('package.json', '{"name":"x"}');
    proj.writeFile('tsconfig.json', '{}');
    proj.writeFile('.wai/externals/geo.yaml', 'projectName: geo-sdk\ninterfaces:\n  - id: distance\n    transport: InProcess\n    abi: c\n    methods: []\n');
    proj.activate();
    try {
      const owner = composeAgentBrief('beta-owner');
      expect(owner.codeFence).toEqual(expect.arrayContaining(['package.json', 'tsconfig.json']));
      expect(owner.instructions).toContain('Shared with the other subsystem owners');
      const planner = composeAgentBrief('planner');
      expect(planner.instructions).toContain('## Externals used');
      expect(planner.instructions).toContain('`geo::distance` (transport InProcess, abi c)');
      expect(planner.readPaths).toContain('.wai/externals/geo.yaml');
      // A component implementer is not a subsystem owner: the setup files are not its fence.
      expect(planner.codeFence).not.toContain('package.json');
    } finally { proj.cleanup(); }
  });

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
    proj.writeFile('.wai/variants/publisher.yaml', 'id: publisher\nbase: Orchestrator\nguidance: Fan-out emitter; reuse the shared publisher helper.\n');
    proj.writeSpec('subsystem', 'alpha', 'schemaVersion: 1.0.0\nid: alpha\nname: Alpha\ndescription: d\nparentSystem: TestSystem');
    proj.writeSpec('component', 'pub-a', 'schemaVersion: 1.0.0\nid: pub-a\nname: pub-a\ndescription: d\nsubsystem: alpha\ncomponentType: Orchestrator\ndependencyClass: pure\nvariant: publisher');
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

describe('briefs carry a code write fence, and every component has a brief without agent files', () => {
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

  function billingProject() {
    const proj = createTempProject();
    proj.writeSpec('subsystem', 'alpha', 'schemaVersion: 1.0.0\nid: alpha\nname: Alpha\ndescription: d\nparentSystem: TestSystem');
    proj.writeSpec('component', 'billing', 'id: billing\nname: Billing\ndescription: d\nsubsystem: alpha\ncomponentType: Orchestrator');
    proj.writeSpec('interface', 'ibilling', 'id: ibilling\nname: IBilling\ndescription: d\ncomponent: billing\nmethods: []');
    proj.writeSpec('implementation', 'billing_impl', 'id: billing_impl\nname: Billing\ndescription: d\ncontract: ibilling\nsourcePath: src/alpha/billing.ts\nmethods: []');
    proj.writeSpec('component', 'ledger', 'id: ledger\nname: Ledger\ndescription: d\nsubsystem: alpha\ncomponentType: Orchestrator');
    proj.writeSpec('interface', 'iledger', 'id: iledger\nname: ILedger\ndescription: d\ncomponent: ledger\nmethods: []');
    proj.writeSpec('implementation', 'ledger_impl', 'id: ledger_impl\nname: Ledger\ndescription: d\ncontract: iledger\nsourcePath: src/alpha/ledger.ts\nmethods: []');
    return proj;
  }

  it('the subsystem owner\'s brief fences its source files and the folder they share', () => {
    const proj = billingProject();
    proj.activate();
    try {
      const brief = composeAgentBrief('alpha-owner');
      expect(brief.codeFence).toEqual(['src/alpha/billing.ts', 'src/alpha/ledger.ts', 'src/alpha/**']);
      expect(brief.instructions).toContain('## Code write fence');
      expect(brief.instructions).toContain('- `src/alpha/**`');
    } finally { proj.cleanup(); }
  });

  it('a component id composes that component\'s implementer brief with generateComponentImplementers off', () => {
    const proj = billingProject();
    proj.activate();
    try {
      for (const id of ['billing', 'billing-implementer']) {
        const brief = composeAgentBrief(id);
        expect(brief.agentId).toBe('billing-implementer');
        expect(brief.template).toBe('implementer');
        expect(brief.codeFence).toEqual(['src/alpha/billing.ts', 'src/alpha/**']);
      }
    } finally { proj.cleanup(); }
  });

  it('with no source file named yet, the fence is empty and the brief says to name the planned files', () => {
    const proj = createTempProject();
    proj.writeSpec('subsystem', 'alpha', 'schemaVersion: 1.0.0\nid: alpha\nname: Alpha\ndescription: d\nparentSystem: TestSystem');
    proj.activate();
    try {
      const brief = composeAgentBrief('alpha-owner');
      expect(brief.codeFence).toEqual([]);
      expect(brief.instructions).toContain('No spec names a code location yet');
      expect(brief.instructions).toContain('declare the planned `sourcePath` on the implementation now');
      expect(brief.instructions).toContain('costs no re-lock');
      // The architect implements nothing: no fence at all.
      expect(composeAgentBrief('system-architect').codeFence).toBeUndefined();
    } finally { proj.cleanup(); }
  });

  it('fences PLANNED code too — simPaths and the subsystem\'s types\' files — and marks what is not written yet', () => {
    const proj = billingProject();
    proj.writeSpec('implementation', 'billing_impl', 'id: billing_impl\nname: Billing\ndescription: d\ncontract: ibilling\nsourcePath: src/alpha/billing.ts\nsimPath: tests/sim/alpha-billing.sim.ts\nmethods: []');
    proj.writeSpec('type', 'invoice', 'kind: entity\nid: invoice\nname: Invoice\nsubsystem: alpha\nsourcePath: src/alpha/invoice.ts\nfields: []\nmethods: []');
    proj.writeFile('src/alpha/billing.ts', 'export {};\n');
    proj.activate();
    try {
      const brief = composeAgentBrief('alpha-owner');
      expect(brief.codeFence).toEqual(expect.arrayContaining([
        'src/alpha/billing.ts', 'src/alpha/ledger.ts', 'tests/sim/alpha-billing.sim.ts', 'src/alpha/invoice.ts',
      ]));
      // Written files are listed plainly; planned ones say to create them.
      expect(brief.instructions).toContain('- `src/alpha/billing.ts`\n');
      expect(brief.instructions).toContain('- `src/alpha/ledger.ts` (planned — create it)');
      expect(brief.instructions).toContain('- `src/alpha/invoice.ts` (planned — create it)');
      expect(brief.instructions).toContain('- `tests/sim/alpha-billing.sim.ts` (planned — create it)');
      // The implementer fences its own simPath, planned or not.
      expect(composeAgentBrief('billing').codeFence).toEqual(expect.arrayContaining(['src/alpha/billing.ts', 'tests/sim/alpha-billing.sim.ts']));
    } finally { proj.cleanup(); }
  });

  it('a planned file alone selects the brief\'s type mapping by its extension', () => {
    const proj = createTempProject();
    proj.writeSpec('subsystem', 'alpha', 'schemaVersion: 1.0.0\nid: alpha\nname: Alpha\ndescription: d\nparentSystem: TestSystem');
    proj.writeSpec('component', 'billing', 'id: billing\nname: Billing\ndescription: d\nsubsystem: alpha\ncomponentType: Orchestrator');
    proj.writeSpec('interface', 'ibilling', 'id: ibilling\nname: IBilling\ndescription: d\ncomponent: billing\nmethods: []');
    proj.writeSpec('implementation', 'billing_impl', 'id: billing_impl\nname: Billing\ndescription: d\ncontract: ibilling\nsourcePath: src/alpha/billing.ts\nmethods: []');
    proj.activate();
    try {
      const brief = composeAgentBrief('billing');
      expect(brief.instructions).toContain('(planned — create it)');
      expect(brief.typeMapping).toBeDefined();
    } finally { proj.cleanup(); }
  });

  it('an unknown id still refuses, saying a component id would compose a brief', () => {
    const proj = createTempProject();
    proj.activate();
    try {
      expect(() => composeAgentBrief('nope')).toThrow(/any component id of this project/);
    } finally { proj.cleanup(); }
  });
});
