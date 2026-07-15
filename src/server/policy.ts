import * as fs from 'fs';
import * as path from 'path';
import type { IncomingMessage, ServerResponse } from 'http';
import { runWithProjectRoot } from '../utils/fs.js';
import { readYamlFile, writeYamlFile } from '../utils/yaml.js';
import { AI_PATHS } from '../config/loader.js';
import { globalPacksDir, discoverPacks } from '../core/extensions.js';
import { authenticateCredential } from './auth.js';
import { UnauthenticatedError, ForbiddenError } from './errors.js';
import { executeApprovedCreate } from './admin.js';
import { resolveProjectRoot } from './projects.js';
import { resolveScopeFor, permits } from './scope.js';
import { appendAuditEvent, DEFAULT_AUDIT_POLICY } from './audit.js';
import { sendJson } from './httpio.js';
import * as packs from './packs.js';
import type {
  AuditEvent,
  AuditRetentionPolicy,
  HostConfig,
  HostedProjectRecord,
  IdentityProviderConfig,
  InstancePackPolicy,
  PolicyEvaluationResult,
  Principal,
  PrincipalSubject,
  ProjectInitRequest,
  ProjectProfileSelection,
} from './types.js';

// ---------------------------------------------------------------------------
// Pack/Profile Policy plane (sdd_host) — Phase 3
//
// Two layers live here, mirroring the spec tree:
//
//   1. Policy Repository (store + registry + index + facade) — the durable,
//      single-record instance pack/profile policy at <dataDir>/pack-policy.json.
//      Exported as getPackPolicyRecord / setPackPolicyRecord: pure storage, no
//      authorization, no null-substitution. The registry stamps updatedAt
//      server-side and preserves the orchestrator-supplied updatedBy; writes go
//      through write-temp-then-rename; a missing file reads as null and malformed
//      JSON fails with a storage error naming the path (losing a persisted policy
//      would silently relax enforcement).
//
//   2. Project Policy Orchestrator + Portal — profile-aware project init and
//      pack/profile policy enforcement. Credential-bearing methods authenticate
//      and authorize by Principal grants; two pre-authorized entries
//      (executeApprovedInit, evaluateInitRequest) serve the self-service approval
//      chain and are never portal-exposed. A null active policy resolves to the
//      documented PERMISSIVE_DEFAULT_POLICY. Audit appends are best-effort and
//      never fail the primary action.
// ---------------------------------------------------------------------------

// ── Policy Repository: single-record storage facade ─────────────────────────

function packPolicyPath(dataDir: string): string {
  return path.join(dataDir, 'pack-policy.json');
}

/**
 * policy_store.load → policy_index.getPackPolicy → policy_repository.getPackPolicy.
 * Read the single persisted active policy record. A missing file yields null (no
 * policy ever configured — the orchestrator substitutes the permissive default);
 * an unreadable file or structurally invalid JSON fails with a storage error
 * naming the path.
 */
export function getPackPolicyRecord(dataDir: string): InstancePackPolicy | null {
  const p = packPolicyPath(dataDir);
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`Failed to read pack policy store at ${p}: ${(e as Error).message}`);
  }
  try {
    return JSON.parse(raw) as InstancePackPolicy;
  } catch (e) {
    throw new Error(`Pack policy store at ${p} contains malformed JSON: ${(e as Error).message}`);
  }
}

/**
 * policy_registry.setPackPolicy → policy_repository.setPackPolicy. Persist the
 * supplied policy as the replacement active record: stamp updatedAt server-side
 * (preserving the orchestrator-supplied updatedBy and the caller's lists/posture
 * verbatim), write the single record via write-temp-then-rename, and return the
 * stored policy. A persistence failure leaves the previous record intact.
 */
export function setPackPolicyRecord(dataDir: string, policy: InstancePackPolicy): InstancePackPolicy {
  const stored: InstancePackPolicy = { ...policy, updatedAt: new Date().toISOString() };
  const p = packPolicyPath(dataDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(stored, null, 2) + '\n');
  fs.renameSync(tmp, p);
  return stored;
}

