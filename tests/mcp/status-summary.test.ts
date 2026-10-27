import { describe, it, expect } from 'vitest';
import { summarizeStatus, statusAnswer, fullStatus, type StatusPieces } from '../../src/mcp/status-summary.js';

const tree = [
  'project demo at /x',
  '',
  'Architecture Status Dashboard',
  '─────────────────────────────',
  '',
  '● System: Demo (90% Complete)',
  '├── [Subsystem] core (100%)',
  '│   ├── [Component: Store] a_store (100%)',
  '│   │   ├── Interface: ia_store (3 methods)',
  '│   │   └── Implementation: a_store_impl -> src/a.ts',
  '│   ├── [Component: Portal] a_portal (50%)',
  '│   │   ├── Interface: ia_portal (1 methods)',
  '│   │   └── Implementation: Missing (-30%)',
  '│   └── [Types] 4 types',
  '└── [Project] sched (scheduler)',
  '    └── [Subsystem] jobs (80%)',
  '        └── [Component: Actor] runner (80%)',
  '            └── Interface: Missing (-30%)',
  'Approval: this project is approved',
  '',
].join('\n');

const pieces = (over: Partial<StatusPieces> = {}): StatusPieces => ({
  banner: '⚠ TRANSACTION PENDING: x\n',
  family: 'Family: demo\n',
  network: 'Network: none declared\n',
  report: tree,
  verdict: 'ℹ  Approved: yesterday\n',
  externals: '\nExternals (compared live):\n- [EXTERNAL_DRIFTED] moved\n',
  version: '9.9.9',
  ...over,
});

describe('sdd_get_status summary', () => {
  const s = summarizeStatus(pieces());

  it('keeps the leads, the verdict, externals, network and the closing version', () => {
    expect(s.startsWith('⚠ TRANSACTION PENDING: x\nFamily: demo\n')).toBe(true);
    expect(s).toContain('Approval: this project is approved');
    expect(s).toContain('ℹ  Approved: yesterday');
    expect(s).toContain('[EXTERNAL_DRIFTED] moved');
    expect(s).toContain('Network: none declared');
    expect(s).toContain('detail: full');
    expect(s).toContain('sdd_search_specs');
    expect(s.trimEnd().endsWith('wairon 9.9.9')).toBe(true);
    expect(s.indexOf('Approval:')).toBeLessThan(s.indexOf('Externals'));
    expect(s.indexOf('Externals')).toBeLessThan(s.indexOf('Network:'));
  });

  it('counts per subsystem (members as projects) and drops the per-spec tree', () => {
    expect(s).toContain('[Subsystem] core (100%): 2 components, 2 interfaces, 1 implementations, 4 types');
    expect(s).toContain('[Project] sched (scheduler)');
    expect(s).toContain('[Subsystem] jobs (80%): 1 components, 0 interfaces, 0 implementations');
    expect(s).not.toContain('a_store');
    expect(s).not.toContain('Interface:');
  });

  it('counts findings by code', () => {
    const s2 = summarizeStatus(pieces({ report: tree.replace('Approval:', '[SOME_CODE] a\n[SOME_CODE] b\n[OTHER] c\nApproval:') }));
    expect(s2).toContain('Findings by code: SOME_CODE x2, OTHER x1');
  });

  it('is a small fraction of the full answer', () => {
    expect(s.length).toBeLessThan(fullStatus(pieces()).length);
  });

  it('never cuts a report that failed to load', () => {
    const failed = pieces({ report: 'Failed to parse specification files:\n[X] bad\n' });
    expect(summarizeStatus(failed)).toBe(fullStatus(failed));
  });

  it('full is the old text, in the old order', () => {
    const p = pieces();
    expect(statusAnswer('full', p)).toBe(`${p.banner}${p.family}${p.network}${p.report}${p.verdict}${p.externals}\nwairon 9.9.9\n`);
    expect(statusAnswer('summary', p)).toBe(s);
  });
});
