import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { resolveAgentTopology } from '../../src/core/agent_resolver.js';

// ---------------------------------------------------------------------------
// Owned-path derivation: implementation sourcePaths are authoritative;
// filename inference is a FALLBACK for components with no implemented
// sourcePath. Regression: a Repository-typed component realized elsewhere
// must not infer-claim a foreign file literally named repository.ts
// (OVERLAPPING_OWNERSHIP across subsystem owners — broke wairon's own
// validate --ci when spec_loader was promoted to a Repository).
// ---------------------------------------------------------------------------

function createTempProject() {
  invalidateSpecCache();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-own-test-'));

  const waiDir = path.join(tempDir, '.wai');
  fs.mkdirSync(waiDir);
  fs.writeFileSync(path.join(waiDir, 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0',
    name: 'test-project',
    projectType: 'backend',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {},
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

describe('agent owned-path derivation (inference is a fallback only)', () => {
  it('an implemented Repository does not infer-claim a foreign file named after its component type', () => {
    const proj = createTempProject();
    proj.writeSpec('subsystem', 'alpha', 'schemaVersion: 1.0.0\nid: alpha\nname: Alpha\ndescription: d\nparentSystem: TestSystem');
    proj.writeSpec('subsystem', 'beta', 'schemaVersion: 1.0.0\nid: beta\nname: Beta\ndescription: d\nparentSystem: TestSystem');

    // beta legitimately realizes its Repository in src/alpha/rules/repository.ts
    // — a foreign-directory realization, exactly like sdd_validator's rule
    // Repository living under src/core/rules/ in wairon's own tree.
    proj.writeSpec('component', 'log_repository', 'schemaVersion: 1.0.0\nid: log_repository\nname: log_repository\ndescription: d\nsubsystem: beta\ncomponentType: Repository');
    proj.writeSpec('interface', 'ilog_repository', `schemaVersion: 1.0.0
id: ilog_repository
name: ILog
description: d
component: log_repository
methods:
  - name: read
    description: Reads the log.
    signature: "read(): string"
    returns: "string"`);
    proj.writeSpec('implementation', 'log_repository_impl', `schemaVersion: 1.0.0
id: log_repository_impl
name: LogImpl
description: d
contract: ilog_repository
sourcePath: src/alpha/rules/repository.ts
methods:
  - name: read
    narrative:
      - { stepNumber: 1, description: return the log, type: return, outcome: the log }`);
    proj.writeFile('src/alpha/rules/repository.ts', 'export const log = 1;\n');

    // alpha's Repository facade is realized in src/alpha/data.ts — its
    // componentType would inference-match beta's repository.ts by basename.
    proj.writeSpec('component', 'spec_facade', 'schemaVersion: 1.0.0\nid: spec_facade\nname: spec_facade\ndescription: d\nsubsystem: alpha\ncomponentType: Repository');
    proj.writeSpec('interface', 'ispec_facade', `schemaVersion: 1.0.0
id: ispec_facade
name: ISpec
description: d
component: spec_facade
methods:
  - name: read
    description: Reads the data.
    signature: "read(): string"
    returns: "string"`);
    proj.writeSpec('implementation', 'spec_facade_impl', `schemaVersion: 1.0.0
id: spec_facade_impl
name: SpecImpl
description: d
contract: ispec_facade
sourcePath: src/alpha/data.ts
methods:
  - name: read
    narrative:
      - { stepNumber: 1, description: return the data, type: return, outcome: the data }`);
    proj.writeFile('src/alpha/data.ts', 'export const data = 1;\n');

    proj.activate();
    try {
      const agents = resolveAgentTopology();
      const alpha = agents.find((a) => a.id === 'alpha-owner')!;
      const beta = agents.find((a) => a.id === 'beta-owner')!;
      expect(alpha.ownedPaths).toContain('src/alpha/data.ts');
      expect(alpha.ownedPaths).not.toContain('src/alpha/rules/repository.ts');
      expect(beta.ownedPaths).toContain('src/alpha/rules/repository.ts');

      // No source path is claimed by two owners (the exact check validate --ci runs).
      const seen = new Map<string, string>();
      for (const a of agents) {
        for (const p of a.ownedPaths.filter((x) => x.startsWith('src/'))) {
          expect(seen.get(p), `path ${p} claimed by ${seen.get(p)} and ${a.id}`).toBeUndefined();
          seen.set(p, a.id);
        }
      }
    } finally { proj.cleanup(); }
  });

  it('a component with no implemented sourcePath still gets the inference fallback', () => {
    const proj = createTempProject();
    proj.writeSpec('subsystem', 'alpha', 'schemaVersion: 1.0.0\nid: alpha\nname: Alpha\ndescription: d\nparentSystem: TestSystem');
    proj.writeSpec('component', 'parser_specialist', 'schemaVersion: 1.0.0\nid: parser_specialist\nname: parser_specialist\ndescription: d\nsubsystem: alpha\ncomponentType: Specialist');
    proj.writeFile('src/alpha/parser_specialist.ts', 'export const parse = 1;\n');

    proj.activate();
    try {
      const alpha = resolveAgentTopology().find((a) => a.id === 'alpha-owner')!;
      expect(alpha.ownedPaths).toContain('src/alpha/parser_specialist.ts');
    } finally { proj.cleanup(); }
  });
});