/**
 * The documented permissive default the ORCHESTRATOR substitutes for a null
 * active policy (empty pack lists, requireProfileSelection false, enforcementMode
 * 'warn'). Never persisted and never returned by the storage facade — a null
 * record stays null at the repository boundary.
 */
export const PERMISSIVE_DEFAULT_POLICY: InstancePackPolicy = {
  id: 'permissive-default',
  requiredGlobalPacks: [],
  defaultProjectPacks: [],
  allowedProfileIds: [],
  requiredProfileIds: [],
  blockedPackNames: [],
  requireProfileSelection: false,
  enforcementMode: 'warn',
  updatedAt: '',
};

/** The active policy or the permissive default when none has ever been configured. */
function effectivePolicy(dataDir: string): InstancePackPolicy {
  return getPackPolicyRecord(dataDir) ?? PERMISSIVE_DEFAULT_POLICY;
}

// ── Policy Repository: identity-provider (SSO) collection storage ─────────────
//
// The same policy store also holds the identity-provider (SSO) configuration
// collection, file-backed at <dataDir>/identity-providers.json. Same storage
// discipline as the pack policy: a missing file reads as an empty collection,
// malformed JSON fails with a storage error naming the path (losing a provider
// would silently disable sign-in), and writes go through write-temp-then-rename.
// The registry stamps updatedAt server-side and persists only a clientSecretRef
// into the host secret mechanism — never a raw client secret — so the whole
// config is whitelist-projected to the persisted type before it is written.

function identityProvidersPath(dataDir: string): string {
  return path.join(dataDir, 'identity-providers.json');
}

/**
 * Whitelist-project an identity-provider config to exactly the fields the type
 * defines, dropping anything outside it (e.g. a raw clientSecret an caller might
 * have attached) so no secret is ever persisted; clientSecretRef is preserved
 * verbatim. Optional fields are copied only when present.
 */
function sanitizeIdentityProvider(config: IdentityProviderConfig): IdentityProviderConfig {
  const clean: IdentityProviderConfig = {
    id: config.id,
    providerType: config.providerType,
    enabled: config.enabled,
    updatedAt: config.updatedAt,
  };
  if (config.displayName !== undefined) clean.displayName = config.displayName;
  if (config.issuerUrl !== undefined) clean.issuerUrl = config.issuerUrl;
  if (config.clientId !== undefined) clean.clientId = config.clientId;
  if (config.clientSecretRef !== undefined) clean.clientSecretRef = config.clientSecretRef;
  if (config.allowedDomains !== undefined) clean.allowedDomains = config.allowedDomains;
  if (config.adminGroupClaims !== undefined) clean.adminGroupClaims = config.adminGroupClaims;
  if (config.allowedRedirectUris !== undefined) clean.allowedRedirectUris = config.allowedRedirectUris;
  if (config.authorizationEndpoint !== undefined) clean.authorizationEndpoint = config.authorizationEndpoint;
  if (config.tokenEndpoint !== undefined) clean.tokenEndpoint = config.tokenEndpoint;
  if (config.jwksUri !== undefined) clean.jwksUri = config.jwksUri;
  if (config.userinfoEndpoint !== undefined) clean.userinfoEndpoint = config.userinfoEndpoint;
  return clean;
}

/** Persist the whole identity-provider collection atomically (write-temp-then-rename). */
function writeIdentityProviderRecords(dataDir: string, records: IdentityProviderConfig[]): void {
  const p = identityProvidersPath(dataDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(records, null, 2) + '\n');
  fs.renameSync(tmp, p);
}

/**
 * policy_store.load → policy_index.listIdentityProviders →
 * policy_repository.listIdentityProviders. Read every configured identity
 * provider. A missing file yields an empty collection (none ever configured); an
 * unreadable file or structurally invalid JSON fails with a storage error naming
 * the path (losing a persisted provider would silently disable sign-in).
 */
