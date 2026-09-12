import * as crypto from 'crypto';
import {
  loadSystemSpec,
  loadSubsystemSpecs,
  loadComponentSpecs,
  loadInterfaceSpecs,
  loadImplementationSpecs,
  loadTypeSpecs,
} from './specs.js';
import type { LoadedExtensions } from './extensions.js';
// The BUILTIN rule registry, read inside doctrineIdentity only. This closes an
// import cycle (rules → coupling → specs → statehash), which is safe for the same
// reason the existing statehash ↔ specs cycle is: nothing here runs at module init.
import { SDD_RULES } from './rules/index.js';
import type { RulesConfig } from '../models/project.js';

// ---------------------------------------------------------------------------
// State Hash Specialist (sdd_host / sdd_core)
//
// Computes the deterministic content identity (StateId) of the current
// project's spec tree. Two trees with identical spec CONTENT produce the same
// StateId; any edit changes it. This backs the commit-scoped lock record and
// the staleness re-check: a lock is scoped to the StateId it validated, and
// every later read recomputes it, so any change after locking auto-invalidates
// the lock. Volatile metadata (createdAt/updatedAt) is excluded so a no-op re-save
// that only bumps a timestamp does not shift the identity.
// ---------------------------------------------------------------------------

export interface StateId {
  algorithm: string;
  digest: string;
}

/**
 * The project-level half of the gate: which profile governs, and how the project
 * tuned the rules. Supplied by the caller so the hash stays a pure function of its
 * inputs rather than reading configuration behind the caller's back.
 */
export interface GateConfig {
  projectType?: string;
  rules?: RulesConfig;
}

/** Algorithm marker for the CONTENT identity: the spec tree alone. */
const CONTENT_ALGORITHM = 'sha256';

/**
 * Algorithm marker for the GATE identity: the spec tree PLUS the doctrine that
 * validated it. Distinct on purpose — `stateIdEquals` compares the algorithm, so
 * a content-only StateId can never satisfy a gate comparison. That makes every
 * lock record written before doctrine was covered read as STALE (forcing a
 * re-lock) instead of silently passing the staleness re-check.
 */
const GATE_ALGORITHM = 'sha256+doctrine';

/** The spec-tree content both identities digest — one loader path, so they can never disagree about the specs. */
function loadTree(): Record<string, unknown> {
  return {
    system: loadSystemSpec(),
    subsystems: loadSubsystemSpecs(),
    components: loadComponentSpecs(),
    interfaces: loadInterfaceSpecs(),
    implementations: loadImplementationSpecs(),
    types: loadTypeSpecs(),
  };
}

/** Deterministic CONTENT StateId over the current (request-scoped) project's spec tree. */
export function computeStateId(): StateId {
  const digest = crypto.createHash('sha256').update(canonicalize(loadTree())).digest('hex');
  return { algorithm: CONTENT_ALGORITHM, digest };
}

/**
 * The identity-bearing surface of the governing doctrine — everything that can
 * change a conformance VERDICT, and nothing else.
 *
 * Excluded on purpose: `skills` and `instructions` (agent-facing prose that
 * cannot alter a verdict — including them would invalidate every lock on a
 * cosmetic documentation edit) and `errors` (transient, and a failed pack load
 * already blocks locking through EXTENSION_LOAD_ERROR). `packNames` is dropped as
 * redundant with `packs`.
 *
 * Programmatic rules are functions and cannot be digested, so a rule's name plus
 * its declared codes stands as its identity.
 */
function doctrineIdentity(doctrine: LoadedExtensions, gate: GateConfig): Record<string, unknown> {
  const byKey = <T>(items: T[], key: (item: T) => string): T[] =>
    [...items].sort((a, b) => key(a).localeCompare(key(b)));

  return {
    /**
     * The BUILTIN rule set, by identity rather than by wairon version.
     *
     * A binary upgrade changes the gate only when the rules change, so hashing the
     * version would invalidate every lock on every patch while hashing nothing
     * would let a minor that ADDS a rule leave locks asserting they passed a gate
     * that no longer exists. Keying on the registry means a release that touches no
     * rule keeps every lock valid, and one that adds, removes, or re-grades a code
     * invalidates exactly the locks it should.
     *
     * Residual gap, accepted knowingly: a rule whose IMPLEMENTATION grows stricter
     * without its name, codes, or default severity changing is not caught. Folding
     * in the wairon version would catch it at the cost of churning every lock on
     * every release — the trade this projection deliberately declines.
     */
    builtinRules: byKey(
      SDD_RULES.map((r) => ({
        name: r.name,
        codes: byKey(r.codes.map((c) => ({ code: c.code, severity: c.defaultSeverity })), (c) => c.code),
      })),
      (r) => r.name,
    ),
    /**
     * Which profile GOVERNS, and the project's own rule tuning. Both decide
     * verdicts — a projectType switch changes the doctrine family outright, and
     * `rules` carries severity overrides, complexity caps, and designDepth — so a
     * lock taken under one and honoured under another was never validated by the
     * gate it claims to have passed.
     */
    projectType: gate.projectType ?? null,
    rulesConfig: gate.rules ?? null,
    packs: byKey(
      doctrine.packs.map((p) => ({ name: p.name, version: p.version ?? null, scope: p.scope })),
      (p) => `${p.name}@${p.version ?? ''}#${p.scope}`,
    ),
    // Merged records already encode pack precedence, so their resolved content is
    // the identity — a load-order change that flips a collision winner shows up here.
    profiles: doctrine.profiles,
    languages: doctrine.languages,
    patterns: byKey(
      doctrine.patterns.map((p) => ({ id: p.id, version: p.version, pack: p.pack })),
      (p) => `${p.pack}/${p.id}@${p.version}`,
    ),
    guarantees: [...doctrine.guarantees].sort(),
    assertions: byKey(doctrine.assertions.map((a) => ({ ...a })), (a) => a.fullCode),
    rules: byKey(
      doctrine.rules.map((r) => ({ name: r.name, codes: r.codes.map((c) => c.code).sort() })),
      (r) => r.name,
    ),
  };
}

/**
 * Deterministic GATE StateId: the spec tree together with the doctrine that
 * governs it. Pure — the caller loads the doctrine and passes it in.
 *
 * This is what a lock must be scoped to. A lock asserts "these specs pass this
 * gate", and the pack set IS part of the gate: without doctrine coverage you
 * could lock a tree validated under one rule set, change the packs, and still
 * act on the strength of the earlier lock, because the spec digest never
 * moved. Content-only consumers (surface snapshot stamps, freshness checks) stay
 * on computeStateId, so a pack bump never marks a vendored contract stale.
 */
export function hashGateState(doctrine: LoadedExtensions, gate: GateConfig = {}): StateId {
  const payload = { tree: loadTree(), doctrine: doctrineIdentity(doctrine, gate) };
  const digest = crypto.createHash('sha256').update(canonicalize(payload)).digest('hex');
  return { algorithm: GATE_ALGORITHM, digest };
}

/** True when two StateIds identify the same spec-tree content. */
export function stateIdEquals(a: StateId | null | undefined, b: StateId | null | undefined): boolean {
  return !!a && !!b && a.algorithm === b.algorithm && a.digest === b.digest;
}

/** Stable serialization: object keys sorted recursively (so key/formatting
 *  order never changes the digest), with volatile timestamps stripped. */
function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) {
      if (k === 'createdAt' || k === 'updatedAt') continue; // volatile metadata
      out[k] = sortKeys(src[k]);
    }
    return out;
  }
  return v;
}
