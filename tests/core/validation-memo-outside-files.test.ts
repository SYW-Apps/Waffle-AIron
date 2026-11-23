import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { validateProject } from '../../src/core/validation.js';
import { runWithProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { materializeFixtureProject, type FixtureTree } from '../rules-matrix/harness.js';

// The validation memo fingerprints every source file the code model reads, the
// other project files its bounded walk reads included (a composition root, a
// test, a file no spec names): what the model reads there changes what the
// rules answer, so a remembered run must not answer for code that changed.

process.env.WAIRON_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-memo-outside-cache-'));

const SUB = { id: 'work', description: 'Does the work of the system.' };

/** A module realizing one contract method, with an exported helper no contract declares; an unspecced file may be the only user of the helper. */
function tree(wiring: string): FixtureTree {
  return {
    system: { name: 'WorkService', vision: 'Does some work and tallies it.', targetLanguage: 'typescript' },
    subsystems: [SUB],
    components: [{ id: 'worker', subsystem: SUB.id, componentType: 'Orchestrator', description: 'Does the work.', invokedBy: { kind: 'runtime', caller: 'The composition root calls the worker once per job.' } }],
    interfaces: [{ id: 'iworker', component: 'worker', methods: [{ name: 'run', description: 'Run one job.', params: [], returns: 'void' }] }],
    implementations: [{ id: 'worker_impl', contract: 'iworker', sourcePath: 'src/worker.ts', methods: [{ name: 'run', narrative: [{ stepNumber: 1, type: 'local', description: 'Do the job.' }] }] }],
    files: {
      'src/worker.ts': 'export function run(): void {\n  void 0;\n}\n\nexport function tally(): number {\n  return 1;\n}\n',
      'src/wiring.ts': wiring,
    },
  } as unknown as FixtureTree;
}

const USING = "import { tally } from './worker.js';\n\nexport const total = tally();\n";
const NOT_USING = 'export const total = 1;\n';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) {
    try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* windows file locks */ }
  }
});

function project(wiring: string): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-memo-outside-')));
  roots.push(root);
  materializeFixtureProject(root, tree(wiring));
  invalidateSpecCache();
  return root;
}

const validate = (root: string): string[] =>
  runWithProjectRoot(root, () => validateProject({ projectType: 'backend' })).issues
    .map((i) => `${i.code}@${i.specId ?? ''}`)
    .sort();

const surface = (codes: string[]): string[] => codes.filter((c) => c.startsWith('UNDECLARED_'));

describe('validation memo: files no spec names', () => {
  it('answers as a fresh run does once the only use of a helper is removed from an unspecced file', () => {
    const root = project(USING);
    const first = validate(root);
    expect(surface(first)).toEqual([]);

    // The unspecced file stops using the helper; nothing under .wai/ changed.
    fs.writeFileSync(path.join(root, 'src', 'wiring.ts'), NOT_USING);
    const second = validate(root);

    const fresh = validate(project(NOT_USING));
    expect(surface(fresh).length).toBeGreaterThan(0);
    expect(second).toEqual(fresh);
  });
});
