import type { ExternalStatus } from '../types';

/**
 * Pure helpers of the family panel: the action table (mirrors the server's POST /web/dev/family shapes),
 * form validation, the member row shape, and the drift notices.
 */

export type FamilyActionId =
  | 'externals-pin'
  | 'externals-status'
  | 'network-declare'
  | 'network-undeclare'
  | 'member-add'
  | 'member-update'
  | 'member-move'
  | 'member-attach'
  | 'member-detach'
  | 'member-adopt'
  | 'member-rename-alias'
  | 'member-internalize'
  | 'member-promote'
  | 'member-demote';

export interface FamilyArg {
  name: string;
  label: string;
  optional?: boolean;
  placeholder?: string;
}

export interface FamilyOption {
  name: string;
  label: string;
  kind: 'flag' | 'value' | 'choice';
  choices?: string[];
  hint?: string;
}

export interface FamilyActionDef {
  id: FamilyActionId;
  label: string;
  /** What the action does, in plain words. */
  text: string;
  args: FamilyArg[];
  options: FamilyOption[];
  /** True when the CLI can show a plan without writing (report). */
  preview: boolean;
  /** True when the action writes nothing and so needs no confirmation. */
  readOnly?: boolean;
}

const packs: FamilyOption = {
  name: 'packs',
  label: 'Extension packs',
  kind: 'choice',
  choices: ['adopt', 'drop'],
  hint: 'What happens to the packs the member brought. Leave empty to decide later.',
};

export const FAMILY_ACTIONS: Record<FamilyActionId, FamilyActionDef> = {
  'externals-pin': {
    id: 'externals-pin',
    label: 'Pin',
    text: "Records the producer's current public surface as the one this project accepts. Pin one external, or leave the alias empty to pin all of them. Do this after you have adapted the uses that changed.",
    args: [{ name: 'alias', label: 'External alias', optional: true, placeholder: 'empty = all externals' }],
    options: [],
    preview: false,
  },
  'externals-status': {
    id: 'externals-status',
    label: 'Check live',
    text: 'Compares every external with its live producer and prints the result. It changes nothing.',
    args: [],
    options: [],
    preview: false,
    readOnly: true,
  },
  'network-declare': {
    id: 'network-declare',
    label: 'Declare network',
    text: "Declares that this project and every member below it form one isolated network. The network rules then judge the design: who may reach whom, and through which gateway. You can describe the network in a few words.",
    args: [],
    options: [{ name: 'description', label: 'Description', kind: 'value' }],
    preview: false,
  },
  'network-undeclare': {
    id: 'network-undeclare',
    label: 'Remove network',
    text: "Removes this project's network declaration. The network rules stop judging the design against it.",
    args: [],
    options: [],
    preview: false,
  },
  'member-add': {
    id: 'member-add',
    label: 'Add member',
    text: 'Adds a new member to this project. The source is a folder (services/x, ../x) or a git address with a commit (git@host:org/repo.git#abc123). By default it becomes a part of this project; tick the box to make it a project of its own.',
    args: [
      { name: 'alias', label: 'Alias', placeholder: 'scheduler' },
      { name: 'source', label: 'Source', placeholder: '../admin' },
    ],
    options: [
      { name: 'project', label: 'Make it a project of its own', kind: 'flag' },
      { name: 'description', label: 'Description', kind: 'value' },
    ],
    preview: true,
  },
  'member-update': {
    id: 'member-update',
    label: 'Update',
    text: "Moves a git member's pinned commit to the head of its branch, or to the branch, tag or commit you give. Only members that come from git can be updated. It never locks.",
    args: [{ name: 'alias', label: 'Member alias' }],
    options: [
      { name: 'ref', label: 'Branch or tag', kind: 'value' },
      { name: 'commit', label: 'Commit', kind: 'value' },
    ],
    preview: true,
  },
  'member-move': {
    id: 'member-move',
    label: 'Move',
    text: "Moves the member's folder to a new place and points this project's members entry at it.",
    args: [
      { name: 'alias', label: 'Member alias' },
      { name: 'path', label: 'New path', placeholder: '../new-place' },
    ],
    options: [],
    preview: false,
  },
  'member-attach': {
    id: 'member-attach',
    label: 'Attach existing project',
    text: 'Makes the existing project at the path a member of this one. It keeps its own design, packs and approval.',
    args: [
      { name: 'alias', label: 'Alias' },
      { name: 'path', label: 'Path to the project', placeholder: '../payments' },
    ],
    options: [{ name: 'description', label: 'Description', kind: 'value' }],
    preview: true,
  },
  'member-detach': {
    id: 'member-detach',
    label: 'Detach',
    text: 'Takes the member out of the family. This project, and every project in the family that uses it, then reach it as an external by its path, pinned.',
    args: [{ name: 'alias', label: 'Member alias' }],
    options: [{ name: 'widen', label: 'Widen the exports the family uses to the instance audience, instead of refusing', kind: 'flag' }],
    preview: true,
  },
  'member-adopt': {
    id: 'member-adopt',
    label: 'Adopt',
    text: "Makes one of this project's externals found by path (inside this project or a sibling folder) a member again. This is the reverse of detach.",
    args: [{ name: 'alias', label: 'External alias' }],
    options: [],
    preview: true,
  },
  'member-rename-alias': {
    id: 'member-rename-alias',
    label: 'Rename',
    text: 'Gives a member a new alias and updates every reference to it in this project.',
    args: [
      { name: 'old', label: 'Current alias' },
      { name: 'new', label: 'New alias' },
    ],
    options: [],
    preview: true,
  },
  'member-internalize': {
    id: 'member-internalize',
    label: 'Fold in',
    text: "Folds the member, every subsystem of it, back into this project. Its own settings go to the homes you name, and every project in the family that used it is pointed at this project.",
    args: [{ name: 'alias', label: 'Member alias' }],
    options: [
      { name: 'into', label: 'Into subsystem', kind: 'value' },
      packs,
      { name: 'export', label: "Also export this public name of the member", kind: 'value' },
    ],
    preview: true,
  },
  'member-promote': {
    id: 'member-promote',
    label: 'Promote',
    text: 'Turns a part into an independent project in place, with its own id and approval. Its exports cover what this project uses of it, and references to it are respelled alias::name.',
    args: [{ name: 'alias', label: 'Part alias' }],
    options: [{ name: 'id', label: 'Project id', kind: 'value' }],
    preview: true,
  },
  'member-demote': {
    id: 'member-demote',
    label: 'Demote',
    text: "Turns a project member back into a part of this project, under this project's approval. This is refused while another project in the family uses it.",
    args: [{ name: 'alias', label: 'Project alias' }],
    options: [{ name: 'home', label: 'Home subsystem', kind: 'value' }, packs],
    preview: true,
  },
};

