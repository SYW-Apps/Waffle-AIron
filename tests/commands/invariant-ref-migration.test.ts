import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { writeSpecFile } from '../../src/core/spec-files.js';
import { ComponentSpecSchema, ImplementationSpecSchema, InterfaceSpecSchema, TypeSpecSchema } from '../../src/models/index.js';
import { validateProject } from '../../src/core/validation.js';
import { plan } from '../../src/migrations/chaining-migration.js';
import { apply } from '../helpers/chaining-transaction.js';
import { buildImportFamily, type ImportFamily } from '../helpers/reference-family.js';

// ---------------------------------------------------------------------------
// An asserted invariant written with the project's OWN alias as its qualifier
// (`app::ledger.balanced`, written inside app in the parent's key form): the
// chaining migration rewrites it like every other raw type position, and the
// finding a leftover one raises names the qualifier as the cause instead of
// claiming that no entity declares the invariant.
// ---------------------------------------------------------------------------

const STAMP = '2026-10-05T00:00:00.000Z';
const specs = (dir: string, ...parts: string[]): string => path.join(dir, '.wai', 'specs', ...parts);

function at<T>(dir: string, fn: () => T): T {
  invalidateSpecCache();
  setProjectRoot(dir);
  return fn();
}

/** app gains an entity with an invariant, and a Store whose write asserts it through app's own alias. */
function withSelfQualifiedInvariant(f: ImportFamily): string {
  writeSpecFile(specs(f.app, 'types', 'ledger.yaml'), TypeSpecSchema.parse({
    kind: 'entity', id: 'ledger', name: 'ledger', description: 'A ledger', subsystem: 'screens', componentClass: 'ledger_store',
    fields: [{ name: 'total', type: 'int', description: 'The total', optional: false }],
    invariants: [{ id: 'balanced', description: 'Debits equal credits' }],
    methods: [], createdAt: STAMP, updatedAt: STAMP,
  }));
  writeSpecFile(specs(f.app, 'screens', 'ledger_store', '.index.yaml'), ComponentSpecSchema.parse({
    id: 'ledger_store', name: 'ledger_store', description: 'Holds ledgers', subsystem: 'screens', componentType: 'Store',
    owns: [], dependsOn: [], status: 'complete', createdAt: STAMP, updatedAt: STAMP,
  }));
  writeSpecFile(specs(f.app, 'screens', 'ledger_store', '.interface.yaml'), InterfaceSpecSchema.parse({
    id: 'iledger_store', name: 'iledger_store', description: 'The ledger contract', component: 'ledger_store',
    methods: [{ name: 'save', description: 'Save a ledger', params: [{ name: 'ledger', type: 'ledger' }], returns: 'void', effect: 'write' }],
    status: 'complete', createdAt: STAMP, updatedAt: STAMP,
  }));
  const file = specs(f.app, 'screens', 'ledger_store', '.implementation.yaml');
  writeSpecFile(file, ImplementationSpecSchema.parse({
    id: 'ledger_store_impl', name: 'ledger_store_impl', description: 'Saves ledgers', contract: 'iledger_store',
    methods: [{ name: 'save', narrative: [{ stepNumber: 1, type: 'local', description: 'Write it', assertsInvariants: ['app::ledger.balanced'] }] }],
    status: 'complete', createdAt: STAMP, updatedAt: STAMP,
  }));
  return file;
}

describe('a self-qualified invariant reference', () => {
  let family: ImportFamily | null = null;
  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    family?.cleanup();
    family = null;
  });

  it('is named as a qualifier problem, not as an invariant nobody declares', () => {
    family = buildImportFamily();
    withSelfQualifiedInvariant(family);
    const found = at(family.app, () => validateProject()).issues.filter((i) => i.code === 'UNKNOWN_INVARIANT_REF');
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('qualifier "app::"');
    expect(found[0].message).toContain('write "ledger.balanced"');
    expect(found[0].message).not.toContain('no entity declares it');
  });

  it('is rewritten by the chaining migration to the bare local reference', () => {
    family = buildImportFamily();
    const file = withSelfQualifiedInvariant(family);
    const f = family;
    const planned = at(f.top, () => plan());
    const rewrite = planned.rewrites.find((r) => r.from === 'app::ledger');
    expect(rewrite).toMatchObject({ project: 'app', position: 'type', to: 'ledger' });
    at(f.top, () => apply(planned));
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('ledger.balanced');
    expect(text).not.toContain('app::ledger.balanced');
    expect(at(f.app, () => validateProject()).issues.filter((i) => i.code === 'UNKNOWN_INVARIANT_REF')).toEqual([]);
  });
});
