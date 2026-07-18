import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import {
  saveSubsystemSpec,
  saveComponentSpec,
  saveInterfaceSpec,
  saveImplementationSpec,
  saveTypeSpec,
  getTypePath,
  updateSpec,
  invalidateSpecCache,
} from '../../src/core/specs.js';

// ---------------------------------------------------------------------------
// Placement notices: the flat legacy layout records subsystem ownership as a
// FIELD while files stay in the shared directories, and a re-save never
// relocates an existing file. Both are by design — the save paths now SAY so
// (returned notices, surfaced through the sdd_* tool responses) instead of
// silently reading as "the parameter was ignored". Placement behavior itself
// is deliberately unchanged.
// ---------------------------------------------------------------------------

const now = new Date().toISOString();
const stamp = `createdAt: '${now}'\nupdatedAt: '${now}'`;

const typeSpec = (over: Record<string, unknown> = {}) => ({
  kind: 'entity' as const,
  id: 'invoice',
  name: 'Invoice',
  description: 'd',
  subsystem: 'billing',
  fields: [],
  methods: [],
  createdAt: now,
  updatedAt: now,
  ...over,
});

let proj: string;
afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  if (proj) fs.rmSync(proj, { recursive: true, force: true });
});

function flatProject(subsystems: string[] = ['billing']): void {
  proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-placement-flat-'));
  const specs = path.join(proj, '.wai', 'specs');
  for (const d of ['subsystems', 'components', 'interfaces', 'implementations', 'types']) {
    fs.mkdirSync(path.join(specs, d), { recursive: true });
  }
  for (const id of subsystems) {
    fs.writeFileSync(
      path.join(specs, 'subsystems', `${id}.yaml`),
      `schemaVersion: 1.0.0\nid: ${id}\nname: ${id}\ndescription: d\nparentSystem: T\n${stamp}\n`,
    );
  }
  setProjectRoot(proj);
  invalidateSpecCache();
}

function nestedProject(): void {
  proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-placement-nested-'));
  fs.mkdirSync(path.join(proj, '.wai', 'specs'), { recursive: true });
  setProjectRoot(proj);
  invalidateSpecCache();
  saveSubsystemSpec({
    id: 'billing', name: 'Billing', description: 'd', parentSystem: 'T',
    publicInterfaces: [], trustedLinks: [], status: 'draft', createdAt: now, updatedAt: now,
  });
}

describe('type placement notices', () => {
  it('flat layout: subsystem param takes effect as a FIELD, file lands in shared types/, and a NOTICE says so', () => {
    flatProject();
    const notices = saveTypeSpec(typeSpec());
    expect(notices.some(n => n.includes('flat layout'))).toBe(true);
    expect(notices.some(n => n.includes('ownership is the field, not the folder'))).toBe(true);

    const p = getTypePath('invoice').replace(/\\/g, '/');
    expect(p).toContain('.wai/specs/types/invoice.yaml');
    expect(fs.readFileSync(getTypePath('invoice'), 'utf8')).toContain('subsystem: billing');
  });

  it('nested layout: the file lands in the subsystem folder and no notice fires', () => {
    nestedProject();
    const notices = saveTypeSpec(typeSpec());
    expect(notices).toEqual([]);
    const p = getTypePath('invoice').replace(/\\/g, '/');
    expect(p).toContain('billing/types/invoice.yaml');
  });

  it('re-saving with a different subsystem never relocates: NOTICE says the field updated in place', () => {
    flatProject(['billing', 'ops']);
    saveTypeSpec(typeSpec());
    const before = getTypePath('invoice');

    const notices = saveTypeSpec(typeSpec({ subsystem: 'ops' }));
    expect(notices.some(n => n.includes('never relocates'))).toBe(true);
    expect(notices.some(n => n.includes('"ops"') && n.includes('"billing"'))).toBe(true);

    expect(getTypePath('invoice')).toBe(before);
    expect(fs.readFileSync(before, 'utf8')).toContain('subsystem: ops');
  });

  it('re-saving with an unchanged subsystem stays silent', () => {
    flatProject();
    saveTypeSpec(typeSpec());
    expect(saveTypeSpec(typeSpec())).toEqual([]);
  });

  it('sdd_update_spec bubbles the save notices', () => {
    flatProject(['billing', 'ops']);
    saveTypeSpec(typeSpec());
    const notices = updateSpec('type', 'invoice', { subsystem: 'ops' });
    expect(notices.some(n => n.includes('never relocates'))).toBe(true);
  });
});

