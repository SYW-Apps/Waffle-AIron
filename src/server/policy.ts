import * as fs from 'fs';
import * as path from 'path';
import type { IncomingMessage, ServerResponse } from 'http';
import { runWithProjectRoot } from '../utils/fs.js';
import { readYamlFile, writeYamlFile } from '../utils/yaml.js';
import { AI_PATHS } from '../config/loader.js';
import { authenticateCredential } from './auth.js';
import { UnauthenticatedError, ForbiddenError } from './errors.js';
import { executeApprovedCreate } from './admin.js';
import { resolveProjectRoot } from './projects.js';
import { authorize } from './authorization.js';
import { appendAuditEvent, DEFAULT_AUDIT_POLICY } from './audit.js';
import { sendJson } from './httpio.js';
import * as packs from './packs.js';
import { hostCore } from './adapters.js';
import type {
  AuditEvent,
  AuditRetentionPolicy,
  AvailableProfile,
  HostConfig,
  HostedProjectRecord,
  HostExposurePolicy,
  IdentityProviderConfig,
  InstancePackPolicy,
  PackResolution,
  PolicyEvaluationResult,
  Principal,
  PrincipalSubject,
  ProjectConfigView,
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
//      (executeApprovedInit, evaluateInitRequest) serve the project-lifecycle approval
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

// ── exposure-policy storage (third policy collection) ────────────────────────
//
// The instance EXPOSURE policy (webUiEnabled/requireTls posture) joins the
// policy repository as its third file-backed collection at
// <dataDir>/exposure-policy.json — the same file the HTTP gate reads, now with
// a proper read/replace path so the web admin surface can edit it.

function exposurePolicyPath(dataDir: string): string {
  return path.join(dataDir, 'exposure-policy.json');
}

/** The compatible default exposure posture: everything mounted on the loopback
 *  admin listener (matching pre-exposure-policy behavior), TLS required, and the
 *  unified web UI OFF — a NEW public surface stays opt-in, so an existing
 *  instance is entirely unaffected until an operator turns it on. */
export const COMPATIBLE_DEFAULT_EXPOSURE: HostExposurePolicy = {
  adminApiMode: 'local_only',
  adminUiEnabled: true,
  identityApiEnabled: true,
  landscapeApiEnabled: true,
  projectPolicyApiEnabled: true,
  cliControlEnabled: true,
  requireTls: true,
  operationsApiEnabled: true,
  webUiEnabled: false,
};

/**
 * Read the persisted instance exposure policy, or null when none has ever been
 * configured (callers substitute the safe default — web UI off, TLS required);
 * an unreadable file or structurally invalid JSON fails with a storage error
 * naming the path.
 */
export function getExposurePolicyRecord(dataDir: string): HostExposurePolicy | null {
  const p = exposurePolicyPath(dataDir);
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`Failed to read exposure policy store at ${p}: ${(e as Error).message}`);
  }
  try {
    return JSON.parse(raw) as HostExposurePolicy;
  } catch (e) {
    throw new Error(`Exposure policy store at ${p} contains malformed JSON: ${(e as Error).message}`);
  }
}

/** Persist the instance exposure policy wholesale via write-temp-then-rename
 *  and return it. No stamping — the exposure posture is a plain settings object. */
