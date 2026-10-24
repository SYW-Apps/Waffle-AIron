/**
 * Type groups as a tree — src/core/rules/integrity/type-groups.ts.
 *
 * Documented intents pinned here (the rule's description):
 *  - TYPE_GROUP_UNKNOWN (error): a type names a group no group spec declares.
 *  - GROUP_PARENT_UNKNOWN (error): a group names a parent that does not exist.
 *  - GROUP_CYCLE (error): a group's parent chain leads back to the group.
 *  - GROUP_PARENT_CROSS_HOME (error): the parent exists but lives in another
 *    home (the shared types folder or one subsystem's) — a group and its
 *    parent share one home.
 *  - TYPE_GROUP_MISPLACED (warning): a group file outside its parent's folder,
 *    or a type file outside its group's folder; `wairon doctor --fix` moves it.
 *
 * The shape is a shared-contracts library: a few nested groups
 * (platform > runtime > vm) over many root-level types, no subsystem. Every
 * group and grouped type is written raw under .wai/specs/types, where the
 * loader finds it, so the folders say exactly what the scenario says.
 */
import { defineRuleFixture, type FixtureTree } from '../harness.js';

const STAMP = "'2026-01-01T00:00:00.000Z'";

/** One group document. */
function groupDoc(id: string, fields: Record<string, string> = {}): string {
  const extra = Object.entries(fields).map(([k, v]) => `${k}: ${v}\n`).join('');
  return `kind: group\nid: ${id}\nname: ${id}\n${extra}createdAt: ${STAMP}\nupdatedAt: ${STAMP}\n`;
}

/** One value-object type document, in a group when it names one. */
function typeDoc(id: string, group?: string): string {
  return [
    'kind: value-object',
    `id: ${id}`,
    `name: ${id}`,
    'description: A contract type of the shared runtime library.',
    ...(group ? [`group: ${group}`] : []),
    'fields:',
    '  - name: value',
    '    type: string',
    '    optional: false',
    'methods: []',
    `createdAt: ${STAMP}`,
    `updatedAt: ${STAMP}`,
    '',
  ].join('\n');
}

const TYPES = '.wai/specs/types';

/** The sound platform > runtime > vm tree with a type in the innermost group, every file where its chain names it. */
function soundFiles(): Record<string, string> {
  return {
    [`${TYPES}/platform/.index.yaml`]: groupDoc('platform'),
    [`${TYPES}/platform/runtime/.index.yaml`]: groupDoc('runtime', { parent: 'platform' }),
    [`${TYPES}/platform/runtime/vm/.index.yaml`]: groupDoc('vm', { parent: 'runtime' }),
    [`${TYPES}/platform/runtime/vm/heap-snapshot.yaml`]: typeDoc('heap-snapshot', 'vm'),
    [`${TYPES}/frame-header.yaml`]: typeDoc('frame-header'),
  };
}

const tree = (files: Record<string, string>): FixtureTree => ({ files });

/** The files without one path, plus extra files. */
function withoutKey(files: Record<string, string>, drop: string, add: Record<string, string>): Record<string, string> {
  const kept = Object.fromEntries(Object.entries(files).filter(([k]) => k !== drop));
  return { ...kept, ...add };
}

