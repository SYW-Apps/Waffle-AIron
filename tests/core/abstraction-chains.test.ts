import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { composeAgentBrief } from '../../src/core/agent_resolver.js';
import { materializeFixtureProject, runRuleFixture, type FixtureTree } from '../rules-matrix/harness.js';

const roots: string[] = [];
afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

/** Materialize the tree as a real project and bind to it, for the tools that read a project from disk. */
function bound(tree: FixtureTree): void {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-abstraction-chains-')));
  roots.push(dir);
  materializeFixtureProject(dir, tree);
  setProjectRoot(dir);
  invalidateSpecCache();
}

// ---------------------------------------------------------------------------
// Abstraction chains: an abstraction may implement abstractions (Animal, Dog,
// GoldenRetriever). The rules read the chain through the shared queries
// (ctx.abstractionsOf / ctx.implementersOf). The fire/control pairs of the
// new codes live in the rule matrix (families/doctrine-abstractions); these
// tests pin the transitive behaviour of the rules a pair cannot.
//
// The scenario: a notification service. notice-sender is the broadest
// abstraction, channel-sender narrows it, and email-sender and sms-sender are
// the concrete channels.
// ---------------------------------------------------------------------------

const SYSTEM = { name: 'NotificationService', vision: 'Sends order notifications over several channels.' };
const SUB = { id: 'notifications', description: 'Order notification delivery.' };
const SEND = { name: 'sendNotice', description: 'Send one notice.', params: [{ name: 'recipient', type: 'string' }], returns: 'void' };

type Comps = NonNullable<FixtureTree['components']>;
type Intfs = NonNullable<FixtureTree['interfaces']>;
type Impls = NonNullable<FixtureTree['implementations']>;
const sub = (components: Comps): Comps => components.map((c) => ({ subsystem: SUB.id, ...c }));

interface ChainOver {
  /** Concrete channels under channel-sender (default email and sms). */
  concrete?: ('email' | 'sms')[];
  extraComponents?: Comps;
  extraInterfaces?: Intfs;
  extraImplementations?: Impls;
  /** Override pieces of a stock entry. */
  channelContract?: Record<string, unknown>;
  emailContract?: Record<string, unknown>;
  noticeContract?: Record<string, unknown>;
  channel?: Record<string, unknown>;
  caller?: Record<string, unknown>;
  callerStep?: { targetComponent: string; targetMethod?: string };
  noCaller?: boolean;
  subsystems?: NonNullable<FixtureTree['subsystems']>;
  channelImpl?: Record<string, unknown>;
  /** The stereotype of every sender (default Adapter). */
  type?: string;
}

