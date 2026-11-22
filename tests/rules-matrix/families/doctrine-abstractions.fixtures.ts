/**
 * Abstractions — a component marked abstract holds a contract several other
 * components implement, and callers depend on it (docs: the abstraction
 * design in .wai/specs, rules abstraction-shape, abstractions,
 * abstraction-bypass, implements-contracts, implements-compatibility,
 * implements-consistency):
 *
 *  - ABSTRACT_NOT_ALLOWED, ABSTRACT_PORTAL_BINDS, ABSTRACTION_HAS_BEHAVIOUR
 *  - ABSTRACTION_UNIMPLEMENTED, ABSTRACTION_SINGLE_IMPLEMENTER,
 *    ABSTRACTION_STEREOTYPE_MISMATCH, ABSTRACTION_CONTAINMENT,
 *    ABSTRACTION_MULTIPLE, ABSTRACTION_CYCLE, ABSTRACTION_UNPUBLISHED
 *  - ABSTRACTION_BYPASSED
 *  - IMPLEMENTS_MISMATCH (a local abstraction, and a Portal's omits),
 *    IMPLEMENTS_NOT_ABSTRACT, IMPLEMENTS_EFFECT_WIDER
 *  - IMPLEMENTS_CONFLICT, OMISSION_NOT_ALLOWED
 *
 * The scenario: a notification service. Callers send a notification through
 * one abstract sender; an email sender and an SMS sender implement it.
 */
import { defineRuleFixture, type FixtureTree } from '../harness.js';

const SYSTEM = { name: 'NotificationService', vision: 'Sends order notifications over several channels.' };
const SUB = { id: 'notifications', description: 'Order notification delivery over email and SMS.' };

type Comps = NonNullable<FixtureTree['components']>;
type Intfs = NonNullable<FixtureTree['interfaces']>;
type Impls = NonNullable<FixtureTree['implementations']>;

const SEND = { name: 'sendNotice', description: 'Send one notice to a recipient.', params: [{ name: 'recipient', type: 'string' }], returns: 'void' };
const sub = (components: Comps): Comps => components.map((c) => ({ subsystem: SUB.id, ...c }));

/** The abstraction, its two implementers and a caller, each with its contract. */
function senders(over: {
  abstract?: Record<string, unknown>;
  emailType?: string;
  smsContract?: Record<string, unknown>;
  emailContract?: Record<string, unknown>;
  caller?: Record<string, unknown>;
  callerTarget?: string;
  abstractImpl?: Record<string, unknown>;
  abstractContract?: Record<string, unknown>;
  emailComponent?: Record<string, unknown>;
  subsystems?: NonNullable<FixtureTree['subsystems']>;
  only?: 'one' | 'none';
  abstractEffect?: string;
  extraComponents?: Comps;
  extraInterfaces?: Intfs;
  extraImplementations?: Impls;
} = {}): FixtureTree {
  const components: Comps = [
    { id: 'notice-sender', componentType: 'Adapter', abstract: true, description: 'Delivers one notice over some channel; callers hold this, never a channel.', ...over.abstract },
    { id: 'email-sender', componentType: over.emailType ?? 'Adapter', description: 'Delivers a notice by email.', ...over.emailComponent },
    ...(over.only === 'one' ? [] : [{ id: 'sms-sender', componentType: 'Adapter', description: 'Delivers a notice by SMS.' }]),
    { id: 'order-notifier', componentType: 'Orchestrator', description: 'Tells the customer an order moved on.', dependsOn: ['notice-sender'], ...over.caller },
    ...(over.extraComponents ?? []),
  ];
  const interfaces: Intfs = [
    { id: 'inotice_sender', component: 'notice-sender', methods: [over.abstractEffect ? { ...SEND, effect: over.abstractEffect } : SEND], ...over.abstractContract },
    { id: 'iemail_sender', component: 'email-sender', implements: ['notice-sender'], methods: [SEND], ...over.emailContract },
    ...(over.only === 'one' ? [] : [{ id: 'isms_sender', component: 'sms-sender', implements: ['notice-sender'], methods: [SEND], ...over.smsContract }]),
    { id: 'iorder_notifier', component: 'order-notifier', methods: [{ name: 'notifyShipped', description: 'Tell the customer the order shipped.' }] },
    ...(over.extraInterfaces ?? []),
  ];
  const implementations: Impls = [
    { id: 'notice_sender_impl', contract: 'inotice_sender', methods: [{ name: 'sendNotice' }], ...over.abstractImpl },
    { id: 'email_sender_impl', contract: 'iemail_sender', methods: [{ name: 'sendNotice', narrative: [{ stepNumber: 1, type: 'local', description: 'Post the notice to the mail relay.' }] }] },
    { id: 'order_notifier_impl', contract: 'iorder_notifier', methods: [{ name: 'notifyShipped', narrative: [{ stepNumber: 1, type: 'call', description: 'Send the notice through the sender.', targetComponent: over.callerTarget ?? 'notice-sender', targetMethod: 'sendNotice' }] }] },
    ...(over.extraImplementations ?? []),
  ];
  return { system: SYSTEM, subsystems: over.subsystems ?? [SUB], components: sub(components), interfaces, implementations };
}

