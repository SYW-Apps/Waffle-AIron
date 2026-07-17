import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { WaironError } from '../utils/errors.js';
import * as admin from '../server/admin.js';
import * as packs from '../server/packs.js';
import * as permissionadmin from '../server/permissionadmin.js';
import { mintToken } from '../server/identity.js';
import { upsertUnit as landscapeUpsertUnit } from '../server/landscape.js';
import { migratePermissionModel } from '../server/migration.js';
import { AdminAuthError, LockValidationError } from '../server/admin.js';
import { startHostServer } from '../server/http.js';
import { registerLocalDevProject, existingProjectRoot } from '../server/projects.js';
import { runWithProjectRoot } from '../utils/fs.js';
import { buildCanvasModel } from '../core/canvas.js';
import { seedDemoTree } from '../core/demo-seed.js';
import { upsertIdentityProviderRecord } from '../server/policy.js';
import { setSecret } from '../utils/secrets.js';
import type {
  Capability,
  DisplayRole,
  HostConfig,
  HostExposurePolicy,
  IdentityProviderConfig,
  PermissionValue,
  ScopeKind,
} from '../server/types.js';

// ---------------------------------------------------------------------------
// CLI Host Client Adapter + host command runners (sdd_cli → sdd_host)
//
// The wairon CLI as an in-process client of the hosting control plane: `wairon
// serve` boots the server; `wairon host project|key …`, `wairon host lock`, and
// `wairon host promote` drive the same admin orchestrator functions the HTTP
// admin API uses. The master credential is read from WAIRON_ADMIN_TOKEN, so an
// operator on the box (or via `docker exec`) administers without extra flags.
// ---------------------------------------------------------------------------

export interface HostOptions {
  host?: string;
  port?: string | number;
  adminHost?: string;
  adminPort?: string | number;
  dataDir?: string;
  noAuth?: boolean;
  id?: string;
  unit?: string;
  slug?: string;
  parent?: string;
  kind?: string;
  project?: string;
  role?: string;
  owner?: string;
  label?: string;
  user?: string;
  capability?: string;
  instance?: boolean;
  subsystem?: string;
  message?: string;
  interval?: string | number;
  skipIfClean?: boolean;
  remote?: string;
  branch?: string;
  target?: string;
  page?: string;
  key?: string;
  value?: string;
  name?: string;
  file?: string;
  open?: boolean;
  force?: boolean;
}

function resolveHostConfig(options: HostOptions): HostConfig {
  const dataDir = options.dataDir || process.env['WAIRON_DATA_DIR'] || path.join(os.homedir(), '.wairon', 'data');
  // Server-global packs live on the data volume so installs persist across
  // container recreation — and so the server, `docker exec`, and validation all
  // resolve the same directory. An explicit WAIRON_PACKS_DIR still wins.
  if (!process.env['WAIRON_PACKS_DIR']) {
    process.env['WAIRON_PACKS_DIR'] = path.join(dataDir, 'packs');
  }
  const cfg: HostConfig = {
    host: options.host || '0.0.0.0',
    port: options.port ? Number(options.port) : 8080,
    adminHost: options.adminHost || '127.0.0.1',
    adminPort: options.adminPort ? Number(options.adminPort) : 8081,
    dataDir,
    authEnabled: !options.noAuth,
  };
  // Built-in super-admin WEB login (optional). When either env value is unset,
  // password login is disabled (SSO-only) — the server still starts. The values
  // live only in memory on the resolved config; never persisted or logged.
  const builtinUser = process.env['WAIRON_ADMIN_USER'];
  const builtinPassword = process.env['WAIRON_ADMIN_PASSWORD'];
  if (builtinUser) cfg.builtinAdminUser = builtinUser;
  if (builtinPassword) cfg.builtinAdminPassword = builtinPassword;
  return cfg;
}

function masterCredential(): string | null {
  return process.env['WAIRON_ADMIN_TOKEN'] ?? null;
}

function mapAdminError(e: unknown): WaironError {
  if (e instanceof AdminAuthError) {
    return new WaironError('Forbidden: set WAIRON_ADMIN_TOKEN to the server\'s admin credential to run host commands.');
  }
  if (e instanceof LockValidationError) {
    const lines = e.errors.map((x) => `  • ${x.specId ? `[${x.specId}] ` : ''}[${x.code}] ${x.message}`).join('\n');
    return new WaironError(`${e.message}\n${lines}`);
  }
  return new WaironError(e instanceof Error ? e.message : String(e));
}