function chain(over: ChainOver = {}): FixtureTree {
  const concrete = over.concrete ?? ['email', 'sms'];
  const components: Comps = [
    { id: 'notice-sender', componentType: over.type ?? 'Adapter', abstract: true, description: 'Delivers one notice somehow; callers hold this.' },
    { id: 'channel-sender', componentType: over.type ?? 'Adapter', abstract: true, description: 'Delivers one notice over a channel.', ...over.channel },
    ...(concrete.includes('email') ? [{ id: 'email-sender', componentType: over.type ?? 'Adapter', description: 'Delivers by email.' }] : []),
    ...(concrete.includes('sms') ? [{ id: 'sms-sender', componentType: over.type ?? 'Adapter', description: 'Delivers by SMS.' }] : []),
    ...(over.noCaller ? [] : [{ id: 'order-notifier', componentType: 'Orchestrator', description: 'Tells the customer.', dependsOn: ['notice-sender'], invokedBy: { kind: 'runtime', caller: 'The composition root calls the notifier.' }, ...over.caller }]),
    ...(over.extraComponents ?? []),
  ];
  const interfaces: Intfs = [
    { id: 'inotice_sender', component: 'notice-sender', methods: [SEND], ...over.noticeContract },
    { id: 'ichannel_sender', component: 'channel-sender', implements: ['notice-sender'], methods: [SEND], ...over.channelContract },
    ...(concrete.includes('email') ? [{ id: 'iemail_sender', component: 'email-sender', implements: ['channel-sender'], methods: [SEND], ...over.emailContract }] : []),
    ...(concrete.includes('sms') ? [{ id: 'isms_sender', component: 'sms-sender', implements: ['channel-sender'], methods: [SEND] }] : []),
    ...(over.noCaller ? [] : [{ id: 'iorder_notifier', component: 'order-notifier', methods: [{ name: 'notifyShipped', description: 'Tell the customer.' }] }]),
    ...(over.extraInterfaces ?? []),
  ];
  const implementations: Impls = [
    { id: 'notice_sender_impl', contract: 'inotice_sender', sourcePath: 'src/notice-sender.ts', methods: [{ name: 'sendNotice' }] },
    { id: 'channel_sender_impl', contract: 'ichannel_sender', sourcePath: 'src/channel-sender.ts', methods: [{ name: 'sendNotice' }], ...over.channelImpl },
    ...(concrete.includes('email') ? [{ id: 'email_sender_impl', contract: 'iemail_sender', methods: [{ name: 'sendNotice', narrative: [{ stepNumber: 1, type: 'local', description: 'Post to the mail relay.' }] }] }] : []),
    ...(concrete.includes('sms') ? [{ id: 'sms_sender_impl', contract: 'isms_sender', methods: [{ name: 'sendNotice', narrative: [{ stepNumber: 1, type: 'local', description: 'Post to the SMS gateway.' }] }] }] : []),
    ...(over.noCaller ? [] : [{
      id: 'order_notifier_impl', contract: 'iorder_notifier',
      methods: [{ name: 'notifyShipped', narrative: [{ stepNumber: 1, type: 'call', description: 'Send the notice.', targetComponent: over.callerStep?.targetComponent ?? 'notice-sender', targetMethod: over.callerStep?.targetMethod ?? 'sendNotice' }] }],
    }]),
    ...(over.extraImplementations ?? []),
  ];
  return { system: SYSTEM, subsystems: over.subsystems ?? [SUB], components: sub(components), interfaces, implementations };
}

function issuesOf(tree: FixtureTree): { code: string; specId?: string; message: string }[] {
  const run = runRuleFixture({ code: 'NONE', expectFire: false, scenario: 'A probe tree whose findings the test reads directly.', tree });
  return run.issues.map((i) => ({ code: i.code, specId: i.specId, message: i.message }));
}
const only = (tree: FixtureTree, code: string): { specId?: string; message: string }[] => issuesOf(tree).filter((i) => i.code === code);

