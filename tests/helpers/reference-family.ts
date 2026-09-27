import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeSpecFile } from '../../src/core/spec-files.js';
import {
  ComponentSpecSchema,
  InterfaceSpecSchema,
  SubsystemSpecSchema,
  SystemSpecSchema,
  TypeSpecSchema,
} from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// The reference family: Waffler's shape in miniature, on disk, for stage 3's
// properties (and waves B and C after it).
//
//   waffly (top, the bound root)          id waffly
//   ├── shared   LEGACY L1 mount           id shared  — a vocabulary project:
//   │            (description + a            project-level types and an L0
//   │            publicInterfaces entry)     exporting one of them; a duplicate
//   │                                        type id; `externals: { core }`
//   └── core     `members:` entry          id core    — consumes the vocabulary
//       │                                    (`shared::host-var-values`), owns a
//       │                                    local subsystem `transpiler` that
//       │                                    shadows its member alias
//       └── transpiler  `members:` entry   id transpiler — two levels down;
//                                            writes `super::`, a member path
//                                            and a leading `::` (and closes a
//                                            second loop with core)
//
// shared -> core (a type field) and core -> shared (a signature) close a
// cross-project cycle. Every document is written through the writer's own
// schema, so a load -> save of an untouched spec reproduces its bytes.
// ---------------------------------------------------------------------------

const STAMP = '2026-09-27T00:00:00.000Z';

export interface ReferenceFamily {
  /** The temp directory holding the family (the top project's root). */
  top: string;
  shared: string;
  core: string;
  transpiler: string;
  /** Every spec file of the family, absolute. */
  specFiles(): string[];
  cleanup(): void;
}

function projectYaml(dir: string, lines: string[]): void {
  fs.mkdirSync(path.join(dir, '.wai'), { recursive: true });
  const body = [
    'schemaVersion: 1.0.0',
    ...lines,
    'targets: []',
    `createdAt: '${STAMP}'`,
    `updatedAt: '${STAMP}'`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, '.wai', 'project.yaml'), body);
}

const specs = (dir: string, ...parts: string[]): string => path.join(dir, '.wai', 'specs', ...parts);

function system(dir: string, name: string, publicInterfaces: Record<string, unknown>[] = []): void {
  writeSpecFile(specs(dir, '.index.yaml'), SystemSpecSchema.parse({
    schemaVersion: '1.0.0', name, vision: `${name} in miniature`, boundaries: [], globalRequirements: [],
    ...(publicInterfaces.length ? { publicInterfaces } : {}), createdAt: STAMP, updatedAt: STAMP,
  }));
}

function subsystem(dir: string, parentSystem: string, id: string, extra: Record<string, unknown> = {}): void {
  writeSpecFile(specs(dir, id, '.index.yaml'), SubsystemSpecSchema.parse({
    id, name: id, description: `The ${id} subsystem`, parentSystem, publicInterfaces: [], trustedLinks: [],
    status: 'complete', createdAt: STAMP, updatedAt: STAMP, ...extra,
  }));
}

function component(dir: string, sub: string, id: string, componentType: string, dependsOn: string[] = [], extra: Record<string, unknown> = {}): void {
  writeSpecFile(specs(dir, sub, id, '.index.yaml'), ComponentSpecSchema.parse({
    id, name: id, description: `The ${id} component`, subsystem: sub, componentType,
    ...(componentType === 'Portal' ? { portalType: 'Custom' } : {}),
    owns: [], dependsOn, status: 'complete', createdAt: STAMP, updatedAt: STAMP, ...extra,
  }));
}

function contract(dir: string, sub: string, comp: string, methods: Record<string, unknown>[]): void {
  writeSpecFile(specs(dir, sub, comp, '.interface.yaml'), InterfaceSpecSchema.parse({
    id: `i${comp}`, name: `i${comp}`, description: `The ${comp} contract`, component: comp, methods,
    status: 'complete', createdAt: STAMP, updatedAt: STAMP,
  }));
}

function type(file: string, id: string, fields: { name: string; type: string }[], extra: Record<string, unknown> = {}): void {
  writeSpecFile(file, TypeSpecSchema.parse({
    kind: 'value-object', id, name: id, description: `The ${id} type`,
    fields: fields.map((f) => ({ ...f, description: `The ${f.name}`, optional: false })),
    methods: [], createdAt: STAMP, updatedAt: STAMP, ...extra,
  }));
}

