import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { validateSddTree } from '../../src/core/validation.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { RulesConfig, RulesConfigSchema } from '../../src/models/project.js';

describe('Naming and Complexity Rules Validation', () => {
  function createTempProject(rules: RulesConfig) {
    invalidateSpecCache();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-naming-complexity-test-'));
    const originalCwd = process.cwd();

    const waiDir = path.join(tempDir, '.wai');
    fs.mkdirSync(waiDir);
    fs.writeFileSync(path.join(waiDir, 'project.yaml'), JSON.stringify({
      schemaVersion: '1.0.0',
      name: 'naming-complexity-test-project',
      targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
      rules,
    }));

    const specsDir = path.join(waiDir, 'specs');
    fs.mkdirSync(specsDir);
    fs.mkdirSync(path.join(specsDir, 'subsystems'));
    fs.mkdirSync(path.join(specsDir, 'components'));
    fs.mkdirSync(path.join(specsDir, 'interfaces'));
    fs.mkdirSync(path.join(specsDir, 'implementations'));
    fs.mkdirSync(path.join(specsDir, 'types'));

    return {
      tempDir,
      originalCwd,
      writeSpec: (type: 'system' | 'subsystem' | 'component' | 'interface' | 'implementation' | 'type', name: string, content: string) => {
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
        invalidateSpecCache();
        vi.restoreAllMocks();
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (e) {
          // ignore cleanup errors
        }
      }
    };
  }

  describe('Naming Conventions', () => {
    it('enforces casing constraints on subsystems and components', () => {
      const rules: RulesConfig = {
        noOverlappingOwnership: true,
        requireOwnedPaths: false,
        metaAgentTags: [],
        enforceReproducibility: false,
        naming: {
          subsystems: 'kebab-case',
          components: 'camelCase',
        }
      };

      const proj = createTempProject(rules);
      proj.activate();

      proj.writeSpec('system', 'system', `
schemaVersion: 1.0.0
name: TestSystem
vision: test
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);

      // Subsystem with PascalCase name (invalid for kebab-case)
      proj.writeSpec('subsystem', 'subsystem_a', `
schemaVersion: 1.0.0
id: subsystem_a
name: SubsystemA
parentSystem: TestSystem
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
description: valid description
`);

      // Component with PascalCase id and kebab-case name (invalid for camelCase)
      proj.writeSpec('component', 'invalid-comp', `
schemaVersion: 1.0.0
id: invalid-comp
name: invalid-comp
subsystem: subsystem_a
componentType: Specialist
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
description: valid description
`);

      const result = validateSddTree(rules);
      expect(result.valid).toBe(true); // Warnings don't invalidate tree
      const codes = result.issues.map(i => i.code);
      expect(codes).toContain('NAMING_CONVENTION_VIOLATION');
      const messages = result.issues.map(i => i.message);
      expect(messages.some(m => m.includes('Subsystem ID "subsystem_a"'))).toBe(true);
      expect(messages.some(m => m.includes('Component ID "invalid-comp"'))).toBe(true);

      proj.cleanup();
    });

    it('enforces stereotype naming prefixes/suffixes', () => {
      const rules: RulesConfig = {
        noOverlappingOwnership: true,
        requireOwnedPaths: false,
        metaAgentTags: [],
        enforceReproducibility: false,
        naming: {
          stereotypes: {
            Portal: {
              match: 'both',
              suffix: 'Portal',
            },
            Store: {
              match: 'id',
              prefix: 'store_',
            }
          }
        }
      };

      const proj = createTempProject(rules);
      proj.activate();

      proj.writeSpec('system', 'system', `
schemaVersion: 1.0.0
name: TestSystem
vision: test
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);

      proj.writeSpec('subsystem', 'sub-a', `
schemaVersion: 1.0.0
id: sub-a
name: sub-a
parentSystem: TestSystem
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
description: valid description
`);

      // Portal component not ending in "Portal"
      proj.writeSpec('component', 'main_entry', `
schemaVersion: 1.0.0
id: main_entry
name: main_entry
subsystem: sub-a
componentType: Portal
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
description: valid description
`);

      // Store component ID not prefixed with "store_"
      proj.writeSpec('component', 'db_store', `
schemaVersion: 1.0.0
id: db_store
name: db_store
subsystem: sub-a
componentType: Store
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
description: valid description
`);

      const result = validateSddTree(rules);
      const codes = result.issues.map(i => i.code);
      expect(codes).toContain('STEREOTYPE_NAMING_VIOLATION');
      const messages = result.issues.map(i => i.message);
      expect(messages.some(m => m.includes('must end with suffix "Portal"'))).toBe(true);
      expect(messages.some(m => m.includes('must start with prefix "store_"'))).toBe(true);

      proj.cleanup();
    });

    it('reports invalid naming regex patterns without crashing validation', () => {
      const rules: RulesConfig = {
        noOverlappingOwnership: true,
        requireOwnedPaths: false,
        metaAgentTags: [],
        enforceReproducibility: false,
        naming: {
          components: '[',
        }
      };

      const proj = createTempProject(rules);
      proj.activate();

      proj.writeSpec('system', 'system', `
schemaVersion: 1.0.0
name: TestSystem
vision: test
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);

      proj.writeSpec('subsystem', 'sub-a', `
schemaVersion: 1.0.0
id: sub-a
name: sub-a
parentSystem: TestSystem
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
description: valid description
`);

      proj.writeSpec('component', 'comp-a', `
schemaVersion: 1.0.0
id: comp-a
name: comp-a
subsystem: sub-a
componentType: Specialist
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
description: valid description
`);

      const result = validateSddTree(rules);
      expect(result.valid).toBe(false);
      expect(result.issues.map(i => i.code)).toContain('INVALID_NAMING_PATTERN');

      proj.cleanup();
    });
  });

  describe('Rule Config Schema', () => {
    it('rejects negative and fractional numeric thresholds', () => {
      expect(RulesConfigSchema.safeParse({ complexity: { maxInterfaceMethods: -1 } }).success).toBe(false);
      expect(RulesConfigSchema.safeParse({ documentation: { minDescriptionLength: 1.5 } }).success).toBe(false);
    });
  });

  describe('Complexity and Metadata Checks', () => {
    it('enforces required description checks and length constraints', () => {
      const rules: RulesConfig = {
        noOverlappingOwnership: true,
        requireOwnedPaths: false,
        metaAgentTags: [],
        enforceReproducibility: false,
        documentation: {
          minDescriptionLength: 10,
          requireDescriptions: true,
        }
      };

      const proj = createTempProject(rules);
      proj.activate();

      proj.writeSpec('system', 'system', `
schemaVersion: 1.0.0
name: TestSystem
vision: test
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);

      proj.writeSpec('subsystem', 'sub-a', `
schemaVersion: 1.0.0
id: sub-a
name: sub-a
parentSystem: TestSystem
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
description: short
`);

      // Component with empty description
      proj.writeSpec('component', 'comp-a', `
schemaVersion: 1.0.0
id: comp-a
name: comp-a
subsystem: sub-a
componentType: Specialist
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
description: ''
`);

      const result = validateSddTree(rules);
      const codes = result.issues.map(i => i.code);
      expect(codes).toContain('MISSING_DESCRIPTION');
      expect(codes).toContain('DESCRIPTION_TOO_SHORT');
      
      const messages = result.issues.map(i => i.message);
      expect(messages.some(m => m.includes('is missing a required description'))).toBe(true);
      expect(messages.some(m => m.includes('description is too short'))).toBe(true);

      proj.cleanup();
    });

    it('enforces complexity metrics (methods, dependencies, steps)', () => {
      const rules: RulesConfig = {
        noOverlappingOwnership: true,
        requireOwnedPaths: false,
        metaAgentTags: [],
        enforceReproducibility: false,
        complexity: {
          maxMethodParams: 1,
          maxInterfaceMethods: 1,
          maxNarrativeSteps: 2,
          maxComponentDependencies: 1,
          maxSubsystemComponents: 2,
        }
      };

      const proj = createTempProject(rules);
      proj.activate();

      proj.writeSpec('system', 'system', `
schemaVersion: 1.0.0
name: TestSystem
vision: test
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);

      proj.writeSpec('subsystem', 'sub-a', `
schemaVersion: 1.0.0
id: sub-a
name: sub-a
parentSystem: TestSystem
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
description: valid description
`);

      // Component with 2 dependencies (limit is 1)
      proj.writeSpec('component', 'comp-a', `
schemaVersion: 1.0.0
id: comp-a
name: comp-a
subsystem: sub-a
componentType: Specialist
dependsOn: [comp-b, comp-c]
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
description: valid description
`);

      proj.writeSpec('component', 'comp-b', `
schemaVersion: 1.0.0
id: comp-b
name: comp-b
subsystem: sub-a
componentType: Specialist
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
description: valid description
`);

      proj.writeSpec('component', 'comp-c', `
schemaVersion: 1.0.0
id: comp-c
name: comp-c
subsystem: sub-a
componentType: Specialist
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
description: valid description
`);

      // Interface with 2 methods (limit is 1)
      proj.writeSpec('interface', 'icomp-a', `
schemaVersion: 1.0.0
id: icomp-a
name: icomp-a
description: valid description
component: comp-a
methods:
  - name: methodOne
    description: one
    signature: 'methodOne(): void'
    returns: void
    params:
      - name: first
        type: string
      - name: second
        type: string
  - name: methodTwo
    description: two
    signature: 'methodTwo(): void'
    returns: void
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);

      // Implementation with 3 narrative steps (limit is 2)
      proj.writeSpec('implementation', 'comp-a', `
schemaVersion: 1.0.0
id: comp-a
name: comp-a
description: valid description
contract: icomp-a
methods:
  - name: methodOne
    narrative:
      - stepNumber: 1
        description: step one
        type: local
      - stepNumber: 2
        description: step two
        type: local
      - stepNumber: 3
        description: step three
        type: local
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);

      const result = validateSddTree(rules);
      const codes = result.issues.map(i => i.code);
      expect(codes).toContain('EXCESSIVE_DEPENDENCIES');
      expect(codes).toContain('EXCESSIVE_METHODS');
      expect(codes).toContain('EXCESSIVE_METHOD_PARAMS');
      expect(codes).toContain('EXCESSIVE_NARRATIVE_STEPS');
      expect(codes).toContain('EXCESSIVE_SUBSYSTEM_COMPONENTS');

      proj.cleanup();
    });
  });
});