export function listIdentityProviderRecords(dataDir: string): IdentityProviderConfig[] {
  const p = identityProvidersPath(dataDir);
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(`Failed to read identity provider store at ${p}: ${(e as Error).message}`);
  }
  try {
    return JSON.parse(raw) as IdentityProviderConfig[];
  } catch (e) {
    throw new Error(`Identity provider store at ${p} contains malformed JSON: ${(e as Error).message}`);
  }
}

/**
 * policy_registry.upsertIdentityProvider → policy_repository.upsertIdentityProvider.
 * Create or update one identity-provider configuration by id: stamp updatedAt
 * server-side, whitelist-project the config to the persisted type (dropping any
 * field outside it so a raw client secret can never be written, preserving
 * clientSecretRef verbatim), insert or replace it in place within the collection,
 * persist the whole collection via write-temp-then-rename, and return the stored
 * config. A persistence failure leaves the previous collection intact.
 */
export function upsertIdentityProviderRecord(
  dataDir: string,
  config: IdentityProviderConfig,
): IdentityProviderConfig {
  const stored = sanitizeIdentityProvider({ ...config, updatedAt: new Date().toISOString() });
  const records = listIdentityProviderRecords(dataDir);
  const idx = records.findIndex((c) => c.id === stored.id);
  if (idx >= 0) records[idx] = stored;
  else records.push(stored);
  writeIdentityProviderRecords(dataDir, records);
  return stored;
}

/**
 * policy_registry.removeIdentityProvider → policy_repository.removeIdentityProvider.
 * Remove one identity-provider configuration by id, rejecting an unknown id with a
 * not-found error; otherwise persist the reduced collection via
 * write-temp-then-rename. A persistence failure leaves the previous collection
 * intact.
 */
export function removeIdentityProviderRecord(dataDir: string, id: string): void {
  const records = listIdentityProviderRecords(dataDir);
  const next = records.filter((c) => c.id !== id);
  if (next.length === records.length) {
    throw new Error(`Identity provider "${id}" not found.`);
  }
  writeIdentityProviderRecords(dataDir, next);
}

// ── grant vocabulary + authorization helpers (mirrored from identity.ts) ─────
//
// '*' is the wildcard in BOTH projectId and permissions (per the grant model).
// A grant that ALSO names an orgUnitId is UNIT-scoped by intent even when its
// projectId is the '*' wildcard (the shape an operator enters for a delegated
// unit/department admin) — it must never satisfy an instance-wide check here
// (the `!orgUnitId` discipline of scope.ts / request.ts / web.ts and the
// canonical identity.ts helpers; keep this copy in lockstep).
//
// Project-scoped methods (evaluateProjectPolicy, reconcileProjectPolicy)
// authorize on the RESOLVED, org-unit-aware mcp:write scope (scope_specialist:
// resolveScopeFor + permits) — a unit admin is first-class over the projects
// placed in its subtree, and a genuine instance-wide grant resolves to
// scope.all. Only the instance-WIDE capabilities (initializeProjectWithProfile,
// setPackPolicy) stay on the flat carriesInstancePermission check by design.

const PROJECT_CREATE_PERMISSION = 'project:create';
const MCP_WRITE_PERMISSION = 'mcp:write';
const POLICY_MANAGE_PERMISSION = 'policy:manage';

// An instance-wide capability requires a grant scoped to ALL projects (a genuine
// '*', no orgUnitId) carrying the permission (or the '*' wildcard). A project- or
// unit-scoped grant, even one carrying the permission, does NOT confer
// instance-wide reach.
function carriesInstancePermission(principal: Principal, permission: string): boolean {
  return (principal.grants ?? []).some(
    (g) =>
      g.projectId === '*' &&
      !g.orgUnitId &&
      (g.permissions.includes('*') || g.permissions.includes(permission)),
  );
}

