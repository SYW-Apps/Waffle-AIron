import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { createCredential, hashToken } from '../../src/server/credentials.js';
import { setAssignment } from '../../src/server/permissions.js';
import { createUnit } from '../../src/server/organization.js';
import { createProject } from '../../src/server/admin.js';
import type {
  ApiKeyRecord,
  Capability,
  HostConfig,
  OrganizationUnitRecord,
  PermissionValue,
  PrincipalSubject,
  ScopeKind,
} from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Shared assignment-model test helpers (sdd_host).
//
// The grant model is gone: a credential record carries NO permissions — a token
// is a narrowing over its OWNER's live permission, and authority comes from the
// assignment grid (setAssignment) + role bindings, resolved per request. These
// helpers give every suite the same three primitives: a grants-free token, a
// grid assignment, and a placed project (every project is placed at creation).
// ---------------------------------------------------------------------------

export function subjectOf(userId: string, over: Partial<PrincipalSubject> = {}): PrincipalSubject {
  return { userId, kind: 'human', issuer: 'local', ...over };
}

/** Mint a stored grants-free token owned by `userId`; returns the plaintext.
 *  Authority comes exclusively from the assignment grid (see allow()). */
export function mintUserToken(
  dataDir: string,
  opts: { id: string; userId: string; projects?: string[]; subject?: Partial<PrincipalSubject> },
): string {
  const token = 'wk_' + crypto.randomBytes(8).toString('hex');
  const record: ApiKeyRecord = {
    id: opts.id,
    keyHash: hashToken(token),
    projects: opts.projects ?? ['*'],
    createdAt: new Date().toISOString(),
    ownerSubject: subjectOf(opts.userId, opts.subject),
  };
  createCredential(dataDir, record);
  return token;
}

/** Seed one assignment in the permission grid: the ONLY way a non-admin subject
 *  gains authority under the resolver model. */
export function allow(
  dataDir: string,
  userId: string,
  capability: Capability,
  scopeKind: ScopeKind,
  scopeId: string | undefined,
  value: PermissionValue = 'yes',
): void {
  setAssignment(dataDir, {
    id: '',
    subjectKind: 'user',
    subjectId: userId,
    scopeKind,
    ...(scopeId !== undefined ? { scopeId } : {}),
    capability,
    value,
    createdAt: '',
  });
}

/** Create an organization unit (projects must be placed somewhere). The name
 *  doubles as the slug, so the qualified id is parentId + '.' + name (or the
 *  name itself for a root unit). */
export function seedUnit(dataDir: string, name: string, over: Partial<OrganizationUnitRecord> = {}): OrganizationUnitRecord {
  return createUnit(dataDir, {
    id: '',
    name,
    slug: name,
    kind: 'team',
    status: 'active',
    createdAt: '',
    createdBy: subjectOf('u-seeder'),
    ...over,
  });
}

/** Seed a subsystem spec into the spec tree at `root` — a CHAINED mount when
 *  projectPath is given (the shape `wairon subsystem add` produces), an
 *  ordinary in-tree subsystem otherwise. */
