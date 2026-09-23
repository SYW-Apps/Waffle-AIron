import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
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

  it('leaves the CLI command with no second declaration of StatusOptions', () => {
    // Two declarations of the same option shape is how the terminal and the
    // MCP server come to disagree about what recursion depth means.
    const source = fs.readFileSync(path.join(REPO_ROOT, 'src/commands/status.ts'), 'utf8');
    expect(source).not.toContain('interface StatusOptions');
    expect(source).toContain("import type { StatusOptions } from '../core/status.js';");
  });
});