/** Build the reference family in a fresh temp directory. */
export function buildReferenceFamily(): ReferenceFamily {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-refam-'));
  const shared = path.join(top, 'shared');
  const core = path.join(top, 'core');
  const transpiler = path.join(core, 'transpiler');

  // ── waffly: the top project ──────────────────────────────────────────────
  projectYaml(top, ['id: waffly', 'name: Waffly', 'members:', '  core: core']);
  system(top, 'Waffly');
  subsystem(top, 'Waffly', 'app');
  // The legacy L1 mount: a description and a publicInterfaces entry of its own.
  writeSpecFile(specs(top, 'shared', '.index.yaml'), SubsystemSpecSchema.parse({
    id: 'shared', name: 'shared', description: 'The vocabulary every project speaks', parentSystem: 'Waffly',
    projectPath: 'shared', publicInterfaces: [{ type: 'Custom', details: 'The shared vocabulary' }],
    trustedLinks: [], status: 'complete', createdAt: STAMP, updatedAt: STAMP,
  }));
  // An alias-form reference, exported by core's L0.
  component(top, 'app', 'app-shell', 'Portal', ['core::engine-portal']);
  // A leading-`::` reference: a member path from the bound root.
  component(top, 'app', 'app-worker', 'Orchestrator', ['::core::engine-portal']);

  // ── shared: the vocabulary member (legacy mount) ─────────────────────────
  projectYaml(shared, ['id: shared', 'name: Shared', 'externals:', '  core: {}']);
  system(shared, 'Shared', [{ typeDef: 'host-var-values', audience: 'project' }]);
  type(specs(shared, 'types', 'host-var-values.yaml'), 'host-var-values', [{ name: 'values', type: 'string[]' }]);
  // shared -> core: one edge of the cycle.
  type(specs(shared, 'types', 'host-binding.yaml'), 'host-binding', [{ name: 'mode', type: 'core::engine-mode' }]);
  // A duplicate type id: two files of one project declare `mode`.
  type(specs(shared, 'types', 'mode.yaml'), 'mode', [{ name: 'label', type: 'string' }]);
  type(specs(shared, 'types', 'legacy', 'mode.yaml'), 'mode', [{ name: 'label', type: 'string' }]);

  // ── core: the sibling that consumes the vocabulary ───────────────────────
  projectYaml(core, ['id: core', 'name: Core', 'externals:', '  shared: {}', 'members:', '  transpiler: transpiler']);
  system(core, 'Core', [
    { from: 'engine', component: 'engine-portal', audience: 'project' },
    { typeDef: 'engine-mode', audience: 'project' },
  ]);
  subsystem(core, 'Core', 'engine', { publicInterfaces: [{ type: 'Custom', details: 'The engine surface', component: 'engine-portal' }] });
  // A local subsystem whose id is also a member alias: shadowed, still reachable.
  subsystem(core, 'Core', 'transpiler');
  component(core, 'engine', 'engine-portal', 'Portal', ['transpiler::lowering-portal']);
  // core -> shared: the other edge of the cycle (a signature naming the vocabulary).
  contract(core, 'engine', 'engine-portal', [{
    name: 'run', description: 'Run the engine', signature: 'run(values: shared::host-var-values): void', returns: 'void',
    params: [{ name: 'values', type: 'shared::host-var-values', description: 'The host variables' }],
  }]);
  type(specs(core, 'types', 'engine-mode.yaml'), 'engine-mode', [{ name: 'label', type: 'string' }]);

  // ── transpiler: a member two levels down ─────────────────────────────────
  projectYaml(transpiler, ['id: transpiler', 'name: Transpiler']);
  system(transpiler, 'Transpiler', [{ from: 'lowering', component: 'lowering-portal', audience: 'project' }]);
  subsystem(transpiler, 'Transpiler', 'lowering', { publicInterfaces: [{ type: 'Custom', details: 'The lowering surface', component: 'lowering-portal' }] });
  component(transpiler, 'lowering', 'lowering-portal', 'Portal');
  // `super::` climbs to core; a member path read from the bound root lands
  // back in transpiler; a leading `::` walks from the top to core again — two
  // texts binding one target, each carried back as written.
  component(transpiler, 'lowering', 'lowering-core', 'Orchestrator', [
    'super::engine-portal',
    'core::transpiler::lowering-portal',
    '::core::engine-portal',
  ]);

  const specFiles = (): string[] => {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (p.endsWith('.yaml') && p.includes(`${path.sep}specs${path.sep}`)) out.push(p);
      }
    };
    walk(top);
    return out.sort();
  };
  return {
    top, shared, core, transpiler, specFiles,
    cleanup: () => fs.rmSync(top, { recursive: true, force: true }),
  };
}
