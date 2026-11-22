import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache, loadComponentSpec, loadInterfaceSpec, rewriteReferences } from '../../src/core/specs.js';
import { writeSpec } from '../../src/core/authoring.js';
import { composeAgentBrief } from '../../src/core/agent_resolver.js';
import { exportDesign } from '../../src/core/design-export.js';
import { InterfaceSpecSchema, ComponentSpecSchema, OmittedMethodSchema } from '../../src/models/specs.js';
import { materializeFixtureProject, runRuleFixture, type FixtureTree } from '../rules-matrix/harness.js';

// ---------------------------------------------------------------------------
// Abstractions: a component marked abstract holds a contract several others
// implement. The finding codes' fire/control pairs live in the rule matrix
// (families/doctrine-abstractions); these tests pin what a pair cannot: the
// list form of implements, omits on a Portal, reachability in both directions,
// effect and dependencyClass narrowing (a cross-project extension point
// included), the dependency-conformance justification, authoring, the brief
// and the design export.
// ---------------------------------------------------------------------------

const roots: string[] = [];
afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

const SYSTEM = { name: 'NotificationService', vision: 'Sends order notifications over several channels.' };
const SUB = { id: 'notifications', description: 'Order notification delivery.' };
const SEND = { name: 'sendNotice', description: 'Send one notice.', params: [{ name: 'recipient', type: 'string' }], returns: 'void' };
const NOW = '2026-01-01T00:00:00.000Z';

type Comps = NonNullable<FixtureTree['components']>;
const sub = (components: Comps): Comps => components.map((c) => ({ subsystem: SUB.id, ...c }));

/** Abstract sender, two implementers and a caller; the caller's step and the implementers' effects vary. */
function senders(over: { caller?: boolean; callerRuntime?: boolean; abstractEffect?: string; emailEffect?: string; emailClass?: string; abstractClass?: string; emailType?: string; abstractType?: string } = {}): FixtureTree {
  const type = over.abstractType ?? 'Adapter';
  return {
    system: SYSTEM,
    subsystems: [SUB],
    components: sub([
      { id: 'notice-sender', componentType: type, abstract: true, ...(over.abstractClass ? { dependencyClass: over.abstractClass } : {}), description: 'Delivers one notice.' },
      { id: 'email-sender', componentType: over.emailType ?? type, ...(over.emailClass ? { dependencyClass: over.emailClass } : {}), description: 'Delivers by email.' },
      { id: 'sms-sender', componentType: over.emailType ?? type, description: 'Delivers by SMS.' },
      { id: 'order-notifier', componentType: 'Orchestrator', description: 'Tells the customer.', dependsOn: ['notice-sender'], ...(over.callerRuntime === false ? {} : { invokedBy: { kind: 'runtime', caller: 'The composition root calls the notifier at boot.' } }) },
    ]),
    interfaces: [
      { id: 'inotice_sender', component: 'notice-sender', methods: [over.abstractEffect ? { ...SEND, effect: over.abstractEffect } : SEND] },
      { id: 'iemail_sender', component: 'email-sender', implements: 'notice-sender', methods: [over.emailEffect ? { ...SEND, effect: over.emailEffect } : SEND] },
      { id: 'isms_sender', component: 'sms-sender', implements: ['notice-sender'], methods: [SEND] },
      { id: 'iorder_notifier', component: 'order-notifier', methods: [{ name: 'notifyShipped', description: 'Tell the customer.' }] },
    ],
    implementations: [
      { id: 'notice_sender_impl', contract: 'inotice_sender', sourcePath: 'src/notice-sender.ts', methods: [{ name: 'sendNotice' }] },
      { id: 'email_sender_impl', contract: 'iemail_sender', methods: [{ name: 'sendNotice', narrative: [{ stepNumber: 1, type: 'local', description: 'Post the notice to the mail relay.' }] }] },
      { id: 'sms_sender_impl', contract: 'isms_sender', methods: [{ name: 'sendNotice', narrative: [{ stepNumber: 1, type: 'local', description: 'Post the notice to the SMS gateway.' }] }] },
      {
        id: 'order_notifier_impl', contract: 'iorder_notifier',
        methods: [{ name: 'notifyShipped', narrative: over.caller === false
          ? [{ stepNumber: 1, type: 'local', description: 'Compose the notice.' }]
          : [{ stepNumber: 1, type: 'call', description: 'Send the notice through the sender.', targetComponent: 'notice-sender', targetMethod: 'sendNotice' }] }],
      },
    ],
  };
}

