import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
// Imported to force colour ON for the dashboard assertions, never to build the
// expectations: those are written out as literal escape sequences.
import chalk from 'chalk';
import { runStatus } from '../../src/commands/status.js';
import { getStatusReport } from '../../src/core/status.js';
import * as corePortal from '../../src/core/index.js';

function createTempProject() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-status-test-'));
  const originalCwd = process.cwd();

  // Create .wai directory and project.yaml
  const waiDir = path.join(tempDir, '.wai');
  fs.mkdirSync(waiDir);
  fs.writeFileSync(path.join(waiDir, 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0',
    name: 'test-project',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
  }));

  const specsDir = path.join(waiDir, 'specs');
  fs.mkdirSync(specsDir);
  fs.mkdirSync(path.join(specsDir, 'subsystems'));
  fs.mkdirSync(path.join(specsDir, 'components'));
  fs.mkdirSync(path.join(specsDir, 'interfaces'));
  fs.mkdirSync(path.join(specsDir, 'implementations'));

  return {
    tempDir,
    originalCwd,
    writeSpec: (type: 'system' | 'subsystem' | 'component' | 'interface' | 'implementation', name: string, content: string) => {
      let filePath = '';
      if (type === 'system') {
        filePath = path.join(specsDir, '.index.yaml');
      } else {
        filePath = path.join(specsDir, `${type}s`, `${name}.yaml`);
      }
      fs.writeFileSync(filePath, content);
    },
    activate: () => {
      vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
    },
    cleanup: () => {
      vi.restoreAllMocks();
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (e) {
        // ignore cleanup
      }
    }
  };
}

