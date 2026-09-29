import { describe, it, expect } from 'vitest';
import { declaredExternals, declaredMembers, ProjectConfigSchema } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// Stage 3: project_config.declaredMembers — a project's `members`, in either
// form, normalized; and the alias both `members` and `externals` claim.
// ---------------------------------------------------------------------------

const TS = '2026-01-01T00:00:00.000Z';
const config = (extra: Record<string, unknown>) => ProjectConfigSchema.parse({ name: 'Waffly', createdAt: TS, updatedAt: TS, ...extra });

describe('project_config.declaredMembers', () => {
  it('reads the shorthand as { path } and the long form as written, in declaration order', () => {
    expect(declaredMembers(config({
      members: {
        billing: 'services/billing',
        ledger: { path: 'services/ledger', description: 'The ledger of record' },
      },
    }))).toEqual([
      { alias: 'billing', path: 'services/billing', use: [] },
      { alias: 'ledger', path: 'services/ledger', description: 'The ledger of record', use: [] },
    ]);
  });

  it('is empty when nothing is declared', () => {
    expect(declaredMembers(config({}))).toEqual([]);
  });

  it('records a malformed alias, an empty or absolute path and an alias externals also declares, never dropping one', () => {
    const members = declaredMembers(config({
      members: {
        'Billing.Svc': 'services/billing',
        empty: '',
        rooted: '/srv/rooted',
        drive: 'C:\\srv\\drive',
        shared: 'shared',
      },
      externals: { shared: {} },
    }));
    expect(members.map((m) => m.alias)).toEqual(['Billing.Svc', 'empty', 'rooted', 'drive', 'shared']);
    expect(members.map((m) => m.problem ?? '')).toEqual([
      expect.stringContaining('breaks [a-z0-9-_]+'),
      expect.stringContaining('empty path'),
      expect.stringContaining('absolute path'),
      expect.stringContaining('absolute path'),
      expect.stringContaining('also declared under `externals`'),
    ]);
  });

  it('marks the external side of a shared alias too — one alias names one project', () => {
    const externals = declaredExternals(config({ members: { shared: 'shared' }, externals: { shared: {}, crm: {} } }));
    expect(externals.map((e) => [e.alias, e.problem ?? ''])).toEqual([
      ['shared', expect.stringContaining('also declared under `members`')],
      ['crm', ''],
    ]);
  });
});