function codesOf(tree: FixtureTree): { code: string; specId?: string; message: string }[] {
  const run = runRuleFixture({ code: 'NONE', expectFire: false, scenario: 'A probe tree whose findings the test reads directly.', tree });
  return run.issues.map((i) => ({ code: i.code, specId: i.specId, message: i.message }));
}

function bound(tree: FixtureTree): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-abstractions-')));
  roots.push(dir);
  materializeFixtureProject(dir, tree);
  setProjectRoot(dir);
  invalidateSpecCache();
  return dir;
}

describe('the model', () => {
  const base = { id: 'isms_sender', name: 'Sms', description: 'd', component: 'sms-sender', createdAt: NOW, updatedAt: NOW };

  it('reads a single implements string as a one-element list and keeps a list as written', () => {
    expect(InterfaceSpecSchema.parse({ ...base, implements: 'notice-sender' }).implements).toEqual(['notice-sender']);
    expect(InterfaceSpecSchema.parse({ ...base, implements: ['notice-sender', 'acme::pager'] }).implements).toEqual(['notice-sender', 'acme::pager']);
    expect(InterfaceSpecSchema.parse(base).implements).toBeUndefined();
  });

  it('holds omits with a method and a reason, and refuses an omission without one', () => {
    expect(InterfaceSpecSchema.parse({ ...base, omits: [{ method: 'watch', reason: 'No streaming on a command line.' }] }).omits).toHaveLength(1);
    expect(OmittedMethodSchema.safeParse({ method: 'watch' }).success).toBe(false);
  });

  it('holds abstract on a component', () => {
    const parsed = ComponentSpecSchema.parse({ id: 'notice-sender', name: 'N', description: 'd', subsystem: 's', componentType: 'Adapter', owns: [], dependsOn: [], abstract: true, createdAt: NOW, updatedAt: NOW });
    expect(parsed.abstract).toBe(true);
  });

  it('loads a stored string implements as a list from disk', () => {
    bound(senders());
    expect(loadInterfaceSpec('iemail_sender')?.implements).toEqual(['notice-sender']);
    expect(loadComponentSpec('notice-sender')?.abstract).toBe(true);
  });
});

describe('implementing a Portal abstraction', () => {
  const portals = (omits: unknown): FixtureTree => ({
    system: SYSTEM,
    subsystems: [SUB],
    components: sub([
      { id: 'notice-api', componentType: 'Portal', abstract: true, description: 'The verbs of a notice API.' },
      { id: 'notice-rest-api', componentType: 'Portal', transport: 'HTTP', invokedBy: { kind: 'entry', caller: 'Browsers of the shop front.' }, description: 'Over HTTP.' },
      { id: 'notice-cli', componentType: 'Portal', transport: 'CLI', invokedBy: { kind: 'entry', caller: 'Operators on a command line.' }, description: 'On a command line.' },
    ]),
    interfaces: [
      { id: 'inotice_api', component: 'notice-api', methods: [SEND, { name: 'watchNotices', description: 'Stream.', returns: 'void' }] },
      { id: 'inotice_rest_api', component: 'notice-rest-api', implements: ['notice-api'], methods: [
        { ...SEND, endpoint: { transport: 'HTTP', method: 'POST', path: '/notices' } },
        { name: 'watchNotices', description: 'Stream.', returns: 'void', endpoint: { transport: 'HTTP', method: 'GET', path: '/notices/watch' } }] },
      { id: 'inotice_cli', component: 'notice-cli', implements: ['notice-api'], ...(omits ? { omits } : {}), methods: [{ ...SEND, endpoint: { transport: 'CLI', command: 'notice send' } }] },
    ],
    implementations: [],
  });

  it('accepts a verb left out with a reason and reports one left out silently', () => {
    expect(codesOf(portals([{ method: 'watchNotices', reason: 'Streaming has no form on a command line.' }])).map((i) => i.code)).not.toContain('IMPLEMENTS_MISMATCH');
    const silent = codesOf(portals(undefined)).find((i) => i.code === 'IMPLEMENTS_MISMATCH');
    expect(silent?.message).toMatch(/omits/);
  });

  it('refuses an omission naming a verb the abstraction does not declare', () => {
    const issues = codesOf(portals([{ method: 'watchNotices', reason: 'No streaming.' }, { method: 'purgeNotices', reason: 'Not a verb of the API.' }]));
    expect(issues.some((i) => i.code === 'OMISSION_NOT_ALLOWED' && /purgeNotices/.test(i.message))).toBe(true);
  });

  it('reaches the abstract verbs through the implementers, which are entered through their own entries', () => {
    const issues = codesOf(portals([{ method: 'watchNotices', reason: 'Streaming has no form on a command line.' }]));
    expect(issues.filter((i) => (i.code === 'UNUSED_METHOD' || i.code === 'UNUSED_COMPONENT') && i.message.includes('notice-api'))).toEqual([]);
  });

  it('leaves an abstract verb no implementer reaches unused', () => {
    const tree = portals([{ method: 'watchNotices', reason: 'Streaming has no form on a command line.' }]);
    for (const c of tree.components!) delete (c as Record<string, unknown>).invokedBy;
    const unused = codesOf(tree).filter((i) => i.code === 'UNUSED_COMPONENT' || i.code === 'UNUSED_METHOD').map((i) => i.message);
    expect(unused.some((m) => m.includes('notice-api'))).toBe(true);
  });
});

