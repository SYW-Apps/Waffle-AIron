import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { setProjectRoot, listFilesRecursive } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { deleteSpec, moveSpec, updateSpecGated } from '../../src/core/authoring.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { materializeFixtureProject, type FixtureTree } from '../rules-matrix/harness.js';

// ---------------------------------------------------------------------------
// Rehearsed writes: a dry run is refused exactly when the write would be, a
// deletion names what it leaves, and a replaced export table names the
// implementers it leaves unpublished.
// ---------------------------------------------------------------------------

const roots: string[] = [];
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => undefined);
  setProjectRoot(null);
  invalidateSpecCache();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

const SEND = { name: 'sendNotice', description: 'Send one notice to a recipient.', params: [{ name: 'recipient', type: 'string' }], returns: 'void' };
const NOTIFICATIONS = {
  id: 'notifications', description: 'Order notification delivery.',
  publicInterfaces: [{ component: 'notice-sender', details: 'The sender contract the channel subsystems implement.', role: 'implement', consumers: ['mail-channels'] }],
};

/** An abstraction published to mail-channels, two implementers (email there, SMS here) and a caller. */
function senders(plain = false): FixtureTree {
  return {
    system: { name: 'NotificationService', vision: 'Sends order notifications over several channels.' },
    subsystems: [plain ? { id: 'notifications', description: 'Order notification delivery.' } : NOTIFICATIONS, { id: 'mail-channels', description: 'The mail channel implementers.' }, { id: 'other', description: 'Somewhere else.' }],
    components: [
      { id: 'notice-sender', subsystem: 'notifications', componentType: 'Adapter', abstract: true, description: 'Delivers one notice over some channel.' },
      { id: 'email-sender', subsystem: plain ? 'notifications' : 'mail-channels', componentType: 'Adapter', description: 'Delivers a notice by email.' },
      { id: 'sms-sender', subsystem: 'notifications', componentType: 'Adapter', description: 'Delivers a notice by SMS.' },
      { id: 'order-notifier', subsystem: 'notifications', componentType: 'Orchestrator', description: 'Tells the customer an order moved on.', dependsOn: ['notice-sender'] },
    ],
    interfaces: [
      { id: 'inotice_sender', component: 'notice-sender', methods: [SEND] },
      { id: 'iemail_sender', component: 'email-sender', implements: ['notice-sender'], methods: [SEND] },
      { id: 'isms_sender', component: 'sms-sender', implements: ['notice-sender'], methods: [SEND] },
      { id: 'iorder_notifier', component: 'order-notifier', methods: [{ name: 'notifyShipped', description: 'Tell the customer the order shipped.' }] },
    ],
    implementations: [
      { id: 'notice_sender_impl', contract: 'inotice_sender', methods: [{ name: 'sendNotice' }] },
      { id: 'email_sender_impl', contract: 'iemail_sender', methods: [{ name: 'sendNotice', narrative: [{ stepNumber: 1, type: 'local', description: 'Post to the mail relay.' }] }] },
      { id: 'sms_sender_impl', contract: 'isms_sender', methods: [{ name: 'sendNotice', narrative: [{ stepNumber: 1, type: 'local', description: 'Post to the SMS gateway.' }] }] },
      { id: 'order_notifier_impl', contract: 'iorder_notifier', methods: [{ name: 'notifyShipped', narrative: [{ stepNumber: 1, type: 'call', description: 'Send the notice.', targetComponent: 'notice-sender', targetMethod: 'sendNotice' }] }] },
    ],
  };
}

function project(plain = false): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-rehearsal-r11-')));
  roots.push(root);
  materializeFixtureProject(root, senders(plain));
  setProjectRoot(root);
  invalidateSpecCache();
  return root;
}

const snapshot = (root: string): Record<string, string> =>
  Object.fromEntries(listFilesRecursive(path.join(root, '.wai')).map((f) => [f, fs.readFileSync(f, 'utf8')]));

describe('a dry run move is refused exactly when the move would be', () => {
  it('refuses moving the email sender to a subsystem its abstraction is not published to, dry run or not', () => {
    const root = project();
    const before = snapshot(root);
    expect(() => moveSpec('component', 'email-sender', 'other', true)).toThrow(/Refused: moving component "email-sender".*ABSTRACTION_UNPUBLISHED/s);
    expect(() => moveSpec('component', 'email-sender', 'other', false)).toThrow(/Refused: moving component "email-sender".*ABSTRACTION_UNPUBLISHED/s);
    expect(snapshot(root)).toEqual(before);
  });
});