/** Authenticate the caller credential or throw (401-mapping). */
function requirePrincipal(cfg: HostConfig, credential: string | null): Principal {
  const principal = authenticateCredential(cfg.dataDir, credential);
  if (!principal.authenticated) throw new UnauthenticatedError();
  return principal;
}

// ── subject / audit helpers (mirrored from identity.ts / selfservice.ts) ─────

/** The stable subject for a principal: its resolved subject, or a synthesized
 *  service identity keyed by the credential's token id for legacy credentials. */
function principalSubject(principal: Principal): PrincipalSubject {
  return (
    principal.subject ?? { userId: 'token:' + principal.tokenId, kind: 'service', issuer: 'local' }
  );
}

/** The audit actor for the pre-authorized (no-principal) init path. */
const SYSTEM_SUBJECT: PrincipalSubject = { userId: 'system', kind: 'service', issuer: 'local' };

function resolveAuditPolicy(_cfg: HostConfig): AuditRetentionPolicy {
  return DEFAULT_AUDIT_POLICY;
}

function buildAuditEvent(
  actor: PrincipalSubject,
  action: string,
  level: string,
  category: string,
  over: Partial<AuditEvent> = {},
  tokenId?: string,
): AuditEvent {
  const event: AuditEvent = {
    id: '',
    timestamp: '',
    level,
    category,
    action,
    outcome: 'success',
    actor,
    ...over,
  };
  if (tokenId) event.tokenId = tokenId;
  return event;
}

/** Append a redacted audit event, best-effort: a failure is recorded as a server
 *  diagnostic and swallowed so an append can never fail the primary action. */
