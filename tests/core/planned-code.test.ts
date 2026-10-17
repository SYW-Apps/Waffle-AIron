import { describe, it, expect } from 'vitest';
import { defineRuleFixture, runRuleFixture, type FixtureTree } from '../rules-matrix/harness.js';
import { isCiDraftWaivable } from '../../src/commands/validate.js';

// ---------------------------------------------------------------------------
// Planned code is a notice (docs/design/linkage-and-drift.md D5): a freshly
// designed tree that names its planned files — implementation, method and
// harness — but has written none of them yet must pass `validate --ci`. Under
// rules.conformance.requireCode the same tree fails, naming the setting.
// ---------------------------------------------------------------------------

/** A design-only shipping tree: the planned files are named, none is written. */
function designOnly(rules?: FixtureTree['rules']): FixtureTree {
  return {
    ...(rules ? { rules } : {}),
    subsystems: [{ id: 'shipping', description: 'Carrier selection and label printing for packed orders.' }],
    components: [
      {
        id: 'label-printer',
        componentType: 'Orchestrator',
        subsystem: 'shipping',
        description: 'Prints the carrier label for a packed parcel.',
      },
    ],
    interfaces: [
      {
        id: 'ilabel_printer',
        component: 'label-printer',
        methods: [
          { name: 'printLabel', description: 'Print the carrier label for one packed parcel.', invokedBy: { kind: 'runtime', caller: 'the packing station terminal when a parcel is sealed' }, params: [{ name: 'label', type: 'ParcelLabel' }] },
          { name: 'reprintLabel', description: 'Print a damaged label again for the same parcel.', invokedBy: { kind: 'runtime', caller: 'the packing station terminal when a parcel is sealed' }, params: [{ name: 'label', type: 'ParcelLabel' }] },
        ],
      },
    ],
    implementations: [
      {
        id: 'label_printer_impl',
        contract: 'ilabel_printer',
        sourcePath: 'src/shipping/label-printer.ts',
        simPath: 'tests/sim/label-printer.sim.ts',
        methods: [
          { name: 'printLabel', narrative: [{ stepNumber: 1, type: 'local', description: 'Render the label for the parcel and send it to the printer.' }] },
          { name: 'reprintLabel', sourcePath: 'src/shipping/reprint-label.ts', narrative: [{ stepNumber: 1, type: 'local', description: 'Render the stored label again and send it to the printer.' }] },
        ],
      },
    ],
    types: [{ id: 'parcel-label', name: 'ParcelLabel', subsystem: 'shipping', sourcePath: 'src/shipping/parcel-label.ts', fields: [{ name: 'id', type: 'string', key: 'primary' }] }],
    files: {},
  } as FixtureTree;
}

const LINKAGE_CODES = new Set(['MISSING_SOURCE_PATH', 'SOURCE_FILE_PLANNED', 'MISSING_SOURCE_FILE', 'METHOD_SOURCE_PATH_MISSING', 'SIM_FILE_MISSING', 'MISSING_INTEGRATION_SIM']);

function run(tree: FixtureTree) {
  return runRuleFixture(defineRuleFixture({
    code: 'SOURCE_FILE_PLANNED',
    expectFire: true,
    scenario: 'A shipping label printer designed and approved before any of its code was written.',
    tree,
  }));
}

describe('a design-only tree', () => {
  it('reports its planned files as notices and nothing about them fails --ci', () => {
    const { issues } = run(designOnly());
    const planned = issues.filter((i) => i.code === 'SOURCE_FILE_PLANNED');
    // The implementation's file, the method's, the harness and the type's.
    expect(planned.map((i) => i.message).join('\n')).toContain('src/shipping/label-printer.ts');
    expect(planned.map((i) => i.message).join('\n')).toContain('src/shipping/reprint-label.ts');
    expect(planned.map((i) => i.message).join('\n')).toContain('tests/sim/label-printer.sim.ts');
    expect(planned.map((i) => i.message).join('\n')).toContain('src/shipping/parcel-label.ts');
    expect(planned.every((i) => i.severity === 'notice')).toBe(true);
    // Nothing a linkage rule says is an error or a warning: before this change
    // the planned files were MISSING_SOURCE_FILE errors and SIM_FILE_MISSING warnings.
    const failing = issues.filter((i) => LINKAGE_CODES.has(i.code) && i.severity !== 'notice');
    expect(failing, failing.map((i) => `${i.severity} ${i.code}: ${i.message}`).join('\n')).toEqual([]);
    // And the whole run would pass `validate --ci`: no error, no warning --ci does not waive.
    const ciFailing = issues.filter((i) => i.severity === 'error' || (i.severity === 'warning' && !isCiDraftWaivable(i)));
    expect(ciFailing, ciFailing.map((i) => `${i.severity} ${i.code}: ${i.message}`).join('\n')).toEqual([]);
  });

  it('fails under rules.conformance.requireCode, naming the setting', () => {
    const { issues } = run(designOnly({ conformance: { requireCode: true } }));
    const planned = issues.filter((i) => i.code === 'SOURCE_FILE_PLANNED');
    expect(planned.length).toBeGreaterThan(0);
    expect(planned.every((i) => i.severity === 'error')).toBe(true);
    expect(planned[0].message).toContain('rules.conformance.requireCode');
  });
});