describe('the abstractions rule over a chain', () => {
  it('counts the concrete implementers through the chain: two concrete channels are neither unimplemented nor single', () => {
    const issues = issuesOf(chain());
    expect(issues.filter((i) => i.code === 'ABSTRACTION_UNIMPLEMENTED')).toEqual([]);
    expect(issues.filter((i) => i.code === 'ABSTRACTION_SINGLE_IMPLEMENTER')).toEqual([]);
  });

  it('reports every abstraction of a chain with no concrete implementer as unimplemented', () => {
    const found = only(chain({ concrete: [] }), 'ABSTRACTION_UNIMPLEMENTED').map((i) => i.specId).sort();
    expect(found).toEqual(['channel-sender', 'notice-sender']);
  });

  it('counts one concrete implementer below the chain as single for each level above it', () => {
    const found = only(chain({ concrete: ['email'] }), 'ABSTRACTION_SINGLE_IMPLEMENTER').map((i) => i.specId).sort();
    expect(found).toEqual(['channel-sender', 'notice-sender']);
  });

  it('exempts the whole chain above an abstraction exported with role implement', () => {
    const tree = chain({
      concrete: [],
      subsystems: [{ ...SUB, publicInterfaces: [{ component: 'channel-sender', details: 'The channel contract other projects implement.', role: 'implement' }] }],
    });
    tree.system = { ...SYSTEM, publicInterfaces: [{ from: SUB.id, component: 'channel-sender', as: 'channel-sender', audience: 'external', role: 'implement', details: 'The channel contract other projects implement.' }] };
    const issues = issuesOf(tree);
    expect(issues.filter((i) => i.code === 'ABSTRACTION_UNIMPLEMENTED')).toEqual([]);
  });

  it('still judges the stereotype of an abstract implementer of a never-implemented abstraction, edge by edge', () => {
    const tree = chain({ concrete: [], extraComponents: [] });
    for (const c of tree.components!) if (c.id === 'channel-sender') c.componentType = 'Orchestrator';
    const issues = issuesOf(tree);
    expect(issues.some((i) => i.code === 'ABSTRACTION_UNIMPLEMENTED' && i.specId === 'notice-sender')).toBe(true);
    expect(issues.some((i) => i.code === 'ABSTRACTION_STEREOTYPE_MISMATCH' && i.specId === 'channel-sender')).toBe(true);
  });

  it('does not count an ancestor of another entry as a second role', () => {
    const tree = chain({ emailContract: { implements: ['channel-sender', 'notice-sender'] } });
    expect(only(tree, 'ABSTRACTION_MULTIPLE')).toEqual([]);
  });

  it('still counts two unrelated abstractions as multiple', () => {
    const tree = chain({
      extraComponents: [{ id: 'audit-sink', componentType: 'Adapter', abstract: true, description: 'Records what was sent.' }],
      extraInterfaces: [{ id: 'iaudit_sink', component: 'audit-sink', methods: [{ name: 'recordSent', description: 'Record it.', returns: 'void' }] }],
      emailContract: { implements: ['channel-sender', 'audit-sink'], methods: [SEND, { name: 'recordSent', description: 'Record it.', returns: 'void' }] },
    });
    expect(only(tree, 'ABSTRACTION_MULTIPLE').map((i) => i.specId)).toEqual(['iemail_sender']);
  });

  it('reports a cycle once, on the first component in id order, and judges its members by no other check', () => {
    const tree = chain();
    // notice-sender now implements channel-sender, which implements notice-sender.
    for (const i of tree.interfaces!) if (i.id === 'inotice_sender') i.implements = ['channel-sender'];
    const issues = issuesOf(tree);
    const cycles = issues.filter((i) => i.code === 'ABSTRACTION_CYCLE');
    expect(cycles).toHaveLength(1);
    expect(cycles[0].specId).toBe('channel-sender');
    expect(cycles[0].message).toMatch(/notice-sender/);
    expect(issues.filter((i) => i.code === 'ABSTRACTION_UNIMPLEMENTED' && (i.specId === 'notice-sender' || i.specId === 'channel-sender'))).toEqual([]);
  });

  it('reports a component implementing itself as a cycle of one', () => {
    const tree = chain();
    for (const i of tree.interfaces!) if (i.id === 'ichannel_sender') i.implements = ['channel-sender'];
    expect(only(tree, 'ABSTRACTION_CYCLE')).toHaveLength(1);
  });

  it('reports no cycle on a straight chain', () => {
    expect(only(chain(), 'ABSTRACTION_CYCLE')).toEqual([]);
  });

  describe('publication across subsystems', () => {
    const two = (published: unknown[] | undefined): FixtureTree => {
      const tree = chain({
        subsystems: [
          { ...SUB, ...(published ? { publicInterfaces: published } : {}) },
          { id: 'channels', description: 'The channel implementers.' },
        ],
      });
      for (const c of tree.components!) if (c.id === 'email-sender' || c.id === 'sms-sender') c.subsystem = 'channels';
      return tree;
    };

    it('reports an abstraction implemented from another subsystem that is not published', () => {
      const found = only(two(undefined), 'ABSTRACTION_UNPUBLISHED');
      expect(found.map((i) => i.specId).sort()).toEqual(['email-sender', 'sms-sender']);
      expect(found[0].message).toMatch(/channel-sender/);
    });

    it('reports a publication with another role', () => {
      const found = only(two([{ component: 'channel-sender', details: 'Callable.', role: 'call' }]), 'ABSTRACTION_UNPUBLISHED');
      expect(found.length).toBe(2);
    });

    it('is silent when the abstraction is published with role implement', () => {
      expect(only(two([{ component: 'channel-sender', details: 'The channel contract.', role: 'implement' }]), 'ABSTRACTION_UNPUBLISHED')).toEqual([]);
    });

    it('honours consumers: reports an entry that leaves the implementing subsystem out', () => {
      const found = only(two([{ component: 'channel-sender', details: 'The channel contract.', role: 'implement', consumers: ['billing'] }]), 'ABSTRACTION_UNPUBLISHED');
      expect(found.length).toBe(2);
    });

    it('is silent when consumers name the implementing subsystem', () => {
      expect(only(two([{ component: 'channel-sender', details: 'The channel contract.', role: 'implement', consumers: ['channels'] }]), 'ABSTRACTION_UNPUBLISHED')).toEqual([]);
    });

    it('is silent within one subsystem', () => {
      expect(only(chain(), 'ABSTRACTION_UNPUBLISHED')).toEqual([]);
    });
  });
});