export function setExposurePolicyRecord(dataDir: string, policy: HostExposurePolicy): HostExposurePolicy {
  const p = exposurePolicyPath(dataDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(policy, null, 2) + '\n');
  fs.renameSync(tmp, p);
  return policy;
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
// authorize project:write over the project through the permission resolver — a
// unit admin is first-class over the projects placed in its subtree, because the
// resolver's leaf->root walk reaches their unit-scoped permission. Only the
// instance-WIDE capabilities (initializeProjectWithProfile, setPackPolicy)
// authorize at the instance root by design.

/** Creating a project is its own capability. */
const PROJECT_CREATE_CAPABILITY = 'project:create';
/** The legacy `mcp:write` permission maps onto project:write. */
const PROJECT_WRITE_CAPABILITY = 'project:write';
const PROJECT_READ_CAPABILITY = 'project:read';
/** The legacy `policy:manage` permission maps onto project:admin. */
const POLICY_MANAGE_CAPABILITY = 'project:admin';

// An instance-WIDE capability must resolve at the instance root: a unit- or
// project-scoped permission, however broad, does NOT confer instance-wide reach.
function carriesInstancePermission(cfg: HostConfig, principal: Principal, capability: string): boolean {
  return authorize(cfg.dataDir, principal, capability, 'instance', '').value === 'yes';
}

/** Authenticate the caller credential or throw (401-mapping). */
function requirePrincipal(cfg: HostConfig, credential: string | null): Principal {
  const principal = authenticateCredential(cfg.dataDir, credential);
  if (!principal.authenticated) throw new UnauthenticatedError();
  return principal;
}

// ── subject / audit helpers (mirrored from identity.ts / projectlifecycle.ts) ─

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

/** The recognized enforcement postures; setPackPolicy rejects anything else so a
 *  typo can never silently disable enforcement or reconciliation. */
const PACK_ENFORCEMENT_MODES = ['warn', 'block', 'auto_reconcile'];

/** The policy's required ∪ default declarative pack names. */
function requiredDefaultNames(policy: InstancePackPolicy): string[] {
  return [...new Set([...policy.requiredGlobalPacks, ...policy.defaultProjectPacks])];
}

/** The active declarative pack names installed in a bound project — canonical
 *  manifest names, so they compare directly against a resolved pack's identity. */
function installedPackNames(cfg: HostConfig, projectId: string): string[] {
  return packs.executeApprovedListProjectPacks(cfg, projectId).map((d) => d.name);
}

/** Vendor each resolved declarative pack into the bound project by its canonical
 *  name. Resolution (across both server-global tiers, both pack forms) and the
 *  unresolved report are the pack registry's job — see executeApprovedResolveGlobalPacks. */
function installResolvedPacks(cfg: HostConfig, projectId: string, resolution: PackResolution): void {
  for (const pack of resolution.resolved) {
    packs.executeApprovedInstallProjectPack(cfg, projectId, pack.name, pack.content);
  }
}

// ── project config: recorded profile selection ───────────────────────────────
//
// project_config carries an optional profileSelection (see the ProjectConfig
// spec), NOW modeled in the ProjectConfig zod schema — which is what stopped a
// later saveProjectConfig (a pack install, a profile write) from stripping the key
// and silently erasing the record.
//
// These reads/writes still go through the RAW project.yaml deliberately, as the
// narratives specify (raw read, merge, write): a raw merge preserves every other
// config key exactly as written, including keys the schema would default,
// normalize, or reorder on a parse/serialize round trip. The schema change removed
// the data-loss bug; it did not make a full-document rewrite the right way to
// touch one key.

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

/** Read the project's projectType (project-level architectural profile) from its
 *  project.yaml at the bound root, defaulting to 'backend' when the config omits it. */
function readProjectType(root: string): string {
  return runWithProjectRoot(root, () => {
    const raw = readYamlFile(AI_PATHS.projectConfig()) as { projectType?: string } | null;
    return raw?.projectType ?? 'backend';
  });
}

/** Write projectType into the project's project.yaml at the bound root, preserving
 *  every other config key (raw read/merge/write, like the profileSelection path). */
function writeProjectType(root: string, projectType: string): void {
  runWithProjectRoot(root, () => {
    const raw = (readYamlFile(AI_PATHS.projectConfig()) ?? {}) as Record<string, unknown>;
    raw['projectType'] = projectType;
    writeYamlFile(AI_PATHS.projectConfig(), raw);
  });
}

/** The pack names a ProjectInitRequest's profile selection carries. */
function requestPackNames(request: ProjectInitRequest): string[] {
  const sel = request.profileSelection;
  if (!sel) return [];
  return [...new Set([...(sel.requiredPackNames ?? []), ...(sel.defaultPackNames ?? [])])];
}

// ── governing profile: classification + candidate choice ─────────────────────
//
// projectType is what actually GOVERNS a project (the profile whose doctrine the
// validator enforces); profileSelection is only the RECORD of what was chosen. The
// two used to drift freely — a selection could be recorded and never applied — so
// every path that reports or repairs the governing profile shares these two reads.

/**
 * Classify a recorded projectType against a project-scoped profile catalog: where
 * it comes from, and whether it resolves to a governing profile at all.
 *
 * 'builtin' covers both a built-in architectural profile and a composite project
 * kind (a legal projectType carrying no doctrine of its own — and absent from the
 * catalog, which lists profiles only). Otherwise only a catalog entry INSTALLED in
 * this project resolves: a profile contributed solely by a not-yet-adopted
 * server-global pack is NOT governing, and a source is reported only when the value
 * really resolves.
 */
function classifyProfile(
  projectType: string,
  catalog: AvailableProfile[],
): { source?: string; resolvable: boolean } {
  if (
    hostCore.builtinProfileIds().includes(projectType) ||
    hostCore.builtinProjectKinds().includes(projectType)
  ) {
    return { source: 'builtin', resolvable: true };
  }
  const installed = catalog.find((p) => p.id === projectType && p.installed);
  if (installed) return { source: installed.source, resolvable: true };
  return { resolvable: false };
}

/**
 * The first candidate id this instance can actually apply as a projectType: a known
 * composite project kind, or an entry in the project-scoped catalog — installed OR
 * adoptable, because the ensure seam vendors an adoptable profile's contributing
 * pack before the id is written. Undefined when no candidate qualifies, which is
 * reported (and audited) rather than throwing: a selection the instance cannot
 * resolve must never fail project creation.
 */
function firstApplicableProfileId(candidates: string[], catalog: AvailableProfile[]): string | undefined {
  const kinds = hostCore.builtinProjectKinds();
  const catalogIds = new Set(catalog.map((p) => p.id));
  return candidates.find((id) => kinds.includes(id) || catalogIds.has(id));
}

/** The recorded selection ids that are NOT the given governing profile — the honest
 *  remainder. projectType takes exactly one profile, so a multi-id selection always
 *  leaves one; those ids belong on individual subsystems (subsystem.profile).
 *  Takes a KNOWN governing id: what "nothing governs" means differs by caller (all
 *  ids unapplied at init; nothing unapplied when no project exists yet), so each
 *  decides that itself rather than having it hidden in here. */
function unappliedIds(selectedProfileIds: string[], governingProfileId: string): string[] {
  return selectedProfileIds.filter((id) => id !== governingProfileId);
}

/**
 * Fold an applied profile id to the FRONT of the project's recorded selection,
 * keeping every other recorded id as the unapplied remainder and stamping the
 * acting identity. Returns the selection as written.
 *
 * Shared by BOTH paths that apply a governing profile — an explicit profile write
 * and a reconciliation repair — because the record is what compliance reads. A
 * repair that wrote projectType without folding would leave a policy's required
 * profile reported as "not selected" even though it now governs, so reconciliation
 * could never converge: the operator would be told to reconcile a project that
 * reconciliation had just fixed. A project with no recorded selection yet gets one
 * carrying just this id.
 */
function foldAppliedProfile(
  root: string,
  profileId: string,
  actor: PrincipalSubject,
): ProjectProfileSelection {
  const recorded = readProjectProfileSelection(root);
  const folded: ProjectProfileSelection = {
    profileIds: [profileId, ...unappliedIds(recorded?.profileIds ?? [], profileId)],
    requiredPackNames: recorded?.requiredPackNames ?? [],
    selectedBy: actor,
    selectedAt: new Date().toISOString(),
  };
  if (recorded?.defaultPackNames) folded.defaultPackNames = recorded.defaultPackNames;
  recordProjectProfileSelection(root, folded);
  return folded;
}

/** The ids of the project's subsystems declaring a profile of their OWN, which
 *  therefore takes precedence over the project-level profile for their components.
 *  Bound-root read of the L1 specs. */
function overridingSubsystemIds(root: string): string[] {
  return runWithProjectRoot(root, () =>
    hostCore
      .loadSubsystemSpecs()
      .filter((s) => !!s.profile)
      .map((s) => s.id),
  );
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
  /** Resolution of the policy's required/default names against the server-global
   *  set. When present, missingPackNames is computed by CANONICAL name and
   *  unresolvedPacks carries names the instance cannot resolve at all. Omitted at
   *  request-time (no instance probe): then missing = required/default not present,
   *  and unresolvedPacks is empty. */
  requiredDefaultResolution?: PackResolution;
  /** The project's governing projectType — the profile the validator really
   *  enforces. Supplied for an existing project so the evaluation reports profile
   *  REALITY (governingProfileId + the unapplied remainder) beside recorded-
   *  selection compliance. OMITTED for an init-request evaluation, where no project
   *  exists yet: then governingProfileId is absent and the remainder is empty. */
  governingProfileId?: string;
}

/** Build a PolicyEvaluationResult from present packs / selected profiles against
 *  the effective policy: missing required/default packs, blocked packs present,
 *  missing required profiles, disallowed profiles, requireProfileSelection — and,
 *  for an existing project, the profile REALITY (which profile actually governs and
 *  which recorded ids do not). */
function buildEvaluation(input: EvalInput): PolicyEvaluationResult {
  const {
    policy,
    presentPackNames,
    selectedProfileIds,
    hasSelection,
    countMissingPacksAsViolation,
    requiredDefaultResolution,
    governingProfileId,
  } = input;

  const present = new Set(presentPackNames);

  // With a resolution, compare by CANONICAL name and split "unresolved" (no
  // server-global pack at all — an instance gap reconciliation can't fix) from
  // "missing" (resolvable, just not installed yet). Without one (request-time),
  // fall back to the raw required/default names and report nothing unresolved.
  let missingPackNames: string[];
  let unresolvedPacks: string[];
  if (requiredDefaultResolution) {
    unresolvedPacks = requiredDefaultResolution.unresolved;
    const canonical = [...new Set(requiredDefaultResolution.resolved.map((r) => r.name))];
    missingPackNames = canonical.filter((n) => !present.has(n));
  } else {
    missingPackNames = requiredDefaultNames(policy).filter((n) => !present.has(n));
    unresolvedPacks = [];
  }

  const blocked = new Set(policy.blockedPackNames ?? []);
  const blockedPackNames = presentPackNames.filter((n) => blocked.has(n));

  const requiredProfileIds = policy.requiredProfileIds ?? [];
  const selected = new Set(selectedProfileIds);
  const missingProfileIds = requiredProfileIds.filter((id) => !selected.has(id));

  const allowed = policy.allowedProfileIds;
  const disallowedProfileIds =
    allowed && allowed.length > 0 ? selectedProfileIds.filter((id) => !allowed.includes(id)) : [];

  const selectionRequiredUnmet = policy.requireProfileSelection && !hasSelection;

  // Profile REALITY: which recorded ids are NOT the governing projectType. Empty at
  // request time (no project exists yet, so nothing governs and nothing is unapplied).
  const unappliedProfileIds = governingProfileId ? unappliedIds(selectedProfileIds, governingProfileId) : [];

  const messages: string[] = [];
  if (selectionRequiredUnmet) {
    messages.push('Profile selection is required by policy but none was provided.');
  }
  for (const n of missingPackNames) messages.push(`Required pack "${n}" is not installed.`);
  for (const n of unresolvedPacks) {
    messages.push(`Required pack "${n}" is not available on the instance (no matching server-global pack).`);
  }
  for (const n of blockedPackNames) messages.push(`Pack "${n}" is blocked by policy.`);
  for (const id of missingProfileIds) messages.push(`Required profile "${id}" is not selected.`);
  for (const id of disallowedProfileIds) messages.push(`Profile "${id}" is not permitted by policy.`);
  for (const id of unappliedProfileIds) {
    messages.push(
      `Selected profile "${id}" is recorded but does not govern the project ` +
        `(projectType is "${governingProfileId}") — a project has exactly one governing profile.`,
    );
  }

  const violation =
    selectionRequiredUnmet ||
    blockedPackNames.length > 0 ||
    missingProfileIds.length > 0 ||
    disallowedProfileIds.length > 0 ||
    (countMissingPacksAsViolation && (missingPackNames.length > 0 || unresolvedPacks.length > 0));

  const result: PolicyEvaluationResult = {
    compliant: !violation,
    mode: policy.enforcementMode,
    missingPackNames,
    blockedPackNames,
    missingProfileIds,
    unresolvedPacks,
    unappliedProfileIds,
    messages,
  };
  if (governingProfileId) result.governingProfileId = governingProfileId;
  return result;
}

// ── shared initialization body ───────────────────────────────────────────────

/** The single profile-aware initialization body shared by the gated portal path
 *  (initializeProjectWithProfile) and approval execution (executeApprovedInit):
 *  validate against the active policy (throwing on violations under a 'block'
 *  policy), create the project, apply required/default + selected declarative
 *  packs, record the resolved profile selection, APPLY that selection so it
 *  actually governs the new project (the first recorded id the instance can
 *  resolve becomes projectType; the rest stay recorded as the unapplied
 *  remainder), and audit 'project.init.policy'. A selection no tier can resolve
 *  leaves the default projectType and is reported in the audit rather than failing
 *  creation. When `principal` is supplied the selection/audit are attributed to the
 *  caller; the pre-authorized entry runs without one. */
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

  // Create AND place the project in its required owner unit (executeApprovedCreate
  // validates the unit and writes the placement, so no init path can mint an
  // unplaced project the permission resolver cannot see).
  const record = executeApprovedCreate(
    cfg,
    request.id,
    request.ownerUnitId,
    principal ? principalSubject(principal) : undefined,
  );

  const packResolution = packs.executeApprovedResolveGlobalPacks([
    ...policy.requiredGlobalPacks,
    ...policy.defaultProjectPacks,
    ...requestPackNames(request),
  ]);
  installResolvedPacks(cfg, record.id, packResolution);

  const selectedBy = principal ? principalSubject(principal) : undefined;
  const selection = resolvedSelection(request, policy, selectedBy);
  recordProjectProfileSelection(record.rootPath, selection);

  // APPLY the recorded selection, so it governs the new project from day one
  // instead of being a name nothing enforces. The project-scoped catalog is listed
  // AFTER the packs above were vendored in, so their profiles count; the choice is
  // then made by inspection rather than exception-driven probing.
  const catalog = packs.executeApprovedListProjectProfiles(cfg, record.id);
  const appliedProfileId = firstApplicableProfileId(selection.profileIds, catalog);
  let appliedSource: string | undefined;
  if (appliedProfileId) {
    // Vendors the contributing pack when the profile comes only from the
    // server-global tiers, so the written projectType really resolves.
    const application = packs.executeApprovedEnsureProfileInstalled(cfg, record.id, appliedProfileId);
    writeProjectType(record.rootPath, application.profileId);
    appliedSource = application.source;
  }
  // An empty selection, or one no tier can resolve, leaves the default projectType
  // in place: the reason is carried into the audit, never raised as a failure —
  // policy bookkeeping must not be able to break project creation. Nothing applied
  // means the WHOLE selection is the unapplied remainder.
  const unapplied = appliedProfileId
    ? unappliedIds(selection.profileIds, appliedProfileId)
    : [...selection.profileIds];

  const actor = principal ? principalSubject(principal) : SYSTEM_SUBJECT;
  tryAppendAudit(
    cfg,
    buildAuditEvent(
      actor,
      'project.init.policy',
      'info',
      'project',
      {
        target: record.id,
        projectId: record.id,
        metadata: JSON.stringify({
          ...(appliedProfileId
            ? { appliedProfileId, profileSource: appliedSource }
            : {
                appliedProfileId: null,
                profileNotApplied:
                  selection.profileIds.length === 0
                    ? 'no profile was selected — the default projectType stands'
                    : 'no selected profile is resolvable on this instance — the default projectType stands',
              }),
          ...(unapplied.length > 0 ? { unappliedProfileIds: unapplied } : {}),
          ...(packResolution.unresolved.length > 0 ? { unresolvedPacks: packResolution.unresolved } : {}),
        }),
      },
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
  // Resolve project:create over the request's REQUIRED owner unit — the resolved
  // value must be yes (an approval-valued caller must use the execute-primary
  // project-lifecycle path instead).
  if (!request.ownerUnitId) {
    throw new Error(
      'ProjectInitRequest.ownerUnitId is required — every project is placed in an organization unit at creation.',
    );
  }
  if (authorize(cfg.dataDir, principal, PROJECT_CREATE_CAPABILITY, 'unit', request.ownerUnitId).value !== 'yes') {
    throw new ForbiddenError('creating a project requires project:create authority over the target unit');
  }
  return performInit(cfg, request, principal);
}

/**
 * Pre-authorized entry for the project-lifecycle approval workflow: performs NO
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
 * selection against the effective policy without side effects. Also reports the
 * profile REALITY beside pack compliance — governingProfileId (the projectType the
 * validator actually enforces) and the recorded ids that are not governing — so a
 * selection that was recorded but never applied is visible instead of invisible.
 */
export function evaluateProjectPolicy(
  cfg: HostConfig,
  credential: string | null,
  projectId: string,
): PolicyEvaluationResult {
  const principal = requirePrincipal(cfg, credential);
  if (authorize(cfg.dataDir, principal, PROJECT_WRITE_CAPABILITY, 'project', projectId).value !== 'yes') {
    throw new ForbiddenError(
      "evaluating a project's policy requires project:write over the project",
    );
  }
  const root = resolveProjectRoot(cfg.dataDir, principal, projectId);
  if (!root) throw new Error(`Unknown project "${projectId}".`);

  const policy = effectivePolicy(cfg.dataDir);
  // Read the governing projectType alongside the recorded selection: a
  // recorded-but-never-applied selection must not read as satisfied. Report only —
  // this method repairs nothing and writes nothing.
  const governingProfileId = readProjectType(root);
  const selection = readProjectProfileSelection(root);
  return buildEvaluation({
    policy,
    presentPackNames: installedPackNames(cfg, projectId),
    selectedProfileIds: selection?.profileIds ?? [],
    hasSelection: !!selection,
    countMissingPacksAsViolation: true,
    requiredDefaultResolution: packs.executeApprovedResolveGlobalPacks(requiredDefaultNames(policy)),
    governingProfileId,
  });
}

/**
 * Authenticate the caller and authorize by the RESOLVED, org-unit-aware mcp:write
 * scope covering the project (a grant on the project itself, a unit-scoped grant
 * whose subtree contains it, or a genuine instance-wide wildcard — scope.all),
 * then apply the resolvable missing required/default declarative packs REGARDLESS
 * of enforcementMode (an explicit, authorized reconciliation applies only the
 * instance policy's own packs), surfacing names the server-global set cannot
 * resolve as unresolvedPacks and auditing 'policy.reconcile'. Also REPAIRS the
 * governing profile, but only when it is broken or non-compliant — a resolvable,
 * policy-compliant projectType is reported and left alone, so a deliberate local
 * choice survives reconciliation. Returns the post-reconciliation evaluation.
 */
export function reconcileProjectPolicy(
  cfg: HostConfig,
  credential: string | null,
  projectId: string,
): PolicyEvaluationResult {
  const principal = requirePrincipal(cfg, credential);
  if (authorize(cfg.dataDir, principal, PROJECT_WRITE_CAPABILITY, 'project', projectId).value !== 'yes') {
    throw new ForbiddenError(
      "reconciling a project's policy requires project:write over the project",
    );
  }
  const root = resolveProjectRoot(cfg.dataDir, principal, projectId);
  if (!root) throw new Error(`Unknown project "${projectId}".`);

  const policy = effectivePolicy(cfg.dataDir);
  const selection = readProjectProfileSelection(root);

  // Explicit reconciliation: apply the resolvable required/default packs not yet
  // installed, REGARDLESS of enforcementMode — this only ever applies the instance
  // policy's own required/default packs (never discretionary changes), which is why
  // project:write (not project:admin) suffices. Names the server-global set cannot
  // resolve are surfaced as unresolvedPacks by the evaluation, never silently skipped.
  const resolution = packs.executeApprovedResolveGlobalPacks(requiredDefaultNames(policy));
  const installedSet = new Set(installedPackNames(cfg, projectId));
  const toApply = resolution.resolved.filter((p) => !installedSet.has(p.name));
  const appliedPackNames = toApply.map((p) => p.name);
  if (toApply.length > 0) {
    installResolvedPacks(cfg, projectId, { resolved: toApply, unresolved: [] });
  }

  // The profile half runs whether or not a pack was missing: a broken governing
  // profile is its own defect. The catalog is listed after the pack application so a
  // just-vendored pack's profiles count as candidates.
  const catalog = packs.executeApprovedListProjectProfiles(cfg, projectId);
  const previousProfileId = readProjectType(root);
  let governingProfileId = previousProfileId;
  const requiredProfileIds = policy.requiredProfileIds ?? [];

  // Repair ONLY a governing profile that is broken or non-compliant: (a) the policy
  // requires profiles and none of them governs, or (b) the recorded projectType
  // resolves to no loaded profile at all. A resolvable, policy-compliant projectType
  // is reported and left exactly as it is — a deliberate local choice survives.
  const policyUnsatisfied = requiredProfileIds.length > 0 && !requiredProfileIds.includes(governingProfileId);
  const governingUnresolvable = !classifyProfile(governingProfileId, catalog).resolvable;
  let repairedProfileId: string | undefined;
  let selectedProfileIds = selection?.profileIds ?? [];
  if (policyUnsatisfied || governingUnresolvable) {
    // The policy's required ids come BEFORE the recorded selection ids: a
    // reconciliation serves the instance policy first.
    const target = firstApplicableProfileId(
      [...requiredProfileIds, ...(selection?.profileIds ?? [])],
      catalog,
    );
    if (target) {
      const application = packs.executeApprovedEnsureProfileInstalled(cfg, projectId, target);
      writeProjectType(root, application.profileId);
      governingProfileId = application.profileId;
      repairedProfileId = application.profileId;
      // Fold the repair into the recorded selection, exactly as an explicit
      // profile write does: compliance reads the RECORD, so a repair that only
      // wrote projectType would keep reporting the policy's required profile as
      // unselected and reconciliation would never converge.
      selectedProfileIds = foldAppliedProfile(root, application.profileId, principalSubject(principal)).profileIds;
    }
  }

  // Re-list the installed packs for the post-reconciliation report — a profile
  // repair can itself have vendored the contributing pack in.
  const result = buildEvaluation({
    policy,
    presentPackNames: installedPackNames(cfg, projectId),
    selectedProfileIds,
    hasSelection: !!selection,
    countMissingPacksAsViolation: true,
    requiredDefaultResolution: resolution,
    governingProfileId,
  });

  tryAppendAudit(
    cfg,
    buildAuditEvent(
      principalSubject(principal),
      'policy.reconcile',
      'info',
      'policy',
      {
        target: projectId,
        projectId,
        metadata: JSON.stringify({
          ...(appliedPackNames.length > 0 ? { appliedPackNames } : {}),
          ...(repairedProfileId ? { repairedProfileId, previousProfileId } : {}),
          ...(resolution.unresolved.length > 0 ? { unresolvedPacks: resolution.unresolved } : {}),
        }),
      },
      principal.tokenId,
    ),
  );

  return result;
}

/**
 * Authenticate the caller, authorize project:read over the target project, bind
 * its isolated root, and return the project's configuration view AND whether it is
 * genuinely in force: the project.yaml projectType (project-level architectural
 * profile, 'backend' default), whether the project holds a lock record, where the
 * profile comes from and whether it resolves at all, the recorded selection ids
 * that are not governing, and the subsystems declaring their own profile. No side
 * effects: an unresolvable recorded projectType is REPORTED, never repaired here.
 */
export function getProjectConfig(
  cfg: HostConfig,
  credential: string | null,
  projectId: string,
): ProjectConfigView {
  const principal = requirePrincipal(cfg, credential);
  if (authorize(cfg.dataDir, principal, PROJECT_READ_CAPABILITY, 'project', projectId).value !== 'yes') {
    throw new ForbiddenError(
      "reading a project's configuration requires project:read over the project",
    );
  }
  const root = resolveProjectRoot(cfg.dataDir, principal, projectId);
  if (!root) throw new Error(`Unknown project "${projectId}".`);

  const projectType = readProjectType(root);
  const selection = readProjectProfileSelection(root);

  // Classify the recorded type against the project-scoped catalog rather than
  // echoing it back unexamined: profileResolvable false means the profile's
  // doctrine is NOT being applied even though a name is recorded (a hand-edited or
  // legacy project.yaml, or a pack removed afterwards). Reported honestly here — the
  // repair path is reconcileProjectPolicy / setProjectType.
  const classified = classifyProfile(projectType, packs.executeApprovedListProjectProfiles(cfg, projectId));

  const locked = runWithProjectRoot(root, () => hostCore.readLockRecord() !== null);
  const overriding = overridingSubsystemIds(root);

  const view: ProjectConfigView = {
    projectType,
    locked,
    profileResolvable: classified.resolvable,
    unappliedProfileIds: unappliedIds(selection?.profileIds ?? [], projectType),
    overridingSubsystemIds: overriding,
  };
  if (classified.source) view.profileSource = classified.source;
  return view;
}

/**
 * Authenticate the caller, authorize project:write over the target project, bind
 * its isolated root, and make the requested projectType actually GOVERN the project
 * rather than merely recording a name: ensure it is resolvable first (vendoring a
 * server-global pack's contribution when needed, REFUSING an id no tier
 * contributes), write it into project.yaml, and fold the applied id to the FRONT of
 * the recorded profileSelection so the record and the governing reality agree.
 * Returns the enriched view.
 */
export function setProjectType(
  cfg: HostConfig,
  credential: string | null,
  projectId: string,
  projectType: string,
): ProjectConfigView {
  const principal = requirePrincipal(cfg, credential);
  if (authorize(cfg.dataDir, principal, PROJECT_WRITE_CAPABILITY, 'project', projectId).value !== 'yes') {
    throw new ForbiddenError(
      "changing a project's configuration requires project:write over the project",
    );
  }
  const root = resolveProjectRoot(cfg.dataDir, principal, projectId);
  if (!root) throw new Error(`Unknown project "${projectId}".`);

  // Ensure BEFORE anything is written: an id no tier contributes throws here, so a
  // projectType that would silently disable the whole profile doctrine is never
  // persisted and the previous one stands untouched.
  const application = packs.executeApprovedEnsureProfileInstalled(cfg, projectId, projectType);

  writeProjectType(root, application.profileId);

  // Fold the applied id to the FRONT of the recorded selection so the record and
  // the governing reality do not drift apart.
  const folded = foldAppliedProfile(root, application.profileId, principalSubject(principal));
  const remainder = folded.profileIds.slice(1);

  const locked = runWithProjectRoot(root, () => hostCore.readLockRecord() !== null);
  const overriding = overridingSubsystemIds(root);

  const view: ProjectConfigView = {
    projectType: application.profileId,
    locked,
    profileSource: application.source,
    // The write path guarantees resolvability — the ensure seam refused anything else.
    profileResolvable: true,
    unappliedProfileIds: remainder,
    overridingSubsystemIds: overriding,
  };
  if (application.adoptedPackName) view.adoptedPackName = application.adoptedPackName;
  return view;
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
  if (!carriesInstancePermission(cfg, principal, POLICY_MANAGE_CAPABILITY)) {
    throw new ForbiddenError('policy administration requires instance-level project:admin');
  }
  if (!PACK_ENFORCEMENT_MODES.includes(policy.enforcementMode)) {
    throw new Error(
      `invalid enforcementMode "${policy.enforcementMode}" — must be one of ${PACK_ENFORCEMENT_MODES.join(', ')}`,
    );
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
