import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { getStatusReport } from '../../src/core/status.js';
import { summarizeStatus } from '../../src/mcp/status-summary.js';
import { materializeFixtureProject } from '../rules-matrix/harness.js';

// ---------------------------------------------------------------------------
// Round 7 (QA): `wairon status` showed an abstraction as "Implementation:
// Missing (-30%)". An abstraction needs no implementation of its own — its
// implementers realize it — so it reads as such and scores as implemented.
// A concrete component without one is still Missing.
// ---------------------------------------------------------------------------

const roots: string[] = [];
afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

const SEND = { name: 'send', description: 'Send one notice.', params: [{ name: 'to', type: 'string' }], returns: 'void' };

function project(): void {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-status-abs-')));
  roots.push(root);
  materializeFixtureProject(root, {
    system: { name: 'Notices', vision: 'Sends notices.' },
    subsystems: [{ id: 'notices', description: 'Notice delivery.', status: 'complete' }],
    components: [
      { id: 'sender', subsystem: 'notices', componentType: 'Adapter', abstract: true, description: 'Delivers a notice somehow.', status: 'complete' },
      { id: 'mailer', subsystem: 'notices', componentType: 'Adapter', description: 'Delivers by mail.', status: 'complete' },
      { id: 'texter', subsystem: 'notices', componentType: 'Adapter', description: 'Delivers by SMS.', status: 'complete' },
    ],
    interfaces: [
      { id: 'isender', component: 'sender', methods: [SEND], status: 'complete' },
      { id: 'imailer', component: 'mailer', implements: ['sender'], methods: [SEND], status: 'complete' },
      { id: 'itexter', component: 'texter', implements: ['sender'], methods: [SEND], status: 'complete' },
    ],
    implementations: [
      { id: 'mailer_impl', contract: 'imailer', methods: [{ name: 'send', narrative: [{ stepNumber: 1, type: 'local', description: 'Post it.' }] }], status: 'complete' },
    ],
  });
  setProjectRoot(root);
  invalidateSpecCache();
}

describe('status — an abstraction without an implementation of its own', () => {
  it('reads as realized by its implementers and scores as implemented; a concrete one stays Missing', () => {
    project();
    const text = getStatusReport().text;
    const lines = text.split('\n');
    const at = (id: string): number => lines.findIndex((l) => l.includes(`] ${id} (`));
    expect(lines[at('sender')]).toMatch(/\] sender \(100%\)/);
    expect(lines.slice(at('sender'), at('sender') + 3).join('\n')).toContain('Implementation: none of its own — an abstraction, realized by its implementers');
    expect(lines.slice(at('sender'), at('sender') + 3).join('\n')).not.toContain('Missing');
    expect(lines[at('texter')]).toMatch(/\] texter \(50%\)/);
    expect(lines.slice(at('texter'), at('texter') + 3).join('\n')).toContain('Implementation: Missing (-30%)');
  });

  it('the summary counts only implementations that exist', () => {
    project();
    const report = getStatusReport();
    const summary = summarizeStatus({ banner: '', family: '', network: '', report: report.text, verdict: '', externals: '', version: 'x', failed: report.failed === true });
    expect(summary).toMatch(/\[Subsystem\] notices[^:\n]*: 3 components, 3 interfaces, 1 implementations/);
  });
});