describe('abstraction-bypass over a chain', () => {
  it('reports a call on a concrete implementer of a method any ancestor declares, naming that ancestor', () => {
    const found = only(chain({ callerStep: { targetComponent: 'email-sender' }, caller: { dependsOn: ['email-sender'] } }), 'ABSTRACTION_BYPASSED');
    expect(found).toHaveLength(1);
    expect(found[0].specId).toBe('order-notifier');
    expect(found[0].message).toMatch(/notice-sender|channel-sender/);
  });

  it('reports a method only the broadest abstraction declares, called on a concrete implementer two levels down', () => {
    const tree = chain({
      callerStep: { targetComponent: 'email-sender', targetMethod: 'sendNotice' },
      caller: { dependsOn: ['email-sender'] },
    });
    // channel-sender restates the method through its own contract, so both levels declare it; the finding names one.
    expect(only(tree, 'ABSTRACTION_BYPASSED')).toHaveLength(1);
  });

  it('is silent for a call on a narrower abstraction: that is the substitution itself', () => {
    expect(only(chain({ callerStep: { targetComponent: 'channel-sender' }, caller: { dependsOn: ['channel-sender'] } }), 'ABSTRACTION_BYPASSED')).toEqual([]);
  });

  it('is silent for a call on the broadest abstraction', () => {
    expect(only(chain(), 'ABSTRACTION_BYPASSED')).toEqual([]);
  });

  it('is silent for the concrete implementers own extra method', () => {
    const tree = chain({
      callerStep: { targetComponent: 'email-sender', targetMethod: 'warmUp' },
      caller: { dependsOn: ['email-sender'] },
      emailContract: { methods: [SEND, { name: 'warmUp', description: 'Open the relay connection.', returns: 'void' }] },
    });
    tree.implementations!.find((i) => i.id === 'email_sender_impl')!.methods = [
      { name: 'sendNotice', narrative: [{ stepNumber: 1, type: 'local', description: 'Post to the mail relay.' }] },
      { name: 'warmUp', narrative: [{ stepNumber: 1, type: 'local', description: 'Open the connection.' }] },
    ];
    expect(only(tree, 'ABSTRACTION_BYPASSED')).toEqual([]);
  });

  it('never reports a decorator: an implementer that also depends on its abstraction and calls it', () => {
    const tree = chain({
      extraComponents: [{ id: 'logging-sender', componentType: 'Adapter', description: 'Logs each notice, then hands it to the sender it wraps.', dependsOn: ['notice-sender'] }],
      extraInterfaces: [{ id: 'ilogging_sender', component: 'logging-sender', implements: ['notice-sender'], methods: [SEND] }],
      extraImplementations: [{
        id: 'logging_sender_impl', contract: 'ilogging_sender',
        methods: [{ name: 'sendNotice', narrative: [{ stepNumber: 1, type: 'call', description: 'Hand it to the wrapped sender.', targetComponent: 'notice-sender', targetMethod: 'sendNotice' }] }],
      }],
    });
    expect(only(tree, 'ABSTRACTION_BYPASSED')).toEqual([]);
  });
});