export function seedSubsystem(root: string, subsystemId: string, projectPath?: string): void {
  const dir = path.join(root, '.wai', 'specs', 'subsystems');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${subsystemId}.yaml`),
    [
      `id: ${subsystemId}`,
      `name: ${subsystemId}`,
      `description: subsystem ${subsystemId}`,
      'parentSystem: root-system',
      ...(projectPath ? [`projectPath: ${projectPath}`] : []),
      "createdAt: '2026-01-01T00:00:00.000Z'",
      "updatedAt: '2026-01-01T00:00:00.000Z'",
      '',
    ].join('\n'),
  );
}

/** Seed a chained-subproject fixture: the subsystem spec carrying projectPath
 *  in the tree at `root`, plus the real child dir (with its own .wai/specs)
 *  inside the root. Returns the resolved child dir. */
export function seedChainedMount(root: string, subsystemId: string, projectPath: string): string {
  seedSubsystem(root, subsystemId, projectPath);
  const childDir = path.resolve(root, projectPath);
  fs.mkdirSync(path.join(childDir, '.wai', 'specs'), { recursive: true });
  return childDir;
}

/** Create a project through the admin plane (master credential) placed into a
 *  fresh unit; returns the unit so tests can scope assignments to it. */
export function createPlacedProject(
  cfg: HostConfig,
  master: string,
  projectId: string,
  unit?: OrganizationUnitRecord,
): OrganizationUnitRecord {
  const target = unit ?? seedUnit(cfg.dataDir, `unit-${projectId}`);
  createProject(cfg, master, projectId, target.id);
  return target;
}

// ---------------------------------------------------------------------------
// A project's L0 export table, backed by a real tree.
//
// The landscape reads a project's RESOLVED export table, so an L0 entry only
// appears once it resolves: its subsystem exists, publishes a Portal, and the
// entry re-exports it. This seeds exactly that — one subsystem publishing a
// Portal per entry, its contract, and the L0 entry naming them — so a suite
// states the surface it means rather than a raw list the resolver would drop.
// ---------------------------------------------------------------------------

/** One method of a seeded contract: its HTTP route and signature types feed the redacted summary. */
export interface SeededMethod {
  name: string;
  http?: { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; path: string };
  params?: { name: string; type: string }[];
  returns?: string;
}

/** An L0 entry to seed; `methods` becomes the backing Portal's contract. */
export interface SeededExport {
  id: string;
  name?: string;
  type?: 'REST' | 'GraphQL' | 'MessageBus' | 'RPC' | 'Custom';
  audience?: string;
  version?: string;
  stability?: string;
  details?: string;
  subsystem?: string;
  component?: string;
  interface?: string;
  methods?: SeededMethod[];
}

const PORTAL_TYPE_OF: Record<string, string> = { REST: 'HTTP_API', GraphQL: 'GraphQL', RPC: 'gRPC', MessageBus: 'MessageBus', Custom: 'Custom' };

function writeSpecYaml(file: string, body: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, yaml.dump(body));
}

/** Seed L0 exports into a provisioned project, each backed by a published Portal and its contract. */
export function seedExportedSurface(root: string, exports: SeededExport[]): void {
  const specs = path.join(root, '.wai', 'specs');
  const now = new Date().toISOString();
  const published = new Map<string, { type: string; details: string; component: string; interface?: string }[]>();
  const l0 = exports.map((e) => {
    const subsystem = e.subsystem ?? 'api';
    const component = e.component ?? `${e.id.replace(/[^a-z0-9]+/g, '_')}_portal`;
    const contract = e.interface ?? `i${component}`;
    const type = e.type ?? 'REST';
    const list = published.get(subsystem) ?? [];
    list.push({ type, details: e.details ?? 'd', component, ...(e.interface ? { interface: e.interface } : {}) });
    published.set(subsystem, list);
    writeSpecYaml(path.join(specs, 'components', `${component}.yaml`), {
      id: component, name: component, description: `Serves ${e.id}.`, subsystem, componentType: 'Portal',
      portalType: PORTAL_TYPE_OF[type], owns: [], dependsOn: [], status: 'complete', createdAt: now, updatedAt: now,
    });
    writeSpecYaml(path.join(specs, 'interfaces', `${contract}.yaml`), {
      id: contract, name: contract, description: `Contract of ${e.id}.`, component, status: 'complete', createdAt: now, updatedAt: now,
      methods: (e.methods ?? []).map((m) => ({
        name: m.name,
        description: m.name,
        signature: `${m.name}(${(m.params ?? []).map((p) => `${p.name}: ${p.type}`).join(', ')}): ${m.returns ?? 'void'}`,
        returns: m.returns ?? 'void',
        params: m.params ?? [],
        ...(m.http ? { endpoint: { transport: 'HTTP', method: m.http.method, path: m.http.path } } : {}),
      })),
    });
    return {
      id: e.id, ...(e.name ? { name: e.name } : {}), subsystem, component, ...(e.interface ? { interface: e.interface } : {}),
      type, ...(e.audience ? { audience: e.audience } : {}), ...(e.version ? { version: e.version } : {}),
      ...(e.stability ? { stability: e.stability } : {}), details: e.details ?? 'd',
    };
  });
  for (const [subsystem, publicInterfaces] of published) {
    writeSpecYaml(path.join(specs, 'subsystems', `${subsystem}.yaml`), {
      id: subsystem, name: subsystem, description: `The ${subsystem} subsystem.`, parentSystem: 'seeded', publicInterfaces,
      status: 'complete', createdAt: now, updatedAt: now,
    });
  }
  const indexPath = path.join(specs, '.index.yaml');
  const system = yaml.load(fs.readFileSync(indexPath, 'utf8')) as Record<string, unknown>;
  system.publicInterfaces = l0;
  fs.writeFileSync(indexPath, yaml.dump(system));
}
