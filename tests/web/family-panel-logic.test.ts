import { describe, it, expect } from 'vitest';
import {
  FAMILY_ACTIONS, driftNotices, emptyForm, externalTone, formArgs, formOptions, formProblem,
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