describe('the narrative walk over a chain', () => {
  it('reaches a concrete implementer two levels below the abstraction its caller depends on', () => {
    const issues = issuesOf(chain());
    expect(issues.filter((i) => i.code === 'UNUSED_COMPONENT' && ['channel-sender', 'email-sender', 'sms-sender'].includes(i.specId ?? ''))).toEqual([]);
    expect(issues.filter((i) => i.code === 'UNUSED_METHOD' && /email-sender|sms-sender|channel-sender/.test(i.message))).toEqual([]);
  });

  it('lifts a reach of a narrower abstraction up the chain without coming down a sibling branch', () => {
    const tree = chain({
      caller: { dependsOn: ['channel-sender'] },
      callerStep: { targetComponent: 'channel-sender' },
      extraComponents: [
        { id: 'freight-sender', componentType: 'Adapter', abstract: true, description: 'Delivers freight notices.' },
        { id: 'ups-sender', componentType: 'Adapter', description: 'Delivers through UPS.' },
      ],
      extraInterfaces: [
        { id: 'ifreight_sender', component: 'freight-sender', implements: ['notice-sender'], methods: [SEND] },
        { id: 'iups_sender', component: 'ups-sender', implements: ['freight-sender'], methods: [SEND] },
      ],
      extraImplementations: [
        { id: 'freight_sender_impl', contract: 'ifreight_sender', sourcePath: 'src/freight-sender.ts', methods: [{ name: 'sendNotice' }] },
        { id: 'ups_sender_impl', contract: 'iups_sender', methods: [{ name: 'sendNotice', narrative: [{ stepNumber: 1, type: 'local', description: 'Post to UPS.' }] }] },
      ],
    });
    const issues = issuesOf(tree);
    expect(issues.filter((i) => i.code === 'UNUSED_COMPONENT' && i.specId === 'notice-sender')).toEqual([]);
    expect(issues.filter((i) => i.code === 'UNUSED_METHOD' && /notice-sender/.test(i.message))).toEqual([]);
    expect(issues.some((i) => i.code === 'UNUSED_COMPONENT' && i.specId === 'freight-sender')).toBe(true);
    expect(issues.some((i) => i.code === 'UNUSED_COMPONENT' && i.specId === 'ups-sender')).toBe(true);
  });

  it('leaves the chain unused when nothing calls the broadest abstraction', () => {
    const issues = issuesOf(chain({ noCaller: true }));
    expect(issues.some((i) => i.code === 'UNUSED_COMPONENT' && i.specId === 'email-sender')).toBe(true);
  });

  it('terminates on a cyclic design', () => {
    const tree = chain();
    for (const i of tree.interfaces!) if (i.id === 'inotice_sender') i.implements = ['channel-sender'];
    expect(() => issuesOf(tree)).not.toThrow();
  });

  it('reaches the verb of every Portal abstraction above a Portal implementer, at any depth', () => {
    const verb = { name: 'sendNotice', description: 'Send one notice.', params: [{ name: 'recipient', type: 'string' }], returns: 'void' };
    const tree: FixtureTree = {
      system: SYSTEM, subsystems: [SUB],
      components: sub([
        { id: 'notice-api', componentType: 'Portal', abstract: true, description: 'The verbs of a notice API.' },
        { id: 'channel-api', componentType: 'Portal', abstract: true, description: 'The verbs of a channel API.' },
        { id: 'notice-rest-api', componentType: 'Portal', transport: 'HTTP', invokedBy: { kind: 'entry', caller: 'Browsers of the shop front.' }, description: 'Over HTTP.' },
        { id: 'notice-cli', componentType: 'Portal', transport: 'CLI', description: 'On a command line.' },
      ]),
      interfaces: [
        { id: 'inotice_api', component: 'notice-api', methods: [verb] },
        { id: 'ichannel_api', component: 'channel-api', implements: ['notice-api'], methods: [verb] },
        { id: 'inotice_rest_api', component: 'notice-rest-api', implements: ['channel-api'], methods: [{ ...verb, endpoint: { transport: 'HTTP', method: 'POST', path: '/notices' } }] },
        { id: 'inotice_cli', component: 'notice-cli', implements: ['channel-api'], methods: [{ ...verb, endpoint: { transport: 'CLI', command: 'notice send' } }] },
      ],
      implementations: [],
    };
    const issues = issuesOf(tree);
    // The entered implementer reaches both abstractions above it.
    expect(issues.filter((i) => i.code === 'UNUSED_METHOD' && /notice-api|channel-api/.test(i.message))).toEqual([]);
    expect(issues.filter((i) => i.code === 'UNUSED_COMPONENT' && (i.specId === 'notice-api' || i.specId === 'channel-api'))).toEqual([]);
  });
});