describe('component / interface / implementation parent-change notices', () => {
  it('flat layout: a component subsystem change updates the field in place with a NOTICE', () => {
    flatProject(['billing', 'ops']);
    const specs = path.join(proj, '.wai', 'specs');
    fs.writeFileSync(
      path.join(specs, 'components', 'widget.yaml'),
      `schemaVersion: 1.0.0\nid: widget\nname: W\ndescription: d\nsubsystem: billing\ncomponentType: Specialist\nowns: []\ndependsOn: []\n${stamp}\n`,
    );
    invalidateSpecCache();

    const notices = saveComponentSpec({
      id: 'widget', name: 'W', description: 'd', subsystem: 'ops', componentType: 'Specialist',
      owns: [], dependsOn: [], status: 'draft', createdAt: now, updatedAt: now,
    });
    expect(notices.some(n => n.includes('never relocates'))).toBe(true);
    const file = path.join(specs, 'components', 'widget.yaml');
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toContain('subsystem: ops');
  });

  it('an interface component rebinding notes the file never moves', () => {
    flatProject();
    const specs = path.join(proj, '.wai', 'specs');
    fs.writeFileSync(
      path.join(specs, 'interfaces', 'iwidget.yaml'),
      `schemaVersion: 1.0.0\nid: iwidget\nname: IW\ndescription: d\ncomponent: widget\nmethods: []\n${stamp}\n`,
    );
    invalidateSpecCache();

    const notices = saveInterfaceSpec({
      id: 'iwidget', name: 'IW', description: 'd', component: 'gadget',
      methods: [], status: 'draft', createdAt: now, updatedAt: now,
    });
    expect(notices.some(n => n.includes('never moves') && n.includes('"gadget"') && n.includes('"widget"'))).toBe(true);
  });

  it('an implementation contract rebinding notes the file never moves', () => {
    flatProject();
    const specs = path.join(proj, '.wai', 'specs');
    fs.writeFileSync(
      path.join(specs, 'implementations', 'widget-impl.yaml'),
      `schemaVersion: 1.0.0\nid: widget-impl\nname: WI\ndescription: d\ncontract: iwidget\nmethods: []\n${stamp}\n`,
    );
    invalidateSpecCache();

    const notices = saveImplementationSpec({
      id: 'widget-impl', name: 'WI', description: 'd', contract: 'igadget',
      methods: [], status: 'draft', createdAt: now, updatedAt: now,
    });
    expect(notices.some(n => n.includes('never moves') && n.includes('"igadget"'))).toBe(true);
  });

  it('unchanged parents stay silent everywhere', () => {
    flatProject();
    const specs = path.join(proj, '.wai', 'specs');
    fs.writeFileSync(
      path.join(specs, 'components', 'widget.yaml'),
      `schemaVersion: 1.0.0\nid: widget\nname: W\ndescription: d\nsubsystem: billing\ncomponentType: Specialist\nowns: []\ndependsOn: []\n${stamp}\n`,
    );
    invalidateSpecCache();
    const notices = saveComponentSpec({
      id: 'widget', name: 'W', description: 'renamed only', subsystem: 'billing', componentType: 'Specialist',
      owns: [], dependsOn: [], status: 'draft', createdAt: now, updatedAt: now,
    });
    expect(notices).toEqual([]);
  });
});
