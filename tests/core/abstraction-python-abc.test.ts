import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildCodeModel } from '../../src/core/source-analysis.js';
import type { ImplementationSpec } from '../../src/models/specs.js';
import type { SourceFileFacts } from '../../src/models/index.js';
import { defineRuleFixture, runRuleFixture, type FixtureTree } from '../rules-matrix/harness.js';

// ---------------------------------------------------------------------------
// A Python abstract base class whose every method is an @abstractmethod is a
// declaration, read as a Protocol is: its signatures, its promised surface, the
// param, return and async comparison, whatever __init__, helpers or default bodies
// it also holds. A class with no @abstractmethod is concrete and records no shape.
// ---------------------------------------------------------------------------

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) fs.rmSync(t, { recursive: true, force: true });
});

function read(file: string, text: string): SourceFileFacts {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'abstraction-python-abc-')));
  temps.push(root);
  fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
  const impls = [{ id: 'impl-a', contract: 'ia', sourcePath: file, methods: [] }] as unknown as ImplementationSpec[];
  const facts = buildCodeModel(impls, [], root).files.find((f) => f.path === file);
  if (!facts) throw new Error(`no facts for ${file}`);
  return facts;
}

const SEND = '    @abstractmethod\n    def send_notice(self, recipient: str, retries: int = 3) -> None: ...\n';