describe('implements-consistency over a chain', () => {
  const portals = (omits: unknown, cliOver: Record<string, unknown> = {}): FixtureTree => {
    const verb = { name: 'sendNotice', description: 'Send one notice.', params: [{ name: 'recipient', type: 'string' }], returns: 'void' };
    const watch = { name: 'watchNotices', description: 'Stream.', returns: 'void' };
    return {
      system: SYSTEM, subsystems: [SUB],
      components: sub([
        { id: 'notice-api', componentType: 'Portal', abstract: true, description: 'The verbs of a notice API.' },
        { id: 'channel-api', componentType: 'Portal', abstract: true, description: 'The verbs of a channel API.' },
        { id: 'notice-cli', componentType: 'Portal', transport: 'CLI', invokedBy: { kind: 'entry', caller: 'Operators.' }, description: 'On a command line.' },
      ]),
      interfaces: [
        { id: 'inotice_api', component: 'notice-api', methods: [verb, watch] },
        { id: 'ichannel_api', component: 'channel-api', implements: ['notice-api'], methods: [verb, watch], ...cliOver },
        { id: 'inotice_cli', component: 'notice-cli', implements: ['channel-api'], ...(omits ? { omits } : {}), methods: [{ ...verb, endpoint: { transport: 'CLI', command: 'notice send' } }] },
      ],
      implementations: [],
    };
  };

  it('accepts an omission of a verb any level of the chain declares, on a concrete Portal', () => {
    const issues = issuesOf(portals([{ method: 'watchNotices', reason: 'No streaming on a command line.' }]));
    expect(issues.filter((i) => i.code === 'OMISSION_NOT_ALLOWED')).toEqual([]);
  });

  it('refuses an omission of a verb no Portal abstraction of the chain declares', () => {
    const found = only(portals([{ method: 'purgeNotices', reason: 'Not a verb.' }]), 'OMISSION_NOT_ALLOWED');
    expect(found).toHaveLength(1);
    expect(found[0].message).toMatch(/purgeNotices/);
  });

  it('refuses omits on an abstract Portal: its own contract is complete', () => {
    const found = only(portals(undefined, { omits: [{ method: 'watchNotices', reason: 'Skipped.' }] }), 'OMISSION_NOT_ALLOWED');
    expect(found.map((i) => i.specId)).toEqual(['ichannel_api']);
  });

  /** Two abstractions one contract implements, each declaring sendNotice with the given parameter type. */
  const twoRoles = (first: string, second: string): FixtureTree => {
    const tree = chain({
      extraComponents: [{ id: 'audit-sink', componentType: 'Adapter', abstract: true, description: 'Records what was sent.' }],
      extraInterfaces: [{ id: 'iaudit_sink', component: 'audit-sink', methods: [{ ...SEND, params: [{ name: 'recipient', type: second }] }] }],
      emailContract: { implements: ['channel-sender', 'audit-sink'] },
    });
    for (const i of tree.interfaces!) if (i.id === 'ichannel_sender') i.methods = [{ ...SEND, params: [{ name: 'recipient', type: first }] }];
    return tree;
  };

  it('reads two spellings of one type as one, as implements-contracts does', () => {
    expect(only(twoRoles('map<string,int>', 'map<string, int>'), 'IMPLEMENTS_CONFLICT')).toEqual([]);
  });

  it('still reports two different types', () => {
    expect(only(twoRoles('map<string, int>', 'map<string, bool>'), 'IMPLEMENTS_CONFLICT').map((i) => i.specId)).toEqual(['iemail_sender']);
  });
});

describe('exemptions of an abstraction implementation', () => {
  it('never asks an abstraction implementation for a narrative or an intent', () => {
    const tree = chain({ channelImpl: { detail: 'full' } });
    const issues = issuesOf(tree);
    expect(issues.filter((i) => (i.code === 'MISSING_NARRATIVE' || i.code === 'INTENT_FLOOR') && /notice_sender_impl|channel_sender_impl/.test(i.message))).toEqual([]);
  });

  it('never judges an abstract Registry as lacking a Store', () => {
    const tree = chain();
    for (const c of tree.components!) if (['notice-sender', 'channel-sender', 'email-sender', 'sms-sender'].includes(c.id as string)) c.componentType = 'Registry';
    const issues = issuesOf(tree);
    expect(issues.filter((i) => i.code === 'REGISTRY_WITHOUT_STORE' && (i.specId === 'notice-sender' || i.specId === 'channel-sender'))).toEqual([]);
    // the concrete implementers still need a Store
    expect(issues.some((i) => i.code === 'REGISTRY_WITHOUT_STORE' && i.specId === 'email-sender')).toBe(true);
  });
});

