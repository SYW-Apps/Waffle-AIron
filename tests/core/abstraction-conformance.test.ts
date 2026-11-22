import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildCodeModel } from '../../src/core/source-analysis.js';
import type { ImplementationSpec } from '../../src/models/specs.js';
import type { SourceFileFacts } from '../../src/models/index.js';
import { defineRuleFixture, runRuleFixture, type FixtureTree } from '../rules-matrix/harness.js';

// ---------------------------------------------------------------------------
// Code conformance for abstractions: the member signatures the readers record
// (type_shape_fact.signatures), an abstraction's declaration compared with its
// contract, the declaration as promised surface, and the dependency edges
// along a chain. Everything runs over real analysed source: the readers are
// driven through buildCodeModel, the rules through the rule-matrix harness.
// ---------------------------------------------------------------------------

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) fs.rmSync(t, { recursive: true, force: true });
});

/** The facts of one file of a throwaway project, read through the whole analyzer. */
function read(file: string, text: string): SourceFileFacts {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'abstraction-conformance-')));
  temps.push(root);
  fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
  const impls = [{ id: 'impl-a', contract: 'ia', sourcePath: file, methods: [] }] as unknown as ImplementationSpec[];
  const facts = buildCodeModel(impls, [], root).files.find((f) => f.path === file);
  if (!facts) throw new Error(`no facts for ${file}`);
  return facts;
}

const own = (record: object | undefined, name: string): boolean => !!record && Object.prototype.hasOwnProperty.call(record, name);

describe('member signatures: the exact TypeScript reader', () => {
  it('records an interface method signature with its parameters, return and completion', () => {
    const facts = read('src/a.ts', 'export interface Sender {\n  send(recipient: string, retries?: number): void;\n  fetch(id: string): Promise<string>;\n}\n');
    const signatures = facts.typeShapes!.Sender.signatures!;
    expect(signatures.send).toEqual([{
      params: [{ name: 'recipient', type: 'string', optional: false }, { name: 'retries', type: 'number', optional: true }],
      returns: 'void',
      completesLater: false,
    }]);
    expect(signatures.fetch[0].returns).toBe('Promise<string>');
    expect(signatures.fetch[0].completesLater).toBe(true);
  });

  it('leaves the declaration facts only: no unused or reads on a parameter, whatever its name', () => {
    const facts = read('src/a.ts', 'export interface Sender { send(_recipient: string): void }\n');
    const [param] = facts.typeShapes!.Sender.signatures!.send[0].params;
    expect(param).toEqual({ name: '_recipient', type: 'string', optional: false });
  });

  it('records one signature per overload of an interface member', () => {
    const facts = read('src/a.ts', 'export interface Sender {\n  send(to: string): void;\n  send(to: string[], bulk: boolean): void;\n}\n');
    expect(facts.typeShapes!.Sender.signatures!.send.map((s) => s.params.length)).toEqual([1, 2]);
  });

  it('records the method signatures of a class, an abstract one included, and never a constructor or an accessor', () => {
    const facts = read('src/a.ts', [
      'export abstract class Sender {',
      '  constructor(private readonly name: string) {}',
      '  abstract send(recipient: string): void;',
      '  abstract fetch(id: string): Promise<string>;',
      '  get label(): string { return this.name; }',
      '  private hidden(x: number): void {}',
      '}',
      '',
    ].join('\n'));
    const signatures = facts.typeShapes!.Sender.signatures!;
    expect(Object.keys(signatures).sort()).toEqual(['fetch', 'send']);
    expect(signatures.fetch[0].completesLater).toBe(true);
  });

  it('records the overload signatures of a class method, never the implementation signature behind them', () => {
    const facts = read('src/a.ts', [
      'export class Sender {',
      '  send(to: string): void;',
      '  send(to: string, bulk: boolean): void;',
      '  send(to: string, bulk?: boolean): void { void to; void bulk; }',
      '}',
      '',
    ].join('\n'));
    expect(facts.typeShapes!.Sender.signatures!.send.map((s) => s.params.length)).toEqual([1, 2]);
  });

  it('records a class method that has one body as that signature, async as declared', () => {
    const facts = read('src/a.ts', 'export class Sender {\n  async send(to: string): Promise<void> { void to; }\n  now(to: string): string { return to; }\n}\n');
    expect(facts.typeShapes!.Sender.signatures!.send[0].completesLater).toBe(true);
    expect(facts.typeShapes!.Sender.signatures!.now[0].completesLater).toBe(false);
  });

  it('records the method signatures of a type literal alias', () => {
    const facts = read('src/a.ts', 'export type Sender = {\n  send(recipient: string): void;\n};\n');
    expect(facts.typeShapes!.Sender.signatures!.send[0].params[0].name).toBe('recipient');
  });

  it('records a property typed by a function type as a method, with its parameters and return', () => {
    const facts = read('src/a.ts', 'export interface Sender {\n  ship: (weight: number, express?: boolean) => string;\n  poll?: (id: string) => Promise<void>;\n}\n');
    const signatures = facts.typeShapes!.Sender.signatures!;
    expect(signatures.ship[0]).toEqual({
      params: [{ name: 'weight', type: 'number', optional: false }, { name: 'express', type: 'boolean', optional: true }],
      returns: 'string',
      completesLater: false,
    });
    expect(signatures.poll[0].completesLater).toBe(true);
  });

  it('records every call signature of a function-typed property written as a type literal', () => {
    const facts = read('src/a.ts', 'export interface Sender {\n  ship: { (weight: number): string; (weight: string): string };\n}\n');
    expect(facts.typeShapes!.Sender.signatures!.ship).toHaveLength(2);
  });

  it('records no signature for a data member, and none at all for a shape with no method-style member', () => {
    const facts = read('src/a.ts', 'export interface Parcel { weight: number; label?: string }\n');
    expect(facts.typeShapes!.Parcel.signatures).toBeUndefined();
  });

  it('reads member names that are Object.prototype names as their own, and finds none that is not declared', () => {
    const facts = read('src/a.ts', 'export interface Sender {\n  toString(): string;\n  constructor(x: number): void;\n  hasOwnProperty(name: string): boolean;\n  send(a: string): void;\n}\n');
    const signatures = facts.typeShapes!.Sender.signatures!;
    expect(own(signatures, 'toString')).toBe(true);
    expect(own(signatures, 'constructor')).toBe(true);
    expect(signatures.constructor[0].params[0].name).toBe('x');
    expect(own(signatures, 'valueOf')).toBe(false);
    expect(own(signatures, '__proto__')).toBe(false);
  });

  it('survives a structured clone, the way a memoized result is held', () => {
    const facts = read('src/a.ts', 'export interface Sender { constructor(x: number): void; send(a: string): void }\n');
    const cloned = structuredClone(facts.typeShapes!.Sender.signatures!);
    expect(own(cloned, 'constructor')).toBe(true);
    expect(cloned.send[0].params[0].name).toBe('a');
  });
});

