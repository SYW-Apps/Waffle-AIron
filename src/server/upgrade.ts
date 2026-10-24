import * as fs from 'fs';
import * as path from 'path';
import * as hostUpgrade from './adapters/upgrade.js';
import { migratePermissionModel, run as migrateRetiredValues } from './migration.js';
import type { MigrationReport } from './migration.js';
import { upgradeMembers } from './members.js';
import type { MemberUpgradeReport } from './members.js';
import { isRetiredPart, listProjectRecords } from './projects.js';
import { appendAuditEvent, effectiveAuditPolicy } from './audit.js';
import { runWithProjectRoot } from '../utils/fs.js';
import { WAIRON_MAJOR } from '../config/defaults.js';
import type { TreeUpgradeReport } from './adapters/upgrade.js';
import type { AuditEvent, HostConfig, PrincipalSubject } from './types.js';

// ---------------------------------------------------------------------------
// Data Dir Upgrade (sdd_host)
//
// A hosting data directory brings itself to the running wairon major when the
// server starts, or refuses to start. Three components share this file:
//   - instance_version_store   : <dataDir>/version.json, `{ "major": n }`.
//   - instance_backup_adapter  : a whole copy of the data directory, beside it.
//   - instance_upgrade         : the workflow — back up, run the permission
//                                model step, rewrite the retired stored values,
//                                upgrade every hosted tree, register
//                                the member records, stamp the major.
// The trees are upgraded before the member records are registered, because a
// v5 tree declares its members only once its legacy mounts have moved into
// members. A failure stops the start; a tree already upgraded stays upgraded,
// each family committed whole.
// ---------------------------------------------------------------------------

/** The oldest major this release upgrades; a data directory with no version is read as it. */
const OLDEST_MAJOR = 5;

/** The operator behind the start-up upgrade: authority is access to the data directory. */
const OPERATOR: PrincipalSubject = { userId: 'operator:host-upgrade', kind: 'service', issuer: 'local' };

/** A start the data directory's major forbids: written by a newer wairon, or older than this release upgrades. */
export class StartRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StartRefused';
  }
}

/** A start an upgrade step stopped: a tree, the permission model or the member records. */
export class StartAborted extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StartAborted';
  }
}

/** hosted_tree_upgrade — one hosted project's tree brought to the running major at start. */
export interface HostedTreeUpgrade {
  /** The hosted project id. */
  project: string;
  /** Its root, absolute. */
  root: string;
  /** What the upgrade came to, when it was planned. */
  report?: TreeUpgradeReport;
  /** Why it was not upgraded: the plan's refusal or the transaction's failure. */
  failure?: string;
}

/** instance_upgrade_report — what bringing a data directory to the running major came to. */
export interface InstanceUpgradeReport {
  /** The major the data directory was written by (5 when it carried no version). */
  fromMajor: number;
  /** The running major. */
  toMajor: number;
  /** Where the data directory was copied before anything moved; absent when it was current. */
  backup?: string;
  /** The permission-model step, when it ran. */
  permissions?: MigrationReport;
  /** Every hosted project tree an older major wrote, each upgraded. */
  trees: HostedTreeUpgrade[];
  /** The member registration step, when it ran. */
  members?: MemberUpgradeReport;
}

// ── instance_version_store ──────────────────────────────────────────────────

/** The version file of a data directory. */
function versionFile(dataDir: string): string {
  return path.join(dataDir, 'version.json');
}

/**
 * iinstance_version_store.read — the recorded major, or null when none is
 * recorded. A file that does not parse, or whose major is not an integer,
 * refuses with its path, so a start never guesses which major wrote the data.
 */
export function readVersion(dataDir: string): number | null {
  const file = versionFile(dataDir);
  if (!fs.existsSync(file)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    throw new Error(`${file} does not parse (${e instanceof Error ? e.message : String(e)}) — it should read { "major": <number> }`);
  }
  const major = (parsed as { major?: unknown } | null)?.major;
  if (typeof major !== 'number' || !Number.isInteger(major)) {
    throw new Error(`${file} does not hold an integer "major" — it should read { "major": <number> }`);
  }
  return major;
}

/** iinstance_version_store.write — record the major: a temporary file beside it, renamed over version.json. */
export function writeVersion(dataDir: string, major: number): void {
  const file = versionFile(dataDir);
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ major }, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, file);
}

// ── instance_backup_adapter ─────────────────────────────────────────────────

/**
 * iinstance_backup_adapter.copy — copy every file of the data directory,
 * recursively, to `<dataDir>.backup-v<from>-to-v<to>-<UTC timestamp>` beside
 * it, and answer that path. A copy that fails removes what it wrote and
 * refuses with the cause, so no upgrade runs without a complete backup.
 */
