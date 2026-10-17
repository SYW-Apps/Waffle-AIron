import { describe, it, expect, afterEach } from 'vitest';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { getStatusReport } from '../../src/core/status.js';
import { statusFamilyContext } from '../../src/mcp/server.js';
import { buildReferenceFamily, type ReferenceFamily } from '../helpers/reference-family.js';

// ---------------------------------------------------------------------------
// The status tree over the reference family (stage 3): the bound project's
// own subsystems print as subsystems, and each member the tree reaches prints
// as a `[Project] alias (id)` holding its own subsystems — never as a
// `[Subsystem]` of its parent. A legacy L1 mount is noted as the mount form,
// and a subsystem under a member is labelled by its local name while its key
// stays honest. The MCP status line names every member, legacy mounts included.
// ---------------------------------------------------------------------------

let family: ReferenceFamily | undefined;

afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  family?.cleanup();
  family = undefined;
});

function bind(root: string): void {
  setProjectRoot(root);
  invalidateSpecCache();
}

describe('status: members print as projects', () => {
  it('nests each member as a [Project] holding its own subsystems, the mount form noted', () => {
    family = buildReferenceFamily();
    bind(family.top);
    const report = getStatusReport({});
    expect(report.failed).toBe(false);
    const lines = report.text.split('\n');

    // The top's own subsystem, then its members as projects.
    expect(lines[0]).toMatch(/^● System: Waffly /);
    expect(lines).toContain('├── [Subsystem] app (20%)');
    expect(lines).toContain('├── [Project] core (core)');
    expect(lines).toContain('└── [Project] shared (shared) [mount form]');
    // core's own subsystems by their local names, and its own member nested under it.
    expect(lines).toContain('│   ├── [Subsystem] engine (50%)');
    expect(lines).toContain('│   ├── [Subsystem] transpiler (0%)');
    expect(lines).toContain('│   └── [Project] transpiler (transpiler)');
    expect(lines).toContain('│       └── [Subsystem] lowering (20%)');
    // A member holding no subsystem (shared: a vocabulary of types) still prints.
    expect(lines[lines.length - 2]).toBe('└── [Project] shared (shared) [mount form]');
    // A member never prints as a subsystem of its parent.
    expect(report.text).not.toMatch(/\[Subsystem\] (core|shared)\b/);
    expect(report.text).not.toMatch(/\[Subsystem\] \S*::/);
  });

  it('marks a project line with its own role, so a caller can colour it', () => {
    family = buildReferenceFamily();
    bind(family.top);
    const report = getStatusReport({}, { layer: (kind, text) => `«${kind}:${text}»` });
    expect(report.text).toContain('«project:[Project] core (core)»');
    expect(report.text).toContain('«subsystem:[Subsystem] engine»');
  });

  it('a tree without members renders exactly as before', () => {
    family = buildReferenceFamily();
    bind(family.transpiler);
    const report = getStatusReport({});
    expect(report.text).not.toContain('[Project]');
    expect(report.text.split('\n')[1]).toBe('└── [Subsystem] lowering (20%)');
  });

  it('the MCP status line lists every member the root declares, legacy mounts included', () => {
    family = buildReferenceFamily();
    bind(family.top);
    expect(statusFamilyContext()).toContain('Family: member projects declared here — core (core), shared (shared, legacy L1 mount).');
  });
});
