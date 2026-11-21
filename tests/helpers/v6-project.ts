import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { captureApprovedSpecs } from '../../src/core/approval.js';
import { computeApprovalId } from '../../src/core/validation.js';
import { writeYamlFile } from '../../src/utils/yaml.js';

// ---------------------------------------------------------------------------
// A project as wairon 6 left it, on a real temp directory: a project.yaml (no
// stamp unless asked), a one-subsystem spec tree, and a format-3 lock record
// whose per-spec digests and gate parts are taken from the tree as it stands,
// so the v6-to-v7 step can prove them unchanged.
// ---------------------------------------------------------------------------

const now = '2026-11-01T00:00:00.000Z';

/** A fresh, real temp directory. */
export function tempRoot(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** The project.yaml of a project; `extra` is merged in (members, externals, extensions). */
export function projectYaml(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: '1.0.0', id, name: id, targets: [], rules: {}, extensions: { packs: [], useGlobalPacks: false },
    createdAt: now, updatedAt: now, ...extra,
  };
}

/** Write one project at a root: its project.yaml and a system with one subsystem and one component. */
export function writeProject(root: string, id: string, extra: Record<string, unknown> = {}): void {
  writeYamlFile(path.join(root, '.wai', 'project.yaml'), projectYaml(id, extra));
  const put = (rel: string, doc: Record<string, unknown>): void => writeYamlFile(path.join(root, '.wai', 'specs', ...rel.split('/')), doc);
  put('.index.yaml', { schemaVersion: '1.0.0', name: id, vision: `the ${id} system`, boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now });
  put(`${id}-core/.index.yaml`, {
    id: `${id}-core`, name: `${id}-core`, description: 'the core', parentSystem: id, publicInterfaces: [], trustedLinks: [],
    status: 'complete', createdAt: now, updatedAt: now,
  });
  put(`${id}-core/${id}-orch/.index.yaml`, {
    id: `${id}-orch`, name: `${id}-orch`, description: 'the orchestrator', subsystem: `${id}-core`, componentType: 'Orchestrator',
    owns: [], dependsOn: [], status: 'complete', createdAt: now, updatedAt: now,
  });
}

/** What the lock a v6 record certified is made of. */
export interface V6LockOptions {
  /** Defaults to 3. */
  format?: number | null;
  /** Leave the per-spec digests as the tree gives them (default) or replace them. */
  specs?: Record<string, string>;
  /** `design` (default) or an older reading. */
  specsReading?: string;
  /** Omit the gate parts. */
  noGateParts?: boolean;
  /** Replace a gate part's digest. */
  tamperPart?: { name: string; digest: string };
  lockedBy?: unknown;
}

/** The format-3 lock record of the project at a root, taken from the tree as it stands. Returns it. */
export function writeV6Lock(root: string, options: V6LockOptions = {}): Record<string, unknown> {
  setProjectRoot(root);
  invalidateSpecCache();
  let record: Record<string, unknown>;
  try {
    const identity = computeApprovalId();
    const gateParts = { ...(identity.parts ?? {}), release: 'abc' };
    if (options.tamperPart) gateParts[options.tamperPart.name] = options.tamperPart.digest;
    record = {
      ...(options.format === null ? {} : { format: options.format ?? 3 }),
      stateId: { algorithm: 'sha256+design+gate+release', digest: 'a'.repeat(64) },
      lockedAt: now,
      lockedBy: options.lockedBy ?? { id: 'approver', source: 'git' },
      validatorVersion: '6.7.4',
      validationResult: { valid: true, errors: 0, warnings: 0, notices: 0 },
      status: 'ready',
      specs: options.specs ?? captureApprovedSpecs(root),
      specsReading: options.specsReading ?? 'design',
      ...(options.noGateParts ? {} : { gateParts }),
      members: { kid: { stateId: { algorithm: 'x', digest: 'y' } } },
      reexpressed: { at: now },
    };
  } finally {
    setProjectRoot(null);
    invalidateSpecCache();
  }
  fs.writeFileSync(path.join(root, '.wai', 'lock.json'), JSON.stringify(record, null, 2) + '\n');
  return record;
}

/** The lock record file of a root, parsed. */
export function readLockJson(root: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(root, '.wai', 'lock.json'), 'utf8')) as Record<string, unknown>;
}