// ── declarative env-based identity-provider seeding ─────────────────────────

/** A trimmed env value, or undefined when unset/blank. */
function envTrim(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

/** Split a comma-separated env value into trimmed, non-empty entries. */
function envCsv(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Declarative env-based seeding of the `default` OIDC identity provider, so a
 * whole SSO setup ships in the compose file with no post-deploy clicking.
 * Activates ONLY when WAIRON_OIDC_ISSUER is set; otherwise a no-op. Builds an
 * IdentityProviderConfig (id `default` — the sign-in screen's default provider
 * id — enabled, fields from the WAIRON_OIDC_* env vars), stores a RAW
 * WAIRON_OIDC_CLIENT_SECRET into the host secret store under the fixed ref
 * `oidc-default` (the provider carries only that clientSecretRef — never the
 * raw secret; an existing stored ref may be named via
 * WAIRON_OIDC_CLIENT_SECRET_REF instead), and UPSERTS the provider through the
 * policy repository — the same store the identity plane's
 * upsertIdentityProvider writes to. Server-side bootstrap: no credential is
 * involved, and the upsert is idempotent, so every boot re-seeds declaratively
 * (env is the source of truth for the `default` provider; the web UI still
 * manages providers on top). Exported for tests.
 */
export function seedIdentityProviderFromEnv(cfg: HostConfig): void {
  const issuer = envTrim('WAIRON_OIDC_ISSUER');
  if (!issuer) return; // seeding activates only when the issuer is set

  // The secret store keys off WAIRON_DATA_DIR — anchor it to the resolved data
  // dir when unset (same precedent as WAIRON_PACKS_DIR in resolveHostConfig).
  if (!process.env['WAIRON_DATA_DIR']) {
    process.env['WAIRON_DATA_DIR'] = cfg.dataDir;
  }

  let clientSecretRef = envTrim('WAIRON_OIDC_CLIENT_SECRET_REF');
  const rawSecret = process.env['WAIRON_OIDC_CLIENT_SECRET'];
  if (rawSecret) {
    // RAW secret shipped in env: store it under the fixed ref and point the
    // provider at it — the raw value never lands on the provider record.
    setSecret('oidc-default', rawSecret);
    clientSecretRef = 'oidc-default';
  }

  const config: IdentityProviderConfig = {
    id: 'default', // matches the sign-in screen's default provider id
    providerType: envTrim('WAIRON_OIDC_PROVIDER_TYPE') ?? 'oidc',
    issuerUrl: issuer,
    enabled: true,
    updatedAt: '', // stamped server-side by the policy registry
  };
  // Login-button label (WAIRON_OIDC_DISPLAY_NAME): the sign-in screen renders
  // "Sign in with <displayName>", defaulting to the provider id when unset.
  const displayName = envTrim('WAIRON_OIDC_DISPLAY_NAME');
  if (displayName) config.displayName = displayName;
  const clientId = envTrim('WAIRON_OIDC_CLIENT_ID');
  if (clientId) config.clientId = clientId;
  if (clientSecretRef) config.clientSecretRef = clientSecretRef;
  const adminGroups = envCsv('WAIRON_OIDC_ADMIN_GROUPS');
  if (adminGroups.length) config.adminGroupClaims = adminGroups;
  const redirectUris = envCsv('WAIRON_OIDC_ALLOWED_REDIRECT_URIS');
  if (redirectUris.length) config.allowedRedirectUris = redirectUris;
  const domains = envCsv('WAIRON_OIDC_ALLOWED_DOMAINS');
  if (domains.length) config.allowedDomains = domains;
  // Split-horizon endpoint overrides (public authorize vs VPC-internal back-channel).
  const authorizationEndpoint = envTrim('WAIRON_OIDC_AUTHORIZATION_ENDPOINT');
  if (authorizationEndpoint) config.authorizationEndpoint = authorizationEndpoint;
  const tokenEndpoint = envTrim('WAIRON_OIDC_TOKEN_ENDPOINT');
  if (tokenEndpoint) config.tokenEndpoint = tokenEndpoint;
  const jwksUri = envTrim('WAIRON_OIDC_JWKS_URI');
  if (jwksUri) config.jwksUri = jwksUri;
  const userinfoEndpoint = envTrim('WAIRON_OIDC_USERINFO_ENDPOINT');
  if (userinfoEndpoint) config.userinfoEndpoint = userinfoEndpoint;

  upsertIdentityProviderRecord(cfg.dataDir, config);
  logger.info("seeded identity provider 'default' from env");
}

// ── wairon serve ────────────────────────────────────────────────────────────

export async function runServe(options: HostOptions = {}): Promise<void> {
  const cfg = resolveHostConfig(options);
  // Declarative SSO bootstrap BEFORE the listeners bind, so the provider exists
  // the moment the server accepts its first sign-in.
  try {
    seedIdentityProviderFromEnv(cfg);
  } catch (e) {
    throw new WaironError(
      `Failed to seed identity provider 'default' from WAIRON_OIDC_* env: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  let handle;
  try {
    handle = startHostServer(cfg);
  } catch (e) {
    throw new WaironError(e instanceof Error ? e.message : String(e));
  }
  logger.success('wairon hosting server started.');
  logger.info(`  data plane:  ${chalk.cyan(`http://${cfg.host}:${cfg.port}/mcp`)}   (auth ${cfg.authEnabled ? chalk.green('ON') : chalk.yellow('OFF')})`);
  logger.info(`  admin plane: ${chalk.cyan(`http://${cfg.adminHost}:${cfg.adminPort}/admin`)}`);
  logger.info(`  data dir:    ${chalk.gray(cfg.dataDir)}`);
  logger.blank();
  logger.info('Press Ctrl+C to stop.');
  await new Promise<void>((resolve) => {
    const shutdown = () => {
      logger.info('Shutting down…');
      handle!.close();
      resolve();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}

// ── wairon dev ────────────────────────────────────────────────────────────────
//
// The local single-project developer server: serves the SAME hosted web UI
// (src/server/web.ts serveApp) pointed at the CURRENT project (the cwd's .wai/),
// auto-signed-in, single-project, with no login screen and no tenancy chrome. It
// REUSES the whole hosted web pipeline (web_orchestrator, web_graph_orchestrator,
// the auth bridge, serveApp) — this is NOT a forked/second UI. Loopback ONLY, auth
// off, dev-only. The developer keeps this open while an agent edits specs and
// refreshes to see the live graph (validator issues overlay as ⚠ badges).

/** Best-effort, cross-platform browser open. Never fatal: a headless box has no
 *  browser, so any failure is swallowed and the printed URL stands. */
function openBrowser(url: string): void {
  try {
    const platform = process.platform;
    const cmd = platform === 'win32' ? 'cmd' : platform === 'darwin' ? 'open' : 'xdg-open';
    const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {
      /* no browser available — best-effort */
    });
    child.unref();
  } catch {
    /* opening a browser is best-effort and never fatal */
  }
}

export async function runDev(options: HostOptions = {}): Promise<void> {
  const cwd = process.cwd();
  // The dev server serves the CURRENT project: a .wai/ must be present.
  if (!fs.existsSync(path.join(cwd, '.wai'))) {
    throw new WaironError(
      'No .wai/ found in the current directory. Run `wairon dev` from a wairon project root (or run `wairon init` first).',
    );
  }

  // Ephemeral, per-cwd dev data dir under the OS temp dir — NOT the project's own
  // .wai. A deterministic hash of the cwd keeps it stable across restarts (so the
  // dev session is reused, not churned) while isolating unrelated projects.
  const hash = crypto.createHash('sha256').update(cwd).digest('hex').slice(0, 16);
  const dataDir = path.join(os.tmpdir(), 'wairon-dev', hash);
  fs.mkdirSync(dataDir, { recursive: true });

  // Register the cwd as the single local project 'local' (idempotent upsert). Its
  // rootPath is the cwd itself, so resolveProjectRoot('local') → the cwd, and the
  // whole hosted graph pipeline resolves against the developer's own .wai/ tree.
  registerLocalDevProject(dataDir, 'local', cwd);

  const port = options.port ? Number(options.port) : 8080;
  // A permissive-but-loopback exposure: the web UI on, TLS not required (plain http
  // on 127.0.0.1). devMode independently forces the web UI on in http.ts, so this is
  // belt-and-suspenders; requireTls:false keeps the dev cookie non-Secure over http.
  const exposurePolicy: HostExposurePolicy = {
    adminApiMode: 'local_only',
    adminUiEnabled: true,
    identityApiEnabled: true,
    landscapeApiEnabled: true,
    projectPolicyApiEnabled: true,
    cliControlEnabled: true,
    requireTls: false,
    operationsApiEnabled: true,
    webUiEnabled: true,
  };
  const cfg: HostConfig = {
    host: '127.0.0.1',
    port,
    adminHost: '127.0.0.1',
    adminPort: port + 1,
    dataDir,
    authEnabled: false,
    devMode: true,
    exposurePolicy,
  };

  let handle;
  try {
    handle = startHostServer(cfg);
  } catch (e) {
    throw new WaironError(e instanceof Error ? e.message : String(e));
  }

  const url = `http://127.0.0.1:${port}`;
  logger.success('wairon dev server started (local, single-project, no login).');
  logger.info(`  open:      ${chalk.cyan(url)}`);
  logger.info(`  project:   ${chalk.gray(cwd)}  ${chalk.gray('(served as "local")')}`);
  logger.info(`  data dir:  ${chalk.gray(dataDir)}  ${chalk.gray('(ephemeral)')}`);
  logger.blank();
  logger.info('An agent edits specs; refresh the page to see the live graph. Press Ctrl+C to stop.');

  if (options.open) openBrowser(url);

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      logger.info('Shutting down…');
      handle!.close();
      resolve();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}

// ── wairon host project <action> ──────────────────────────────────────────────

export async function runHostProject(action: string, options: HostOptions = {}): Promise<void> {
  const cfg = resolveHostConfig(options);
  const cred = masterCredential();
  try {
    switch (action) {
      case 'create': {
        if (!options.id) throw new WaironError('`--id <id>` is required for `host project create`.');
        if (!options.unit) {
          throw new WaironError(
            '`--unit <unitId>` is required for `host project create` — every project is placed in an organization unit at creation.',
          );
        }
        const rec = admin.createProject(cfg, cred, options.id, options.unit);
        logger.success(`Created project "${rec.id}" at ${chalk.gray(rec.rootPath)}`);
        break;
      }
      case 'list': {
        const list = admin.listProjects(cfg, cred);
        if (!list.length) {
          logger.info('No projects.');
        } else {
          for (const r of list) logger.info(`  ${r.id.padEnd(20)} ${r.status.padEnd(9)} ${chalk.gray(r.rootPath)}`);
        }
        break;
      }
      case 'destroy': {
        if (!options.id) throw new WaironError('`--id <id>` is required for `host project destroy`.');
        admin.destroyProject(cfg, cred, options.id);
        logger.success(`Destroyed project "${options.id}".`);
        break;
      }
      default:
        throw new WaironError(`Unknown project action "${action}" (create | list | destroy).`);
    }
  } catch (e) {
    throw mapAdminError(e);
  }
}

// ── wairon host demo ──────────────────────────────────────────────────────────

/**
 * Provision a project and seed it with the rich "ShopFlow" example spec tree, so
 * the architecture canvas renders substantial content across all views. Every
 * project is placed in an organization unit at creation (permission model), so
 * this first ensures an owner unit exists (idempotent upsert; defaults to a root
 * unit named after `--unit`, default "demo"). `--force` destroys and reseeds an
 * existing project instead of erroring.
 */
export async function runHostDemo(options: HostOptions = {}): Promise<void> {
  const cfg = resolveHostConfig(options);
  const cred = masterCredential();
  const id = options.id || 'demo';
  const unitId = options.unit || 'demo';
  try {
    // Ensure the owner unit exists (idempotent — updates it if already present).
    landscapeUpsertUnit(cfg, cred, {
      id: unitId,
      name: unitId,
      slug: unitId,
      kind: 'team',
      status: 'active',
      createdAt: '',
      createdBy: { userId: 'master', kind: 'service', issuer: 'local' },
    });

    const existing = existingProjectRoot(cfg.dataDir, id);
    if (existing && !options.force) {
      throw new WaironError(
        `Project "${id}" already exists at ${existing}. Re-run with --force to destroy and reseed it.`,
      );
    }
    if (existing) admin.destroyProject(cfg, cred, id);
    const rec = admin.createProject(cfg, cred, id, unitId);

    const summary = runWithProjectRoot(rec.rootPath, () => {
      seedDemoTree();
      const model = buildCanvasModel();
      return {
        subsystems: model.subsystems.length,
        components: model.components.length,
        edges: model.edges.length,
        crossEdges: model.edges.filter((e) => e.cross).length,
        types: model.types.length,
        typeEdges: model.typeEdges.length,
        databases: model.system.databases?.length ?? 0,
        narratives: model.components.reduce((n, c) => n + c.narratives.length, 0),
      };
    });

    logger.success(`Seeded demo project "${rec.id}" at ${chalk.gray(rec.rootPath)}`);
    logger.info(
      `  ${summary.subsystems} subsystems · ${summary.components} components · ${summary.edges} dependency edges (${summary.crossEdges} cross-subsystem)`,
    );
    logger.info(
      `  ${summary.types} types · ${summary.typeEdges} ERD edges · ${summary.databases} databases · ${summary.narratives} narratives`,
    );
    logger.blank();
    logger.info(`Explore it in the web UI canvas (Components / Types / Databases / Flow).`);
  } catch (e) {
    throw mapAdminError(e);
  }
}

// ── wairon host unit <action> ─────────────────────────────────────────────────

export async function runHostUnit(action: string, options: HostOptions = {}): Promise<void> {
  const cfg = resolveHostConfig(options);
  const cred = masterCredential();
  try {
    switch (action) {
      case 'create': {
        if (!options.slug) throw new WaironError('`--slug <slug>` is required for `host unit create`.');
        // A unit's qualified dot-path id is its parent's id + '.' + slug; a root
        // unit's id IS its slug.
        const qualifiedId = options.parent ? `${options.parent}.${options.slug}` : options.slug;
        const stored = landscapeUpsertUnit(cfg, cred, {
          id: qualifiedId,
          name: options.name ?? options.slug,
          slug: options.slug,
          kind: options.kind ?? 'team',
          ...(options.parent ? { parentId: options.parent } : {}),
          status: 'active',
          createdAt: '',
          createdBy: { userId: 'master', kind: 'service', issuer: 'local' },
        });
        logger.success(`Created organization unit "${stored.id}".`);
        break;
      }
      default:
        throw new WaironError(`Unknown unit action "${action}" (create).`);
    }
  } catch (e) {
    throw mapAdminError(e);
  }
}

// ── wairon host doctor ────────────────────────────────────────────────────────

/**
 * Inspect a hosted data dir for pre-permission-model shapes and (with --fix)
 * migrate them in place: stored grants → grid assignments, ownerless keys →
 * synthesized service owners carrying their legacy authority, units → slugs +
 * qualified dot-path ids with every reference remapped, unplaced projects →
 * the 'unassigned' root unit, legacy builtin sessions/keys → revoked. This
 * migration is REQUIRED at rollout: without it every existing user and token
 * resolves to zero permissions under the live-owner model.
 */
export async function runHostDoctor(options: HostOptions & { fix?: boolean } = {}): Promise<void> {
  const cfg = resolveHostConfig(options);
  const report = migratePermissionModel(cfg.dataDir, options.fix === true);
  if (report.findings.length === 0) {
    logger.success('Hosted data is on the permission model — nothing to migrate.');
    return;
  }
  logger.info(`${report.findings.length} finding(s)${report.applied ? ' — applied' : ' (dry run; re-run with --fix to apply)'}:`);
  for (const f of report.findings) {
    logger.info(`  [${f.area.padEnd(8)}] ${f.detail}`);
  }
  if (!report.applied) {
    logger.warn('NOT applied. Without --fix, pre-permission-model users and tokens resolve to ZERO permissions.');
  }
}

// ── wairon host permission <action> ──────────────────────────────────────────

const CAPABILITIES: Capability[] = ['project:read', 'project:create', 'project:write', 'project:admin', 'approval:decide'];
const PERMISSION_VALUES: PermissionValue[] = ['yes', 'approval', 'no', 'inherit'];

/** The assignment scope from the mutually exclusive --project/--unit/--instance flags. */
function resolveScopeOptions(options: HostOptions): { kind: ScopeKind; id?: string } {
  if (options.project) return { kind: 'project', id: options.project };
  if (options.unit) return { kind: 'unit', id: options.unit };
  return { kind: 'instance' };
}

export async function runHostPermission(action: string, options: HostOptions = {}): Promise<void> {
  const cfg = resolveHostConfig(options);
  const cred = masterCredential();
  try {
    switch (action) {
      case 'set': {
        if (!options.user) throw new WaironError('`--user <userId>` is required for `host permission set`.');
        if (!options.capability || !CAPABILITIES.includes(options.capability as Capability)) {
          throw new WaironError(`\`--capability\` must be one of: ${CAPABILITIES.join(', ')}.`);
        }
        const value = (options.value ?? 'yes') as PermissionValue;
        if (!PERMISSION_VALUES.includes(value)) {
          throw new WaironError(`\`--value\` must be one of: ${PERMISSION_VALUES.join(', ')}.`);
        }
        const scope = resolveScopeOptions(options);
        const stored = permissionadmin.setAssignment(cfg, cred, {
          id: '',
          subjectKind: 'user',
          subjectId: options.user,
          scopeKind: scope.kind,
          ...(scope.id !== undefined ? { scopeId: scope.id } : {}),
          capability: options.capability as Capability,
          value,
          createdAt: '',
        });
        logger.success(
          `Assignment ${stored.id}: ${options.user} ${options.capability}=${value} @ ${scope.kind}${scope.id ? ` ${scope.id}` : ''}`,
        );
        break;
      }
      case 'list': {
        const scope = resolveScopeOptions(options);
        const list = permissionadmin.listAssignments(
          cfg,
          cred,
          options.project || options.unit || options.instance ? scope.kind : undefined,
          scope.id,
          options.user ? 'user' : undefined,
          options.user,
        );
        if (!list.length) {
          logger.info('No assignments.');
        } else {
          for (const a of list) {
            const subject = a.subjectKind === 'everyone' ? 'everyone' : a.subjectId;
            logger.info(`  ${a.id}  ${String(subject).padEnd(20)} ${a.capability.padEnd(16)} ${a.value.padEnd(9)} ${a.scopeKind}${a.scopeId ? ` ${a.scopeId}` : ''}`);
          }
        }
        break;
      }
      case 'remove': {
        if (!options.id) throw new WaironError('`--id <assignmentId>` is required for `host permission remove`.');
        permissionadmin.removeAssignment(cfg, cred, options.id);
        logger.success(`Removed assignment "${options.id}".`);
        break;
      }
      default:
        throw new WaironError(`Unknown permission action "${action}" (set | list | remove).`);
    }
  } catch (e) {
    throw mapAdminError(e);
  }
}

// ── wairon host key <action> ──────────────────────────────────────────────────

export async function runHostKey(action: string, options: HostOptions = {}): Promise<void> {
  const cfg = resolveHostConfig(options);
  const cred = masterCredential();
  try {
    switch (action) {
      case 'mint': {
        if (!options.project) throw new WaironError('`--project <id|*>` is required for `host key mint`.');
        // Owner-bound mint (the assignment-model path): the token carries NO
        // permissions — it acts as the owner's LIVE permission, narrowed to the
        // named project. Seed the owner's authority with `host permission set`.
        if (options.owner) {
          const key = mintToken(cfg, cred, {
            ownerUserId: options.owner,
            label: options.label ?? `cli token (${options.project})`,
            projects: options.project === '*' ? ['*'] : [options.project],
          });
          logger.success(`API key minted for owner "${options.owner}" (shown once — store it now):`);
          logger.blank();
          console.log(`  ${chalk.bold(key)}`);
          logger.blank();
          break;
        }
        const role = (options.role ?? 'editor') as DisplayRole;
        if (role !== 'editor' && role !== 'admin') throw new WaironError('`--role` must be editor or admin.');
        const key = admin.mintKey(cfg, cred, options.project, role);
        logger.success('API key minted (shown once — store it now):');
        logger.blank();
        console.log(`  ${chalk.bold(key)}`);
        logger.blank();
        logger.warn(
          'This key has NO owner: under the permission model it resolves to ZERO permissions ' +
            'on the data plane. Mint with `--owner <userId>` and seed authority with `host permission set`.',
        );
        break;
      }
      case 'list': {
        const list = admin.listKeys(cfg, cred, options.project ?? '*');
        if (!list.length) {
          logger.info('No keys.');
        } else {
          for (const r of list) logger.info(`  ${r.id}  ${(r.role ?? 'editor').padEnd(6)} ${r.projects.join(',')}`);
        }
        break;
      }
      case 'revoke': {
        if (!options.id) throw new WaironError('`--id <id>` is required for `host key revoke`.');
        admin.revokeKey(cfg, cred, options.id);
        logger.success(`Revoked key "${options.id}".`);
        break;
      }
      default:
        throw new WaironError(`Unknown key action "${action}" (mint | list | revoke).`);
    }
  } catch (e) {
    throw mapAdminError(e);
  }
}

// ── wairon host lock / promote ────────────────────────────────────────────────

export async function runHostLock(options: HostOptions = {}): Promise<void> {
  const cfg = resolveHostConfig(options);
  if (!options.project) throw new WaironError('`--project <id>` is required for `host lock`.');
  try {
    const rec = admin.lockProject(cfg, masterCredential(), options.project);
    logger.success(`Locked "${options.project}" @ ${rec.stateId.algorithm}:${rec.stateId.digest.slice(0, 12)}… (status ${rec.status}).`);
  } catch (e) {
    throw mapAdminError(e);
  }
}

export async function runHostPromote(options: HostOptions = {}): Promise<void> {
  const cfg = resolveHostConfig(options);
  if (!options.project) throw new WaironError('`--project <id>` is required for `host promote`.');
  try {
    const result = admin.promoteProject(cfg, masterCredential(), options.project);
    const mark = result.status === 'ready' ? chalk.green('✓') : chalk.yellow('✗');
    logger.info(`${mark} ${result.message}`);
    if (result.status !== 'ready') process.exitCode = 1;
  } catch (e) {
    throw mapAdminError(e);
  }
}

// ── wairon host git <action> ──────────────────────────────────────────────────

// ── wairon host producer <action> ─────────────────────────────────────────────

export async function runHostProducer(action: string, options: HostOptions = {}): Promise<void> {
  const cfg = resolveHostConfig(options);
  const cred = masterCredential();
  const target = options.target ?? 'notion';
  try {
    switch (action) {
      case 'configure': {
        if (!options.project || !options.page) throw new WaironError('`--project <id>` and `--page <id>` are required.');
        admin.configureProducer(cfg, cred, options.project, target, options.page);
        logger.success(`Configured "${target}" for project "${options.project}".`);
        break;
      }
      case 'produce': {
        if (!options.project) throw new WaironError('`--project <id>` is required.');
        await admin.produceProducer(cfg, cred, options.project, target);
        logger.success(`Produced "${options.project}" to "${target}".`);
        break;
      }
      case 'remove': {
        if (!options.project) throw new WaironError('`--project <id>` is required.');
        admin.removeProducer(cfg, cred, options.project, target);
        logger.success(`Removed "${target}" from project "${options.project}".`);
        break;
      }
      case 'list': {
        if (!options.project) throw new WaironError('`--project <id>` is required.');
        const list = admin.listProducers(cfg, cred, options.project);
        if (!list.length) logger.info('No producers configured.');
        else for (const p of list) logger.info(`  ${p.target.padEnd(10)} → ${p.parentPageId}`);
        break;
      }
      default:
        throw new WaironError(`Unknown producer action "${action}" (configure | produce | remove | list).`);
    }
  } catch (e) {
    throw mapAdminError(e);
  }
}

// ── wairon host secret <action> ───────────────────────────────────────────────

export async function runHostSecret(action: string, options: HostOptions = {}): Promise<void> {
  const cfg = resolveHostConfig(options);
  const cred = masterCredential();
  try {
    switch (action) {
      case 'set': {
        if (!options.key || options.value === undefined) throw new WaironError('`--key <name>` and `--value <secret>` are required.');
        admin.setSecret(cfg, cred, options.key, options.value);
        logger.success(`Secret "${options.key}" set (read live — no restart needed).`);
        break;
      }
      case 'list': {
        const keys = admin.listSecrets(cfg, cred);
        if (!keys.length) logger.info('No secrets set.');
        else for (const k of keys) logger.info(`  ${k}`);
        break;
      }
      default:
        throw new WaironError(`Unknown secret action "${action}" (set | list).`);
    }
  } catch (e) {
    throw mapAdminError(e);
  }
}

// ── wairon host packs <action> ────────────────────────────────────────────────

export async function runHostPacks(action: string, options: HostOptions = {}): Promise<void> {
  const cfg = resolveHostConfig(options);
  const cred = masterCredential();
  const project = options.project;
  const scope = project ? `project "${project}"` : 'server-global';
  try {
    switch (action) {
      case 'list': {
        const list = project ? packs.listProjectPacks(cfg, cred, project) : packs.listGlobalPacks(cfg, cred);
        if (!list.length) {
          logger.info(`No ${scope} packs.`);
          break;
        }
        logger.info(`${scope} packs:`);
        for (const p of list) {
          if (p.error) console.log(`  ${chalk.red('✖')} ${chalk.bold(p.name)}  ${chalk.red(p.error)}`);
          else console.log(`  ${chalk.green('●')} ${chalk.bold(p.name.padEnd(20))} ${chalk.gray(`${p.profiles} profile(s), ${p.languages} language(s), ${p.rules} rule(s)`)}`);
        }
        break;
      }
      case 'install': {
        if (!options.file) throw new WaironError('`--file <path>` (a declarative pack YAML) is required for install.');
        const name = options.name ?? path.basename(options.file).replace(/\.(ya?ml)$/i, '');
        const content = fs.readFileSync(path.resolve(options.file), 'utf8');
        const desc = project
          ? packs.installProjectPack(cfg, cred, project, name, content)
          : packs.installGlobalPack(cfg, cred, name, content);
        logger.success(`Installed ${scope} pack "${desc.name}" (${desc.profiles} profile(s), ${desc.languages} language(s)).`);
        if (project) logger.info('Committed with the project — every clone and CI will enforce it.');
        break;
      }
      case 'remove': {
        if (!options.name) throw new WaironError('`--name <name>` is required for `host packs remove`.');
        if (project) packs.removeProjectPack(cfg, cred, project, options.name);
        else packs.removeGlobalPack(cfg, cred, options.name);
        logger.success(`Removed ${scope} pack "${options.name}".`);
        break;
      }
      default:
        throw new WaironError(`Unknown packs action "${action}" (list | install | remove).`);
    }
  } catch (e) {
    throw mapAdminError(e);
  }
}

export async function runHostGit(action: string, options: HostOptions = {}): Promise<void> {
  const cfg = resolveHostConfig(options);
  const cred = masterCredential();
  try {
    switch (action) {
      case 'enable': {
        if (!options.project || !options.remote) {
          throw new WaironError('`--project <id>` and `--remote <url>` are required for `host git enable`.');
        }
        admin.enableGit(cfg, cred, options.project, options.remote, options.branch ?? 'main');
        logger.success(`Git backing enabled for "${options.project}" (cloned ${options.remote}).`);
        break;
      }
      case 'disable': {
        if (!options.project) throw new WaironError('`--project <id>` is required for `host git disable`.');
        admin.disableGit(cfg, cred, options.project);
        logger.success(`Git backing disabled for "${options.project}".`);
        break;
      }
      case 'sync': {
        if (!options.project) throw new WaironError('`--project <id>` is required for `host git sync`.');
        admin.syncGit(cfg, cred, options.project);
        logger.success(`Synced "${options.project}" (default → working branch).`);
        break;
      }
      case 'commit': {
        if (!options.project) throw new WaironError('`--project <id>` is required for `host git commit`.');
        const publish = admin.commitProject(cfg, cred, options.project, options.subsystem, options.message);
        if (!publish.published) {
          logger.info('Nothing to publish — the scoped .wai/ path is clean (or the project is not git-backed).');
        } else {
          logger.success(`Published ${publish.commitSha?.slice(0, 12)}…${publish.compareUrl ? ` (${publish.compareUrl})` : ''}`);
        }
        break;
      }
      case 'status': {
        if (!options.project) throw new WaironError('`--project <id>` is required for `host git status`.');
        const s = admin.getGitBinding(cfg, cred, options.project);
        if (!s.enabled) {
          logger.info('Not git-backed.');
        } else {
          logger.info(`  remote:   ${s.remote}`);
          logger.info(`  branch:   ${s.branch} (working: ${s.workingBranch})`);
          logger.info(`  dirty:    ${s.dirty === true ? 'yes (.wai/ has unpublished changes)' : 'no'}`);
          logger.info(`  sync:     ${s.periodicSyncMinutes !== undefined ? `every ${s.periodicSyncMinutes}m (skip-if-clean: ${s.skipIfClean !== false})` : 'manual only'}`);
          if (s.lastSyncAt) logger.info(`  last:     ${s.lastSyncAt}`);
        }
        break;
      }
      case 'sync-config': {
        if (!options.project) throw new WaironError('`--project <id>` is required for `host git sync-config`.');
        const minutes = options.interval !== undefined ? Number(options.interval) : undefined;
        admin.configureGitSync(cfg, cred, options.project, minutes, options.skipIfClean);
        logger.success(
          minutes !== undefined
            ? `Periodic sync every ${minutes}m for "${options.project}".`
            : `Periodic sync disabled for "${options.project}".`,
        );
        break;
      }
      default:
        throw new WaironError(`Unknown git action "${action}" (enable | disable | sync | commit | status | sync-config).`);
    }
  } catch (e) {
    throw mapAdminError(e);
  }
}
