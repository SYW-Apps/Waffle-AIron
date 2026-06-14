import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { runStatus } from '../../src/commands/status.js';

describe('runStatus completeness dashboard', () => {
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
          filePath = path.join(specsDir, 'system.yaml');
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
dependencies: []
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
dependencies: []
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
});
