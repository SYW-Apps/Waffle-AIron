import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { validateProject, type ValidationIssue } from '../../src/core/validation.js';
import { composeAgentBrief } from '../../src/core/agent_resolver.js';
import { materializeFixtureProject, type FixtureTree } from '../rules-matrix/harness.js';

// ---------------------------------------------------------------------------
// The code<->spec and brief gaps the eleventh round of user trials found:
//
//   1. A type whose fields live in one file and whose pure methods are planned
//      in a second: once the first exists the second is planned, as a
//      component method's planned file is — never MISSING_SOURCE_FILE — and
//      the brief of the component whose narrative calls those methods fences
//      it (solo-app top-2).
//   2. The brief says never to delete or move outside the fence, nor to use a
//      project folder as scratch space (solo-app top-1).
// ---------------------------------------------------------------------------

const roots: string[] = [];
afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  for (const dir of roots.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* windows locks */ }
  }
});

function bound(tree: FixtureTree): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-round11-')));
  roots.push(dir);
  materializeFixtureProject(dir, tree);
  setProjectRoot(dir);
  invalidateSpecCache();
  return dir;
}

const byCode = (issues: ValidationIssue[], code: string): ValidationIssue[] => issues.filter((i) => i.code === code);

/** Reminders: the type's fields in src/types.ts, its pure method planned in src/reminder_schedule.ts. */
function reminderTree(files: Record<string, string>, callerMentions = true): FixtureTree {
  return {
    system: { name: 'Habitly', vision: 'Habits and their reminders.', targetLanguage: 'TypeScript' },
    subsystems: [{ id: 'habits', description: 'Habits and reminders.' }],
    components: [
      { id: 'reminder_orchestrator', componentType: 'Orchestrator', description: 'Sends the reminders that are due.', invokedBy: { kind: 'runtime', caller: 'The scheduler' } },
      { id: 'habit_orchestrator', componentType: 'Orchestrator', description: 'Keeps each habit\'s reminder setting.', invokedBy: { kind: 'runtime', caller: 'The settings job' } },
    ],
    interfaces: [
      { id: 'ireminder_orchestrator', component: 'reminder_orchestrator', methods: [{ name: 'sendDue', description: 'Send the reminder when it is due.', params: [{ name: 'reminder', type: 'reminder' }, { name: 'now', type: 'string' }], returns: 'bool', effect: 'none' }] },
      { id: 'ihabit_orchestrator', component: 'habit_orchestrator', methods: [{ name: 'setReminder', description: 'Keep a habit\'s reminder setting.', params: [{ name: 'reminder', type: 'reminder' }], returns: 'void', effect: 'none' }] },
    ],
    implementations: [
      { id: 'reminder_orchestrator_impl', contract: 'ireminder_orchestrator', sourcePath: 'src/reminder_orchestrator.ts', methods: [{ name: 'sendDue', narrative: [
        { stepNumber: 1, description: 'Is it due?', type: 'branch', condition: callerMentions ? 'reminder.isDue(now)' : 'the reminder is due', onTrueStep: 2, onFalseStep: 3 },
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
  it('is SOURCE_FILE_PLANNED (a notice) naming the method, never MISSING_SOURCE_FILE', () => {
    bound(reminderTree({ 'src/types.ts': 'export interface Reminder { timeOfDay: string }\n' }));
    const issues = validateProject().issues;
    expect(byCode(issues, 'MISSING_SOURCE_FILE')).toEqual([]);
    const planned = byCode(issues, 'SOURCE_FILE_PLANNED').filter((i) => i.specId === 'reminder');
    expect(planned).toHaveLength(1);
    expect(planned[0].severity).toBe('notice');
    expect(planned[0].message).toContain('Type "reminder" method "isDue" sourcePath "src/reminder_schedule.ts" is planned, not written yet — the type\'s own file exists');
  });

  it('control: the type\'s OWN file missing while its methods file exists stays MISSING_SOURCE_FILE', () => {
    bound(reminderTree({ 'src/reminder_schedule.ts': 'export function isDue(now: string): boolean { return now.length > 0; }\n' }));
    const missing = byCode(validateProject().issues, 'MISSING_SOURCE_FILE');
    expect(missing).toHaveLength(1);
    expect(missing[0].severity).toBe('error');
    expect(missing[0].message).toContain('Type "reminder" sourcePath "src/types.ts"');
  });

  it('the component whose narrative calls the method fences its file; the other neither fences nor shares it', () => {
    bound(reminderTree({ 'src/types.ts': 'export interface Reminder { timeOfDay: string }\n' }));
    const caller = composeAgentBrief('reminder_orchestrator-implementer');
    expect(caller.codeFence).toContain('src/reminder_schedule.ts');
    expect(caller.instructions).toContain('`src/reminder_schedule.ts` (planned — create it)');
    const other = composeAgentBrief('habit_orchestrator-implementer');
    expect(other.codeFence ?? []).not.toContain('src/reminder_schedule.ts');
    expect(other.sharedPaths ?? []).not.toContain('src/reminder_schedule.ts');
  });

  it('with no narrative calling the methods, the file stays shared by the contracts naming the type', () => {
    bound(reminderTree({ 'src/types.ts': 'export interface Reminder { timeOfDay: string }\n' }, false));
    for (const id of ['reminder_orchestrator-implementer', 'habit_orchestrator-implementer']) {
      const brief = composeAgentBrief(id);
      expect(brief.codeFence ?? []).not.toContain('src/reminder_schedule.ts');
      expect(brief.sharedPaths).toContain('src/reminder_schedule.ts');
    }
  });
});

describe('2. the brief bounds deletions and scratch space (solo-app top-1)', () => {
  it('the code write fence section says it once', () => {
    bound(reminderTree({}));
    const brief = composeAgentBrief('reminder_orchestrator-implementer');
    const fence = brief.instructions.slice(brief.instructions.indexOf('## Code write fence'));
    expect(fence).toContain('Never delete or move a file or folder outside the files this brief fences');
    expect(fence).toContain('never use an existing project folder as scratch space: keep scratch work in a temporary directory outside the repository');
  });
});
