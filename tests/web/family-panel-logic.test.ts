import { describe, it, expect } from 'vitest';
import {
  FAMILY_ACTIONS, driftNotices, emptyForm, externalTone, formArgs, formOptions, formProblem, memberRows,
} from '../../web/src/views/familyPanelLogic.js';

const ext = (o: object) => ({ alias: 'a', project: 'p', sourceKind: 'path', pinned: true, reachable: true, stale: false, uses: [], ...o }) as any;

describe('family panel logic', () => {
  it('validates required args and leading dashes', () => {
    const def = FAMILY_ACTIONS['member-add'];
    const f = emptyForm(def);
    expect(formProblem(def, f)).toMatch(/required/);
    f.args.alias = 'x'; f.args.source = '-evil';
    expect(formProblem(def, f)).toMatch(/must not start/);
    f.args.source = '../x';
    expect(formProblem(def, f)).toBeUndefined();
    f.options.description = '-d';
    expect(formProblem(def, f)).toMatch(/must not start/);
  });
  it('drops a blank optional arg and sends flags as true', () => {
    const pin = FAMILY_ACTIONS['externals-pin'];
    expect(formArgs(pin, emptyForm(pin))).toEqual([]);
    expect(formArgs(pin, emptyForm(pin, { alias: 'a' }))).toEqual(['a']);
    const add = FAMILY_ACTIONS['member-add'];
    const f = emptyForm(add); f.options.project = 'true'; f.options.description = ' hi ';
    expect(formOptions(add, f)).toEqual({ project: 'true', description: 'hi' });
  });
  it('derives member rows: projects top-level only, parts grouped by alias', () => {
    const rows = memberRows([
      { id: 'admin', name: 'admin', project: true, storage: '../admin' },
      { id: 'admin::x', project: true },
      { id: 'ext', project: true, external: true },
      { id: 's1', name: 'S1', storage: 'part sched · services/sched' },
      { id: 's2', name: 'S2', storage: 'part sched · services/sched' },
      { id: 'plain', name: 'Plain' },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ kind: 'part', alias: 'sched', storage: 'services/sched', subsystems: ['S1', 'S2'] });
  });
  it('flags drifted, stale and changed externals', () => {
    expect(externalTone(ext({}))).toMatchObject({ label: 'current' });
    const n = driftNotices([
      ext({ alias: 'ok' }),
      ext({ alias: 'd', drifted: true }),
      ext({ alias: 'c', uses: [{ state: 'changed', publicName: 'api', detail: 'sig' }] }),
    ]);
    expect(n.map((x) => x.alias)).toEqual(['d', 'c']);
    expect(n[1].reasons[0]).toContain('api changed - sig');
  });
});