describe('runStatus completeness dashboard', () => {
  it('prints completeness tree correctly for complete and draft nodes', async () => {
    const proj = createTempProject();
    proj.writeSpec('system', 'system', `
schemaVersion: 1.0.0
name: TestSystem
vision: A system for testing
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);
    proj.writeSpec('subsystem', 'sub-a', `
schemaVersion: 1.0.0
id: sub-a
name: SubsystemA
description: Subsystem A description
parentSystem: TestSystem
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);
    // comp-complete is 100% complete (L2, L3, L4, source file exist)
    proj.writeSpec('component', 'comp-complete', `
schemaVersion: 1.0.0
id: comp-complete
name: ComponentComplete
description: Complete component
subsystem: sub-a
componentType: Orchestrator
dependsOn: []
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);
    proj.writeSpec('interface', 'icomp-complete', `
schemaVersion: 1.0.0
id: icomp-complete
name: InterfaceComplete
description: Interface Complete
component: comp-complete
methods:
  - name: execute
    description: Execute
    signature: "execute(): Promise<void>"
    returns: "Promise<void>"
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);
    // Create actual source path on disk inside temp directory
    const srcPath = path.join(proj.tempDir, 'src/complete.ts');
    fs.mkdirSync(path.join(proj.tempDir, 'src'), { recursive: true });
    fs.writeFileSync(srcPath, '// code');

    proj.writeSpec('implementation', 'impl-complete', `
schemaVersion: 1.0.0
id: impl-complete
name: ImplementationComplete
description: Implementation Complete
contract: icomp-complete
sourcePath: src/complete.ts
methods:
  - name: execute
    narrative:
      - stepNumber: 1
        description: Step
        type: local
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);

    // comp-draft is explicitly status: draft (capped at max 50%)
    proj.writeSpec('component', 'comp-draft', `
schemaVersion: 1.0.0
id: comp-draft
name: ComponentDraft
description: Draft component
subsystem: sub-a
componentType: Store
dependsOn: []
status: draft
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);

    proj.activate();

    // Mock console.log
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await runStatus();

      const loggedLines = logSpy.mock.calls.map(call => call.join(' ')).join('\n');

      // Verify that system, subsystem and components are listed
      expect(loggedLines).toContain('TestSystem');
      expect(loggedLines).toContain('sub-a');
      expect(loggedLines).toContain('comp-complete');
      expect(loggedLines).toContain('comp-draft');

      // Verify percentage calculations
      // comp-complete: 20 (L2) + 30 (L3) + 30 (L4) + 20 (srcExists) = 100%
      expect(loggedLines).toContain('comp-complete');
      expect(loggedLines).toContain('(100%)');
      // comp-draft: status is draft, so capped at 50% (actual score is 20% due to missing interface/implementation)
      expect(loggedLines).toContain('comp-draft');
      expect(loggedLines).toContain('(20%)');
    } finally {
      logSpy.mockRestore();
      proj.cleanup();
    }
  });

  it("lists a method's own source file", () => {
    const proj = createTempProject();
    proj.writeSpec('system', 'system', `
schemaVersion: 1.0.0
name: TestSystem
vision: A system for testing
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);
    proj.writeSpec('subsystem', 'sub-a', `
schemaVersion: 1.0.0
id: sub-a
name: SubsystemA
description: Subsystem A description
parentSystem: TestSystem
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);
    proj.writeSpec('component', 'comp-method-path', `
schemaVersion: 1.0.0
id: comp-method-path
name: ComponentMethodPath
description: Component with a method-level source file
subsystem: sub-a
componentType: Orchestrator
dependsOn: []
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);
    proj.writeSpec('interface', 'icomp-method-path', `
schemaVersion: 1.0.0
id: icomp-method-path
name: InterfaceMethodPath
description: Interface Method Path
component: comp-method-path
methods:
  - name: execute
    description: Execute
    signature: "execute(): Promise<void>"
    returns: "Promise<void>"
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);

    fs.mkdirSync(path.join(proj.tempDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(proj.tempDir, 'src/impl.ts'), '// impl');
    fs.writeFileSync(path.join(proj.tempDir, 'src/execute.ts'), '// method');

    proj.writeSpec('implementation', 'impl-method-path', `
schemaVersion: 1.0.0
id: impl-method-path
name: ImplementationMethodPath
description: Implementation Method Path
contract: icomp-method-path
sourcePath: src/impl.ts
methods:
  - name: execute
    sourcePath: src/execute.ts
    narrative:
      - stepNumber: 1
        description: Step
        type: local
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);

    proj.activate();
    try {
      const report = getStatusReport();
      // Proof (revert): removing the method-listing loop in getStatusReport
      // makes this assertion fail because the method line is never printed.
      expect(report).toContain('method execute -> src/execute.ts');
      expect(report).not.toContain('method execute -> src/execute.ts (File Missing!)');
    } finally {
      proj.cleanup();
    }
  });

  it('flags a missing method source file', async () => {
    const proj = createTempProject();
    proj.writeSpec('system', 'system', `
schemaVersion: 1.0.0
name: TestSystem
vision: A system for testing
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);
    proj.writeSpec('subsystem', 'sub-a', `
schemaVersion: 1.0.0
id: sub-a
name: SubsystemA
description: Subsystem A description
parentSystem: TestSystem
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);
    proj.writeSpec('component', 'comp-method-missing', `
schemaVersion: 1.0.0
id: comp-method-missing
name: ComponentMethodMissing
description: Component with a missing method-level source file
subsystem: sub-a
componentType: Orchestrator
dependsOn: []
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);
    proj.writeSpec('interface', 'icomp-method-missing', `
schemaVersion: 1.0.0
id: icomp-method-missing
name: InterfaceMethodMissing
description: Interface Method Missing
component: comp-method-missing
methods:
  - name: execute
    description: Execute
    signature: "execute(): Promise<void>"
    returns: "Promise<void>"
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);

    fs.mkdirSync(path.join(proj.tempDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(proj.tempDir, 'src/impl.ts'), '// impl');
    // src/missing-execute.ts is deliberately never written to disk.

    proj.writeSpec('implementation', 'impl-method-missing', `
schemaVersion: 1.0.0
id: impl-method-missing
name: ImplementationMethodMissing
description: Implementation Method Missing
contract: icomp-method-missing
sourcePath: src/impl.ts
methods:
  - name: execute
    sourcePath: src/missing-execute.ts
    narrative:
      - stepNumber: 1
        description: Step
        type: local
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);

    proj.activate();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runStatus();
      const loggedLines = logSpy.mock.calls.map(call => call.join(' ')).join('\n');
      // Proof (revert): dropping the ` (File Missing!)` suffix on a missing
      // method file makes this assertion fail.
      expect(loggedLines).toContain('method execute -> src/missing-execute.ts (File Missing!)');
    } finally {
      logSpy.mockRestore();
      proj.cleanup();
    }
  });

  it('requires every named file to exist before crediting the source-file score', () => {
    const proj = createTempProject();
    proj.writeSpec('system', 'system', `
schemaVersion: 1.0.0
name: TestSystem
vision: A system for testing
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);
    proj.writeSpec('subsystem', 'sub-a', `
schemaVersion: 1.0.0
id: sub-a
name: SubsystemA
description: Subsystem A description
parentSystem: TestSystem
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);
    proj.writeSpec('component', 'comp-partial-files', `
schemaVersion: 1.0.0
id: comp-partial-files
name: ComponentPartialFiles
description: Component whose implementation only partially exists on disk
subsystem: sub-a
componentType: Orchestrator
dependsOn: []
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);
    proj.writeSpec('interface', 'icomp-partial-files', `
schemaVersion: 1.0.0
id: icomp-partial-files
name: InterfacePartialFiles
description: Interface Partial Files
component: comp-partial-files
methods:
  - name: execute
    description: Execute
    signature: "execute(): Promise<void>"
    returns: "Promise<void>"
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);

    // The implementation's OWN source file exists...
    fs.mkdirSync(path.join(proj.tempDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(proj.tempDir, 'src/impl.ts'), '// impl');
    // ...but the method's own file does not.

    proj.writeSpec('implementation', 'impl-partial-files', `
schemaVersion: 1.0.0
id: impl-partial-files
name: ImplementationPartialFiles
description: Implementation Partial Files
contract: icomp-partial-files
sourcePath: src/impl.ts
methods:
  - name: execute
    sourcePath: src/missing-execute.ts
    narrative:
      - stepNumber: 1
        description: Step
        type: local
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);

    proj.activate();
    try {
      const report = getStatusReport();
      // 20 (L2) + 30 (L3) + 30 (L4) = 80%; the 20% source-file credit is
      // withheld because the method's own file does not exist even though
      // the implementation's own sourcePath does.
      //
      // Proof (revert): scoring only on impl.sourcePath (the old behavior)
      // makes this component read (100%) instead of (80%).
      expect(report).toContain('comp-partial-files');
      expect(report).toContain('(80%)');
      expect(report).not.toContain('(100%)');
    } finally {
      proj.cleanup();
    }
  });

  it('lists method files instead of "(No source path)" when the implementation names no path of its own', () => {
    const proj = createTempProject();
    proj.writeSpec('system', 'system', `
schemaVersion: 1.0.0
name: TestSystem
vision: A system for testing
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);
    proj.writeSpec('subsystem', 'sub-a', `
schemaVersion: 1.0.0
id: sub-a
name: SubsystemA
description: Subsystem A description
parentSystem: TestSystem
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);
    proj.writeSpec('component', 'comp-no-own-path', `
schemaVersion: 1.0.0
id: comp-no-own-path
name: ComponentNoOwnPath
description: Component whose implementation names no path of its own
subsystem: sub-a
componentType: Orchestrator
dependsOn: []
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);
    proj.writeSpec('interface', 'icomp-no-own-path', `
schemaVersion: 1.0.0
id: icomp-no-own-path
name: InterfaceNoOwnPath
description: Interface No Own Path
component: comp-no-own-path
methods:
  - name: execute
    description: Execute
    signature: "execute(): Promise<void>"
    returns: "Promise<void>"
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);

    fs.mkdirSync(path.join(proj.tempDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(proj.tempDir, 'src/execute.ts'), '// method');

    // No implementation-level sourcePath at all — only the method names one.
    proj.writeSpec('implementation', 'impl-no-own-path', `
schemaVersion: 1.0.0
id: impl-no-own-path
name: ImplementationNoOwnPath
description: Implementation No Own Path
contract: icomp-no-own-path
methods:
  - name: execute
    sourcePath: src/execute.ts
    narrative:
      - stepNumber: 1
        description: Step
        type: local
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);

    proj.activate();
    try {
      const report = getStatusReport();
      // Proof (revert): restoring the old unconditional "(No source path)"
      // suffix (whenever impl.sourcePath is absent) makes this assertion fail.
      expect(report).not.toContain('(No source path)');
      expect(report).toContain('method execute -> src/execute.ts');
      // Every file implementationSourceFiles(impl) names exists (just the one
      // method file), so the 20% source-file credit is still earned: 100%.
      expect(report).toContain('(100%)');
    } finally {
      proj.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Where the report is published from. The content of the report is covered
// above; what is asserted here is the BOUNDARY — which module owns it, and who
// is allowed to reach it from where. A type-check cannot make any of these:
// every spelling below compiles either way, so only the import SITE says which
// side of the subsystem line a caller is on.
// ---------------------------------------------------------------------------
describe('the completeness report is published from sdd_core', () => {
  const REPO_ROOT = path.resolve(__dirname, '..', '..');

  it('is the same function on the core portal as in the module — an identity re-export, not a wrapper', () => {
    // core_portal getStatusReport forwards 1:1 to project_status report, and
    // the forward is the re-export itself. A wrapper would still return the
    // right string while breaking the N:1 identity that CALL_STEP_UNREALIZED
    // exempts, so equality of OUTPUT is not the assertion that matters here.
    expect(corePortal.getStatusReport).toBe(getStatusReport);
  });

  it('answers through the portal what the module answers directly', () => {
    const proj = createTempProject();
    proj.writeSpec('system', 'system', `
schemaVersion: 1.0.0
name: TestSystem
vision: A system for testing
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);
    proj.writeSpec('subsystem', 'sub-a', `
schemaVersion: 1.0.0
id: sub-a
name: SubsystemA
description: Subsystem A description
parentSystem: TestSystem
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);
    proj.writeSpec('component', 'comp-a', `
schemaVersion: 1.0.0
id: comp-a
name: ComponentA
description: A component
subsystem: sub-a
componentType: Orchestrator
status: complete
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);

    proj.activate();
    try {
      const throughTheModule = getStatusReport();
      const throughThePortal = corePortal.getStatusReport();
      expect(throughTheModule).toContain('[Subsystem] sub-a');
      expect(throughThePortal).toBe(throughTheModule);
    } finally {
      proj.cleanup();
    }
  });

  it('is how the MCP server reaches it — sdd_mcp does not import the sdd_cli command', () => {
    // sdd_mcp importing ../commands/status.js put one subsystem behind another
    // for its own status tool. The ban is on the SPECIFIER in any spelling —
    // static import, lazy require or dynamic import — not on one import line.
    // The approval verdict now rides the same import, for the same reason: it
    // was a private helper in the CLI command, so the MCP tool had nothing to
    // say about a tree that had drifted.
    const source = fs.readFileSync(path.join(REPO_ROOT, 'src/mcp/server.ts'), 'utf8');
    expect(source).not.toContain('commands/status.js');
    expect(source).toMatch(/import \{ getStatusReport[^}]*\} from '\.\.\/core\/index\.js';/);
  });

  it('leaves the CLI command with no second declaration of the report vocabulary', () => {
    // Two declarations of the same option shape is how the terminal and the
    // MCP server come to disagree about what recursion depth means. The same
    // is true of the decor roles: the terminal supplies the COLOURS, never a
    // second opinion about what the roles are.
    const source = fs.readFileSync(path.join(REPO_ROOT, 'src/commands/status.ts'), 'utf8');
    expect(source).not.toContain('interface StatusOptions');
    expect(source).not.toContain('interface StatusDecor');
    expect(source).toContain("import type { StatusDecor, StatusOptions } from '../core/status.js';");
  });
});

// ---------------------------------------------------------------------------
// One renderer, two readers.
//
// `wairon status` used to be a second copy of this renderer: 901 of its 902
// output lines were identical to the report's, and the line that was not was
// the approval verdict — present in one copy, absent from the other, which is
// how the terminal and `sdd_get_status` came to disagree about whether the tree
// had drifted from its lock. The copy is gone; the terminal now supplies the
// COLOURS through `StatusDecor` and nothing else.
//
// What is asserted below is the seam that makes that safe: the report with no
// decor is the report it always was, every role lands where it is meant to and
// nowhere else, and the terminal's own output carries the same escape sequences
// it carried before the copy was deleted.
// ---------------------------------------------------------------------------

const REPO_ROOT_STATUS = path.resolve(__dirname, '..', '..');

/**
 * One tree exercising every role the report can mark: a present source file, a
 * missing one, a layer never written, a draft tag at three levels, a score at
 * each of the three grades, and an implementation that names no path at all.
 */
function createDecorFixture() {
  const proj = createTempProject();
  proj.writeSpec('system', 'system', `
schemaVersion: 1.0.0
name: TestSystem
vision: A system for testing
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);
  proj.writeSpec('subsystem', 'sub-a', `
schemaVersion: 1.0.0
id: sub-a
name: SubsystemA
description: Subsystem A description
parentSystem: TestSystem
status: complete
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);
  proj.writeSpec('subsystem', 'sub-b', `
schemaVersion: 1.0.0
id: sub-b
name: SubsystemB
description: Subsystem B description
parentSystem: TestSystem
status: draft
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);

  const component = (id: string, type: string, status: string) => `
schemaVersion: 1.0.0
id: ${id}
name: ${id}
description: Component ${id}
subsystem: sub-a
componentType: ${type}
dependsOn: []
status: ${status}
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`;
  const contract = (id: string, component: string, status: string, methods: string[]) => `
schemaVersion: 1.0.0
id: ${id}
name: ${id}
description: Interface ${id}
component: ${component}
status: ${status}
methods:
${methods.map(m => `  - name: ${m}\n    description: ${m}\n    signature: "${m}(): void"\n    returns: void`).join('\n')}
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`;

  proj.writeSpec('component', 'c1-full', component('c1-full', 'Orchestrator', 'complete'));
  proj.writeSpec('interface', 'ic1-full', contract('ic1-full', 'c1-full', 'complete', ['alpha']));
  proj.writeSpec('implementation', 'im1-full', `
schemaVersion: 1.0.0
id: im1-full
name: im1-full
description: Implementation im1-full
contract: ic1-full
sourcePath: src/one.ts
status: complete
methods:
  - name: alpha
    narrative:
      - stepNumber: 1
        description: Step
        type: local
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);

  proj.writeSpec('component', 'c2-gone', component('c2-gone', 'Store', 'complete'));
  proj.writeSpec('interface', 'ic2-gone', contract('ic2-gone', 'c2-gone', 'draft', ['alpha']));
  proj.writeSpec('implementation', 'im2-gone', `
schemaVersion: 1.0.0
id: im2-gone
name: im2-gone
description: Implementation im2-gone
contract: ic2-gone
sourcePath: src/gone.ts
status: complete
methods:
  - name: alpha
    narrative:
      - stepNumber: 1
        description: Step
        type: local
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);

  // Never given a contract, so the report says what is missing and what it cost.
  proj.writeSpec('component', 'c3-bare', component('c3-bare', 'Adapter', 'draft'));

  proj.writeSpec('component', 'c4-nopath', component('c4-nopath', 'Index', 'complete'));
  proj.writeSpec('interface', 'ic4-nopath', contract('ic4-nopath', 'c4-nopath', 'complete', ['alpha']));
  proj.writeSpec('implementation', 'im4-nopath', `
schemaVersion: 1.0.0
id: im4-nopath
name: im4-nopath
description: Implementation im4-nopath
contract: ic4-nopath
status: complete
methods:
  - name: alpha
    narrative:
      - stepNumber: 1
        description: Step
        type: local
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);

  proj.writeSpec('component', 'c5-methods', component('c5-methods', 'Registry', 'complete'));
  proj.writeSpec('interface', 'ic5-methods', contract('ic5-methods', 'c5-methods', 'complete', ['alpha', 'beta']));
  proj.writeSpec('implementation', 'im5-methods', `
schemaVersion: 1.0.0
id: im5-methods
name: im5-methods
description: Implementation im5-methods
contract: ic5-methods
status: complete
methods:
  - name: alpha
    sourcePath: src/m-here.ts
    narrative:
      - stepNumber: 1
        description: Step
        type: local
  - name: beta
    sourcePath: src/m-gone.ts
    narrative:
      - stepNumber: 1
        description: Step
        type: local
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);

  fs.mkdirSync(path.join(proj.tempDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(proj.tempDir, 'src/one.ts'), '// one');
  fs.writeFileSync(path.join(proj.tempDir, 'src/m-here.ts'), '// here');
  // src/gone.ts and src/m-gone.ts are deliberately never written.

  proj.activate();
  return proj;
}

/** The report that tree has always produced, with nothing marking it up. */
const PLAIN_FIXTURE_REPORT = [
  '● System: TestSystem (33% Complete)',
  '├── [Subsystem] sub-a (66%)',
  '│   ├── [Component: Orchestrator] c1-full (100%)',
  '│   │   ├── Interface: ic1-full (1 methods)',
  '│   │   └── Implementation: im1-full -> src/one.ts',
  '│   ├── [Component: Store] c2-gone (50%)',
  '│   │   ├── Interface: ic2-gone [draft] (1 methods)',
  '│   │   └── Implementation: im2-gone -> src/gone.ts (File Missing!)',
  '│   ├── [Component: Adapter] c3-bare [draft] (20%)',
  '│   │   └── Interface: Missing (-30%)',
  '│   │   └── Implementation: Missing (-30%)',
  '│   ├── [Component: Index] c4-nopath (80%)',
  '│   │   ├── Interface: ic4-nopath (1 methods)',
  '│   │   └── Implementation: im4-nopath (No source path)',
  '│   └── [Component: Registry] c5-methods (80%)',
  '│       ├── Interface: ic5-methods (2 methods)',
  '│       └── Implementation: im5-methods',
  '│           ├── method alpha -> src/m-here.ts',
  '│           └── method beta -> src/m-gone.ts (File Missing!)',
  '└── [Subsystem] sub-b [draft] (0%)',
  '',
].join('\n');

describe('the report renders once and the caller decides how it looks', () => {
  it('answers the same bytes with no decor that it answered before there was one', () => {
    const proj = createDecorFixture();
    try {
      // Byte equality, not containment: the decor seam defaults every role to
      // identity, so a report asked for plainly must be indistinguishable from
      // the report this renderer produced when it had no roles at all.
      expect(getStatusReport()).toBe(PLAIN_FIXTURE_REPORT);
    } finally {
      proj.cleanup();
    }
  });

  it('answers the same bytes for a decor that marks nothing', () => {
    const proj = createDecorFixture();
    try {
      const identity = {
        structure: (text: string) => text,
        emphasis: (text: string) => text,
        layer: (_kind: string, text: string) => text,
        score: (_pct: number, text: string) => text,
        draft: (text: string) => text,
        present: (text: string) => text,
        missing: (text: string) => text,
      };
      expect(getStatusReport({}, identity)).toBe(PLAIN_FIXTURE_REPORT);
    } finally {
      proj.cleanup();
    }
  });

  it('hands each part to the role that names what it is — and to no other', () => {
    const proj = createDecorFixture();
    try {
      const report = getStatusReport({}, {
        structure: text => `«s:${text}»`,
        emphasis: text => `«e:${text}»`,
        layer: (kind, text) => `«l/${kind}:${text}»`,
        score: (pct, text) => `«n/${pct}:${text}»`,
        draft: text => `«d:${text}»`,
        present: text => `«p:${text}»`,
        missing: text => `«m:${text}»`,
      });

      // The system's own name is the one thing marked `emphasis`, its label is
      // the `system` layer, and the percentage arrives with its number.
      expect(report).toContain('«l/system:● System:» «e:TestSystem» «n/33:(33% Complete)»');

      // Every layer label knows which layer it is.
      expect(report).toContain('«l/subsystem:[Subsystem] sub-a»');
      expect(report).toContain('«l/component:[Component: Orchestrator] c1-full»');
      expect(report).toContain('«l/interface:Interface: ic1-full»');
      expect(report).toContain('«l/implementation:Implementation: im1-full»');

      // Scaffolding — prefixes and indentation — is `structure`, one call per
      // line covering the whole run of it rather than one per box character.
      expect(report).toContain('«s:├── »«l/subsystem:[Subsystem] sub-a»');
      expect(report).toContain('«s:│   ├── »«l/component:[Component: Orchestrator] c1-full»');
      expect(report).toContain('«s:│           └── »«m:method beta -> src/m-gone.ts (File Missing!)»');

      // A source file that is there is `present`; one a spec names and does not
      // have is `missing`, which is also what an unwritten layer is.
      expect(report).toContain('«p: -> src/one.ts»');
      expect(report).toContain('«m: -> src/gone.ts (File Missing!)»');
      expect(report).toContain('«p:method alpha -> src/m-here.ts»');
      expect(report).toContain('«m:Interface: Missing (-30%)»');
      expect(report).toContain('«m:Implementation: Missing (-30%)»');

      // Detail that should recede is `structure`, not `missing`: an
      // implementation naming no path has nothing wrong with it.
      expect(report).toContain('«l/implementation:Implementation: im4-nopath»«s: (No source path)»');

      // A status tag on anything not complete is `draft`, at all three levels,
      // and it carries its own leading space so the role owns the whole tag.
      expect(report).toContain('«l/interface:Interface: ic2-gone»«d: [draft]»');
      expect(report).toContain('«l/component:[Component: Adapter] c3-bare»«d: [draft]»');
      expect(report).toContain('«l/subsystem:[Subsystem] sub-b»«d: [draft]»');

      // And nowhere else: the method COUNT beside an interface is plain text,
      // never a score, and a complete thing gets no draft tag.
      expect(report).toContain('«l/interface:Interface: ic1-full» (1 methods)');
      expect(report).not.toContain('«n/1:');
      expect(report).not.toContain('«n/2:');
      expect(report).not.toContain('«d: [complete]»');
      // The system name is emphasised once and never marked any other way.
      expect(report.match(/«e:/g)).toHaveLength(1);
    } finally {
      proj.cleanup();
    }
  });

  it('keeps sdd_core ignorant of terminals — the renderer imports no chalk', () => {
    // The whole reason the roles are named for MEANING rather than colour. A
    // chalk import here would compile and pass every output assertion above,
    // and would put a terminal concern inside the module the MCP server reads.
    const source = fs.readFileSync(path.join(REPO_ROOT_STATUS, 'src/core/status.ts'), 'utf8');
    expect(source).not.toMatch(/from ['"]chalk['"]/);
    expect(source).not.toContain('chalk');
  });
});

describe('wairon status keeps the colours it has always had', () => {
  it('carries the same escape sequences for the same parts', async () => {
    const proj = createDecorFixture();
    const previousLevel = chalk.level;
    // Force colour on the shared chalk instance the command imports — the
    // FORCE_COLOR=1 case, decided at import time in a real terminal.
    chalk.level = 1;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runStatus();
      const printed = logSpy.mock.calls.map(call => call.join(' ')).join('\n');

      // The sequences are written out literally rather than rebuilt with chalk:
      // composing the expectation from the same library that produced the
      // output would pass whatever that library did.
      const ESC = String.fromCharCode(27);
      const bold = (text: string) => `${ESC}[1m${text}${ESC}[22m`;
      const colour = (code: number, text: string) => `${ESC}[${code}m${text}${ESC}[39m`;
      const gray = (text: string) => colour(90, text);

      // System: bold blue label, bold name, and a score red below 50.
      expect(printed).toContain(
        `${bold(colour(34, '● System:'))} ${bold('TestSystem')} ${colour(31, '(33% Complete)')}`,
      );
      // Subsystem: gray scaffolding, bold cyan label, yellow score at 50+.
      expect(printed).toContain(
        `${gray('├── ')}${bold(colour(36, '[Subsystem] sub-a'))} ${colour(33, '(66%)')}`,
      );
      // A draft tag is yellow, and a component label is magenta.
      expect(printed).toContain(
        `${gray('│   ├── ')}${colour(35, '[Component: Adapter] c3-bare')}${colour(33, ' [draft]')} ${colour(31, '(20%)')}`,
      );
      // An interface label is blue; the method count beside it is uncoloured.
      expect(printed).toContain(
        `${gray('│   │   ├── ')}${colour(34, 'Interface: ic1-full')} (1 methods)`,
      );
      // An implementation label is green, and so is a source file that exists.
      expect(printed).toContain(
        `${gray('│   │   └── ')}${colour(32, 'Implementation: im1-full')}${colour(32, ' -> src/one.ts')}`,
      );
      // A file the spec names and the tree does not have is red.
      expect(printed).toContain(colour(31, ' -> src/gone.ts (File Missing!)'));
      expect(printed).toContain(colour(31, 'Interface: Missing (-30%)'));
      // A missing method file is red; one that is there is green.
      expect(printed).toContain(colour(32, 'method alpha -> src/m-here.ts'));
      expect(printed).toContain(colour(31, 'method beta -> src/m-gone.ts (File Missing!)'));
      // "no source path" recedes into gray rather than reading as an error.
      expect(printed).toContain(`${colour(32, 'Implementation: im4-nopath')}${gray(' (No source path)')}`);
      // A score of 100 is green.
      expect(printed).toContain(colour(32, '(100%)'));

      // The report arrives as ONE console.log — it is no longer printed a line
      // at a time — and it already ends its last line, so printing it must not
      // open a second blank one between the tree and the verdict below it.
      const treeCall = logSpy.mock.calls.find(call => String(call[0]).includes('● System:'));
      expect(treeCall).toBeDefined();
      expect(String(treeCall?.[0]).endsWith('\n')).toBe(false);
      expect(String(treeCall?.[0])).toContain('[Subsystem] sub-b');
    } finally {
      chalk.level = previousLevel;
      logSpy.mockRestore();
      proj.cleanup();
    }
  });
});