describe('member signatures: the Python reader', () => {
  it('records the methods of a Protocol with the receiver set aside, annotations and async def', () => {
    const facts = read('src/sender.py', [
      'from typing import Protocol',
      '',
      '',
      'class Sender(Protocol):',
      '    def send(self, recipient: str, retries: int = 3) -> None: ...',
      '    async def fetch(self, id: str) -> str: ...',
      '',
    ].join('\n'));
    const signatures = facts.typeShapes!.Sender.signatures!;
    expect(signatures.send).toEqual([{
      params: [{ name: 'recipient', type: 'str', optional: false }, { name: 'retries', type: 'int', optional: true }],
      returns: 'None',
      completesLater: false,
    }]);
    expect(signatures.fetch[0].completesLater).toBe(true);
    expect(signatures.fetch[0].returns).toBe('str');
    expect(facts.typeShapes!.Sender.methods.sort()).toEqual(['fetch', 'send']);
  });

  it('keeps a parameter unannotated and a return absent when the Protocol states none', () => {
    const facts = read('src/sender.py', 'from typing import Protocol\n\n\nclass Sender(Protocol):\n    def send(self, recipient): ...\n');
    expect(facts.typeShapes!.Sender.signatures!.send[0]).toEqual({ params: [{ name: 'recipient', optional: false }], completesLater: false });
  });

  it('records a Protocol written with a typing prefix or a subscript, and a staticmethod keeps its first parameter', () => {
    const facts = read('src/sender.py', [
      'import typing',
      '',
      '',
      'class Sender(typing.Protocol[int]):',
      '    @staticmethod',
      '    def make(kind: str) -> None: ...',
      '',
    ].join('\n'));
    expect(facts.typeShapes!.Sender.signatures!.make[0].params).toEqual([{ name: 'kind', type: 'str', optional: false }]);
  });

  it('records nothing for an ordinary class and for a Protocol with no method', () => {
    const facts = read('src/sender.py', 'from typing import Protocol\n\n\nclass Plain:\n    def send(self, recipient: str) -> None:\n        pass\n\n\nclass Marker(Protocol):\n    name: str\n');
    expect(facts.typeShapes?.Plain).toBeUndefined();
    expect(facts.typeShapes?.Marker).toBeUndefined();
  });

  it('reads a Protocol member named like an Object.prototype name as its own', () => {
    const facts = read('src/sender.py', 'from typing import Protocol\n\n\nclass Sender(Protocol):\n    def constructor(self, x: int) -> None: ...\n    def toString(self) -> str: ...\n');
    const signatures = facts.typeShapes!.Sender.signatures!;
    expect(own(signatures, 'constructor')).toBe(true);
    expect(own(signatures, 'toString')).toBe(true);
    expect(own(signatures, 'valueOf')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The rules, over a small notification design.
// ---------------------------------------------------------------------------

const SYSTEM = { name: 'NotificationService', vision: 'Sends order notifications over several channels.' };
const SUB = { id: 'notifications', description: 'Order notification delivery.' };

type Comps = NonNullable<FixtureTree['components']>;
const sub = (components: Comps): Comps => components.map((c) => ({ subsystem: SUB.id, ...c }));

function issuesOf(tree: FixtureTree) {
  const run = runRuleFixture(defineRuleFixture({ code: 'NONE', expectFire: false, reason: 'probe', scenario: 'A probe tree whose findings the test reads directly.', tree }));
  return run.issues;
}
/** Every finding above a notice: what a correct design must not draw from any rule. */
const warned = (tree: FixtureTree) => issuesOf(tree).filter((i) => i.severity !== 'notice').map((i) => `${i.code}: ${i.message.slice(0, 140)}`);
const found = (tree: FixtureTree, code: string) => issuesOf(tree).filter((i) => i.code === code);

type Param = { name: string; type: string; optional?: boolean };
const DOC = 'Send one notice.';

/** A one-method abstraction with two implementers and one caller; the files and the contract vary. */
function flat(over: { declaration?: string; returns?: string; params?: Param[]; implementer?: string; caller?: string; language?: 'python'; files?: Record<string, string> } = {}): FixtureTree {
  const params = over.params ?? [{ name: 'recipient', type: 'string' }];
  const python = over.language === 'python';
  const verb = python ? 'send_notice' : 'sendNotice';
  const method = { name: verb, description: DOC, params, returns: over.returns ?? 'void' };
  const ext = python ? 'py' : 'ts';
  const bound = { name: verb };
  return {
    system: { ...SYSTEM, ...(python ? { targetLanguage: 'python' } : {}) },
    subsystems: [SUB],
    components: sub([
      { id: 'notice-sender', componentType: 'Adapter', abstract: true, description: 'Delivers one notice.' },
      { id: 'email-sender', componentType: 'Adapter', description: 'Delivers by email.' },
      { id: 'sms-sender', componentType: 'Adapter', description: 'Delivers by SMS.' },
      { id: 'order-notifier', componentType: 'Orchestrator', description: 'Tells the customer.', dependsOn: ['notice-sender'], invokedBy: { kind: 'runtime', caller: 'The composition root calls the notifier at boot.' } },
    ]),
    interfaces: [
      { id: 'inotice_sender', component: 'notice-sender', methods: [method] },
      { id: 'iemail_sender', component: 'email-sender', implements: ['notice-sender'], methods: [method] },
      { id: 'isms_sender', component: 'sms-sender', implements: ['notice-sender'], methods: [method] },
      { id: 'iorder_notifier', component: 'order-notifier', methods: [{ name: python ? 'notify_shipped' : 'notifyShipped', description: 'Tell the customer.' }] },
    ],
    implementations: [
      { id: 'notice_sender_impl', contract: 'inotice_sender', sourcePath: `src/notice_sender.${ext}`, methods: [{ ...bound }] },
      { id: 'email_sender_impl', contract: 'iemail_sender', sourcePath: `src/email_sender.${ext}`, methods: [{ ...bound, narrative: [{ stepNumber: 1, type: 'local', description: 'Post the notice to the mail relay.' }] }] },
      { id: 'sms_sender_impl', contract: 'isms_sender', sourcePath: `src/sms_sender.${ext}`, methods: [{ ...bound, narrative: [{ stepNumber: 1, type: 'local', description: 'Post the notice to the SMS gateway.' }] }] },
      { id: 'order_notifier_impl', contract: 'iorder_notifier', sourcePath: `src/order_notifier.${ext}`, methods: [{ name: python ? 'notify_shipped' : 'notifyShipped', narrative: [{ stepNumber: 1, type: 'call', description: 'Send the notice through the sender.', targetComponent: 'notice-sender', targetMethod: verb }] }] },
    ],
    files: python ? {
      'src/__init__.py': '',
      'src/notice_sender.py': over.declaration ?? 'from typing import Protocol\n\n\nclass NoticeSender(Protocol):\n    def send_notice(self, recipient: str) -> None: ...\n',
      'src/email_sender.py': over.implementer ?? 'from .notice_sender import NoticeSender\n\n\nclass EmailSender(NoticeSender):\n    def send_notice(self, recipient: str) -> None:\n        print(recipient)\n',
      'src/sms_sender.py': 'from .notice_sender import NoticeSender\n\n\nclass SmsSender(NoticeSender):\n    def send_notice(self, recipient: str) -> None:\n        print(recipient)\n',
      'src/order_notifier.py': over.caller ?? 'from .notice_sender import NoticeSender\n\n\nclass OrderNotifier:\n    def __init__(self, sender: NoticeSender) -> None:\n        self.sender = sender\n\n    def notify_shipped(self) -> None:\n        self.sender.send_notice("c")\n',
      ...over.files,
    } : {
      'src/notice_sender.ts': over.declaration ?? 'export interface NoticeSender { sendNotice(recipient: string): void }\n',
      'src/email_sender.ts': over.implementer ?? "import type { NoticeSender } from './notice_sender';\nexport class EmailSender implements NoticeSender { sendNotice(recipient: string): void { void recipient; } }\n",
      'src/sms_sender.ts': "import type { NoticeSender } from './notice_sender';\nexport class SmsSender implements NoticeSender { sendNotice(recipient: string): void { void recipient; } }\n",
      'src/order_notifier.ts': over.caller ?? "import type { NoticeSender } from './notice_sender';\nexport class OrderNotifier { constructor(private readonly sender: NoticeSender) {} notifyShipped(): void { this.sender.sendNotice('c'); } }\n",
      ...over.files,
    },
  };
}

describe('a correct abstraction draws nothing from the whole rule set', () => {
  it('TypeScript interface, implementers and a caller holding the interface type', () => {
    expect(warned(flat())).toEqual([]);
  });
  it('an abstract class holding only abstract members, extended by its implementers', () => {
    const tree = flat({
      declaration: 'export abstract class NoticeSender { abstract sendNotice(recipient: string): void }\n',
      implementer: "import { NoticeSender } from './notice_sender';\nexport class EmailSender extends NoticeSender { sendNotice(recipient: string): void { void recipient; } }\n",
      files: { 'src/sms_sender.ts': "import { NoticeSender } from './notice_sender';\nexport class SmsSender extends NoticeSender { sendNotice(recipient: string): void { void recipient; } }\n" },
    });
    expect(warned(tree)).toEqual([]);
  });
  it('a type literal, and a function-typed property', () => {
    expect(warned(flat({ declaration: 'export type NoticeSender = { sendNotice(recipient: string): void };\n' }))).toEqual([]);
    expect(warned(flat({ declaration: 'export interface NoticeSender { sendNotice: (recipient: string) => void }\n' }))).toEqual([]);
  });
  it('an async contract declared as a Promise', () => {
    expect(warned(flat({
      returns: 'async string',
      declaration: 'export interface NoticeSender { sendNotice(recipient: string): Promise<string> }\n',
      implementer: "import type { NoticeSender } from './notice_sender';\nexport class EmailSender implements NoticeSender { async sendNotice(recipient: string): Promise<string> { return recipient; } }\n",
      files: { 'src/sms_sender.ts': "import type { NoticeSender } from './notice_sender';\nexport class SmsSender implements NoticeSender { async sendNotice(recipient: string): Promise<string> { return recipient; } }\n" },
    }))).toEqual([]);
  });
  it('a Python Protocol with a base class and a caller', () => {
    expect(warned(flat({ language: 'python' }))).toEqual([]);
  });
});

describe('an abstraction declaration compared with its contract: param-conformance', () => {
  it('reports a parameter the declaration lacks, as UNREALIZED_PARAM', () => {
    const issues = found(flat({ declaration: 'export interface NoticeSender { sendNotice(): void }\n' }), 'UNREALIZED_PARAM');
    expect(issues).toHaveLength(1);
    expect(issues[0].specId).toBe('notice_sender_impl');
  });
  it('reports a parameter the declaration adds, as UNDECLARED_PARAM', () => {
    expect(found(flat({ declaration: 'export interface NoticeSender { sendNotice(recipient: string, copy: string): void }\n' }), 'UNDECLARED_PARAM')).toHaveLength(1);
  });
  it('reports a parameter named otherwise, as PARAM_NAME_MISMATCH', () => {
    expect(found(flat({ declaration: 'export interface NoticeSender { sendNotice(to: string): void }\n' }), 'PARAM_NAME_MISMATCH')).toHaveLength(1);
  });
  it('reports a parameter typed otherwise, as PARAM_TYPE_MISMATCH', () => {
    expect(found(flat({ declaration: 'export interface NoticeSender { sendNotice(recipient: number): void }\n' }), 'PARAM_TYPE_MISMATCH')).toHaveLength(1);
  });
  it('reports a parameter that may be left out where the contract requires it, as PARAM_OPTIONALITY', () => {
    expect(found(flat({ declaration: 'export interface NoticeSender { sendNotice(recipient?: string): void }\n' }), 'PARAM_OPTIONALITY')).toHaveLength(1);
  });
  it('reports a return type the contract does not describe, as RETURN_TYPE_MISMATCH', () => {
    const tree = flat({ returns: 'string', declaration: 'export interface NoticeSender { sendNotice(recipient: string): number }\n', implementer: "import type { NoticeSender } from './notice_sender';\nexport class EmailSender implements NoticeSender { sendNotice(recipient: string): number { return recipient.length; } }\n" });
    expect(found(tree, 'RETURN_TYPE_MISMATCH').filter((i) => i.specId === 'notice_sender_impl')).toHaveLength(1);
  });
  it('reads a class, a type literal and a function-typed property as the interface is read', () => {
    expect(found(flat({ declaration: 'export abstract class NoticeSender { abstract sendNotice(recipient: number): void }\n' }), 'PARAM_TYPE_MISMATCH')).toHaveLength(1);
    expect(found(flat({ declaration: 'export type NoticeSender = { sendNotice(recipient: number): void };\n' }), 'PARAM_TYPE_MISMATCH')).toHaveLength(1);
    expect(found(flat({ declaration: 'export interface NoticeSender { sendNotice: (recipient: number) => void }\n' }), 'PARAM_TYPE_MISMATCH')).toHaveLength(1);
  });
  it('judges an overload set on what every overload says: one that matches keeps it silent, all that drift report it', () => {
    const matching = 'export interface NoticeSender {\n  sendNotice(): void;\n  sendNotice(recipient: string): void;\n}\n';
    expect(found(flat({ declaration: matching }), 'UNREALIZED_PARAM')).toEqual([]);
    const drifting = 'export interface NoticeSender {\n  sendNotice(): void;\n  sendNotice(): string;\n}\n';
    expect(found(flat({ declaration: drifting }), 'UNREALIZED_PARAM')).toHaveLength(1);
  });
  it('reads the shape named as the component when the file declares several that hold the member', () => {
    const other = 'export interface Unrelated { sendNotice(recipient: number): void }\n';
    const own = 'export interface NoticeSender { sendNotice(recipient: string): void }\n';
    expect(found(flat({ declaration: `${other}${own}` }), 'PARAM_TYPE_MISMATCH')).toEqual([]);
    const swapped = 'export interface Unrelated { sendNotice(recipient: string): void }\nexport interface NoticeSender { sendNotice(recipient: number): void }\n';
    expect(found(flat({ declaration: swapped }), 'PARAM_TYPE_MISMATCH')).toHaveLength(1);
  });
  it('compares nothing where the file states no signature for the member: no facts, no guess', () => {
    expect(found(flat({ declaration: 'export const NOTICE_CHANNEL = "mail";\n' }), 'UNREALIZED_PARAM')).toEqual([]);
    expect(found(flat({ declaration: 'export interface NoticeSender { channel: string }\n' }), 'UNREALIZED_PARAM')).toEqual([]);
  });
  it('still compares an implementer with its own contract: a drifted implementer is reported on its own spec', () => {
    const issues = found(flat({ implementer: "import type { NoticeSender } from './notice_sender';\nexport class EmailSender implements NoticeSender { sendNotice(to: string): void { void to; } }\n" }), 'PARAM_NAME_MISMATCH');
    expect(issues.map((i) => i.specId)).toEqual(['email_sender_impl']);
  });
  it('reads a Python Protocol by the same rules', () => {
    const drift = 'from typing import Protocol\n\n\nclass NoticeSender(Protocol):\n    def send_notice(self, to: str) -> None: ...\n';
    expect(found(flat({ language: 'python', declaration: drift }), 'PARAM_NAME_MISMATCH').map((i) => i.specId)).toEqual(['notice_sender_impl']);
    const lacking = 'from typing import Protocol\n\n\nclass NoticeSender(Protocol):\n    def send_notice(self) -> None: ...\n';
    expect(found(flat({ language: 'python', declaration: lacking }), 'UNREALIZED_PARAM').map((i) => i.specId)).toEqual(['notice_sender_impl']);
  });
});

describe('an abstraction declaration compared with its contract: async-conformance', () => {
  const asyncImplementer = "import type { NoticeSender } from './notice_sender';\nexport class EmailSender implements NoticeSender { async sendNotice(recipient: string): Promise<string> { return recipient; } }\n";
  const asyncOther = { 'src/sms_sender.ts': "import type { NoticeSender } from './notice_sender';\nexport class SmsSender implements NoticeSender { async sendNotice(recipient: string): Promise<string> { return recipient; } }\n" };
  it('reports a declaration that completes now where the contract says async', () => {
    const tree = flat({ returns: 'async string', declaration: 'export interface NoticeSender { sendNotice(recipient: string): string }\n', implementer: asyncImplementer, files: asyncOther });
    expect(found(tree, 'ASYNC_MISMATCH').filter((i) => i.specId === 'notice_sender_impl')).toHaveLength(1);
  });
  it('reports a declaration that completes later where the contract says it completes now', () => {
    const tree = flat({ returns: 'string', declaration: 'export interface NoticeSender { sendNotice(recipient: string): Promise<string> }\n' });
    expect(found(tree, 'ASYNC_MISMATCH').filter((i) => i.specId === 'notice_sender_impl')).toHaveLength(1);
  });
  it('is silent where both agree, in a class, and where the member is not declared', () => {
    const agree = flat({ returns: 'async string', declaration: 'export abstract class NoticeSender { abstract sendNotice(recipient: string): Promise<string> }\n', implementer: asyncImplementer, files: asyncOther });
    expect(found(agree, 'ASYNC_MISMATCH')).toEqual([]);
    expect(found(flat({ returns: 'async string', declaration: 'export const NOTICE_CHANNEL = "mail";\n', implementer: asyncImplementer, files: asyncOther }), 'ASYNC_MISMATCH')).toEqual([]);
  });
  it('reads a Python Protocol: a def against an async contract', () => {
    const sync = 'from typing import Protocol\n\n\nclass NoticeSender(Protocol):\n    def send_notice(self, recipient: str) -> str: ...\n';
    const tree = flat({ language: 'python', returns: 'async string', declaration: sync });
    expect(found(tree, 'ASYNC_MISMATCH').filter((i) => i.specId === 'notice_sender_impl')).toHaveLength(1);
  });
});

describe('an abstraction declaration is promised surface: export-conformance', () => {
  it('is never an UNDECLARED_EXPORT, whoever takes it: a value import of an abstract class by an implementer', () => {
    const tree = flat({
      declaration: 'export abstract class NoticeSender { abstract sendNotice(recipient: string): void }\n',
      implementer: "import { NoticeSender } from './notice_sender';\nexport class EmailSender extends NoticeSender { sendNotice(recipient: string): void { void recipient; } }\n",
    });
    expect(found(tree, 'UNDECLARED_EXPORT')).toEqual([]);
    expect(found(tree, 'UNDECLARED_PUBLIC_MEMBER')).toEqual([]);
  });
  it('promises only the declaration: a name beside it that another component takes still crosses', () => {
    const tree = flat({
      declaration: 'export interface NoticeSender { sendNotice(recipient: string): void }\nexport const CHANNEL = "mail";\n',
      implementer: "import { CHANNEL } from './notice_sender';\nimport type { NoticeSender } from './notice_sender';\nexport class EmailSender implements NoticeSender { sendNotice(recipient: string): void { void recipient; void CHANNEL; } }\n",
    });
    const crossed = found(tree, 'UNDECLARED_EXPORT');
    expect(crossed).toHaveLength(1);
    expect(crossed[0].message).toContain('"CHANNEL"');
    expect(crossed[0].message).not.toContain('"NoticeSender"');
  });
});

describe('dependency-conformance over a chain of abstractions', () => {
  /** Animal, Dog (implements Animal), GoldenRetriever (implements Dog), and a caller holding Animal. */
  function chain(files: Record<string, string>): FixtureTree {
    const speak = { name: 'speak', description: 'Make the sound.', params: [{ name: 'volume', type: 'int' }], returns: 'string' };
    return {
      system: SYSTEM,
      subsystems: [SUB],
      components: sub([
        { id: 'animal', componentType: 'Adapter', abstract: true, description: 'Any animal.' },
        { id: 'dog', componentType: 'Adapter', abstract: true, description: 'Any dog.' },
        { id: 'golden-retriever', componentType: 'Adapter', description: 'A golden retriever.' },
        { id: 'kennel', componentType: 'Orchestrator', description: 'Keeps the animals.', dependsOn: ['animal'], invokedBy: { kind: 'runtime', caller: 'The composition root calls the kennel at boot.' } },
      ]),
      interfaces: [
        { id: 'ianimal', component: 'animal', methods: [speak] },
        { id: 'idog', component: 'dog', implements: ['animal'], methods: [speak] },
        { id: 'igolden_retriever', component: 'golden-retriever', implements: ['dog'], methods: [speak] },
        { id: 'ikennel', component: 'kennel', methods: [{ name: 'feed', description: 'Feed the animals.' }] },
      ],
      implementations: [
        { id: 'animal_impl', contract: 'ianimal', sourcePath: 'src/animal.ts', methods: [{ name: 'speak' }] },
        { id: 'dog_impl', contract: 'idog', sourcePath: 'src/dog.ts', methods: [{ name: 'speak' }] },
        { id: 'golden_impl', contract: 'igolden_retriever', sourcePath: 'src/golden.ts', methods: [{ name: 'speak', narrative: [{ stepNumber: 1, type: 'local', description: 'Answer with a bark.' }] }] },
        { id: 'kennel_impl', contract: 'ikennel', sourcePath: 'src/kennel.ts', methods: [{ name: 'feed', narrative: [{ stepNumber: 1, type: 'call', description: 'Make it speak.', targetComponent: 'animal', targetMethod: 'speak' }] }] },
      ],
      files: {
        'src/animal.ts': 'export interface Animal { speak(volume: number): string }\n',
        'src/dog.ts': "import type { Animal } from './animal';\nexport interface Dog extends Animal { speak(volume: number): string }\n",
        'src/golden.ts': "import type { Dog } from './dog';\nexport class GoldenRetriever implements Dog { speak(volume: number): string { return 'woof'.repeat(volume); } }\n",
        'src/kennel.ts': "import type { Animal } from './animal';\nexport class Kennel { constructor(private readonly animal: Animal) {} feed(): void { this.animal.speak(1); } }\n",
        ...files,
      },
    };
  }
  const undeclared = (tree: FixtureTree, from: string, to: string) =>
    found(tree, 'UNDECLARED_DEPENDENCY').filter((i) => i.message.includes(`"${from}"`) && i.message.includes(`"${to}"`));

  it('is clean for a three-level chain written the honest way', () => {
    expect(warned(chain({}))).toEqual([]);
  });
  it('lets the concrete implementer import the abstraction two levels up, as a value or a type', () => {
    const tree = chain({
      'src/animal.ts': 'export interface Animal { speak(volume: number): string }\nexport const LOUD = 2;\n',
      'src/golden.ts': "import type { Dog } from './dog';\nimport { LOUD } from './animal';\nexport class GoldenRetriever implements Dog { speak(volume: number): string { return 'woof'.repeat(volume * LOUD); } }\n",
    });
    expect(undeclared(tree, 'src/golden.ts', 'src/animal.ts')).toEqual([]);
    expect(undeclared(tree, 'src/golden.ts', 'src/dog.ts')).toEqual([]);
  });
  it('lets an abstraction implementing another import it, an extends of an abstract class included', () => {
    const tree = chain({
      'src/animal.ts': 'export abstract class Animal { abstract speak(volume: number): string }\n',
      'src/dog.ts': "import { Animal } from './animal';\nexport abstract class Dog extends Animal { abstract speak(volume: number): string }\n",
      'src/golden.ts': "import { Dog } from './dog';\nexport class GoldenRetriever extends Dog { speak(volume: number): string { return 'woof'.repeat(volume); } }\n",
      'src/kennel.ts': "import { Animal } from './animal';\nexport class Kennel { constructor(private readonly animal: Animal) {} feed(): void { this.animal.speak(1); } }\n",
    });
    expect(undeclared(tree, 'src/dog.ts', 'src/animal.ts')).toEqual([]);
    expect(undeclared(tree, 'src/golden.ts', 'src/dog.ts')).toEqual([]);
    expect(undeclared(tree, 'src/golden.ts', 'src/animal.ts')).toEqual([]);
  });
  it('never lets an abstraction import an implementer: the reverse stays an undeclared dependency', () => {
    const tree = chain({
      'src/animal.ts': "import { Golden } from './golden';\nexport interface Animal { speak(volume: number): string }\nexport const DEFAULT = Golden;\n",
      'src/golden.ts': "import type { Dog } from './dog';\nexport const Golden = 1;\nexport class GoldenRetriever implements Dog { speak(volume: number): string { return String(volume); } }\n",
    });
    expect(undeclared(tree, 'src/animal.ts', 'src/golden.ts')).toHaveLength(1);
  });
  it('justifies a caller landing on a transitive implementer through the interface type, with no dependsOn on it', () => {
    const tree = chain({});
    expect(undeclared(tree, 'src/kennel.ts', 'src/golden.ts')).toEqual([]);
    expect(undeclared(tree, 'src/kennel.ts', 'src/dog.ts')).toEqual([]);
    expect(found(tree, 'UNREALIZED_DEPENDENCY')).toEqual([]);
  });
  it('realizes the caller\'s edge by a call through the interface type that lands in a transitive implementer, with no import of the interface file', () => {
    const tree = chain({ 'src/kennel.ts': "import type { Dog } from './dog';\nexport class Kennel { constructor(private readonly animal: Dog) {} feed(): void { this.animal.speak(1); } }\n" });
    expect(found(tree, 'UNREALIZED_DEPENDENCY')).toEqual([]);
  });
  it('keeps a direct import of an implementer an UNDECLARED_DEPENDENCY, and never realizes the edge to the abstraction by it', () => {
    const tree = chain({ 'src/kennel.ts': "import { GoldenRetriever } from './golden';\nexport class Kennel { feed(): void { new GoldenRetriever().speak(1); } }\n" });
    expect(undeclared(tree, 'src/kennel.ts', 'src/golden.ts')).toHaveLength(1);
    expect(found(tree, 'UNREALIZED_DEPENDENCY').filter((i) => i.message.includes('"kennel"') && i.message.includes('"animal"'))).toHaveLength(1);
  });
  it('keeps a direct import of the concrete implementer undeclared for a caller that also holds the root interface', () => {
    const tree = chain({ 'src/kennel.ts': "import { GoldenRetriever } from './golden';\nimport type { Animal } from './animal';\nexport class Kennel { constructor(private readonly animal: Animal) {} feed(): void { this.animal.speak(1); void GoldenRetriever; } }\n" });
    expect(undeclared(tree, 'src/kennel.ts', 'src/golden.ts')).toHaveLength(1);
  });
  it('treats a Python base class imported from the abstraction\'s module as the declared relation, and not the reverse', () => {
    expect(found(flat({ language: 'python' }), 'UNDECLARED_DEPENDENCY')).toEqual([]);
    const reverse = flat({ language: 'python', declaration: 'from typing import Protocol\n\nfrom .email_sender import EmailSender\n\n\nclass NoticeSender(Protocol):\n    def send_notice(self, recipient: str) -> None: ...\n\n\nDEFAULT = EmailSender\n' });
    expect(found(reverse, 'UNDECLARED_DEPENDENCY').filter((i) => i.message.includes('src/notice_sender.py'))).toHaveLength(1);
  });
});

describe('a Portal calling through the root of a chain lands on a transitive implementer', () => {
  /** Animal, Dog (implements Animal), GoldenRetriever (implements Dog), and a Portal holding Animal. */
  function portalChain(files: Record<string, string>): FixtureTree {
    const speak = { name: 'speak', description: 'Make the sound.', params: [{ name: 'volume', type: 'int' }], returns: 'string', effect: 'read' };
    return {
      system: SYSTEM,
      subsystems: [SUB],
      components: sub([
        { id: 'animal', componentType: 'Index', abstract: true, description: 'Any animal.' },
        { id: 'dog', componentType: 'Index', abstract: true, description: 'Any dog.' },
        { id: 'golden-retriever', componentType: 'Index', description: 'A golden retriever.' },
        { id: 'kennel-api', componentType: 'Portal', transport: 'InProcess', description: 'The kennel verbs.', dependsOn: ['animal'], invokedBy: { kind: 'entry', caller: 'Applications link the kennel library and call its verbs in process.' } },
      ]),
      interfaces: [
        { id: 'ianimal', component: 'animal', methods: [speak] },
        { id: 'idog', component: 'dog', implements: ['animal'], methods: [speak] },
        { id: 'igolden_retriever', component: 'golden-retriever', implements: ['dog'], methods: [speak] },
        { id: 'ikennel_api', component: 'kennel-api', methods: [{ name: 'feedAll', description: 'Feed the animals.', params: [], returns: 'string' }] },
      ],
      implementations: [
        { id: 'animal_impl', contract: 'ianimal', sourcePath: 'src/animal.ts', methods: [{ name: 'speak' }] },
        { id: 'dog_impl', contract: 'idog', sourcePath: 'src/dog.ts', methods: [{ name: 'speak' }] },
        { id: 'golden_impl', contract: 'igolden_retriever', sourcePath: 'src/golden.ts', methods: [{ name: 'speak', narrative: [{ stepNumber: 1, type: 'local', description: 'Answer with a bark.' }] }] },
        { id: 'kennel_api_impl', contract: 'ikennel_api', sourcePath: 'src/kennel_api.ts', methods: [{ name: 'feedAll', narrative: [{ stepNumber: 1, type: 'call', description: 'Make the animal speak.', targetComponent: 'animal', targetMethod: 'speak' }] }] },
      ],
      files: {
        'src/animal.ts': 'export interface Animal { speak(volume: number): string }\n',
        'src/dog.ts': "import type { Animal } from './animal';\nexport interface Dog extends Animal { speak(volume: number): string }\n",
        'src/golden.ts': "import type { Dog } from './dog';\nexport class GoldenRetriever implements Dog { speak(volume: number): string { return 'woof'.repeat(volume); } }\n",
        'src/kennel_api.ts': "import type { Animal } from './animal';\nexport function feedAll(animal: Animal): string { return animal.speak(1); }\n",
        ...files,
      },
    };
  }
  const undeclared = (tree: FixtureTree, from: string, to: string) =>
    found(tree, 'UNDECLARED_DEPENDENCY').filter((i) => i.message.includes(`"${from}"`) && i.message.includes(`"${to}"`));

  it('is justified by the dependsOn on the root, with no dependsOn on the implementer two levels down', () => {
    const tree = portalChain({});
    expect(undeclared(tree, 'src/kennel_api.ts', 'src/golden.ts')).toEqual([]);
    expect(warned(tree)).toEqual([]);
  });
  it('is not excused for a call made on the implementer class itself', () => {
    const tree = portalChain({ 'src/kennel_api.ts': "import { GoldenRetriever } from './golden';\nexport function feedAll(): string { return new GoldenRetriever().speak(1); }\n" });
    expect(undeclared(tree, 'src/kennel_api.ts', 'src/golden.ts')).toHaveLength(1);
  });
});

describe('the import forms an abstraction is reached by', () => {
  it('a caller importing the interface plainly, not as a type, realizes its dependsOn and accuses nothing', () => {
    const tree = flat({ caller: "import { NoticeSender } from './notice_sender';\nexport class OrderNotifier { constructor(private readonly sender: NoticeSender) {} notifyShipped(): void { this.sender.sendNotice('c'); } }\n" });
    expect(warned(tree)).toEqual([]);
  });
  it('a composition root importing the interface and the implementers it builds needs the edges it uses declared, and no more', () => {
    const wired = flat({
      files: {
        'src/composition_root.ts': "import type { NoticeSender } from './notice_sender';\nimport { EmailSender } from './email_sender';\nimport { OrderNotifier } from './order_notifier';\nexport function boot(): OrderNotifier { const sender: NoticeSender = new EmailSender(); return new OrderNotifier(sender); }\n",
      },
    });
    wired.components!.push({ id: 'composition-root', componentType: 'Orchestrator', subsystem: SUB.id, description: 'Wires the notifier at boot.', dependsOn: ['email-sender', 'order-notifier'], invokedBy: { kind: 'runtime', caller: 'The process entry point calls boot.' } });
    wired.interfaces!.push({ id: 'icomposition_root', component: 'composition-root', methods: [{ name: 'boot', description: 'Wire the notifier.', params: [], returns: 'void' }] });
    wired.implementations!.push({ id: 'composition_root_impl', contract: 'icomposition_root', sourcePath: 'src/composition_root.ts', methods: [{ name: 'boot', narrative: [{ stepNumber: 1, type: 'local', description: 'Build the sender and the notifier.' }] }] });
    expect(found(wired, 'UNDECLARED_DEPENDENCY')).toEqual([]);
    // Without the dependsOn on the implementer its direct import is judged like any other.
    const missing = structuredClone(wired);
    missing.components!.find((c) => c.id === 'composition-root')!.dependsOn = ['order-notifier'];
    expect(found(missing, 'UNDECLARED_DEPENDENCY').filter((i) => i.message.includes('src/email_sender.ts'))).toHaveLength(1);
  });
});

describe('a Python Protocol is no declarative class: trees without an abstraction read as before', () => {
  const PROTOCOL_ORDER = 'from typing import Protocol\n\n\nclass Order(Protocol):\n    @property\n    def amount(self) -> int: ...\n\n    def total(self) -> int: ...\n';
  function typeTree(code: string): FixtureTree {
    return {
      system: { targetLanguage: 'python' },
      subsystems: [{ id: 'ordering', description: 'Takes and answers orders.' }],
      components: [{ id: 'order-desk', componentType: 'Orchestrator', description: 'Takes orders.', invokedBy: { kind: 'entry', caller: 'the shop front, which calls the desk for every order taken' } }],
      interfaces: [{ id: 'iorder_desk', component: 'order-desk', methods: [{ name: 'take', description: 'Take an order.', signature: 'take(): void', returns: 'void', params: [] }] }],
      implementations: [{ id: 'order_desk_impl', contract: 'iorder_desk', sourcePath: 'src/orders/desk.py', methods: [{ name: 'take', detail: 'intent', narrative: [], intent: 'Takes an order; it never fails, and answers nothing back.' }] }],
      types: [{ id: 'order', name: 'Order', kind: 'value-object', sourcePath: 'src/orders/models.py', fields: [{ name: 'amount', type: 'int', optional: false }, { name: 'currency', type: 'string', optional: false }] }],
      files: { 'src/orders/__init__.py': '', 'src/orders/desk.py': 'def take() -> None:\n    pass\n', 'src/orders/models.py': code },
    } as unknown as FixtureTree;
  }
  const typeCodes = (tree: FixtureTree) => issuesOf(tree).map((i) => i.code).filter((c) => /^(UNREALIZED_TYPE_FIELD|UNDECLARED_TYPE_FIELD|TYPE_FIELD_|TYPE_HOLDS)/.test(c));

  it('judges no field of a type whose code is a Protocol with properties, as a plain class is not judged', () => {
    expect(typeCodes(typeTree(PROTOCOL_ORDER))).toEqual([]);
  });
  it('still judges a declarative class (the control: the same tree with a dataclass is accused of the field it lacks)', () => {
    const dataclass = 'from dataclasses import dataclass\n\n\n@dataclass\nclass Order:\n    amount: int\n';
    expect(typeCodes(typeTree(dataclass))).toContain('UNREALIZED_TYPE_FIELD');
  });

  it('keeps a Protocol beside the class implementing it a table-only body, for an ordinary component', () => {
    // The Protocol is module-private, so its body is a table's, not a realization: only the class is judged,
    // and its undeclared parameter is reported although the Protocol beside it does not take it.
    const implementer = [
      'from typing import Protocol',
      '',
      'from .notice_sender import NoticeSender',
      '',
      '',
      'class _Wire(Protocol):',
      '    def send_notice(self, recipient: str) -> None: ...',
      '',
      '',
      'class EmailSender(NoticeSender):',
      '    def send_notice(self, recipient: str, extra: int) -> None:',
      '        print(recipient, extra)',
      '',
    ].join('\n');
    const found2 = found(flat({ language: 'python', implementer }), 'UNDECLARED_PARAM');
    expect(found2.map((i) => i.specId)).toEqual(['email_sender_impl']);
  });
});

describe('only a declaration is the abstraction: a class with behaviour is no declaration', () => {
  const both = [
    'export class NoticeSender { sendNotice(recipient: number): void { void recipient; } }',
    'export interface NoticeSenderPort { sendNotice(recipient: string): void }',
    '',
  ].join('\n');
  it('reads the interface beside a concrete class of the same method, even where the class bears the component name', () => {
    expect(found(flat({ declaration: both }), 'PARAM_TYPE_MISMATCH').filter((i) => i.specId === 'notice_sender_impl')).toEqual([]);
    const drifted = both.replace('recipient: string', 'recipient: boolean');
    expect(found(flat({ declaration: drifted }), 'PARAM_TYPE_MISMATCH').filter((i) => i.specId === 'notice_sender_impl')).toHaveLength(1);
  });
  it('promises the interface and not the class: the class an implementer takes still crosses', () => {
    const tree = flat({
      declaration: both,
      implementer: "import { NoticeSender } from './notice_sender';\nimport type { NoticeSenderPort } from './notice_sender';\nexport class EmailSender implements NoticeSenderPort { sendNotice(recipient: string): void { new NoticeSender().sendNotice(recipient.length); } }\n",
    });
    const crossed = found(tree, 'UNDECLARED_EXPORT');
    expect(crossed).toHaveLength(1);
    expect(crossed[0].message).toContain('"NoticeSender"');
    expect(crossed[0].message).not.toContain('"NoticeSenderPort"');
  });
  it('reads an abstract class with behaviour no more as the declaration than a concrete one', () => {
    const behaving = 'export abstract class NoticeSender { abstract sendNotice(recipient: string): void; helper(): number { return 1; } }\nexport interface NoticeSenderPort { sendNotice(recipient: boolean): void }\n';
    expect(found(flat({ declaration: behaving }), 'PARAM_TYPE_MISMATCH').filter((i) => i.specId === 'notice_sender_impl')).toHaveLength(1);
  });
  it('still reads an abstract class whose members are all abstract', () => {
    expect(found(flat({ declaration: 'export abstract class NoticeSender { abstract sendNotice(recipient: number): void }\n' }), 'PARAM_TYPE_MISMATCH')).toHaveLength(1);
  });
});
