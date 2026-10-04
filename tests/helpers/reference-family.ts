import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeSpecFile } from '../../src/core/spec-files.js';
import {
  ComponentSpecSchema,
  ImplementationSpecSchema,
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
  type(specs(shared, 'types', 'host-var-values.yaml'), 'host-var-values', [{ name: 'values', type: 'list<string>' }]);
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

// ---------------------------------------------------------------------------
// The import family (stage 4): bare names bound through declared `use` imports.
//
//   vocab (top, the bound root)            id vocab
//   ├── shared   `members:` entry          id shared — exports the types
//   │                                        `waffler-error` and `index-value`
//   ├── ui       `members:` entry          id ui     — ALSO exports a type keyed
//   │                                        `waffler-error` (the ambiguity)
//   └── app      `members:` entry          id app    — consumes shared as an
//                                            `externals` entry (a sibling), so
//                                            from its own root it is judged
//                                            against its pin
//
// The top's own type `report` names `WafflerError` bare in a field — nameKey
// normalization is what makes that `waffler-error`. Each scenario rewrites the
// top's (or app's) project.yaml to declare the imports it is about.
// ---------------------------------------------------------------------------

export interface ImportFamily {
  top: string;
  shared: string;
  ui: string;
  app: string;
  /** Rewrite the top's project.yaml `members` (long forms allowed). */
  setTopMembers(members: Record<string, unknown>): void;
  /** Rewrite app's project.yaml `externals`. */
  setAppExternals(externals: Record<string, unknown>): void;
  /** Add a type of the top's own. */
  addTopType(id: string, fields: { name: string; type: string }[]): void;
  /** Rewrite a field type of shared's `host-record` (a reference inside the producer). */
  setSharedRecordField(type: string): void;
  cleanup(): void;
}

/** Build the import family in a fresh temp directory. */
export function buildImportFamily(): ImportFamily {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-imfam-'));
  const shared = path.join(top, 'shared');
  const ui = path.join(top, 'ui');
  const app = path.join(top, 'app');
  const members = { shared: 'shared', ui: 'ui', app: 'app' };

  projectYaml(top, ['id: vocab', 'name: Vocab', 'members:', '  shared: shared', '  ui: ui', '  app: app']);
  system(top, 'Vocab');
  subsystem(top, 'Vocab', 'reporting');
  type(specs(top, 'types', 'report.yaml'), 'report', [{ name: 'failure', type: 'WafflerError' }]);

  projectYaml(shared, ['id: shared', 'name: Shared']);
  system(shared, 'Shared', [
    { typeDef: 'waffler-error', audience: 'project' },
    { typeDef: 'index-value', audience: 'project' },
    { typeDef: 'host-record', audience: 'project' },
  ]);
  type(specs(shared, 'types', 'waffler-error.yaml'), 'waffler-error', [{ name: 'message', type: 'string' }]);
  type(specs(shared, 'types', 'index-value.yaml'), 'index-value', [{ name: 'value', type: 'number' }]);
  type(specs(shared, 'types', 'host-record.yaml'), 'host-record', [{ name: 'index', type: 'index-value' }]);

  projectYaml(ui, ['id: ui', 'name: Ui']);
  system(ui, 'Ui', [{ typeDef: 'waffler_error', audience: 'project' }]);
  type(specs(ui, 'types', 'waffler_error.yaml'), 'waffler_error', [{ name: 'banner', type: 'string' }]);

  projectYaml(app, ['id: app', 'name: App', 'externals:', '  shared: {}']);
  system(app, 'App');
  subsystem(app, 'App', 'screens');
  type(specs(app, 'types', 'screen-state.yaml'), 'screen-state', [{ name: 'error', type: 'WafflerError' }, { name: 'record', type: 'shared::host-record' }]);

  const rewriteConfig = (dir: string, lines: string[]): void => projectYaml(dir, lines);
  const yamlBlock = (key: string, value: Record<string, unknown>): string[] => {
    const out = [`${key}:`];
    for (const [alias, v] of Object.entries(value)) {
      out.push(typeof v === 'string' ? `  ${alias}: ${v}` : `  ${alias}: ${JSON.stringify(v)}`);
    }
    return out;
  };
  return {
    top, shared, ui, app,
    setTopMembers: (m) => rewriteConfig(top, ['id: vocab', 'name: Vocab', ...yamlBlock('members', { ...members, ...m })]),
    setAppExternals: (e) => rewriteConfig(app, ['id: app', 'name: App', ...yamlBlock('externals', e)]),
    addTopType: (id, fields) => type(specs(top, 'types', `${id}.yaml`), id, fields),
    setSharedRecordField: (t) => type(specs(shared, 'types', 'host-record.yaml'), 'host-record', [{ name: 'index', type: t }]),
    cleanup: () => fs.rmSync(top, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// The contract family (stage 4, wave B): one producer, one consumer, siblings.
//
//   house (top, the bound root)            id house
//   ├── ledger   `members:` entry          id ledger  — exports its `books`
//   │                                        portal `ledger-portal`: post(amount)
//   │                                        and balance()
//   └── billing  `members:` entry          id billing — declares `ledger` as an
//                                            external and calls
//                                            `ledger::ledger-portal` post
//
// What the family run composes: billing's lock records the `post` it uses; a
// rename of `post` is EXTERNAL_INCOMPATIBLE, a change to the unused `balance`
// is EXTERNAL_DRIFTED. billing's own gate judges against its pin either way.
// ---------------------------------------------------------------------------

export interface ContractFamily {
  top: string;
  ledger: string;
  billing: string;
  /** Rewrite ledger's portal contract: the method names and balance's return type. */
  setLedgerContract(postName: string, balanceReturns?: string): void;
  /** Rewrite a member's project.yaml (lines between the schema version and the targets). */
  setConfig(dir: string, lines: string[]): void;
  cleanup(): void;
}

/** Build the contract family in a fresh temp directory. */
export function buildContractFamily(): ContractFamily {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-ctfam-'));
  const ledger = path.join(top, 'ledger');
  const billing = path.join(top, 'billing');

  projectYaml(top, ['id: house', 'name: House', 'members:', '  ledger: ledger', '  billing: billing']);
  system(top, 'House');
  subsystem(top, 'House', 'front');

  projectYaml(ledger, ['id: ledger', 'name: Ledger']);
  system(ledger, 'Ledger', [{ from: 'books', component: 'ledger-portal', audience: 'project' }]);
  subsystem(ledger, 'Ledger', 'books', { publicInterfaces: [{ type: 'Custom', details: 'The ledger surface', component: 'ledger-portal' }] });
  component(ledger, 'books', 'ledger-portal', 'Portal');
  const setLedgerContract = (postName: string, balanceReturns = 'number'): void => contract(ledger, 'books', 'ledger-portal', [
    { name: postName, description: 'Post an amount', signature: `${postName}(amount: number): void`, returns: 'void',
      params: [{ name: 'amount', type: 'number', description: 'The amount' }] },
    { name: 'balance', description: 'The balance', signature: `balance(): ${balanceReturns}`, returns: balanceReturns, params: [] },
  ]);
  setLedgerContract('post');

  projectYaml(billing, ['id: billing', 'name: Billing', 'externals:', '  ledger: {}']);
  system(billing, 'Billing');
  subsystem(billing, 'Billing', 'invoicing');
  component(billing, 'invoicing', 'invoice-poster', 'Adapter', ['ledger::ledger-portal']);
  contract(billing, 'invoicing', 'invoice-poster', [
    { name: 'settle', description: 'Settle an invoice', signature: 'settle(amount: number): void', returns: 'void',
      params: [{ name: 'amount', type: 'number', description: 'The amount' }] },
  ]);
  writeSpecFile(specs(billing, 'invoicing', 'invoice-poster', '.implementation.yaml'), ImplementationSpecSchema.parse({
    id: 'invoice-poster-impl', name: 'invoice-poster-impl', description: 'Posts through the ledger', contract: 'iinvoice-poster',
    methods: [{ name: 'settle', narrative: [
      { stepNumber: 1, description: 'Post the amount to the ledger', type: 'call', targetComponent: 'ledger::ledger-portal', targetMethod: 'post' },
    ] }],
    status: 'complete', createdAt: STAMP, updatedAt: STAMP,
  }));

  return {
    top, ledger, billing, setLedgerContract,
    setConfig: (dir, lines) => projectYaml(dir, lines),
    cleanup: () => fs.rmSync(top, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// The approval family (stage 5): a clean chain every project of which locks.
//
//   top (the bound root)                   id top
//   ├── mid      `members:` entry          id mid  — itself a parent
//   │   └── leaf `members:` entry          id leaf — two levels below top
//   └── sib      `members:` entry          id sib  — a sibling of mid
//
// Every project validates as complete with no design error, so the real lock
// workflow runs at each root. `touch` edits one of a project's own specs (a
// design change at that root only); `setComposition` rewrites the top's
// `composition` block.
// ---------------------------------------------------------------------------

export interface ApprovalFamily {
  top: string;
  mid: string;
  leaf: string;
  sib: string;
  /** Change one of the project's own specs, as a design edit at that root. */
  touch(dir: string, note: string): void;
  /** Rewrite the top's composition block (YAML lines under `composition:`). */
  setComposition(lines: string[]): void;
  cleanup(): void;
}

/** Build the approval family in a fresh temp directory. */
export function buildApprovalFamily(): ApprovalFamily {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-apfam-'));
  const mid = path.join(top, 'mid');
  const leaf = path.join(mid, 'leaf');
  const sib = path.join(top, 'sib');
  const topConfig = (extra: string[] = []): void =>
    projectYaml(top, ['id: top', 'name: Top', 'members:', '  mid: mid', '  sib: sib', ...extra]);

  topConfig();
  system(top, 'Top');
  subsystem(top, 'Top', 'front');
  projectYaml(mid, ['id: mid', 'name: Mid', 'members:', '  leaf: leaf']);
  system(mid, 'Mid');
  subsystem(mid, 'Mid', 'middle');
  projectYaml(leaf, ['id: leaf', 'name: Leaf']);
  system(leaf, 'Leaf');
  subsystem(leaf, 'Leaf', 'bottom');
  projectYaml(sib, ['id: sib', 'name: Sib']);
  system(sib, 'Sib');
  subsystem(sib, 'Sib', 'aside');

  const ownSubsystem: Record<string, [string, string]> = {
    [top]: ['Top', 'front'], [mid]: ['Mid', 'middle'], [leaf]: ['Leaf', 'bottom'], [sib]: ['Sib', 'aside'],
  };
  return {
    top, mid, leaf, sib,
    touch: (dir, note) => {
      const [parentSystem, id] = ownSubsystem[dir];
      subsystem(dir, parentSystem, id, { description: `The ${id} subsystem — ${note}` });
    },
    setComposition: (lines) => topConfig(['composition:', ...lines.map((l) => `  ${l}`)]),
    cleanup: () => fs.rmSync(top, { recursive: true, force: true }),
  };
}
