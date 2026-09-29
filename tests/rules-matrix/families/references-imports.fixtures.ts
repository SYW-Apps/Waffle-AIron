/**
 * Declared imports (stage 4): a project may name another project's public
 * names bare once it imports them — `members: { shared: { path, use: [...] } }`
 * or `externals: { shared: { use: [...] } }` — owner-scoped and explicit, with
 * no family-wide matching.
 *
 * Rules pinned here:
 *  - project-boundaries: IMPORT_AMBIGUOUS — two imports supply one bare name
 *    (two `*`, or two explicit names); an explicit name beats a `*`.
 *  - external-declarations: IMPORT_UNRESOLVED — a named `use` entry the
 *    producer does not export; IMPORT_SHADOWED_BY_LOCAL — a named import a
 *    spec of the importing project hides (a hidden `*` is silent).
 *
 * The tree: the Waffly root owns a `report` type whose field names
 * `WafflerError` bare; its members shared and ui each export a type keyed
 * `waffler-error` (nameKey: `WafflerError` = `waffler-error` = `waffler_error`).
 */
import * as yaml from 'js-yaml';
import { defineRuleFixture, type FixtureTree } from '../harness.js';

const TS = '2026-01-01T00:00:00.000Z';

function dump(spec: Record<string, unknown>): string {
  return yaml.dump({ schemaVersion: '1.0.0', createdAt: TS, updatedAt: TS, ...spec }, { noRefs: true, lineWidth: 200 });
}

function member(dir: string, id: string, typeId: string): Record<string, string> {
  return {
    [`${dir}/.wai/project.yaml`]: dump({ id, name: id, targets: [], extensions: { packs: [], useGlobalPacks: false } }),
    [`${dir}/.wai/specs/.index.yaml`]: dump({
      name: `${id}-vocabulary`, vision: `The ${id} error vocabulary every consumer speaks.`,
      publicInterfaces: [{ typeDef: typeId, audience: 'project' }],
    }),
    [`${dir}/.wai/specs/types/${typeId}.yaml`]: dump({
      kind: 'value-object', id: typeId, name: typeId, description: 'An error a waffle machine reports.',
      fields: [{ name: 'message', type: 'string', description: 'What went wrong.', optional: false }], methods: [],
    }),
  };
}

interface Options {
  shared?: string[];
  ui?: string[];
  /** A type of the root's own keyed like the imported name. */
  localError?: boolean;
}

function waffly(o: Options): FixtureTree {
  const decl = (path: string, use?: string[]) => (use ? { path, use } : path);
  return {
    system: { name: 'Waffly', vision: 'Waffle machines, their reports and their errors.' },
    subsystems: [{ id: 'reporting', description: 'Machine reports for the operators.' }],
    types: [
      { id: 'machine-report', kind: 'value-object', subsystem: 'reporting', description: 'One machine\'s end-of-shift report.', fields: [{ name: 'failure', type: 'WafflerError', description: 'The failure the shift ended on.', optional: false }] },
      ...(o.localError ? [{ id: 'waffler-error', kind: 'value-object', subsystem: 'reporting', description: 'The root\'s own error record.', fields: [{ name: 'code', type: 'number', description: 'The error code.', optional: false }] }] : []),
    ],
    files: {
      '.wai/project.yaml': dump({
        id: 'waffly', name: 'Waffly', targets: [], extensions: { packs: [], useGlobalPacks: false },
        members: { shared: decl('packages/shared', o.shared), ui: decl('packages/ui', o.ui) },
      }),
      ...member('packages/shared', 'shared', 'waffler-error'),
      ...member('packages/ui', 'ui', 'waffler_error'),
    },
  };
}

export default [
  // -------------------------------------------------------------------------
  // IMPORT_AMBIGUOUS
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'IMPORT_AMBIGUOUS',
    severity: 'error',
    anchoredTo: 'machine-report',
    expectFire: true,
    scenario: 'The Waffly root imports every name of both shared and ui with `*`, and both export a type keyed waffler-error, so the bare `WafflerError` in the machine report could mean either.',
    tree: waffly({ shared: ['*'], ui: ['*'] }),
  }),
  defineRuleFixture({
    code: 'IMPORT_AMBIGUOUS',
    severity: 'error',
    anchoredTo: 'machine-report',
    expectFire: true,
    scenario: 'The Waffly root names waffler-error in the `use` of shared AND waffler_error in the `use` of ui — two explicit imports of one bare name.',
    tree: waffly({ shared: ['waffler-error'], ui: ['waffler_error'] }),
  }),
  defineRuleFixture({
    code: 'IMPORT_AMBIGUOUS',
    expectFire: false,
    reason: 'An explicit name beats a `*`: shared imports waffler-error by name, so ui\'s glob does not compete for it.',
    scenario: 'The Waffly root imports waffler-error from shared by name and everything from ui with `*`.',
    tree: waffly({ shared: ['waffler-error'], ui: ['*'] }),
  }),

  // -------------------------------------------------------------------------
  // IMPORT_UNRESOLVED
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'IMPORT_UNRESOLVED',
    severity: 'error',
    anchoredTo: null,
    expectFire: true,
    scenario: 'The Waffly root imports `waffle-error` from shared — a misspelling of the one name shared exports.',
    tree: waffly({ shared: ['waffle-error'] }),
  }),
  defineRuleFixture({
    code: 'IMPORT_UNRESOLVED',
    expectFire: false,
    reason: 'Shared exports waffler-error to its family, so the named import resolves.',
    scenario: 'The Waffly root imports waffler-error from shared, which exports it at audience project.',
    tree: waffly({ shared: ['waffler-error'] }),
  }),

  // -------------------------------------------------------------------------
  // IMPORT_SHADOWED_BY_LOCAL
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'IMPORT_SHADOWED_BY_LOCAL',
    severity: 'error',
    anchoredTo: null,
    expectFire: true,
    scenario: 'The Waffly root imports waffler-error from shared by name, but owns a waffler-error type itself, so every bare reference binds its own and the import never takes effect.',
    tree: waffly({ shared: ['waffler-error'], localError: true }),
  }),
  defineRuleFixture({
    code: 'IMPORT_SHADOWED_BY_LOCAL',
    expectFire: false,
    reason: 'A glob import shadowed by a local spec is silent, as in Rust: `*` names nothing in particular.',
    scenario: 'The Waffly root owns a waffler-error type and imports everything shared exports with `*`.',
    tree: waffly({ shared: ['*'], localError: true }),
  }),
];
