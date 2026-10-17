import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FixtureTree } from '../rules-matrix/harness';
import { createTrialSandbox, countCode, transcript, type TrialSandbox } from './trials-helpers';

// ---------------------------------------------------------------------------
// Round-11 user trials (dev.115), the code gate and the briefs, against the
// built CLI:
//   1. a type whose fields live in one file and whose pure methods are planned
//      in a second: once the first existed the second was MISSING_SOURCE_FILE
//      (an ERROR, the tree red mid-wave), and no brief fenced it — solo-app top-2.
//   2. an implementation subagent deleted a project folder outside its fence;
//      the brief said nothing about deleting or scratch space — solo-app top-1.
// ---------------------------------------------------------------------------

let sb: TrialSandbox;
let seq = 0;
const fresh = (tree: FixtureTree): string => sb.materialize(`p${++seq}`, tree);

/** The files `wairon agent brief` lists under its code write fence. */
function fenceOf(stdout: string): string[] {
  const lines = stdout.split(/\r?\n/);
  const at = lines.findIndex((l) => l.includes('Code write fence:'));
  const out: string[] = [];
  for (const line of lines.slice(at + 1)) {
    const m = /^\S*\s+(\S+\.\w+)\s*$/.exec(line);
    if (!m) break;
    out.push(m[1]);
  }
  return out;
}

beforeAll(() => { sb = createTrialSandbox('r11conf'); });
afterAll(async () => { await sb?.cleanup(); });

/** Habitly's reminders: the reminder type's fields in src/types.ts, its pure methods planned in src/reminder_schedule.ts. */
function reminderTree(files: Record<string, string>): FixtureTree {
  return {
    system: { name: 'Habitly', vision: 'Habits and their reminders.', targetLanguage: 'TypeScript' },
    subsystems: [{ id: 'habits', description: 'Habits and reminders.' }],
    components: [
      { id: 'reminder_orchestrator', componentType: 'Orchestrator', description: 'Sends the reminders that are due.', invokedBy: { kind: 'runtime', caller: 'The scheduler the composition root starts' } },
      { id: 'habit_orchestrator', componentType: 'Orchestrator', description: 'Keeps each habit\'s reminder setting.', invokedBy: { kind: 'runtime', caller: 'The settings job the composition root starts' } },
    ],
    interfaces: [
      { id: 'ireminder_orchestrator', component: 'reminder_orchestrator', methods: [{ name: 'sendDue', description: 'Send the reminder when it is due.', params: [{ name: 'reminder', type: 'reminder' }, { name: 'now', type: 'string' }], returns: 'bool', effect: 'none' }] },
      { id: 'ihabit_orchestrator', component: 'habit_orchestrator', methods: [{ name: 'setReminder', description: 'Keep a habit\'s reminder setting.', params: [{ name: 'reminder', type: 'reminder' }], returns: 'void', effect: 'none' }] },
    ],
    implementations: [
      { id: 'reminder_orchestrator_impl', contract: 'ireminder_orchestrator', sourcePath: 'src/reminder_orchestrator.ts', methods: [{ name: 'sendDue', narrative: [
        { stepNumber: 1, description: 'Is it due?', type: 'branch', condition: 'reminder.isDue(now)', onTrueStep: 2, onFalseStep: 3 },
        { stepNumber: 2, description: 'Due: send it', type: 'return', outcome: 'sent' },
        { stepNumber: 3, description: 'Not due', type: 'return', outcome: 'skipped' },
      ] }] },
      { id: 'habit_orchestrator_impl', contract: 'ihabit_orchestrator', sourcePath: 'src/habit_orchestrator.ts', methods: [{ name: 'setReminder', detail: 'intent', intent: 'Validates the reminder setting and keeps it with the habit; an invalid time of day is refused.' }] },
    ],
    types: [{
      id: 'reminder', kind: 'value-object', subsystem: 'habits', name: 'Reminder', description: 'When a habit reminds.',
      sourcePath: 'src/types.ts',
      fields: [{ name: 'timeOfDay', type: 'string' }],
      methods: [{ name: 'isDue', signature: 'isDue(now: string): bool', returns: 'bool', params: [{ name: 'now', type: 'string' }], sourcePath: 'src/reminder_schedule.ts' }],
    }],
    files,
  };
}

describe('1. a type\'s methods file planned while its fields file exists (solo-app top-2)', () => {
  it('validate: a SOURCE_FILE_PLANNED notice, never MISSING_SOURCE_FILE; the tree stays valid', async () => {
    const dir = fresh(reminderTree({ 'src/types.ts': 'export interface Reminder { timeOfDay: string }\n' }));
    const r = await sb.run(['validate'], dir);
    // Round 11: "✖ [reminder] [MISSING_SOURCE_FILE] … does not resolve to a file although the type's realization has begun".
    expect(countCode(r.all, 'MISSING_SOURCE_FILE'), transcript(r)).toBe(0);
    expect(r.all).toMatch(/\[SOURCE_FILE_PLANNED\][^\n]*Type "reminder" method "isDue" sourcePath "src\/reminder_schedule\.ts" is planned, not written yet — the type's own file exists/);
    expect(r.code, transcript(r)).toBe(0);
  });

  it('control — the type\'s OWN file missing while its methods file exists stays a broken link', async () => {
    const dir = fresh(reminderTree({ 'src/reminder_schedule.ts': 'export function isDue(now: string): boolean { return now.length > 0; }\n' }));
    const r = await sb.run(['validate'], dir);
    expect(r.all, transcript(r)).toMatch(/\[MISSING_SOURCE_FILE\][^\n]*Type "reminder" sourcePath "src\/types\.ts"/);
  });

  it('the brief of the component whose narrative calls the method fences the file; the other lists it nowhere', async () => {
    const dir = fresh(reminderTree({ 'src/types.ts': 'export interface Reminder { timeOfDay: string }\n' }));
    const caller = await sb.run(['agent', 'brief', 'reminder_orchestrator-implementer'], dir);
    expect(caller.code, transcript(caller)).toBe(0);
    // Round 11: three briefs listed it under Shared only, and none fenced it.
    expect(fenceOf(caller.stdout)).toContain('src/reminder_schedule.ts');
    const other = await sb.run(['agent', 'brief', 'habit_orchestrator-implementer'], dir);
    expect(other.code, transcript(other)).toBe(0);
    expect(other.stdout).not.toContain('src/reminder_schedule.ts');
  });
});

describe('2. the brief bounds deletions and scratch space (solo-app top-1)', () => {
  it('the code write fence says never to delete outside it, nor to use a project folder as scratch', async () => {
    const dir = fresh(reminderTree({}));
    const r = await sb.run(['agent', 'brief', 'reminder_orchestrator-implementer'], dir);
    expect(r.code, transcript(r)).toBe(0);
    expect(r.stdout).toContain('Never delete or move a file or folder outside the files this brief fences');
    expect(r.stdout).toContain('never use an existing project folder as scratch space');
  });
});