describe('a signature taken along the implements chain', () => {
  const withSource = (from: string, source: string): FixtureTree => {
    const tree = chain();
    for (const i of tree.interfaces!) {
      if (i.id === from) i.methods = [{ name: 'sendNotice', description: 'Send one notice.', signatureFrom: source }];
    }
    return tree;
  };

  it('resolves an implementer taking its signature from the abstraction it implements', () => {
    const issues = issuesOf(withSource('iemail_sender', 'channel-sender.sendNotice'));
    expect(issues.filter((i) => i.code === 'SIGNATURE_SOURCE_OFF_EDGE' || i.code === 'SIGNATURE_SOURCE_UNRESOLVED')).toEqual([]);
  });

  it('resolves an implementer taking its signature from an abstraction two levels above', () => {
    const issues = issuesOf(withSource('iemail_sender', 'notice-sender.sendNotice'));
    expect(issues.filter((i) => i.code === 'SIGNATURE_SOURCE_OFF_EDGE' || i.code === 'SIGNATURE_SOURCE_UNRESOLVED')).toEqual([]);
  });

  it('resolves an abstraction taking its signature from the abstraction it implements', () => {
    const issues = issuesOf(withSource('ichannel_sender', 'notice-sender.sendNotice'));
    expect(issues.filter((i) => i.code === 'SIGNATURE_SOURCE_OFF_EDGE' || i.code === 'SIGNATURE_SOURCE_UNRESOLVED')).toEqual([]);
  });

  it('still reports a source on a component the method neither depends on nor implements', () => {
    const issues = issuesOf(withSource('iemail_sender', 'sms-sender.sendNotice'));
    expect(issues.some((i) => i.code === 'SIGNATURE_SOURCE_OFF_EDGE' && i.specId === 'iemail_sender')).toBe(true);
  });

  it('never chains sources: a source that itself names a source is refused', () => {
    const tree = withSource('iemail_sender', 'channel-sender.sendNotice');
    for (const i of tree.interfaces!) if (i.id === 'ichannel_sender') i.methods = [{ name: 'sendNotice', description: 'Send one notice.', signatureFrom: 'notice-sender.sendNotice' }];
    expect(issuesOf(tree).some((i) => i.code === 'SIGNATURE_SOURCE_CHAINED')).toBe(true);
  });
});

describe('an abstraction published with role implement', () => {
  const published = (type: string, role: string | undefined): FixtureTree => {
    const entry = { component: 'channel-sender', details: 'The contract other projects implement.', ...(role ? { role } : {}) };
    const tree = chain({ type, subsystems: [{ ...SUB, publicInterfaces: [entry] }] });
    tree.system = { ...SYSTEM, publicInterfaces: [{ from: SUB.id, component: 'channel-sender', as: 'channel-sender', audience: 'external', ...(role ? { role } : {}), details: entry.details }] };
    return tree;
  };

  it('is a consumable export when the abstraction is not an Adapter: neither the binding nor the table refuses it', () => {
    const issues = issuesOf(published('Orchestrator', 'implement'));
    expect(issues.filter((i) => i.code === 'EXPORT_UNCONSUMABLE' || i.code === 'PUBLIC_INTERFACE_NOT_PORTAL')).toEqual([]);
  });

  it('is shown as an in-process extension point in the project table', () => {
    const run = runRuleFixture({ code: 'NONE', expectFire: false, scenario: 'A probe tree whose export table the test reads.', tree: published('Orchestrator', 'implement') });
    expect(run.issues.some((i) => i.code === 'EXPORT_INVALID')).toBe(false);
  });

  it('is still refused with role call: nothing can call an abstract Orchestrator across the boundary', () => {
    const issues = issuesOf(published('Orchestrator', undefined));
    expect(issues.some((i) => i.code === 'PUBLIC_INTERFACE_NOT_PORTAL' && i.specId === SUB.id)).toBe(true);
    expect(issues.some((i) => i.code === 'EXPORT_UNCONSUMABLE')).toBe(true);
  });

  it('keeps an Adapter extension point consumable', () => {
    const issues = issuesOf(published('Adapter', 'implement'));
    expect(issues.filter((i) => i.code === 'EXPORT_UNCONSUMABLE' || i.code === 'PUBLIC_INTERFACE_NOT_PORTAL')).toEqual([]);
  });
});