export function copyDataDir(dataDir: string, fromMajor: number, toMajor: number): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const target = `${path.resolve(dataDir)}.backup-v${fromMajor}-to-v${toMajor}-${stamp}`;
  try {
    fs.cpSync(dataDir, target, { recursive: true, errorOnExist: true, force: false });
  } catch (e) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch {
      /* the cause below is the one to report */
    }
    throw new Error(`could not back up ${dataDir} to ${target}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return target;
}

/**
 * iinstance_backup_adapter.discard — delete the data directory and every
 * `<dataDir>.backup-*` folder beside it, and answer the paths removed. Only the
 * local development server's data directory is ever discarded: the one caller
 * is resetDevDataDir, which refuses a host that is not in development mode.
 */
export function discardDataDir(dataDir: string): string[] {
  const dir = path.resolve(dataDir);
  const parent = path.dirname(dir);
  const name = path.basename(dir);
  // Never a filesystem root: a directory with no name beside it has nothing to be a sibling of.
  if (name === '' || parent === dir) throw new Error(`refusing to discard ${dir}: it is a filesystem root`);
  const removed: string[] = [];
  const targets = [dir];
  if (fs.existsSync(parent)) {
    for (const entry of fs.readdirSync(parent)) {
      if (entry.startsWith(`${name}.backup-`)) targets.push(path.join(parent, entry));
    }
  }
  for (const target of targets) {
    if (!fs.existsSync(target)) continue;
    fs.rmSync(target, { recursive: true, force: true });
    removed.push(target);
  }
  return removed;
}

// ── instance_upgrade ────────────────────────────────────────────────────────

/**
 * iinstance_upgrade.resetDevDataDir — development mode only: a data directory
 * that is unversioned, written by another major or has a version file that does
 * not parse is deleted with its old backups (it is disposable: never backed up,
 * never migrated) and stamped with the running major, so whatever the start
 * writes into it next belongs to a current directory. A directory already at the
 * running major is left as it is. Answers whether anything was deleted.
 */
export function resetDevDataDir(cfg: Pick<HostConfig, 'dataDir' | 'devMode'>): boolean {
  // Steps 1-2.
  if (cfg.devMode !== true) {
    throw new Error("Only the local development server's disposable data directory may be reset.");
  }
  // Step 3: a version file that does not parse reads as not current.
  let recorded: number | null;
  try {
    recorded = readVersion(cfg.dataDir);
  } catch {
    recorded = null;
  }
  // Steps 4 and 7.
  if (recorded === WAIRON_MAJOR) return false;
  // Steps 5-6.
  const removed = discardDataDir(cfg.dataDir);
  // The fresh directory is current from its first byte: a registration written before the server's own
  // bootstrap stamps it must never read as an unversioned (v5) directory awaiting migration.
  writeVersion(cfg.dataDir, WAIRON_MAJOR);
  return removed.length > 0;
}

/** iinstance_upgrade.run — bring the data directory and every hosted tree to the running major, or refuse to start. */
export function run(cfg: Pick<HostConfig, 'dataDir' | 'auditPolicy' | 'devMode'>): InstanceUpgradeReport {
  // Step 1.
  const recorded = readVersion(cfg.dataDir);
  // Step 2: no version recorded reads as the oldest major this release upgrades.
  const from = recorded ?? OLDEST_MAJOR;
  const to = WAIRON_MAJOR;
  // Steps 3-4.
  if (from > to) {
    throw new StartRefused(
      `${cfg.dataDir} was written by wairon ${from}, newer than this wairon ${to} — install the newer wairon to serve it.`,
    );
  }
  // Steps 5-6.
  if (from < OLDEST_MAJOR) {
    throw new StartRefused(
      `${cfg.dataDir} was written by wairon ${from}, older than the oldest major this release upgrades (${OLDEST_MAJOR}) — `
        + `install the last release of wairon ${from + 1} first, start it once, then this one.`,
    );
  }
  const older = from < to;
  let backup: string | undefined;
  let permissions: MigrationReport | undefined;
  const named = (): string => (backup ? ` The data directory was copied first to ${backup}.` : '');
  if (older) {
    // Step 8.
    backup = copyDataDir(cfg.dataDir, from, to);
    // Step 9.
    try {
      permissions = migratePermissionModel(cfg.dataDir, true);
    } catch (e) {
      throw new StartAborted(
        `the permission-model step of the upgrade failed: ${e instanceof Error ? e.message : String(e)}.${named()}`,
      );
    }
    // Step 10: the retired values the data directory stores, rewritten; the older major wrote them, this one refuses them.
    try {
      migrateRetiredValues(cfg.dataDir, true, cfg.auditPolicy);
    } catch (e) {
      throw new StartAborted(
        `the retired-value step of the upgrade failed: ${e instanceof Error ? e.message : String(e)}.${named()}`,
      );
    }
  }
  // Step 11: run even on a current data directory, so a tree restored or imported from an older major is upgraded too.
  const trees = upgradeTrees(cfg);
  // Steps 12-13: only a hosted start stops on a failed tree; the development server keeps them in the report,
  // which the start prints and the web UI shows.
  const failed = trees.filter((t) => t.failure !== undefined);
  if (failed.length > 0 && cfg.devMode !== true) {
    throw new StartAborted(
      `${failed.length} hosted project(s) were not upgraded: ${failed.map((t) => `${t.project} (${t.failure})`).join('; ')}.`
        + `${named()} Every tree already upgraded stays upgraded, its family committed whole.`,
    );
  }
  let members: MemberUpgradeReport | undefined;
  if (older) {
    // Step 15.
    members = upgradeMembers(cfg, true);
    // Steps 16-17: blocked by a refusal, or a commit that failed; a plan with nothing to write is not a failure.
    if (members.plan.refusals.length > 0 || (members.outcome !== undefined && !members.applied)) {
      const why = members.plan.refusals.length > 0
        ? members.plan.refusals.map((r) => `${r.area}: ${r.detail}`).join('; ')
        : members.outcome?.failure ?? 'the member upgrade did not commit';
      throw new StartAborted(`the member records were not registered: ${why}.${named()}`);
    }
    // Step 18.
    writeVersion(cfg.dataDir, to);
  }
  // Step 19.
  return { fromMajor: from, toMajor: to, ...(backup ? { backup } : {}), ...(permissions ? { permissions } : {}), trees, ...(members ? { members } : {}) };
}

/**
 * iinstance_upgrade.upgradeTrees — bring every hosted project tree an older
 * major wrote to the running major, each family through its top, each all or
 * nothing; a refused or failed one is answered with why and the pass goes on.
 */
export function upgradeTrees(cfg: Pick<HostConfig, 'dataDir' | 'auditPolicy'>): HostedTreeUpgrade[] {
  const out: HostedTreeUpgrade[] = [];
  const seen = new Set<string>();
  // Step 1: family tops before their members.
  const records = listProjectRecords(cfg.dataDir);
  const ordered = [...records.filter((r) => !r.parentProjectId), ...records.filter((r) => r.parentProjectId)];
  // Step 2.
  for (const record of ordered) {
    if (!record.rootPath) continue;
    // Steps 3-5: a part retired into its parent is its parent's tree.
    if (isRetiredPart(record)) continue;
    const root = path.resolve(record.rootPath);
    if (seen.has(root)) continue;
    seen.add(root);
    // A record whose root holds no project yet (created, not yet initialized) has no tree to upgrade.
    if (!['.wai', '.wairon'].some((dir) => fs.existsSync(path.join(root, dir, 'project.yaml')))) continue;
    try {
      // Step 6.
      const stand = runWithProjectRoot(root, () => hostUpgrade.standing(root));
      // Step 7.
      if (stand.state !== 'older') continue;
      // Steps 8-9.
      const report = runWithProjectRoot(root, () => hostUpgrade.apply(hostUpgrade.plan(root)));
      if (report.committed) {
        // Steps 10-12.
        out.push({ project: record.id, root, report });
        audit(cfg, record.id, report);
      } else {
        // Step 13.
        out.push({ project: record.id, root, report, failure: report.failure ?? report.plan.refusal ?? 'the upgrade did not commit' });
      }
    } catch (e) {
      // Step 13.
      out.push({ project: record.id, root, failure: e instanceof Error ? e.message : String(e) });
    }
  }
  // Step 15.
  return out;
}

/** Step 11: one migration.upgrade audit event per tree the start upgraded. */
function audit(cfg: Pick<HostConfig, 'dataDir' | 'auditPolicy'>, projectId: string, report: TreeUpgradeReport): void {
  const event: AuditEvent = {
    id: '',
    timestamp: '',
    level: 'info',
    category: 'project',
    action: 'migration.upgrade',
    outcome: 'success',
    actor: OPERATOR,
    projectId,
    target: projectId,
    metadata: JSON.stringify({ stamped: report.stamped, relock: report.relock }),
  };
  try {
    appendAuditEvent(cfg.dataDir, event, effectiveAuditPolicy(cfg));
  } catch (e) {
    console.error(`[sdd_host] audit append failed for migration.upgrade (project=${projectId}): ${e instanceof Error ? e.message : String(e)}`);
  }
}