describe('reachability through a non-Portal abstraction', () => {
  it('reaches every implementer through the abstraction its caller depends on', () => {
    const unused = codesOf(senders()).filter((i) => i.code === 'UNUSED_COMPONENT' || i.code === 'UNUSED_METHOD');
    expect(unused.map((i) => i.message).filter((m) => /email-sender|sms-sender|notice-sender/.test(m))).toEqual([]);
  });

  it('leaves the abstraction and its implementers unused when nothing calls the abstraction', () => {
    const unused = codesOf(senders({ caller: false })).filter((i) => i.code === 'UNUSED_COMPONENT' || i.code === 'UNUSED_METHOD').map((i) => i.message);
    expect(unused.some((m) => m.includes('notice-sender'))).toBe(true);
    expect(unused.some((m) => m.includes('email-sender'))).toBe(true);
  });
});

describe('effect and dependency class narrowing', () => {
  it('reports an implementer whose effect is wider than the abstraction promises', () => {
    const wider = codesOf(senders({ abstractEffect: 'read', emailEffect: 'write' })).filter((i) => i.code === 'IMPLEMENTS_EFFECT_WIDER');
    expect(wider.map((i) => i.specId)).toEqual(['iemail_sender']);
  });

  it('accepts an equal or narrower effect, and judges none where a side states none', () => {
    expect(codesOf(senders({ abstractEffect: 'write', emailEffect: 'read' })).some((i) => i.code === 'IMPLEMENTS_EFFECT_WIDER')).toBe(false);
    expect(codesOf(senders({ abstractEffect: 'read' })).some((i) => i.code === 'IMPLEMENTS_EFFECT_WIDER')).toBe(false);
  });

  it('keeps io matching only io or none', () => {
    expect(codesOf(senders({ abstractEffect: 'io', emailEffect: 'read' })).some((i) => i.code === 'IMPLEMENTS_EFFECT_WIDER')).toBe(true);
    expect(codesOf(senders({ abstractEffect: 'io', emailEffect: 'none' })).some((i) => i.code === 'IMPLEMENTS_EFFECT_WIDER')).toBe(false);
  });

  it('reports an implementer whose dependencyClass is wider than the abstraction states', () => {
    const tree = senders({ abstractType: 'Orchestrator', abstractClass: 'pure', emailClass: 'read' });
    const wider = codesOf(tree).filter((i) => i.code === 'IMPLEMENTS_EFFECT_WIDER');
    expect(wider.map((i) => i.specId)).toContain('email-sender');
  });
});