describe('reading an abstract base class as a Protocol is read', () => {
  const header = (base: string, imports = 'from abc import ABC, ABCMeta, abstractmethod'): string => `${imports}\n\n\nclass NoticeSender${base}:\n`;

  it.each([
    ['ABC as a base', '(ABC)', 'from abc import ABC, abstractmethod'],
    ['abc.ABC as a base', '(abc.ABC)', 'import abc\nfrom abc import abstractmethod'],
    ['metaclass=ABCMeta', '(metaclass=ABCMeta)', 'from abc import ABCMeta, abstractmethod'],
    ['metaclass=abc.ABCMeta', '(metaclass=abc.ABCMeta)', 'import abc\nfrom abc import abstractmethod'],
  ])('records the signatures of %s', (_name, base, imports) => {
    const facts = read('src/sender.py', header(base, imports) + SEND);
    expect(facts.typeShapes!.NoticeSender.signatures!.send_notice).toEqual([{
      params: [{ name: 'recipient', type: 'str', optional: false }, { name: 'retries', type: 'int', optional: true }],
      returns: 'None',
      completesLater: false,
      owed: true,
    }]);
    expect(facts.typeShapes!.NoticeSender.methods).toEqual(['send_notice']);
  });

  it('reads abc.abstractmethod, an async method and a decorator stacked with it', () => {
    const facts = read('src/sender.py', [
      'import abc',
      'from abc import ABC',
      '',
      '',
      'class NoticeSender(ABC):',
      '    @abc.abstractmethod',
      '    async def fetch(self, id: str) -> str: ...',
      '',
      '    @staticmethod',
      '    @abc.abstractmethod',
      '    def make(kind: str) -> None: ...',
      '',
    ].join('\n'));
    const signatures = facts.typeShapes!.NoticeSender.signatures!;
    expect(signatures.fetch[0].completesLater).toBe(true);
    expect(signatures.fetch[0].returns).toBe('str');
    expect(signatures.make[0].params).toEqual([{ name: 'kind', type: 'str', optional: false }]);
  });

  it('still declares when one method has behaviour, whatever its name or order, and records it too', () => {
    const helper = 'from abc import ABC, abstractmethod\n\n\nclass NoticeSender(ABC):\n' + SEND + '\n    def helper(self) -> int:\n        return 1\n';
    const after = read('src/sender.py', helper).typeShapes!.NoticeSender;
    expect(after.declaration).toBe(true);
    expect(Object.keys(after.signatures!).sort()).toEqual(['helper', 'send_notice']);
    const first = 'from abc import ABC, abstractmethod\n\n\nclass NoticeSender(ABC):\n    def helper(self) -> int:\n        return 1\n\n' + SEND;
    expect(read('src/sender.py', first).typeShapes!.NoticeSender.declaration).toBe(true);
  });

  it('still declares for a class with an __init__, which is no signature of the shape', () => {
    const init = 'from abc import ABC, abstractmethod\n\n\nclass NoticeSender(ABC):\n    def __init__(self, name: str) -> None:\n        self.name = name\n\n' + SEND;
    const shape = read('src/sender.py', init).typeShapes!.NoticeSender;
    expect(shape.declaration).toBe(true);
    expect(Object.keys(shape.signatures!)).toEqual(['send_notice']);
  });

  it('records no shape for a class that is no abstract base class', () => {
    const plain = 'from abc import abstractmethod\n\n\nclass NoticeSender:\n' + SEND;
    expect(read('src/sender.py', plain).typeShapes?.NoticeSender).toBeUndefined();
  });

  it('gives an abstract property no signature, and no shape when it is the only member', () => {
    const mixed = 'from abc import ABC, abstractmethod\n\n\nclass NoticeSender(ABC):\n    @property\n    @abstractmethod\n    def label(self) -> str: ...\n\n' + SEND;
    const facts = read('src/sender.py', mixed);
    expect(Object.keys(facts.typeShapes!.NoticeSender.signatures!)).toEqual(['send_notice']);
    const only = 'from abc import ABC, abstractmethod\n\n\nclass Labelled(ABC):\n    @property\n    @abstractmethod\n    def label(self) -> str: ...\n';
    expect(read('src/labelled.py', only).typeShapes?.Labelled).toBeUndefined();
  });

  it('reads a member named like an Object.prototype name as its own', () => {
    const facts = read('src/sender.py', 'from abc import ABC, abstractmethod\n\n\nclass NoticeSender(ABC):\n    @abstractmethod\n    def constructor(self, x: int) -> None: ...\n');
    const signatures = facts.typeShapes!.NoticeSender.signatures!;
    expect(Object.prototype.hasOwnProperty.call(signatures, 'constructor')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(signatures, 'valueOf')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The rules over a Python tree whose abstraction is written as an ABC.
// ---------------------------------------------------------------------------

const SUB = { id: 'notifications', description: 'Order notification delivery.' };
const METHOD = { name: 'send_notice', description: 'Send one notice.', params: [{ name: 'recipient', type: 'string' }], returns: 'void' };

function notices(declaration: string, implementer?: string, returns = 'void'): FixtureTree {
  const method = { ...METHOD, returns };
  return {
    system: { name: 'NotificationService', vision: 'Sends order notifications over several channels.', targetLanguage: 'python' },
    subsystems: [SUB],
    components: [
      { id: 'notice-sender', subsystem: SUB.id, componentType: 'Adapter', abstract: true, description: 'Delivers one notice.' },
      { id: 'email-sender', subsystem: SUB.id, componentType: 'Adapter', description: 'Delivers by email.' },
      { id: 'sms-sender', subsystem: SUB.id, componentType: 'Adapter', description: 'Delivers by SMS.' },
      { id: 'order-notifier', subsystem: SUB.id, componentType: 'Orchestrator', description: 'Tells the customer.', dependsOn: ['notice-sender'], invokedBy: { kind: 'runtime', caller: 'The composition root calls the notifier at boot.' } },
    ],
    interfaces: [
      { id: 'inotice_sender', component: 'notice-sender', methods: [method] },
      { id: 'iemail_sender', component: 'email-sender', implements: ['notice-sender'], methods: [method] },
      { id: 'isms_sender', component: 'sms-sender', implements: ['notice-sender'], methods: [method] },
      { id: 'iorder_notifier', component: 'order-notifier', methods: [{ name: 'notify_shipped', description: 'Tell the customer.' }] },
    ],
    implementations: [
      { id: 'notice_sender_impl', contract: 'inotice_sender', sourcePath: 'src/notice_sender.py', methods: [{ name: 'send_notice' }] },
      { id: 'email_sender_impl', contract: 'iemail_sender', sourcePath: 'src/email_sender.py', methods: [{ name: 'send_notice', narrative: [{ stepNumber: 1, type: 'local', description: 'Post the notice to the mail relay.' }] }] },
      { id: 'sms_sender_impl', contract: 'isms_sender', sourcePath: 'src/sms_sender.py', methods: [{ name: 'send_notice', narrative: [{ stepNumber: 1, type: 'local', description: 'Post the notice to the SMS gateway.' }] }] },
      { id: 'order_notifier_impl', contract: 'iorder_notifier', sourcePath: 'src/order_notifier.py', methods: [{ name: 'notify_shipped', narrative: [{ stepNumber: 1, type: 'call', description: 'Send the notice through the sender.', targetComponent: 'notice-sender', targetMethod: 'send_notice' }] }] },
    ],
    files: {
      'src/__init__.py': '',
      'src/notice_sender.py': declaration,
      'src/email_sender.py': implementer ?? 'from .notice_sender import NoticeSender\n\n\nclass EmailSender(NoticeSender):\n    def send_notice(self, recipient: str) -> None:\n        print(recipient)\n',
      'src/sms_sender.py': 'from .notice_sender import NoticeSender\n\n\nclass SmsSender(NoticeSender):\n    def send_notice(self, recipient: str) -> None:\n        print(recipient)\n',
      'src/order_notifier.py': 'from .notice_sender import NoticeSender\n\n\nclass OrderNotifier:\n    def __init__(self, sender: NoticeSender) -> None:\n        self.sender = sender\n\n    def notify_shipped(self) -> None:\n        self.sender.send_notice("c")\n',
    },
  };
}

const issuesOf = (tree: FixtureTree) =>
  runRuleFixture(defineRuleFixture({ code: 'NONE', expectFire: false, reason: 'probe', scenario: 'A probe tree whose findings the test reads directly.', tree })).issues;
const warned = (tree: FixtureTree) => issuesOf(tree).filter((i) => i.severity !== 'notice').map((i) => `${i.code}: ${i.message.slice(0, 140)}`);
const found = (tree: FixtureTree, code: string) => issuesOf(tree).filter((i) => i.code === code);

const ABC_DECLARATION = 'from abc import ABC, abstractmethod\n\n\nclass NoticeSender(ABC):\n    @abstractmethod\n    def send_notice(self, recipient: str) -> None: ...\n';

describe('an abstract base class as the declaration of an abstraction', () => {
  it('draws nothing from the whole rule set when it states the contract', () => {
    expect(warned(notices(ABC_DECLARATION))).toEqual([]);
  });

  it('is compared with its contract: a parameter the contract does not declare, a type that differs, a return that differs', () => {
    const extra = ABC_DECLARATION.replace('recipient: str)', 'recipient: str, retries: int)');
    expect(found(notices(extra), 'UNDECLARED_PARAM').map((i) => i.specId)).toEqual(['notice_sender_impl']);
    const typed = ABC_DECLARATION.replace('recipient: str', 'recipient: int');
    expect(found(notices(typed), 'PARAM_TYPE_MISMATCH').map((i) => i.specId)).toEqual(['notice_sender_impl']);
    const returned = ABC_DECLARATION.replace('-> None', '-> int');
    expect(found(notices(returned, undefined, 'string'), 'RETURN_TYPE_MISMATCH').map((i) => i.specId)).toContain('notice_sender_impl');
  });

  it('is compared on completing later', () => {
    const async = ABC_DECLARATION.replace('def send_notice', 'async def send_notice');
    expect(found(notices(async), 'ASYNC_MISMATCH').map((i) => i.specId)).toEqual(['notice_sender_impl']);
  });

  it('is promised surface of its file: taken by the implementers and the caller, it is no undeclared export or public member', () => {
    const issues = issuesOf(notices(ABC_DECLARATION)).filter((i) => i.code === 'UNDECLARED_EXPORT' || i.code === 'UNDECLARED_PUBLIC_MEMBER');
    expect(issues).toEqual([]);
  });

  it('is a declaration with one method that has a body too: it is compared all the same', () => {
    const behaving = ABC_DECLARATION.replace('recipient: str)', 'recipient: int)') + '\n    def helper(self) -> int:\n        return 1\n';
    expect(found(notices(behaving), 'PARAM_TYPE_MISMATCH').filter((i) => i.specId === 'notice_sender_impl')).toHaveLength(1);
  });
});

describe('a tree with no abstraction reads an abstract base class as before', () => {
  const desk = (code: string): FixtureTree => ({
    system: { targetLanguage: 'python' },
    subsystems: [{ id: 'ordering', description: 'Takes and answers orders.' }],
    components: [{ id: 'order-desk', componentType: 'Orchestrator', description: 'Takes orders.', invokedBy: { kind: 'entry', caller: 'the shop front, which calls the desk for every order taken' } }],
    interfaces: [{ id: 'iorder_desk', component: 'order-desk', methods: [{ name: 'take', description: 'Take an order.', signature: 'take(): void', returns: 'void', params: [] }] }],
    implementations: [{ id: 'order_desk_impl', contract: 'iorder_desk', sourcePath: 'src/orders/desk.py', methods: [{ name: 'take', detail: 'intent', narrative: [], intent: 'Takes an order; it never fails, and answers nothing back.' }] }],
    types: [{ id: 'order', name: 'Order', kind: 'value-object', sourcePath: 'src/orders/models.py', fields: [{ name: 'amount', type: 'int', optional: false }, { name: 'currency', type: 'string', optional: false }] }],
    files: { 'src/orders/__init__.py': '', 'src/orders/desk.py': code, 'src/orders/models.py': 'from abc import ABC, abstractmethod\n\n\nclass Order(ABC):\n    @abstractmethod\n    def total(self) -> int: ...\n' },
  }) as unknown as FixtureTree;
  const typeCodes = (tree: FixtureTree) => issuesOf(tree).map((i) => i.code).filter((c) => /^(UNREALIZED_TYPE_FIELD|UNDECLARED_TYPE_FIELD|TYPE_FIELD_|TYPE_HOLDS)/.test(c));

  it('judges no field of a type whose code is an abstract base class, as a plain class is not judged', () => {
    expect(typeCodes(desk('def take() -> None:\n    pass\n'))).toEqual([]);
  });

  it('keeps a module-private abstract base class beside the class implementing it a table-only body', () => {
    const implementer = [
      'from abc import ABC, abstractmethod',
      '',
      'from .notice_sender import NoticeSender',
      '',
      '',
      'class _Wire(ABC):',
      '    @abstractmethod',
      '    def send_notice(self, recipient: str) -> None: ...',
      '',
      '',
      'class EmailSender(NoticeSender):',
      '    def send_notice(self, recipient: str, extra: int) -> None:',
      '        print(recipient, extra)',
      '',
    ].join('\n');
    expect(found(notices(ABC_DECLARATION, implementer), 'UNDECLARED_PARAM').map((i) => i.specId)).toEqual(['email_sender_impl']);
  });
});
