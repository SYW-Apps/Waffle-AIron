import * as packs from './packs.js';
import * as policy from './policy.js';
import * as admin from './admin.js';
import * as identity from './identity.js';
import * as operations from './operations.js';
import * as gitbacking from './gitbacking.js';
import type { GitBackingStatus, GitPublish } from '../git/index.js';
import type { ProducerConfig } from '../producers/index.js';
import type {
  AuditEvent,
  AuditQuery,
  GitBackingBinding,
  HostConfig,
  HostedProjectRecord,
  HostExposurePolicy,
  InstancePackPolicy,
  PackDescriptor,
  PolicyEvaluationResult,
} from './types.js';

// ---------------------------------------------------------------------------
// Project Ops Orchestrator (sdd_host)
//
// The single operational seam that surfaces the control-plane project/instance
// operations to BOTH the web portal (browser session as the credential) and the
// MCP data plane (bearer token as the credential): declarative packs (global +
// per-project), pack/profile policy, producer targets, per-project git backing,
// the container-level backup bindings, the scoped audit viewer, and the
// instance exposure policy.
//
// Every method is a pure 1:1 forward passing the caller's credential to the
// OWNING orchestrator, which authenticates and authorizes through the
// permission resolver — no authorization logic and no state lives here, so the
// two portals stay lean and the gates stay single-sourced.
// ---------------------------------------------------------------------------

// ── packs ─────────────────────────────────────────────────────────────────────

export function listGlobalPacks(cfg: HostConfig, credential: string | null): PackDescriptor[] {
  return packs.listGlobalPacks(cfg, credential);
}

export function installGlobalPack(cfg: HostConfig, credential: string | null, name: string, content: string): PackDescriptor {
  return packs.installGlobalPack(cfg, credential, name, content);
}

export function removeGlobalPack(cfg: HostConfig, credential: string | null, name: string): void {
  packs.removeGlobalPack(cfg, credential, name);
}

export function listProjectPacks(cfg: HostConfig, credential: string | null, project: string): PackDescriptor[] {
  return packs.listProjectPacks(cfg, credential, project);
}

export function installProjectPack(cfg: HostConfig, credential: string | null, project: string, name: string, content: string): PackDescriptor {
  return packs.installProjectPack(cfg, credential, project, name, content);
}

export function removeProjectPack(cfg: HostConfig, credential: string | null, project: string, name: string): void {
  packs.removeProjectPack(cfg, credential, project, name);
}

export function installGlobalPackArchive(cfg: HostConfig, credential: string | null, archive: Uint8Array, name?: string): PackDescriptor {
  return packs.installGlobalPackArchive(cfg, credential, archive, name);
}

export function installProjectPackArchive(cfg: HostConfig, credential: string | null, project: string, archive: Uint8Array, name?: string): PackDescriptor {
  return packs.installProjectPackArchive(cfg, credential, project, archive, name);
}

// ── pack/profile policy ───────────────────────────────────────────────────────

export function getPackPolicy(cfg: HostConfig, credential: string | null): InstancePackPolicy {
  return policy.getPackPolicy(cfg, credential);
}

export function setPackPolicy(cfg: HostConfig, credential: string | null, packPolicy: InstancePackPolicy): InstancePackPolicy {
  return policy.setPackPolicy(cfg, credential, packPolicy);
}

export function evaluateProjectPolicy(cfg: HostConfig, credential: string | null, projectId: string): PolicyEvaluationResult {
  return policy.evaluateProjectPolicy(cfg, credential, projectId);
}

export function reconcileProjectPolicy(cfg: HostConfig, credential: string | null, projectId: string): PolicyEvaluationResult {
  return policy.reconcileProjectPolicy(cfg, credential, projectId);
}

// ── producers ─────────────────────────────────────────────────────────────────

export function listProducers(cfg: HostConfig, credential: string | null, project: string): ProducerConfig[] {
  return admin.listProducers(cfg, credential, project);
}

export function configureProducer(cfg: HostConfig, credential: string | null, project: string, target: string, parentPageId: string): void {
  admin.configureProducer(cfg, credential, project, target, parentPageId);
}

export function removeProducer(cfg: HostConfig, credential: string | null, project: string, target: string): void {
  admin.removeProducer(cfg, credential, project, target);
}

export async function produceProducer(cfg: HostConfig, credential: string | null, project: string, target: string): Promise<void> {
  await admin.produceProducer(cfg, credential, project, target);
}

// ── per-project git backing ───────────────────────────────────────────────────

export function getGitBinding(cfg: HostConfig, credential: string | null, project: string): GitBackingStatus {
  return admin.getGitBinding(cfg, credential, project);
}

export function enableGit(
  cfg: HostConfig,
  credential: string | null,
  project: string,
  remote: string,
  branch: string,
  pat?: string,
): HostedProjectRecord {
  return admin.enableGit(cfg, credential, project, remote, branch, pat);
}

export function disableGit(cfg: HostConfig, credential: string | null, project: string): void {
  admin.disableGit(cfg, credential, project);
}

export function syncGit(cfg: HostConfig, credential: string | null, project: string): void {
  admin.syncGit(cfg, credential, project);
}

export function commitProject(cfg: HostConfig, credential: string | null, project: string, subsystem?: string, message?: string): GitPublish {
  return admin.commitProject(cfg, credential, project, subsystem, message);
}

export function configureGitSync(cfg: HostConfig, credential: string | null, project: string, periodicSyncMinutes?: number, skipIfClean?: boolean): void {
  admin.configureGitSync(cfg, credential, project, periodicSyncMinutes, skipIfClean);
}

// ── container-level backup bindings ───────────────────────────────────────────

export function listBackingBindings(cfg: HostConfig, credential: string | null): GitBackingBinding[] {
  return gitbacking.listBackingBindings(cfg, credential);
}

export function bindBackingScope(
  cfg: HostConfig,
  credential: string | null,
  binding: GitBackingBinding,
  pat?: string,
): GitBackingBinding {
  return gitbacking.bindScope(cfg, credential, binding, pat);
}

export function unbindBackingScope(cfg: HostConfig, credential: string | null, bindingId: string): void {
  gitbacking.unbindScope(cfg, credential, bindingId);
}

export function syncBackingScope(cfg: HostConfig, credential: string | null, bindingId: string): boolean {
  return gitbacking.syncBackingScope(cfg, credential, bindingId);
}

// ── audit viewer ──────────────────────────────────────────────────────────────

export function queryAuditEvents(cfg: HostConfig, credential: string | null, query: AuditQuery): AuditEvent[] {
  return identity.queryAuditEvents(cfg, credential, query);
}

export function countAuditEvents(cfg: HostConfig, credential: string | null, query: AuditQuery): number {
  return identity.countAuditEvents(cfg, credential, query);
}

// ── instance exposure policy ──────────────────────────────────────────────────

export function getExposurePolicy(cfg: HostConfig, credential: string | null): HostExposurePolicy {
  return operations.getExposurePolicy(cfg, credential);
}

export function setExposurePolicy(cfg: HostConfig, credential: string | null, exposure: HostExposurePolicy): HostExposurePolicy {
  return operations.setExposurePolicy(cfg, credential, exposure);
}