describe('a call through the abstraction in code', () => {
  const noticeFiles = {
    'src/notice-sender.ts': 'export interface NoticeSender { sendNotice(recipient: string): void }\n',
    'src/email-sender.ts': "import type { NoticeSender } from './notice-sender';\nexport class EmailSender implements NoticeSender { sendNotice(recipient: string): void { void recipient; } }\n",
  };
  const withNotifier = (notifier: string): FixtureTree => {
    const tree = senders();
    for (const impl of tree.implementations!) {
      if (impl.id === 'notice_sender_impl') impl.sourcePath = 'src/notice-sender.ts';
      if (impl.id === 'email_sender_impl') impl.sourcePath = 'src/email-sender.ts';
      if (impl.id === 'order_notifier_impl') impl.sourcePath = 'src/order-notifier.ts';
    }
    tree.files = { ...noticeFiles, 'src/order-notifier.ts': notifier };
    return tree;
  };
  const undeclared = (issues: ReturnType<typeof codesOf>, from: string, to: string) =>
    issues.filter((i) => i.code === 'UNDECLARED_DEPENDENCY' && i.message.includes(from) && i.message.includes(to));

  it('is clean when the caller holds the abstraction type: the interface file realizes its dependsOn', () => {
    const issues = codesOf(withNotifier("import type { NoticeSender } from './notice-sender';\nexport class OrderNotifier { constructor(private readonly sender: NoticeSender) {} notifyShipped(): void { this.sender.sendNotice('c'); } }\n"));
    expect(undeclared(issues, 'order-notifier', 'email-sender')).toEqual([]);
    expect(issues.filter((i) => i.code === 'UNREALIZED_DEPENDENCY' && /notice-sender/.test(i.message))).toEqual([]);
  });

  const direct = "import { EmailSender } from './email-sender';\nexport class OrderNotifier { notifyShipped(): void { new EmailSender().sendNotice('c'); } }\n";

  it('still reports a direct runtime import of an implementer from an Orchestrator', () => {
    expect(undeclared(codesOf(withNotifier(direct)), 'src/order-notifier.ts', 'src/email-sender.ts')).toHaveLength(1);
  });

  it('does not let a direct call of an implementer realize the edge to the abstraction', () => {
    const unrealized = codesOf(withNotifier(direct)).filter((i) => i.code === 'UNREALIZED_DEPENDENCY' && /order-notifier/.test(i.message) && /notice-sender/.test(i.message));
    expect(unrealized).toHaveLength(1);
  });

  const parcels = (portal: string): FixtureTree => ({
    system: SYSTEM,
    subsystems: [SUB],
    components: sub([
      { id: 'parcel-store', componentType: 'Store', abstract: true, description: 'Holds parcels.' },
      { id: 'pg-parcel-store', componentType: 'Store', durability: 'durable', description: 'Holds parcels in Postgres.' },
      { id: 'memory-parcel-store', componentType: 'Store', durability: 'ram-projection', description: 'Holds parcels in memory.' },
      { id: 'parcel-api', componentType: 'Portal', transport: 'InProcess', dependsOn: ['parcel-store'], description: 'The parcel verbs.' },
    ]),
    interfaces: [
      { id: 'iparcel_store', component: 'parcel-store', methods: [{ name: 'findParcel', description: 'Find a parcel.', params: [{ name: 'id', type: 'string' }], returns: 'string', effect: 'read' }] },
      { id: 'ipg_parcel_store', component: 'pg-parcel-store', implements: ['parcel-store'], methods: [{ name: 'findParcel', description: 'Find a parcel.', params: [{ name: 'id', type: 'string' }], returns: 'string', effect: 'read' }] },
      { id: 'imemory_parcel_store', component: 'memory-parcel-store', implements: ['parcel-store'], methods: [{ name: 'findParcel', description: 'Find a parcel.', params: [{ name: 'id', type: 'string' }], returns: 'string', effect: 'read' }] },
      { id: 'iparcel_api', component: 'parcel-api', methods: [{ name: 'handle', description: 'Handle a request.', params: [{ name: 'id', type: 'string' }], returns: 'string' }] },
    ],
    implementations: [
      { id: 'parcel_store_impl', contract: 'iparcel_store', sourcePath: 'src/parcel-store.ts', methods: [{ name: 'findParcel' }] },
      { id: 'pg_parcel_store_impl', contract: 'ipg_parcel_store', sourcePath: 'src/pg.ts', methods: [{ name: 'findParcel' }] },
      { id: 'memory_parcel_store_impl', contract: 'imemory_parcel_store', sourcePath: 'src/memory.ts', methods: [{ name: 'findParcel' }] },
      { id: 'parcel_api_impl', contract: 'iparcel_api', sourcePath: 'src/parcel-api.ts', methods: [{ name: 'handle' }] },
    ],
    files: {
      'src/parcel-store.ts': 'export interface ParcelStore { findParcel(id: string): string }\n',
      'src/pg.ts': "import type { ParcelStore } from './parcel-store';\nexport class PgParcelStore implements ParcelStore { findParcel(id: string): string { return id; } }\n",
      'src/memory.ts': "import type { ParcelStore } from './parcel-store';\nexport class MemoryParcelStore implements ParcelStore { findParcel(id: string): string { return id; } }\n",
      'src/parcel-api.ts': portal,
    },
  });

  it('still reports a direct runtime import of an implementer from a Portal', () => {
    const issues = codesOf(parcels("import { PgParcelStore } from './pg';\nexport function handle(id: string): string { return new PgParcelStore().findParcel(id); }\n"));
    expect(undeclared(issues, 'src/parcel-api.ts', 'src/pg.ts')).toHaveLength(1);
  });

  it('is clean when a Portal calls through the interface type the checker lands on the implementer classes', () => {
    const issues = codesOf(parcels("import type { ParcelStore } from './parcel-store';\nexport function handle(store: ParcelStore, id: string): string { return store.findParcel(id); }\n"));
    expect(undeclared(issues, 'src/parcel-api.ts', 'src/pg.ts')).toEqual([]);
    expect(undeclared(issues, 'src/parcel-api.ts', 'src/memory.ts')).toEqual([]);
  });
});

