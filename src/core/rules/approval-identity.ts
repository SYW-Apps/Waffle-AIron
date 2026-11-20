import * as crypto from 'crypto';
import { canonicalize, compareOrdinal } from '../../utils/canonical-json.js';
import type { CompositionConfig, NetworkDeclaration, RulesConfig } from '../../models/project.js';
import type { LoadedExtensions } from '../extensions.js';
import type { StateId } from '../statehash.js';
import { judgesCode, type SddRule } from './types.js';

// ---------------------------------------------------------------------------
// Approval identity (sdd_validator)
//
// The identity a lock records and every staleness check compares: ONE
// project's own design identity digested together with its policy — the
// project type, the design rule tuning, its `composition` block, its network
// declaration and the packs it selects. That is the whole of what a lock
// certifies. What the project consumes is not in it: wairon's built-in rules
// (the release), a pack's content, a consumed contract and a member's approval
// are build inputs, judged beside the approval. A release, a pack update, a
// re-pin or a member's re-lock never re-opens it.
//
// Beside it, the code analyzer's doctrine gets a digest of its own
// (analyzerDigest), recorded next to the claim and never inside it, and each
// loaded pack's doctrine gets one for the inputs lock (packContents).
//
// Pure: the spec validator gathers every input and passes it in, so a lock and
// the re-check that later judges it stale can never disagree.
// ---------------------------------------------------------------------------

/**
 * One pack selection as the policy states it: what the project CHOSE, by name,
 * declared version and scope. What it resolves to is a build input.
 */
export interface PackSelectionRef {
  name: string;
  /** The version the selection declares, as written; absent when it declares none. */
  version?: string;
  scope?: string;
}

/**
 * gate_config — the project's policy: the half of the approval identity beside
 * its own design. A lock taken under one policy and honoured under another was
 * never approved under the policy it claims.
 */
export interface GateConfig {
  projectType?: string;
  rules?: RulesConfig;
  /** The project's `composition` block; null/absent when it declares none. */
  composition?: CompositionConfig | null;
  /**
   * The project's network declaration, when it declares one: it changes the
   * family run's network verdicts. Absent when the project declares none — and
   * then left out of the digest entirely.
   */
  network?: NetworkDeclaration | null;
  /** The packs the project selects, by name, declared version and scope. */
  selections?: PackSelectionRef[];
}

/** Algorithm marker for the approval identity: the own design together with the policy. */
export const APPROVAL_ALGORITHM = 'sha256+design+policy';

// Ordinal, never localeCompare: collation is locale- and ICU-dependent, and it
// re-weights exactly the characters rule names are full of (hyphens,
// underscores), so the same rule set could digest differently on two machines.
const byKey = <T>(items: T[], key: (item: T) => string): T[] =>
  [...items].sort((a, b) => compareOrdinal(key(a), key(b)));

/** A rule by name with its codes and default severities — a function cannot be digested. */
function ruleIdentities(rules: SddRule[]): Record<string, unknown>[] {
  return byKey(
    rules.map((r) => ({
      name: r.name,
      codes: byKey(r.codes.map((c) => ({ code: c.code, severity: c.defaultSeverity })), (c) => c.code),
    })),
    (r) => r.name,
  );
}

/** Every code a code-judging rule declares. */
function codeJudgedCodes(builtinRules: SddRule[]): Set<string> {
  return new Set(builtinRules.filter(judgesCode).flatMap((r) => r.codes.map((c) => c.code)));
}

/**
 * The rule config WITHOUT its code-conformance tuning: rules.conformance and
 * every sddRuleSeverity override of a code a code-judging rule declares. Both
 * tune only findings the approval does not certify, and enter the analyzer's
 * digest instead.
 */
function designRulesConfig(rules: RulesConfig | undefined, codeCodes: Set<string>): Record<string, unknown> | null {
  if (!rules) return null;
  const { conformance: _codeTuning, sddRuleSeverity, ...rest } = rules;
  const severities = Object.fromEntries(Object.entries(sddRuleSeverity ?? {}).filter(([code]) => !codeCodes.has(code)));
  // An empty override map and an absent one tune nothing alike.
  return { ...rest, ...(Object.keys(severities).length > 0 ? { sddRuleSeverity: severities } : {}) };
}

/** The policy's identity-bearing surface: what the approval certifies beside the design. */
function policyIdentity(builtinRules: SddRule[], gate: GateConfig): {
  projectType: string | null;
  rules: Record<string, unknown> | null;
  composition: CompositionConfig | null;
  network?: NetworkDeclaration;
  selections: { name: string; version: string | null; scope: string | null }[];
} {
  return {
    projectType: gate.projectType ?? null,
    rules: designRulesConfig(gate.rules, codeJudgedCodes(builtinRules)),
    composition: gate.composition ?? null,
    // LEFT OUT when the project declares no network — never written as null.
    ...(gate.network ? { network: gate.network } : {}),
    selections: byKey(
      (gate.selections ?? []).map((s) => ({ name: s.name, version: s.version ?? null, scope: s.scope ?? null })),
      (s) => `${s.name}@${s.version ?? ''}#${s.scope ?? ''}`,
    ),
  };
}