function tryAppendAudit(cfg: HostConfig, event: AuditEvent): void {
  try {
    appendAuditEvent(cfg.dataDir, event, resolveAuditPolicy(cfg));
  } catch (err) {
    console.error(
      `[policy] audit append failed for "${event.action}": ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

// ── pack registry helpers ────────────────────────────────────────────────────
//
// Applying required/default packs vendors the server-global declarative pack
// into the bound project through the pack registry's pre-authorized entries —
// the caller was already authorized for the initialization/reconciliation, so
// no credential is re-presented (same idiom as admin.ts executeApproved*).

/** The name stem of a pack ref (basename without a pack extension). */
function packStem(ref: string): string {
  return path.basename(ref).replace(/\.(ya?ml|cjs|js)$/i, '');
}

/** Resolve one named pack's declarative content from the server-global pack set,
 *  or null when the global set carries no such pack. */
function readGlobalPackContent(name: string): string | null {
  const dir = globalPacksDir();
  for (const candidate of [path.join(dir, `${name}.yaml`), path.join(dir, `${name}.yml`)]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return fs.readFileSync(candidate, 'utf8');
    }
  }
  const match = discoverPacks(dir).find((ref) => packStem(ref) === name || path.basename(ref) === name);
  if (match && fs.statSync(match).isFile()) return fs.readFileSync(match, 'utf8');
  return null;
}

/** The active declarative pack names installed in a bound project. */
function installedPackNames(cfg: HostConfig, projectId: string): string[] {
  return packs.executeApprovedListProjectPacks(cfg, projectId).map((d) => d.name);
}

/** Vendor and register each named declarative pack into the bound project,
 *  skipping any name the server-global set cannot resolve. */
function installPacks(cfg: HostConfig, projectId: string, names: Iterable<string>): void {
  for (const name of new Set(names)) {
    const content = readGlobalPackContent(name);
    if (content) packs.executeApprovedInstallProjectPack(cfg, projectId, name, content);
  }
}

// ── project config: recorded profile selection ───────────────────────────────
//
// project_config carries an optional profileSelection (see the ProjectConfig
// spec). The ProjectConfig zod schema does not yet model it, so we read/write the
// raw project.yaml directly to avoid the schema stripping the key on a round trip.

function readProjectProfileSelection(root: string): ProjectProfileSelection | undefined {
  return runWithProjectRoot(root, () => {
    const raw = readYamlFile(AI_PATHS.projectConfig()) as
      | { profileSelection?: ProjectProfileSelection }
      | null;
    return raw?.profileSelection;
  });
}

function recordProjectProfileSelection(root: string, selection: ProjectProfileSelection): void {
  runWithProjectRoot(root, () => {
    const raw = (readYamlFile(AI_PATHS.projectConfig()) ?? {}) as Record<string, unknown>;
    raw['profileSelection'] = selection;
    writeYamlFile(AI_PATHS.projectConfig(), raw);
  });
}

/** The pack names a ProjectInitRequest's profile selection carries. */
function requestPackNames(request: ProjectInitRequest): string[] {
  const sel = request.profileSelection;
  if (!sel) return [];
  return [...new Set([...(sel.requiredPackNames ?? []), ...(sel.defaultPackNames ?? [])])];
}

/** The resolved ProjectProfileSelection recorded onto an initialized project: the
 *  request's selected profile ids plus the policy's required profile ids, and the
 *  policy's required/default pack names merged with the request's own. */
function resolvedSelection(
  request: ProjectInitRequest,
  policy: InstancePackPolicy,
  selectedBy?: PrincipalSubject,
): ProjectProfileSelection {
  const sel = request.profileSelection;
  const selection: ProjectProfileSelection = {
    profileIds: [...new Set([...(sel?.profileIds ?? []), ...(policy.requiredProfileIds ?? [])])],
    requiredPackNames: [...new Set([...policy.requiredGlobalPacks, ...(sel?.requiredPackNames ?? [])])],
    defaultPackNames: [...new Set([...policy.defaultProjectPacks, ...(sel?.defaultPackNames ?? [])])],
    selectedAt: new Date().toISOString(),
  };
  if (selectedBy) selection.selectedBy = selectedBy;
  return selection;
}

// ── policy evaluation ────────────────────────────────────────────────────────

interface EvalInput {
  /** The effective (active or permissive-default) policy. */
  policy: InstancePackPolicy;
  /** Pack names present: installed packs (existing project) or the request's. */
  presentPackNames: string[];
  /** Selected profile ids: recorded (existing project) or the request's. */
  selectedProfileIds: string[];
  /** Whether a profile selection was provided at all. */
  hasSelection: boolean;
  /** Whether missing required/default packs count as a compliance violation.
   *  True for an existing project; false for an init request (init applies them). */
  countMissingPacksAsViolation: boolean;
}

/** Build a PolicyEvaluationResult from present packs / selected profiles against
 *  the effective policy: missing required/default packs, blocked packs present,
 *  missing required profiles, disallowed profiles, and requireProfileSelection. */
function buildEvaluation(input: EvalInput): PolicyEvaluationResult {
  const { policy, presentPackNames, selectedProfileIds, hasSelection, countMissingPacksAsViolation } =
    input;

  const present = new Set(presentPackNames);
  const requiredDefault = [...new Set([...policy.requiredGlobalPacks, ...policy.defaultProjectPacks])];
  const missingPackNames = requiredDefault.filter((n) => !present.has(n));

  const blocked = new Set(policy.blockedPackNames ?? []);
  const blockedPackNames = presentPackNames.filter((n) => blocked.has(n));

  const requiredProfileIds = policy.requiredProfileIds ?? [];
  const selected = new Set(selectedProfileIds);
  const missingProfileIds = requiredProfileIds.filter((id) => !selected.has(id));

  const allowed = policy.allowedProfileIds;
  const disallowedProfileIds =
    allowed && allowed.length > 0 ? selectedProfileIds.filter((id) => !allowed.includes(id)) : [];

  const selectionRequiredUnmet = policy.requireProfileSelection && !hasSelection;

  const messages: string[] = [];
  if (selectionRequiredUnmet) {
    messages.push('Profile selection is required by policy but none was provided.');
  }
  for (const n of missingPackNames) messages.push(`Required pack "${n}" is not installed.`);
  for (const n of blockedPackNames) messages.push(`Pack "${n}" is blocked by policy.`);
  for (const id of missingProfileIds) messages.push(`Required profile "${id}" is not selected.`);
  for (const id of disallowedProfileIds) messages.push(`Profile "${id}" is not permitted by policy.`);

  const violation =
    selectionRequiredUnmet ||
    blockedPackNames.length > 0 ||
    missingProfileIds.length > 0 ||
    disallowedProfileIds.length > 0 ||
    (countMissingPacksAsViolation && missingPackNames.length > 0);

  return {
    compliant: !violation,
    mode: policy.enforcementMode,
    missingPackNames,
    blockedPackNames,
    missingProfileIds,
    messages,
  };
}

// ── shared initialization body ───────────────────────────────────────────────

/** The single profile-aware initialization body shared by the gated portal path
 *  (initializeProjectWithProfile) and approval execution (executeApprovedInit):
 *  validate against the active policy (throwing on violations under a 'block'
 *  policy), create the project, apply required/default + selected declarative
 *  packs, record the resolved profile selection, and audit 'project.init.policy'.
 *  When `principal` is supplied the selection/audit are attributed to the caller;
 *  the pre-authorized entry runs without one. */
function performInit(
  cfg: HostConfig,
  request: ProjectInitRequest,
  principal?: Principal,
): HostedProjectRecord {
  const policy = effectivePolicy(cfg.dataDir);

  const evaluation = buildEvaluation({
    policy,
    presentPackNames: requestPackNames(request),
    selectedProfileIds: request.profileSelection?.profileIds ?? [],
    hasSelection: !!request.profileSelection,
    countMissingPacksAsViolation: false,
  });
  if (policy.enforcementMode === 'block' && !evaluation.compliant) {
    throw new Error('policy violation — project initialization rejected under the active pack policy');
  }

  const record = executeApprovedCreate(cfg, request.id);

  installPacks(cfg, record.id, [
    ...policy.requiredGlobalPacks,
    ...policy.defaultProjectPacks,
    ...requestPackNames(request),
  ]);

  const selectedBy = principal ? principalSubject(principal) : undefined;
  recordProjectProfileSelection(record.rootPath, resolvedSelection(request, policy, selectedBy));

  const actor = principal ? principalSubject(principal) : SYSTEM_SUBJECT;
  tryAppendAudit(
    cfg,
    buildAuditEvent(
      actor,
      'project.init.policy',
      'info',
      'project',
      { target: record.id, projectId: record.id },
      principal?.tokenId,
    ),
  );

  return record;
}

// ── orchestrator methods ─────────────────────────────────────────────────────

/**
 * Authenticate the caller and authorize project creation (a project:create grant
 * or an instance-admin grant), then run the shared profile-aware initialization
 * body. Returns the created hosted project record.
 */
export function initializeProjectWithProfile(
  cfg: HostConfig,
  credential: string | null,
  request: ProjectInitRequest,
): HostedProjectRecord {
  const principal = requirePrincipal(cfg, credential);
  if (!carriesInstancePermission(principal, PROJECT_CREATE_PERMISSION)) {
    throw new ForbiddenError('creating a project requires a project:create grant or an instance-admin grant');
  }
  return performInit(cfg, request, principal);
}

/**
 * Pre-authorized entry for the self-service approval workflow: performs NO
 * authentication (the caller has already enforced approval-based authorization).
 * Runs the shared initialization body. Never exposed on any portal.
 */
export function executeApprovedInit(cfg: HostConfig, request: ProjectInitRequest): HostedProjectRecord {
  return performInit(cfg, request);
}

/**
 * Pure pre-creation policy evaluation with no side effects and no authentication
 * (the caller authenticated upstream): evaluate the ProjectInitRequest against the
 * effective policy — missing required profile selection, requested blocked packs,
 * and unknown/disallowed profile ids. Never exposed on any portal.
 */
export function evaluateInitRequest(cfg: HostConfig, request: ProjectInitRequest): PolicyEvaluationResult {
  const policy = effectivePolicy(cfg.dataDir);
  return buildEvaluation({
    policy,
    presentPackNames: requestPackNames(request),
    selectedProfileIds: request.profileSelection?.profileIds ?? [],
    hasSelection: !!request.profileSelection,
    countMissingPacksAsViolation: false,
  });
}

/**
 * Authenticate the caller and authorize by the RESOLVED, org-unit-aware mcp:write
 * scope covering the project (a grant on the project itself, a unit-scoped grant
 * whose subtree contains it, or a genuine instance-wide wildcard — scope.all),
 * resolve the project, and evaluate its active packs and recorded profile
 * selection against the effective policy without side effects.
 */
export function evaluateProjectPolicy(
  cfg: HostConfig,
  credential: string | null,
  projectId: string,
): PolicyEvaluationResult {
  const principal = requirePrincipal(cfg, credential);
  if (!permits(resolveScopeFor(cfg, principal, MCP_WRITE_PERMISSION), projectId)) {
    throw new ForbiddenError(
      "evaluating a project's policy requires a grant covering the project or an instance-admin grant",
    );
  }
  const root = resolveProjectRoot(cfg.dataDir, principal, projectId);
  if (!root) throw new Error(`Unknown project "${projectId}".`);

  const policy = effectivePolicy(cfg.dataDir);
  const selection = readProjectProfileSelection(root);
  return buildEvaluation({
    policy,
    presentPackNames: installedPackNames(cfg, projectId),
    selectedProfileIds: selection?.profileIds ?? [],
    hasSelection: !!selection,
    countMissingPacksAsViolation: true,
  });
}

/**
 * Authenticate the caller and authorize by the RESOLVED, org-unit-aware mcp:write
 * scope covering the project (a grant on the project itself, a unit-scoped grant
 * whose subtree contains it, or a genuine instance-wide wildcard — scope.all),
 * evaluate the project against the effective policy, and — when the policy mode
 * permits auto-reconciliation ('auto_reconcile') — apply the missing
 * required/default declarative packs, auditing 'policy.reconcile'. Returns the
 * post-reconciliation evaluation.
 */
export function reconcileProjectPolicy(
  cfg: HostConfig,
  credential: string | null,
  projectId: string,
): PolicyEvaluationResult {
  const principal = requirePrincipal(cfg, credential);
  if (!permits(resolveScopeFor(cfg, principal, MCP_WRITE_PERMISSION), projectId)) {
    throw new ForbiddenError(
      "reconciling a project's policy requires a grant covering the project or an instance-admin grant",
    );
  }
  const root = resolveProjectRoot(cfg.dataDir, principal, projectId);
  if (!root) throw new Error(`Unknown project "${projectId}".`);

  const policy = effectivePolicy(cfg.dataDir);
  const selection = readProjectProfileSelection(root);

  let installed = installedPackNames(cfg, projectId);
  const requiredDefault = [...new Set([...policy.requiredGlobalPacks, ...policy.defaultProjectPacks])];
  const missing = requiredDefault.filter((n) => !installed.includes(n));
  if (policy.enforcementMode === 'auto_reconcile' && missing.length > 0) {
    installPacks(cfg, projectId, missing);
    installed = installedPackNames(cfg, projectId);
  }

  const result = buildEvaluation({
    policy,
    presentPackNames: installed,
    selectedProfileIds: selection?.profileIds ?? [],
    hasSelection: !!selection,
    countMissingPacksAsViolation: true,
  });

  tryAppendAudit(
    cfg,
    buildAuditEvent(
      principalSubject(principal),
      'policy.reconcile',
      'info',
      'policy',
      { target: projectId, projectId },
      principal.tokenId,
    ),
  );

  return result;
}

/**
 * Authenticate the caller (any authenticated principal may read the policy) and
 * return the active instance pack/profile policy, substituting the documented
 * permissive default when none has ever been configured.
 */
export function getPackPolicy(cfg: HostConfig, credential: string | null): InstancePackPolicy {
  requirePrincipal(cfg, credential);
  return getPackPolicyRecord(cfg.dataDir) ?? PERMISSIVE_DEFAULT_POLICY;
}

/**
 * Authenticate the caller and authorize policy administration (a policy:manage
 * grant or an instance-admin grant), stamp updatedBy from the authenticated
 * caller, replace the active policy wholesale through the repository, and audit
 * 'policy.set' at security level.
 */
export function setPackPolicy(
  cfg: HostConfig,
  credential: string | null,
  policy: InstancePackPolicy,
): InstancePackPolicy {
  const principal = requirePrincipal(cfg, credential);
  if (!carriesInstancePermission(principal, POLICY_MANAGE_PERMISSION)) {
    throw new ForbiddenError('policy administration requires a policy:manage grant or an instance-admin grant');
  }

  const stamped: InstancePackPolicy = { ...policy, updatedBy: principalSubject(principal) };
  const stored = setPackPolicyRecord(cfg.dataDir, stamped);

  tryAppendAudit(
    cfg,
    buildAuditEvent(
      principalSubject(principal),
      'policy.set',
      'security',
      'policy',
      { target: stored.id },
      principal.tokenId,
    ),
  );

  return stored;
}

// ── Project Policy Portal (HTTP) ─────────────────────────────────────────────
//
// Pure forwarding to the orchestrator functions above. Rides the ADMIN-plane
// listener (mirroring identity.ts), owning its own error → status mapping
// (401/403/404/400) so faults never fall through to the admin-plane catch. The
// pre-authorized entries (executeApprovedInit, evaluateInitRequest) are
// intentionally not exposed here. Called by http.ts when the admin listener sees
// a `/projects/*` or `/instance/*` path.

export function handlePolicyRequest(
  cfg: HostConfig,
  credential: string | null,
  req: IncomingMessage,
  res: ServerResponse,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any,
  url: URL,
): void {
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  try {
    if (parts[0] === 'projects') {
      // POST /projects/init
      if (req.method === 'POST' && parts.length === 2 && parts[1] === 'init') {
        return sendJson(res, 201, initializeProjectWithProfile(cfg, credential, body as ProjectInitRequest));
      }
      // GET /projects/{id}/policy/evaluation
      if (req.method === 'GET' && parts.length === 4 && parts[2] === 'policy' && parts[3] === 'evaluation') {
        return sendJson(res, 200, evaluateProjectPolicy(cfg, credential, parts[1]));
      }
      // POST /projects/{id}/policy/reconcile
      if (req.method === 'POST' && parts.length === 4 && parts[2] === 'policy' && parts[3] === 'reconcile') {
        return sendJson(res, 200, reconcileProjectPolicy(cfg, credential, parts[1]));
      }
    }

    if (parts[0] === 'instance') {
      // GET /instance/pack-policy
      if (req.method === 'GET' && parts.length === 2 && parts[1] === 'pack-policy') {
        return sendJson(res, 200, getPackPolicy(cfg, credential));
      }
      // PUT /instance/pack-policy
      if (req.method === 'PUT' && parts.length === 2 && parts[1] === 'pack-policy') {
        return sendJson(res, 200, setPackPolicy(cfg, credential, body as InstancePackPolicy));
      }
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    if (err instanceof UnauthenticatedError) return sendJson(res, 401, { error: 'unauthorized' });
    if (err instanceof ForbiddenError) return sendJson(res, 403, { error: 'forbidden' });
    const msg = err instanceof Error ? err.message : String(err);
    if (/not found|unknown project/i.test(msg)) return sendJson(res, 404, { error: msg });
    return sendJson(res, 400, { error: msg });
  }
}