export default [
  // ---- TYPE_GROUP_UNKNOWN --------------------------------------------------
  defineRuleFixture({
    code: 'TYPE_GROUP_UNKNOWN',
    severity: 'error',
    anchoredTo: 'heap-snapshot',
    expectFire: true,
    scenario: 'The heap-snapshot contract type names the group "vm-state", a typo of the vm group no group spec declares.',
    tree: tree({
      ...soundFiles(),
      [`${TYPES}/platform/runtime/vm/heap-snapshot.yaml`]: typeDoc('heap-snapshot', 'vm-state'),
    }),
  }),
  defineRuleFixture({
    code: 'TYPE_GROUP_UNKNOWN',
    expectFire: false,
    reason: 'The group the type names is declared, three levels down the platform tree.',
    scenario: 'The heap-snapshot contract type names the vm group, which the platform > runtime > vm tree declares.',
    tree: tree(soundFiles()),
  }),

  // ---- GROUP_PARENT_UNKNOWN ------------------------------------------------
  defineRuleFixture({
    code: 'GROUP_PARENT_UNKNOWN',
    severity: 'error',
    anchoredTo: 'runtime',
    expectFire: true,
    scenario: 'The runtime group names the parent "platform-core", which no group spec declares.',
    tree: tree({
      ...soundFiles(),
      [`${TYPES}/platform/runtime/.index.yaml`]: groupDoc('runtime', { parent: 'platform-core' }),
    }),
  }),
  defineRuleFixture({
    code: 'GROUP_PARENT_UNKNOWN',
    expectFire: false,
    reason: 'A parent that exists is the sanctioned shape; a top-level group names none.',
    scenario: 'The runtime group names the platform group, which exists beside it.',
    tree: tree(soundFiles()),
  }),

  // ---- GROUP_CYCLE ---------------------------------------------------------
  defineRuleFixture({
    code: 'GROUP_CYCLE',
    severity: 'error',
    anchoredTo: 'platform',
    expectFire: true,
    scenario: 'After a bad merge the platform group names its own descendant vm as its parent, so the chain platform > runtime > vm > platform never ends.',
    tree: tree({
      ...soundFiles(),
      [`${TYPES}/platform/.index.yaml`]: groupDoc('platform', { parent: 'vm' }),
    }),
  }),
  defineRuleFixture({
    code: 'GROUP_CYCLE',
    expectFire: false,
    reason: 'The chain of every group ends at a top-level group.',
    scenario: 'The platform > runtime > vm chain ends at the top-level platform group.',
    tree: tree(soundFiles()),
  }),

  // ---- GROUP_PARENT_CROSS_HOME ---------------------------------------------
  defineRuleFixture({
    code: 'GROUP_PARENT_CROSS_HOME',
    severity: 'error',
    anchoredTo: 'runtime',
    expectFire: true,
    scenario: 'The runtime group is homed in the vm-runtime subsystem while its parent platform lives in the shared types folder.',
    tree: {
      subsystems: [{ id: 'vm-runtime', description: 'The virtual machine runtime of the shared contracts library.' }],
      files: {
        ...soundFiles(),
        [`${TYPES}/platform/runtime/.index.yaml`]: groupDoc('runtime', { parent: 'platform', subsystem: 'vm-runtime' }),
      },
    },
  }),
  defineRuleFixture({
    code: 'GROUP_PARENT_CROSS_HOME',
    expectFire: false,
    reason: 'A group and its parent share one home, here the shared types folder.',
    scenario: 'The runtime group and its platform parent both live in the shared types folder.',
    tree: {
      subsystems: [{ id: 'vm-runtime', description: 'The virtual machine runtime of the shared contracts library.' }],
      files: soundFiles(),
    },
  }),

  // ---- TYPE_GROUP_MISPLACED ------------------------------------------------
  defineRuleFixture({
    code: 'TYPE_GROUP_MISPLACED',
    severity: 'warning',
    anchoredTo: 'heap-snapshot',
    expectFire: true,
    scenario: 'The heap-snapshot type names the vm group but its file was left at the top of the types folder when the groups were reorganized.',
    tree: tree(withoutKey(soundFiles(), `${TYPES}/platform/runtime/vm/heap-snapshot.yaml`, { [`${TYPES}/heap-snapshot.yaml`]: typeDoc('heap-snapshot', 'vm') })),
  }),
  defineRuleFixture({
    code: 'TYPE_GROUP_MISPLACED',
    severity: 'warning',
    anchoredTo: 'runtime',
    expectFire: true,
    scenario: 'The runtime group names platform as its parent but its folder sits at the top of the types folder, outside the platform folder.',
    tree: tree({
      [`${TYPES}/platform/.index.yaml`]: groupDoc('platform'),
      [`${TYPES}/runtime/.index.yaml`]: groupDoc('runtime', { parent: 'platform' }),
      [`${TYPES}/frame-header.yaml`]: typeDoc('frame-header'),
    }),
  }),
  defineRuleFixture({
    code: 'TYPE_GROUP_MISPLACED',
    expectFire: false,
    reason: 'Every group folder sits inside its parent folder and every grouped type beside its group index.',
    scenario: 'The platform > runtime > vm folders mirror the parent chain and the heap-snapshot type sits beside the vm group index.',
    tree: tree(soundFiles()),
  }),
];