export default [
  // ---- ABSTRACT_NOT_ALLOWED ------------------------------------------------
  defineRuleFixture({
    code: 'ABSTRACT_NOT_ALLOWED', severity: 'error', anchoredTo: 'delivery-observer', expectFire: true,
    scenario: 'A delivery-receipt Observer is marked abstract, though an Observer is reached by its topic and cannot be substituted by callers.',
    tree: senders({ extraComponents: [{ id: 'delivery-observer', componentType: 'Observer', abstract: true, description: 'Reacts to delivery receipts.' }] }),
  }),
  defineRuleFixture({
    code: 'ABSTRACT_NOT_ALLOWED', expectFire: false,
    reason: 'The abstract mark stands on an Adapter, one of the blocks that may be an abstraction.',
    scenario: 'The notice sender is an abstract Adapter, which is where the mark may stand.',
    tree: senders(),
  }),

  // ---- ABSTRACT_PORTAL_BINDS -----------------------------------------------
  defineRuleFixture({
    code: 'ABSTRACT_PORTAL_BINDS', severity: 'error', anchoredTo: 'notice-api', expectFire: true,
    scenario: 'An abstract notice API Portal declares an HTTP transport, though each implementer Portal binds its own.',
    tree: {
      system: SYSTEM, subsystems: [SUB],
      components: sub([
        { id: 'notice-api', componentType: 'Portal', abstract: true, transport: 'HTTP', description: 'The verbs every notice API offers.' },
        { id: 'notice-rest-api', componentType: 'Portal', transport: 'HTTP', description: 'The notice verbs over HTTP.' },
        { id: 'notice-cli', componentType: 'Portal', transport: 'CLI', description: 'The notice verbs on a command line.' },
      ]),
      interfaces: [
        { id: 'inotice_api', component: 'notice-api', methods: [SEND] },
        { id: 'inotice_rest_api', component: 'notice-rest-api', implements: ['notice-api'], methods: [{ ...SEND, endpoint: { transport: 'HTTP', method: 'POST', path: '/notices' } }] },
        { id: 'inotice_cli', component: 'notice-cli', implements: ['notice-api'], methods: [{ ...SEND, endpoint: { transport: 'CLI', command: 'notice send' } }] },
      ],
      implementations: [],
    },
  }),
  defineRuleFixture({
    code: 'ABSTRACT_PORTAL_BINDS', expectFire: false,
    reason: 'The abstract Portal states only its verbs; each implementer Portal binds its own transport and endpoints.',
    scenario: 'An abstract notice API Portal states no transport while two Portals bind HTTP and a command line.',
    tree: {
      system: SYSTEM, subsystems: [SUB],
      components: sub([
        { id: 'notice-api', componentType: 'Portal', abstract: true, description: 'The verbs every notice API offers.' },
        { id: 'notice-rest-api', componentType: 'Portal', transport: 'HTTP', description: 'The notice verbs over HTTP.' },
        { id: 'notice-cli', componentType: 'Portal', transport: 'CLI', description: 'The notice verbs on a command line.' },
      ]),
      interfaces: [
        { id: 'inotice_api', component: 'notice-api', methods: [SEND] },
        { id: 'inotice_rest_api', component: 'notice-rest-api', implements: ['notice-api'], methods: [{ ...SEND, endpoint: { transport: 'HTTP', method: 'POST', path: '/notices' } }] },
        { id: 'inotice_cli', component: 'notice-cli', implements: ['notice-api'], methods: [{ ...SEND, endpoint: { transport: 'CLI', command: 'notice send' } }] },
      ],
      implementations: [],
    },
  }),

  // ---- ABSTRACTION_HAS_BEHAVIOUR -------------------------------------------
  defineRuleFixture({
    code: 'ABSTRACTION_HAS_BEHAVIOUR', severity: 'error', anchoredTo: 'notice_sender_impl', expectFire: true,
    scenario: 'The notice sender abstraction carries a narrative step in its implementation, though its behaviour lives in the channel implementers.',
    tree: senders({ abstractImpl: { methods: [{ name: 'sendNotice', narrative: [{ stepNumber: 1, type: 'local', description: 'Pick a channel and send.' }] }] } }),
  }),
  defineRuleFixture({
    code: 'ABSTRACTION_HAS_BEHAVIOUR', expectFire: false,
    reason: "The abstraction's implementation names only its methods and code linkage.",
    scenario: 'The notice sender abstraction implementation carries code linkage only.',
    tree: senders({ abstractImpl: { sourcePath: 'src/notice-sender.ts' } }),
  }),

  // ---- ABSTRACTION_UNIMPLEMENTED -------------------------------------------
  defineRuleFixture({
    code: 'ABSTRACTION_UNIMPLEMENTED', severity: 'error', anchoredTo: 'notice-sender', expectFire: true,
    scenario: 'The notice sender is abstract but neither the email nor the SMS contract declares implements on it.',
    tree: senders({ emailContract: { implements: [] }, smsContract: { implements: [] } }),
  }),
  defineRuleFixture({
    code: 'ABSTRACTION_UNIMPLEMENTED', expectFire: false,
    reason: 'Two contracts implement the abstraction.',
    scenario: 'Email and SMS senders both implement the abstract notice sender.',
    tree: senders(),
  }),

  // ---- ABSTRACTION_SINGLE_IMPLEMENTER --------------------------------------
  defineRuleFixture({
    code: 'ABSTRACTION_SINGLE_IMPLEMENTER', severity: 'notice', anchoredTo: 'notice-sender', expectFire: true,
    scenario: 'Only the email sender implements the abstract notice sender, so the abstraction has not earned its place yet.',
    tree: senders({ only: 'one' }),
  }),
  defineRuleFixture({
    code: 'ABSTRACTION_SINGLE_IMPLEMENTER', expectFire: false,
    reason: 'Two implementers use the abstraction together.',
    scenario: 'Email and SMS senders both implement the abstract notice sender.',
    tree: senders(),
  }),

  // ---- ABSTRACTION_STEREOTYPE_MISMATCH -------------------------------------
  defineRuleFixture({
    code: 'ABSTRACTION_STEREOTYPE_MISMATCH', severity: 'error', anchoredTo: 'email-sender', expectFire: true,
    scenario: 'The email sender is a Registry while the abstraction it implements is an Adapter.',
    tree: senders({ emailType: 'Registry' }),
  }),
  defineRuleFixture({
    code: 'ABSTRACTION_STEREOTYPE_MISMATCH', expectFire: false,
    reason: 'Every implementer is an Adapter like the abstraction.',
    scenario: 'Both senders are Adapters, like the abstract notice sender.',
    tree: senders(),
  }),

  // ---- ABSTRACTION_CONTAINMENT ---------------------------------------------
  defineRuleFixture({
    code: 'ABSTRACTION_CONTAINMENT', severity: 'error', anchoredTo: 'email-sender', expectFire: true,
    scenario: 'The email sender is a private member of a mail gateway Repository while the abstraction it implements is unowned.',
    tree: senders({
      extraComponents: [{ id: 'mail-gateway', componentType: 'Repository', description: 'Mail delivery pattern.', owns: ['email-sender'] }],
    }),
  }),
  defineRuleFixture({
    code: 'ABSTRACTION_CONTAINMENT', expectFire: false,
    reason: 'The abstraction and both implementers are unowned.',
    scenario: 'The abstraction and its two senders all stand outside any pattern.',
    tree: senders(),
  }),

  // ---- ABSTRACTION_MULTIPLE ------------------------------------------------
  defineRuleFixture({
    code: 'ABSTRACTION_MULTIPLE', severity: 'notice', anchoredTo: 'iemail_sender', expectFire: true,
    scenario: 'The email contract implements the notice sender and also a bounce reader abstraction, one vendor client serving two roles.',
    tree: senders({
      emailContract: { implements: ['notice-sender', 'bounce-reader'], methods: [SEND, { name: 'readBounces', description: 'Read the bounces.', returns: 'void' }] },
      extraComponents: [{ id: 'bounce-reader', componentType: 'Adapter', abstract: true, description: 'Reads delivery bounces.' }],
      extraInterfaces: [
        { id: 'ibounce_reader', component: 'bounce-reader', methods: [{ name: 'readBounces', description: 'Read the bounces.', returns: 'void' }] },
        { id: 'ibounce_mailbox', component: 'sms-sender', implements: ['bounce-reader'], methods: [{ name: 'readBounces', description: 'Read the bounces.', returns: 'void' }] },
      ],
    }),
  }),
  defineRuleFixture({
    code: 'ABSTRACTION_MULTIPLE', expectFire: false,
    reason: 'Each contract implements exactly one abstraction.',
    scenario: 'Each sender contract implements only the notice sender.',
    tree: senders(),
  }),

  // ---- ABSTRACTION_CYCLE ---------------------------------------------------
  defineRuleFixture({
    code: 'ABSTRACTION_CYCLE', severity: 'error', anchoredTo: 'channel-sender', expectFire: true,
    scenario: 'The notice sender implements the channel sender, which implements the notice sender: the two abstractions form a loop.',
    tree: senders({
      abstractContract: { implements: ['channel-sender'] },
      extraComponents: [{ id: 'channel-sender', componentType: 'Adapter', abstract: true, description: 'Delivers one notice over a channel.' }],
      extraInterfaces: [{ id: 'ichannel_sender', component: 'channel-sender', implements: ['notice-sender'], methods: [SEND] }],
    }),
  }),
  defineRuleFixture({
    code: 'ABSTRACTION_CYCLE', expectFire: false,
    reason: 'The channel sender implements the notice sender and nothing implements the channel sender back: a chain from the broadest to the narrowest.',
    scenario: 'A straight chain: the channel sender narrows the notice sender and the email and SMS senders implement the channel sender.',
    tree: senders({
      emailContract: { implements: ['channel-sender'] },
      smsContract: { implements: ['channel-sender'] },
      extraComponents: [{ id: 'channel-sender', componentType: 'Adapter', abstract: true, description: 'Delivers one notice over a channel.' }],
      extraInterfaces: [{ id: 'ichannel_sender', component: 'channel-sender', implements: ['notice-sender'], methods: [SEND] }],
    }),
  }),

  // ---- ABSTRACTION_UNPUBLISHED ---------------------------------------------
  defineRuleFixture({
    code: 'ABSTRACTION_UNPUBLISHED', severity: 'error', anchoredTo: 'email-sender', expectFire: true,
    scenario: 'The email sender lives in a mail channels subsystem and implements the notice sender of the notifications subsystem, which publishes nothing.',
    tree: senders({
      subsystems: [SUB, { id: 'mail-channels', description: 'The mail channel implementers.' }],
      emailComponent: { subsystem: 'mail-channels' },
    }),
  }),
  defineRuleFixture({
    code: 'ABSTRACTION_UNPUBLISHED', expectFire: false,
    reason: 'The notifications subsystem publishes the notice sender with role implement, so the mail channels subsystem may implement it.',
    scenario: 'The email sender implements the notice sender of another subsystem, which publishes it with role implement.',
    tree: senders({
      subsystems: [
        { ...SUB, publicInterfaces: [{ component: 'notice-sender', details: 'The sender contract the channel subsystems implement.', role: 'implement' }] },
        { id: 'mail-channels', description: 'The mail channel implementers.' },
      ],
      emailComponent: { subsystem: 'mail-channels' },
    }),
  }),

  // ---- ABSTRACTION_BYPASSED ------------------------------------------------
  defineRuleFixture({
    code: 'ABSTRACTION_BYPASSED', severity: 'warning', anchoredTo: 'order-notifier', expectFire: true,
    scenario: 'The order notifier calls the email sender directly for a method the notice sender declares.',
    tree: senders({ callerTarget: 'email-sender', caller: { dependsOn: ['notice-sender', 'email-sender'] } }),
  }),
  defineRuleFixture({
    code: 'ABSTRACTION_BYPASSED', expectFire: false,
    reason: 'The caller goes through the abstraction.',
    scenario: 'The order notifier calls the abstract notice sender.',
    tree: senders(),
  }),

  // ---- IMPLEMENTS_MISMATCH (local) -----------------------------------------
  defineRuleFixture({
    code: 'IMPLEMENTS_MISMATCH', severity: 'error', anchoredTo: 'isms_sender', expectFire: true,
    scenario: 'The SMS contract implements the notice sender but does not declare sendNotice.',
    tree: senders({ smsContract: { methods: [{ name: 'sendBulk', description: 'Send many.', returns: 'void' }] } }),
  }),
  defineRuleFixture({
    code: 'IMPLEMENTS_MISMATCH', expectFire: false,
    reason: 'Both contracts declare sendNotice with the abstraction\'s signature.',
    scenario: 'Both sender contracts declare sendNotice as the abstraction does.',
    tree: senders(),
  }),

  // ---- IMPLEMENTS_NOT_ABSTRACT ---------------------------------------------
  defineRuleFixture({
    code: 'IMPLEMENTS_NOT_ABSTRACT', severity: 'error', anchoredTo: 'isms_sender', expectFire: true,
    scenario: 'The SMS contract implements the order notifier, a component that is not abstract.',
    tree: senders({ smsContract: { implements: ['notice-sender', 'order-notifier'] } }),
  }),
  defineRuleFixture({
    code: 'IMPLEMENTS_NOT_ABSTRACT', expectFire: false,
    reason: 'Every implements entry names an abstract component.',
    scenario: 'Both sender contracts implement the abstract notice sender.',
    tree: senders(),
  }),

  // ---- IMPLEMENTS_EFFECT_WIDER ---------------------------------------------
  defineRuleFixture({
    code: 'IMPLEMENTS_EFFECT_WIDER', severity: 'error', anchoredTo: 'isms_sender', expectFire: true,
    scenario: 'The abstract sender promises sendNotice has no effect on state but the SMS sender declares it writes.',
    tree: senders({
      abstractEffect: 'read',
      smsContract: { methods: [{ ...SEND, effect: 'write' }] },
    }),
  }),
  defineRuleFixture({
    code: 'IMPLEMENTS_EFFECT_WIDER', expectFire: false,
    reason: 'Neither side states an effect, so none is judged.',
    scenario: 'No sender states an effect for sendNotice.',
    tree: senders(),
  }),

  // ---- IMPLEMENTS_CONFLICT -------------------------------------------------
  defineRuleFixture({
    code: 'IMPLEMENTS_CONFLICT', severity: 'error', anchoredTo: 'iemail_sender', expectFire: true,
    scenario: 'The email contract implements two abstractions that declare sendNotice with different parameters.',
    tree: senders({
      emailContract: { implements: ['notice-sender', 'audit-sender'] },
      extraComponents: [{ id: 'audit-sender', componentType: 'Adapter', abstract: true, description: 'Sends audit notices.' }],
      extraInterfaces: [
        { id: 'iaudit_sender', component: 'audit-sender', methods: [{ name: 'sendNotice', description: 'Send an audit notice.', params: [{ name: 'recipient', type: 'string' }, { name: 'reason', type: 'string' }], returns: 'void' }] },
        { id: 'iaudit_log_sender', component: 'sms-sender', implements: ['audit-sender'], methods: [{ name: 'sendNotice', description: 'Send an audit notice.', params: [{ name: 'recipient', type: 'string' }, { name: 'reason', type: 'string' }], returns: 'void' }] },
      ],
    }),
  }),
  defineRuleFixture({
    code: 'IMPLEMENTS_CONFLICT', expectFire: false,
    reason: 'Each contract implements one abstraction.',
    scenario: 'Each sender implements only the notice sender.',
    tree: senders(),
  }),

  // ---- OMISSION_NOT_ALLOWED ------------------------------------------------
  defineRuleFixture({
    code: 'OMISSION_NOT_ALLOWED', severity: 'error', anchoredTo: 'iemail_sender', expectFire: true,
    scenario: 'The email sender, an Adapter, lists an omission, though omits stands only on a Portal implementing a Portal abstraction.',
    tree: senders({ emailContract: { omits: [{ method: 'sendNotice', reason: 'No email form.' }] } }),
  }),
  defineRuleFixture({
    code: 'OMISSION_NOT_ALLOWED', expectFire: false,
    reason: 'A command-line Portal leaves out a verb of the Portal abstraction, with a reason.',
    scenario: 'The notice CLI Portal omits a streaming verb of the abstract notice API with a stated reason.',
    tree: {
      system: SYSTEM, subsystems: [SUB],
      components: sub([
        { id: 'notice-api', componentType: 'Portal', abstract: true, description: 'The verbs every notice API offers.' },
        { id: 'notice-rest-api', componentType: 'Portal', transport: 'HTTP', description: 'The notice verbs over HTTP.' },
        { id: 'notice-cli', componentType: 'Portal', transport: 'CLI', description: 'The notice verbs on a command line.' },
      ]),
      interfaces: [
        { id: 'inotice_api', component: 'notice-api', methods: [SEND, { name: 'watchNotices', description: 'Stream notices.', returns: 'void' }] },
        { id: 'inotice_rest_api', component: 'notice-rest-api', implements: ['notice-api'], methods: [{ ...SEND, endpoint: { transport: 'HTTP', method: 'POST', path: '/notices' } }, { name: 'watchNotices', description: 'Stream notices.', returns: 'void', endpoint: { transport: 'HTTP', method: 'GET', path: '/notices/watch' } }] },
        { id: 'inotice_cli', component: 'notice-cli', implements: ['notice-api'], omits: [{ method: 'watchNotices', reason: 'Streaming has no form on a command line.' }], methods: [{ ...SEND, endpoint: { transport: 'CLI', command: 'notice send' } }] },
      ],
      implementations: [],
    },
  }),
];