/** What the form holds: positional values by arg name, option values by option name (a flag is 'true' or ''). */
export interface FamilyForm {
  args: Record<string, string>;
  options: Record<string, string>;
}

export const emptyForm = (def: FamilyActionDef, preset: Record<string, string> = {}): FamilyForm => ({
  args: Object.fromEntries(def.args.map((a) => [a.name, preset[a.name] ?? ''])),
  options: Object.fromEntries(def.options.map((o) => [o.name, ''])),
});

/** The request body's positional arguments: in order, a blank optional one dropped. */
export function formArgs(def: FamilyActionDef, form: FamilyForm): string[] {
  return def.args
    .map((a) => ({ a, v: (form.args[a.name] ?? '').trim() }))
    .filter((x) => x.v !== '' || !x.a.optional)
    .map((x) => x.v);
}

/** The request body's options: only the set ones; a flag carries 'true'. */
export function formOptions(def: FamilyActionDef, form: FamilyForm): Record<string, string> {
  const out: Record<string, string> = {};
  for (const o of def.options) {
    const v = (form.options[o.name] ?? '').trim();
    if (v !== '') out[o.name] = o.kind === 'flag' ? 'true' : v;
  }
  return out;
}

/** Why the form cannot be sent (the server refuses the same), or undefined when it can. */
export function formProblem(def: FamilyActionDef, form: FamilyForm): string | undefined {
  for (const a of def.args) {
    const v = (form.args[a.name] ?? '').trim();
    if (v === '' && !a.optional) return `${a.label} is required.`;
    if (v.startsWith('-')) return `${a.label} must not start with "-".`;
  }
  for (const o of def.options) {
    const v = (form.options[o.name] ?? '').trim();
    if (v === '') continue;
    if (o.kind === 'flag' && v !== 'true') return `${o.label} is a switch.`;
    if (o.kind !== 'flag' && v.startsWith('-')) return `${o.label} must not start with "-".`;
    if (o.kind === 'choice' && !(o.choices ?? []).includes(v)) return `${o.label} must be ${(o.choices ?? []).join(' or ')}.`;
  }
  return undefined;
}

// ── Members, from the canvas model ───────────────────────────────────────────

export interface MemberRow {
  kind: 'project' | 'part';
  alias: string;
  storage?: string;
  description?: string;
  /** A part's subsystems. */
  subsystems: string[];
}

/** How an external's relation health reads at a glance. Unavailable is never a pass. */
export function externalTone(s: ExternalStatus): { tone: 'ok' | 'warn' | 'bad' | 'neutral'; label: string } {
  if (!s.reachable) return { tone: 'warn', label: s.outOfReach ? 'out of reach' : 'unavailable' };
  if (s.stale) return { tone: 'bad', label: 'stale' };
  if (s.drifted) return { tone: 'warn', label: 'drifted' };
  if (!s.pinned) return { tone: 'warn', label: 'not pinned' };
  if (s.uses.some((u) => u.state === 'unavailable')) return { tone: 'neutral', label: 'pinned · not comparable here' };
  return { tone: 'ok', label: 'current' };
}

// ── Drift notices ────────────────────────────────────────────────────────────

export interface DriftNotice {
  alias: string;
  label: string;
  reasons: string[];
}

/** The externals that need re-pinning: drifted, stale, or with a changed/removed use. */
export function driftNotices(externals: ExternalStatus[]): DriftNotice[] {
  const out: DriftNotice[] = [];
  for (const s of externals) {
    const bad = s.uses.filter((u) => u.state === 'changed' || u.state === 'removed');
    if (!s.drifted && !s.stale && bad.length === 0) continue;
    const reasons = bad.map((u) => {
      const name = [u.publicName, u.member].filter(Boolean).join('.') || '(the external)';
      return `${name} ${u.state}${u.detail ? ` - ${u.detail}` : ''}`;
    });
    if (s.detail && reasons.length === 0) reasons.push(s.detail);
    out.push({ alias: s.alias, label: externalTone(s).label, reasons });
  }
  return out;
}