/** sha256 over a value's canonical form, in hex. */
function digestOf(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalize(value)).digest('hex');
}

/**
 * approval_identity.compute — the approval identity of one project: its OWN
 * design identity digested together with its policy. The same inputs always
 * give the same identity.
 */
export function computeApprovalIdentity(design: StateId, builtinRules: SddRule[], gate: GateConfig): StateId {
  // Steps 1-2: the policy, with the code-conformance tuning left out.
  const policy = policyIdentity(builtinRules, gate);
  // Step 3: the own design digest and the policy, digested.
  const digest = digestOf({ design: design.digest, policy });
  // Step 4.
  return { algorithm: APPROVAL_ALGORITHM, digest };
}

/**
 * approval_identity.analyzer — the digest of the code analyzer's doctrine: the
 * built-in rules that judge code (name, codes, default severities) with the
 * project's code-conformance tuning — rules.conformance and the
 * sddRuleSeverity overrides of those rules' codes. Exactly the tuning compute
 * leaves out, so this digest moves when the analyzer's rule set or tuning
 * does, and the approval identity does not.
 */
export function analyzerDigest(builtinRules: SddRule[], gate: GateConfig): string {
  // Steps 1-2: the code-judging rules and the project's code tuning.
  const codeCodes = codeJudgedCodes(builtinRules);
  const overrides = Object.entries(gate.rules?.sddRuleSeverity ?? {}).filter(([code]) => codeCodes.has(code));
  const payload = {
    rules: ruleIdentities(builtinRules.filter(judgesCode)),
    conformance: gate.rules?.conformance ?? null,
    severities: byKey(overrides, ([code]) => code).map(([code, severity]) => ({ code, severity })),
  };
  // Step 3.
  return digestOf(payload);
}

/**
 * approval_identity.parts — the approval identity's halves digested ONE BY
 * ONE, in exactly the projection compute takes them in: `design`, `rules`
 * (the project type with the design rule tuning), `composition`, `network`
 * (only when declared) and `selections`. Never part of the identity's digest:
 * a lock records them beside it, so a later check can name the half that
 * moved. design, rules, composition and network are projected exactly as the
 * wairon 6 gate parts of the same names, so an upgrade compares them with a
 * wairon 6 record's parts directly. Pure.
 */
export function approvalParts(design: StateId, builtinRules: SddRule[], gate: GateConfig): Record<string, string> {
  // Step 1: the policy as compute projects it, split into its halves.
  const policy = policyIdentity(builtinRules, gate);
  // Steps 2-3: each half digested on its own.
  return {
    design: design.digest,
    rules: digestOf({ projectType: policy.projectType, rulesConfig: policy.rules }),
    composition: digestOf(policy.composition),
    ...(policy.network !== undefined ? { network: digestOf(policy.network) } : {}),
    selections: digestOf(policy.selections),
  };
}

/**
 * approval_identity.packContents — the doctrine digest of each loaded pack,
 * keyed by pack name: what the pack contributes to judging a design — its
 * profiles, languages, patterns, guarantees, assertions and rules (each rule
 * by name with its codes and default severities), every list codepoint-sorted.
 * Agent-facing prose (skills, instructions, practices) and technology
 * packages are left out. What `wairon packs sync` and `wairon lock` record in
 * the inputs lock, and what the build compares against it.
 *
 * The loader merges profiles, languages, guarantee tokens and pack rules across
 * packs but records what each pack contributed by itself (LoadedExtensions.
 * contributions), so a pack's digest covers only its own content: a change in
 * another pack never owes this one a sync.
 */
export function packContents(doctrine: LoadedExtensions): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pack of doctrine.packs) {
    // Step 1: what this pack contributes by itself.
    const own = doctrine.contributions[pack.name];
    const projection = {
      profiles: own?.profiles ?? {},
      languages: own?.languages ?? {},
      guarantees: [...(own?.guarantees ?? [])].sort(compareOrdinal),
      rules: byKey(
        (own?.rules ?? []).map((r) => ({
          name: r.name,
          codes: byKey(r.codes.map((c) => ({ code: c.code, severity: c.defaultSeverity })), (c) => c.code),
        })),
        (r) => r.name,
      ),
      patterns: byKey(
        doctrine.patterns.filter((p) => p.pack === pack.name).map((p) => ({ id: p.id, version: p.version })),
        (p) => `${p.id}@${p.version}`,
      ),
      assertions: byKey(doctrine.assertions.filter((a) => a.pack === pack.name).map((a) => ({ ...a })), (a) => a.fullCode),
    };
    // Step 2: digested on its own.
    out[pack.name] = digestOf(projection);
  }
  // Step 3.
  return out;
}