describe('the agent brief over a chain', () => {
  it('tells a concrete implementer each abstraction of the chain, with its contract to read', () => {
    bound(chain());
    const brief = composeAgentBrief('email-sender-implementer');
    expect(brief.instructions).toContain('## Abstractions');
    expect(brief.instructions).toMatch(/implements the abstraction `channel-sender`/);
    expect(brief.instructions).toMatch(/implements the abstraction `notice-sender`/);
    expect(brief.instructions).toContain('`src/channel-sender.ts`');
    expect(brief.instructions).toContain('`src/notice-sender.ts`');
    expect(brief.readPaths.some((p) => p.endsWith('ichannel_sender.yaml'))).toBe(true);
    expect(brief.readPaths.some((p) => p.endsWith('inotice_sender.yaml'))).toBe(true);
  });

  it('tells an abstraction that implements another to state every method of it itself, and lists every implementer below it', () => {
    bound(chain());
    const instructions = composeAgentBrief('channel-sender-implementer').instructions;
    expect(instructions).toMatch(/IS an abstraction\. Declare the interface, trait or Protocol only/);
    expect(instructions).toContain('`email-sender`');
    expect(instructions).toContain('`sms-sender`');
    expect(instructions).toMatch(/implements `notice-sender` in turn: its declaration states every method of each itself, since nothing inherits/);
    // an abstraction has no class to declare anything with
    expect(instructions).not.toMatch(/`channel-sender` implements the abstraction/);
    expect(composeAgentBrief('channel-sender-implementer').readPaths.some((p) => p.endsWith('inotice_sender.yaml'))).toBe(true);
  });

  it('lists the implementers at every level below the broadest abstraction', () => {
    bound(chain());
    const instructions = composeAgentBrief('notice-sender-implementer').instructions;
    for (const id of ['channel-sender', 'email-sender', 'sms-sender']) expect(instructions).toContain(`\`${id}\``);
  });

  it('suggests a type name for an abstraction only when no file is named', () => {
    const named = chain();
    bound(named);
    expect(composeAgentBrief('channel-sender-implementer').instructions).not.toContain('ChannelSender');
    const unnamed = chain();
    for (const impl of unnamed.implementations!) if (impl.id === 'channel_sender_impl') delete impl.sourcePath;
    setProjectRoot(null);
    bound(unnamed);
    expect(composeAgentBrief('channel-sender-implementer').instructions).toMatch(/name the type `ChannelSender`/);
  });

  it('names each member by its method symbol when the abstraction states one', () => {
    const tree = chain();
    for (const impl of tree.implementations!) if (impl.id === 'channel_sender_impl') impl.methods = [{ name: 'sendNotice', symbol: 'ChannelSender.send' }];
    bound(tree);
    expect(composeAgentBrief('email-sender-implementer').instructions).toContain('`sendNotice` as `ChannelSender.send`');
  });

  it('tells a caller to hold the abstraction type, never an implementer nor a narrower abstraction', () => {
    bound(chain());
    expect(composeAgentBrief('order-notifier-implementer').instructions).toMatch(/never an implementer's class, nor a narrower abstraction's/);
  });

  it('adds the omissions of a concrete Portal, and none to an abstract one', () => {
    const verb = { name: 'sendNotice', description: 'Send one notice.', params: [{ name: 'recipient', type: 'string' }], returns: 'void' };
    const watch = { name: 'watchNotices', description: 'Stream.', returns: 'void' };
    const tree: FixtureTree = {
      system: SYSTEM, subsystems: [SUB],
      components: sub([
        { id: 'notice-api', componentType: 'Portal', abstract: true, description: 'The verbs of a notice API.' },
        { id: 'channel-api', componentType: 'Portal', abstract: true, description: 'The verbs of a channel API.' },
        { id: 'notice-cli', componentType: 'Portal', transport: 'CLI', description: 'On a command line.' },
      ]),
      interfaces: [
        { id: 'inotice_api', component: 'notice-api', methods: [verb, watch] },
        { id: 'ichannel_api', component: 'channel-api', implements: ['notice-api'], methods: [verb, watch] },
        { id: 'inotice_cli', component: 'notice-cli', implements: ['channel-api'], omits: [{ method: 'watchNotices', reason: 'No streaming on a command line.' }], methods: [{ ...verb, endpoint: { transport: 'CLI', command: 'notice send' } }] },
      ],
      implementations: [{ id: 'notice_api_impl', contract: 'inotice_api', sourcePath: 'src/notice-api.ts', methods: [{ name: 'sendNotice' }, { name: 'watchNotices' }] }],
    };
    bound(tree);
    const concrete = composeAgentBrief('notice-cli-implementer').instructions;
    expect(concrete).toMatch(/leaves out `watchNotices` \(No streaming on a command line\.\)/);
    expect(composeAgentBrief('channel-api-implementer').instructions).not.toContain('leaves out');
  });
});
