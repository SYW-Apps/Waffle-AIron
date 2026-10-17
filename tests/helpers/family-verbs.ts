import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { setProjectRoot, runWithProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { validateFamily, type ValidationIssue } from '../../src/core/validation.js';
import { pinExternals } from '../../src/core/surfaces.js';
import * as migrations from '../../src/migrations/index.js';
import type { FamilyMigrationReport, MigrationPlan, MigrationRequest } from '../../src/migrations/types.js';

// ---------------------------------------------------------------------------
// Shared by the stage 6 wave B verb tests: bind a root, plan and apply a verb
// through the migration portal, and read a family the way the properties
// compare it — its .wai bytes, and its family run's findings. Nothing is
// mocked: every verb runs the real planner, the real writers on a real
// rehearsal, and the real family transaction.
// ---------------------------------------------------------------------------

/** Bind a root and read it as it is now. */
export function at<T>(dir: string, fn: () => T): T {
  invalidateSpecCache();
  setProjectRoot(dir);
  return fn();
}

/** Plan a family migration from a bound root. */
export function plan(dir: string, request: MigrationRequest): MigrationPlan {
  return at(dir, () => migrations.plan(request));
}

/** Plan and apply a family migration from a bound root, failing loudly on a refusal. */
export function migrate(dir: string, request: MigrationRequest): FamilyMigrationReport {
  const planned = plan(dir, request);
  if (planned.refusals.length > 0) {
    migrations.discard(planned);
    throw new Error(`refused: ${planned.refusals.map((r) => `${r.code}: ${r.detail}`).join('; ')}`);
  }
  const report = at(dir, () => migrations.apply(planned));
  if (planned.changes.length > 0 && !report.applied) throw new Error(`not applied: ${report.outcome?.failure ?? 'no outcome'}`);
  return report;
}

/** Every file under a root, .wai trees only (source is never a migration's), by digest — and every transaction left behind. */
export function waiState(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (entry.isDirectory()) {
        if (rel.endsWith('.wai') || rel.includes('.wai/')) out[`${rel}/`] = 'dir';
        walk(full);
      } else if (rel.includes('.wai/')) out[rel] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  };
  walk(root);
  return out;
}

/** Every file under a root, whatever it is, by digest: a refusal writes nothing, anywhere. */
export function dirHash(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (entry.isDirectory()) {
        out[`${rel}/`] = 'dir';
        walk(full);
      } else out[rel] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  };
  walk(root);
  return out;
}

/**
 * The family run's errors and warnings from a root, each as `severity code`;
 * `except` drops the ones a predicate names (a verb's own, expected finding).
 */
export function familyFindings(top: string, except: (i: ValidationIssue) => boolean = () => false): string[] {
  const run = at(top, () => validateFamily({ family: true }));
  return run.issues.filter((i: ValidationIssue) => i.severity !== 'notice' && !except(i)).map((i) => `${i.severity} ${i.code}`).sort();
}

/** The family run's errors and warnings from a root, each with what it names — for a failure message. */
export function familyLines(top: string): string[] {
  const run = at(top, () => validateFamily({ family: true }));
  return run.issues.filter((i: ValidationIssue) => i.severity !== 'notice').map((i) => `${i.severity} ${i.code} [${i.project ?? ''}] @${i.specId ?? '-'} ${i.message.slice(0, 160)}`).sort();
}

/**
 * The findings of `after` that `before` does not account for (multiset
 * difference): property family-consistent says a verb adds none.
 */
export function newFindings(before: string[], after: string[]): string[] {
  const left = [...before];
  const added: string[] = [];
  for (const f of after) {
    const i = left.indexOf(f);
    if (i >= 0) left.splice(i, 1);
    else added.push(f);
  }
  return added;
}

/** Pin a project's externals from its own root, within the family's reach. */
export function pinAt(dir: string): void {
  invalidateSpecCache();
  runWithProjectRoot(dir, () => pinExternals());
  invalidateSpecCache();
}

/** Write a file (and its directories). */
export function put(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** Every L0 export of a project widened from the family's audience to the instance's — a person's design decision a detach needs made first. */
export function widen(dir: string): void {
  const file = path.join(dir, '.wai', 'specs', '.index.yaml');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/audience: project/g, 'audience: instance'));
  invalidateSpecCache();
}