describe('a deletion names what it leaves', () => {
  it('names ABSTRACTION_SINGLE_IMPLEMENTER when one of two implementers goes, for the dry run and the deletion', () => {
    const root = project(true);
    const before = snapshot(root);
    const dry = deleteSpec('component', 'sms-sender', true);
    expect(dry.findings?.some((f) => f.includes('ABSTRACTION_SINGLE_IMPLEMENTER'))).toBe(true);
    expect(snapshot(root)).toEqual(before);
    const done = deleteSpec('component', 'sms-sender');
    expect(done.deleted).toBe(true);
    expect(done.findings).toEqual(dry.findings);
  });
});

describe('sdd_set_public_interfaces dryRun', () => {
  it('writes nothing and names the implementer the replacement leaves unpublished', async () => {
    const root = project();
    const before = snapshot(root);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'rehearsal-r11-test', version: '0.0.1' });
    await Promise.all([createMcpServer().connect(serverTransport), client.connect(clientTransport)]);
    clients.push(client);
    const result = await client.callTool({ name: 'sdd_set_public_interfaces', arguments: { subsystem: 'notifications', publicInterfaces: [], dryRun: true } }) as { isError?: boolean; content?: { text?: string }[] };
    const text = result.content?.[0]?.text ?? '';
    expect(result.isError ?? false, text).toBe(false);
    expect(text).toContain('DRY RUN');
    expect(text).toContain('email-sender');
    expect(text).toContain('ABSTRACTION_UNPUBLISHED');
    expect(snapshot(root)).toEqual(before);
  });
});

// Round 6: a write touching an abstraction rehearses on a copy and reports the
// findings it lands on specs it does not name (IMPLEMENTS_MISMATCH on an
// implementer), dry run or not, and is never refused for them.
describe('a write touching an abstraction reports the findings it brings', () => {
  const RETYPED = [{ name: 'sendNotice', params: [{ name: 'recipient', type: 'int', description: 'who' }] }];

  it('update_spec on an implementer foretells its IMPLEMENTS_MISMATCH, dry run and real alike, and still writes', () => {
    const root = project(true);
    const before = snapshot(root);
    const dry = updateSpecGated('interface', 'isms_sender', { methods: RETYPED }, true);
    expect(dry.findings?.some((f) => /^error IMPLEMENTS_MISMATCH \[isms_sender\]/.test(f)), JSON.stringify(dry.findings)).toBe(true);
    expect(snapshot(root)).toEqual(before);
    const real = updateSpecGated('interface', 'isms_sender', { methods: RETYPED });
    expect(real.written).toBe(true);
    expect(real.findings).toEqual(dry.findings);
  });

  it('update_spec on the abstraction names each implementer it leaves mismatched', () => {
    project(true);
    const dry = updateSpecGated('interface', 'inotice_sender', { methods: RETYPED }, true);
    const mismatched = (dry.findings ?? []).filter((f) => f.includes('IMPLEMENTS_MISMATCH')).join('\n');
    expect(mismatched).toContain('[iemail_sender]');
    expect(mismatched).toContain('[isms_sender]');
  });

  it('a write touching no abstraction carries no findings field', () => {
    project(true);
    const report = updateSpecGated('interface', 'iorder_notifier', { description: 'Tells the customer, precisely.' }, true);
    expect(report.findings).toBeUndefined();
  });

  it('sdd_define_interface restating an implementer renders the findings it brings', async () => {
    project(true);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'rehearsal-r11-test', version: '0.0.1' });
    await Promise.all([createMcpServer().connect(serverTransport), client.connect(clientTransport)]);
    clients.push(client);
    const result = await client.callTool({
      name: 'sdd_define_interface',
      arguments: { id: 'isms_sender', name: 'ISmsSender', description: 'The SMS sender.', component: 'sms-sender', implements: ['notice-sender'], methods: [{ ...SEND, params: [{ name: 'recipient', type: 'int', description: 'who' }] }] },
    }) as { isError?: boolean; content?: { text?: string }[]; structuredContent?: { findings?: string[] } };
    const text = result.content?.[0]?.text ?? '';
    expect(result.isError ?? false, text).toBe(false);
    expect(text).toContain('FINDINGS this write brought');
    expect(result.structuredContent?.findings?.some((f) => f.includes('IMPLEMENTS_MISMATCH'))).toBe(true);
  });
});