describe('resolving implements entries', () => {
  /** A foreign snapshot (.wai/surfaces) exporting one extension point under a public name, with its one method. */
  const snapshot = (id: string, method: string, effect?: string): string => [
    'projectName: pager', 'origin: exchanged', "generatedAt: '2026-01-01T00:00:00.000Z'", 'types: []',
    'interfaces:',
    `  - id: ${id}`, `    name: ${id}`, `    component: ${id}-port`, '    type: Custom', '    role: implement', '    details: An extension point of the pager.',
    '    methods:',
    `      - name: ${method}`, '        description: Send one notice.', `        signature: "${method}(recipient: string): void"`, '        returns: void',
    ...(effect ? [`        effect: ${effect}`] : []),
    '        params:', '          - name: recipient', '            type: string',
    '',
  ].join('\n');

  it('never reads a local implements entry through a foreign snapshot that exports the same bare name', () => {
    // The local abstraction names its method send_notice (not this project's camelCase); a snapshot exporting an
    // extension point of the same bare name also lists send_notice. The local entry must not borrow the snapshot's names.
    const tree = senders();
    for (const intf of tree.interfaces!) {
      for (const m of (intf.methods ?? []) as { name: string }[]) if (m.name === 'sendNotice') m.name = 'send_notice';
    }
    for (const impl of tree.implementations!) {
      for (const m of (impl.methods ?? []) as { name: string }[]) if (m.name === 'sendNotice') m.name = 'send_notice';
      for (const m of (impl.methods ?? []) as { narrative?: { targetMethod?: string }[] }[]) for (const st of m.narrative ?? []) if (st.targetMethod === 'sendNotice') st.targetMethod = 'send_notice';
    }
    const plain = codesOf(tree).filter((i) => i.code === 'NAMING_CONVENTION_VIOLATION' && i.specId === 'iemail_sender');
    expect(plain.length, 'the implementer contract breaks the casing').toBeGreaterThan(0);
    tree.files = { '.wai/surfaces/pager.yaml': snapshot('notice-sender', 'send_notice') };
    const withSnapshot = codesOf(tree).filter((i) => i.code === 'NAMING_CONVENTION_VIOLATION' && i.specId === 'iemail_sender');
    expect(withSnapshot.length).toBe(plain.length);
  });

  const tileTree = (effect: string): FixtureTree => ({
    system: { ...SYSTEM, targetLanguage: 'typescript' },
    subsystems: [SUB],
    components: sub([{ id: 'oncall-pager', componentType: 'Adapter', description: 'Pages the on-call engineer.' }]),
    interfaces: [{ id: 'ioncall_pager', component: 'oncall-pager', implements: ['pager::notice-sender'], methods: [{ name: 'sendNotice', description: 'Send one notice.', params: [{ name: 'recipient', type: 'string' }], returns: 'void', effect }] }],
    implementations: [],
    files: {
      '.wai/project.yaml': [
        "schemaVersion: '1.0.0'", 'name: notifications', 'targets: []', 'extensions:', '  packs: []', '  useGlobalPacks: false',
        'externals:', '  pager:', '    source: https://example.invalid/pager.git',
        `createdAt: '${NOW}'`, `updatedAt: '${NOW}'`, '',
      ].join('\n'),
      '.wai/inputs.lock.yaml': 'externals:\n  pager:\n    project: pager\n    snapshot: .wai/externals/pager.yaml\n    digest: sha256:pinned\n    used: {}\n',
      '.wai/externals/pager.yaml': snapshot('notice-sender', 'sendNotice', 'read'),
    },
  });

  it('reports a method whose effect is wider than the pinned extension point states', () => {
    const issues = codesOf(tileTree('write'));
    expect(issues.filter((i) => i.code === 'IMPLEMENTS_EFFECT_WIDER' && i.specId === 'ioncall_pager')).toHaveLength(1);
    expect(issues.some((i) => i.code === 'EXTERNAL_NOT_EXPORTED' || i.code === 'EXTERNAL_UNDECLARED')).toBe(false);
  });

  it('accepts a method whose effect is no wider than the pinned extension point states', () => {
    const issues = codesOf(tileTree('read'));
    expect(issues.some((i) => i.code === 'IMPLEMENTS_EFFECT_WIDER')).toBe(false);
    expect(issues.some((i) => i.code === 'IMPLEMENTS_MISMATCH')).toBe(false);
  });
});

