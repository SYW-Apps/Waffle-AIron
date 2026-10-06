import { it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { buildCanvasDataModel } from '../../src/core/index.js';
import { exportSurface } from '../../src/core/surface-portal.js';
import { writeSpecFile } from '../../src/core/spec-files.js';
import { ComponentSpecSchema, InterfaceSpecSchema, SubsystemSpecSchema, SystemSpecSchema } from '../../src/models/index.js';
import { buildReferenceFamily, type ReferenceFamily } from '../helpers/reference-family.js';

// ---------------------------------------------------------------------------
// Probe P3 (stage 3): `billing::billing` stays an honest id — only the display
// collapses it. A member `billing` whose own subsystem and portal are both
// `billing` must never put the doubled key into a display name: the canvas
// labels (the share snapshot's primary payload), and the OpenAPI documents'
// titles, tags and operation ids (the share snapshot's API set), read from the
// top root and from the member's own root.
// ---------------------------------------------------------------------------

let family: ReferenceFamily | undefined;
afterEach(() => { setProjectRoot(null); invalidateSpecCache(); family?.cleanup(); family = undefined; });

const STAMP = '2026-09-27T00:00:00.000Z';

it('a doubled member id never reaches a canvas label or an OpenAPI name', () => {
  family = buildReferenceFamily();
  // A member `billing` whose own subsystem is `billing`, publishing an HTTP portal `billing`.
  const billing = path.join(family.top, 'billing');
  fs.mkdirSync(path.join(billing, '.wai'), { recursive: true });
  fs.writeFileSync(path.join(billing, '.wai', 'project.yaml'), `schemaVersion: 1.0.0\nid: billing\nname: Billing\ntargets: []\ncreatedAt: '${STAMP}'\nupdatedAt: '${STAMP}'\n`);
  const cfg = path.join(family.top, '.wai', 'project.yaml');
  fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replace('members:\n', 'members:\n  billing: billing\n'));
  const s = (...p: string[]) => path.join(billing, '.wai', 'specs', ...p);
  writeSpecFile(s('.index.yaml'), SystemSpecSchema.parse({ schemaVersion: '1.0.0', name: 'Billing', vision: 'v', boundaries: [], globalRequirements: [],
    publicInterfaces: [{ from: 'billing', component: 'billing', audience: 'project' }], createdAt: STAMP, updatedAt: STAMP }));
  writeSpecFile(s('billing', '.index.yaml'), SubsystemSpecSchema.parse({ id: 'billing', name: 'billing', description: 'd', parentSystem: 'Billing',
    publicInterfaces: [{ type: 'REST', details: 'billing api', component: 'billing' }], trustedLinks: [], status: 'complete', createdAt: STAMP, updatedAt: STAMP }));
  writeSpecFile(s('billing', 'billing', '.index.yaml'), ComponentSpecSchema.parse({ id: 'billing', name: 'billing', description: 'd', subsystem: 'billing',
    componentType: 'Portal', transport: 'HTTP', owns: [], dependsOn: [], status: 'complete', createdAt: STAMP, updatedAt: STAMP }));
  writeSpecFile(s('billing', 'billing', '.interface.yaml'), InterfaceSpecSchema.parse({ id: 'ibilling', name: 'ibilling', description: 'd', component: 'billing',
    methods: [{ name: 'charge', description: 'd', signature: 'charge(): void', returns: 'void', endpoint: { transport: 'HTTP', method: 'POST', path: '/charge' } }],
    status: 'complete', createdAt: STAMP, updatedAt: STAMP }));

  for (const root of [family.top, billing]) {
    setProjectRoot(root); invalidateSpecCache();
    const canvas = buildCanvasDataModel();
    const labels = [...canvas.subsystems, ...canvas.components].map((n) => n.name);
    expect(labels.filter((l) => l.includes('::'))).toEqual([]);
    // The ids stay honest.
    if (root === family.top) expect(canvas.components.map((c) => c.id)).toContain('billing::billing');
    for (const spec of exportSurface('project', 'openapi').renderedSet ?? []) {
      expect(spec.name).not.toContain('::');
      const doc = JSON.parse(spec.document) as { info: { title: string }; paths: Record<string, Record<string, { tags: string[]; operationId: string }>> };
      expect(doc.info.title).not.toContain('::');
      for (const op of Object.values(doc.paths).flatMap((p) => Object.values(p))) {
        expect(op.operationId).toBe('charge');
        expect(op.tags.join()).not.toContain('::');
      }
    }
  }
});