describe('respelling an implements entry', () => {
  const stored = (dir: string, id: string): string[] | string => {
    const file = path.join(dir, '.wai', 'specs', 'interfaces', `${id}.yaml`);
    const m = /^implements:(?: (.+))?\n((?:  - .+\n)*)/m.exec(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
    if (!m) throw new Error('no implements stored');
    return m[1] !== undefined ? m[1].replace(/^'|'$/g, '') : m[2].split('\n').filter(Boolean).map((l) => l.replace(/^  - /, '').replace(/^'|'$/g, ''));
  };
  const edit = (id: string, from: string, to: string) => ({ kind: 'interface' as const, specId: id, position: 'implements', from, to });

  it('rewrites an entry of a stored list, and leaves the other entries alone', () => {
    const tree = senders();
    for (const i of tree.interfaces!) if (i.id === 'iemail_sender') i.implements = ['notice-sender', 'pager::notice-sender'];
    const dir = bound(tree);
    expect(stored(dir, 'iemail_sender')).toEqual(['notice-sender', 'pager::notice-sender']);
    expect(rewriteReferences('interface', 'iemail_sender', [edit('iemail_sender', 'pager::notice-sender', 'paging::notice-sender')])).toBe(true);
    invalidateSpecCache();
    expect(stored(dir, 'iemail_sender')).toEqual(['notice-sender', 'paging::notice-sender']);
  });

  it('still rewrites a stored single string', () => {
    const tree = senders();
    for (const i of tree.interfaces!) if (i.id === 'iemail_sender') i.implements = 'pager::notice-sender';
    const dir = bound(tree);
    expect(rewriteReferences('interface', 'iemail_sender', [edit('iemail_sender', 'pager::notice-sender', 'paging::notice-sender')])).toBe(true);
    invalidateSpecCache();
    expect(loadInterfaceSpec('iemail_sender')?.implements).toEqual(['paging::notice-sender']);
    expect(dir).toBeTruthy();
  });
});

describe('authoring', () => {
  it('carries abstract, an implements list and omits through the authoring seam', () => {
    bound(senders());
    writeSpec({
      kind: 'component',
      spec: { id: 'pager-sender', name: 'Pager Sender', description: 'Delivers by pager.', subsystem: 'notifications', componentType: 'Adapter', owns: [], dependsOn: [], abstract: true } as never,
      fields: ['id', 'name', 'description', 'subsystem', 'componentType', 'owns', 'dependsOn', 'abstract'],
    });
    expect(loadComponentSpec('pager-sender')?.abstract).toBe(true);
    writeSpec({
      kind: 'interface',
      spec: { id: 'ipager_sender', name: 'Pager', description: 'The pager contract.', component: 'pager-sender', implements: ['notice-sender'], omits: [{ method: 'sendNotice', reason: 'Not here.' }], methods: [] } as never,
      fields: ['id', 'name', 'description', 'component', 'implements', 'omits', 'methods'],
    });
    const stored = loadInterfaceSpec('ipager_sender');
    expect(stored?.implements).toEqual(['notice-sender']);
    expect(stored?.omits).toEqual([{ method: 'sendNotice', reason: 'Not here.' }]);
  });
});

describe('the agent brief', () => {
  it('tells an implementer which interface its class declares and what its abstraction asks', () => {
    bound(senders());
    const brief = composeAgentBrief('email-sender-implementer');
    expect(brief.instructions).toContain('## Abstractions');
    expect(brief.instructions).toMatch(/implements the abstraction `notice-sender`/);
    expect(brief.instructions).toContain('`src/notice-sender.ts`');
    // The file is known, so the brief points at the declaration there and guesses no name.
    expect(brief.instructions).toMatch(/implements the interface, trait or Protocol that `src\/notice-sender\.ts` declares for `notice-sender`/);
    expect(brief.instructions).not.toContain('NoticeSender');
    expect(brief.readPaths.some((p) => p.endsWith('inotice_sender.yaml'))).toBe(true);
  });

  it('tells an abstraction to declare the interface only, listing its implementers', () => {
    bound(senders());
    const brief = composeAgentBrief('notice-sender-implementer');
    expect(brief.instructions).toMatch(/IS an abstraction\. Declare the interface, trait or Protocol only/);
    expect(brief.instructions).toContain('`email-sender`');
    expect(brief.instructions).toContain('`sms-sender`');
  });

  it('tells a caller to hold the abstraction type, never an implementer', () => {
    bound(senders());
    const brief = composeAgentBrief('order-notifier-implementer');
    expect(brief.instructions).toMatch(/hold its interface type, the one `src\/notice-sender\.ts` declares, never an implementer/);
    expect(brief.instructions).not.toContain('NoticeSender');
  });

  it('gives a PascalCase name only as the one to use while the abstraction\'s file is still to be written', () => {
    const tree = senders();
    for (const impl of tree.implementations!) if (impl.id === 'notice_sender_impl') delete impl.sourcePath;
    bound(tree);
    const implementer = composeAgentBrief('email-sender-implementer').instructions;
    expect(implementer).toMatch(/not written yet.*`NoticeSender`/);
    expect(composeAgentBrief('order-notifier-implementer').instructions).toMatch(/not written yet.*`NoticeSender`/);
  });

  it('adds no section to an agent that touches no abstraction', () => {
    const tree = senders();
    tree.components!.push({ subsystem: SUB.id, id: 'audit-log', componentType: 'Store', durability: 'durable', description: 'Keeps the audit log.' });
    tree.interfaces!.push({ id: 'iaudit_log', component: 'audit-log', methods: [{ name: 'append', description: 'Append.', returns: 'void' }] });
    bound(tree);
    expect(composeAgentBrief('audit-log-implementer').instructions).not.toContain('## Abstractions');
  });
});

describe('the design export', () => {
  it('carries abstract, implements and omits', () => {
    bound(senders());
    const exported = exportDesign();
    const sender = exported.components.find((c) => c.key === 'notice-sender');
    expect(exported.formatVersion, 'abstract, implements and omits are a MINOR addition').toBe('2.3');
    expect(sender?.abstract).toBe(true);
    expect(exported.components.find((c) => c.key === 'email-sender')?.abstract).toBeUndefined();
    expect(exported.interfaces.find((i) => i.key === 'iemail_sender')?.implements).toEqual(['notice-sender']);
    expect(exported.interfaces.find((i) => i.key === 'inotice_sender')?.implements).toBeUndefined();
  });
});
