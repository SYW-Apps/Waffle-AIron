import * as crypto from 'crypto';
import { canonicalize, compareOrdinal } from '../../utils/canonical-json.js';
import type { CompositionConfig, NetworkDeclaration, RulesConfig } from '../../models/project.js';
import type { LoadedExtensions } from '../extensions.js';
import type { StateId } from '../statehash.js';
import { judgesCode, type SddRule } from './types.js';

// ---------------------------------------------------------------------------
// Gate identity (sdd_validator)
//
// The identity a lock records and every staleness check compares: ONE
// project's own content identity digested together with the DESIGN doctrine
// that governs it, its own consumed contract inputs, its `composition` block
// and each direct member's composition subject. A lock asserts "this design
// passes THIS gate under THESE inputs", so changing a pack, the project's rule
// tuning, a pinned contract, a requirement or a member's approval invalidates
// it by identity mismatch exactly as a spec edit does.
//
// Beside it, the code analyzer's doctrine gets a digest of its own
// (analyzerDigest): the rules that judge code and the project's code tuning.
// A lock records that digest next to its claim, never inside it, so an
// analyzer upgrade or a code-severity change never stales an approval.
//
// Pure: the spec validator gathers every input (computeGateStateId) and passes
// it in, so a lock and the re-check that later judges it stale can never
// disagree about which rule set or which contracts applied.
// ---------------------------------------------------------------------------

/**
 * The project-level half of the gate: which profile governs, and how the project
 * tuned the rules. A lock taken under one and honoured under another was never
 * judged by the gate it claims to have passed.
 */
export interface GateConfig {
  projectType?: string;
  rules?: RulesConfig;
  /** The project's `composition` block; null/absent when it declares none. */
  composition?: CompositionConfig | null;
  /**
   * The project's network declaration, when it declares one: it changes the
   * family run's network verdicts, so a lock taken without it is not a lock
   * of the gate with it. Absent when the project declares none — and then
   * left out of the digest entirely, so no lock taken before networks existed
   * goes stale.
   */
  network?: NetworkDeclaration | null;
}

/**
 * Algorithm marker for the gate identity. It names the composition — the own
 * DESIGN digest (code linkage out, lock format 3), the design doctrine, the
 * own inputs and the members' subjects — so a record written under an earlier
 * one never matches by accident, and a spec identity (sha256, sha256-design)
 * never compares equal to a gate identity.
 */
export const GATE_ALGORITHM = 'sha256+design-2+doctrine+inputs+members';

/**
 * The gate algorithm of the EARLIER design reading, whose content half still
 * carried each spec's status: what every format-3 lock written before
 * readiness left the approval was taken under. compute marks an identity with
 * it when handed an earlier-reading design identity (state_hash.ownDesignAsRecorded),
 * which is how such a lock is recomputed exactly as it was taken.
 */
const EARLIER_DESIGN_GATE_ALGORITHM = 'sha256+design+doctrine+inputs+members';

/**
 * The previous gate algorithm, whose content half was the FULL content
 * identity (code linkage included) — what every format-2 lock was taken
 * under. compute marks an identity with it when handed a full-content
 * identity, which is how a format-2 lock is recomputed exactly as it was
 * taken (StateId.asRecorded) instead of being forced into a re-lock.
 */
const CONTENT_GATE_ALGORITHM = 'sha256+content+doctrine+inputs+members';

/** The spec-identity marker of a design identity (state_hash.ownDesign). */
const DESIGN_CONTENT_ALGORITHM = 'sha256-design-2';

/** The spec-identity marker of the earlier design reading (state_hash.ownDesignAsRecorded). */
const EARLIER_DESIGN_CONTENT_ALGORITHM = 'sha256-design';

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
function doctrineIdentity(doctrine: LoadedExtensions, builtinRules: SddRule[], gate: GateConfig): Record<string, unknown> {
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
    //
    // Only the rules that judge DESIGN: a code analyzer that gains a code or a
    // stricter check must never stale an approval (analyzer-upgrade-keeps-approval).
    builtinRules: ruleIdentities(builtinRules.filter((r) => !judgesCode(r))),
    /**
     * Which profile GOVERNS, and the project's own design rule tuning. Both
     * decide verdicts — a projectType switch changes the doctrine family
     * outright, and `rules` carries design severity overrides, complexity caps
     * and designDepth. Its code-conformance tuning is the analyzer's.
     */
    projectType: gate.projectType ?? null,
    rulesConfig: designRulesConfig(gate.rules, codeJudgedCodes(builtinRules)),
    /**
     * What the project requires of the projects it contains (stage 5): a
     * changed requirement stales the requiring project's lock.
     */
    composition: gate.composition ?? null,
    /**
     * The network declaration changes the family run's network verdicts, so
     * declaring, removing or redescribing one stales the declaring project's
     * lock. The key is LEFT OUT when the project declares no network — never
     * written as null — so every lock taken before networks existed keeps its
     * identity.
     */
    ...(gate.network ? { network: gate.network } : {}),
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
 * gate_identity.compute — the gate identity of one project: its OWN spec
 * identity (the design identity from format 3 on; a full-content identity to
 * recompute a format-2 lock) digested together with the design doctrine, its own consumed
 * contract inputs, its composition block and each direct member's composition
 * subject. The same inputs always give the same identity.
 *
 * `members` maps each direct member's alias to the stateId its own lock record
 * carries (`<algorithm>:<digest>`), or `never`. That subject already covers the
 * member's own members, so a change two levels down reaches this identity only
 * once the member between re-locks (pin-chain); a member's live, unapproved
 * edits never move it.
 */
export function computeGateIdentity(
  content: StateId,
  doctrine: LoadedExtensions,
  builtinRules: SddRule[],
  inputs: string[],
  gate: GateConfig,
  members: Record<string, string>,
): StateId {
  const payload = {
    content: content.digest,
    doctrine: doctrineIdentity(doctrine, builtinRules, gate),
    inputs: [...inputs].sort(compareOrdinal),
    members: byKey(Object.entries(members), ([alias]) => alias).map(([alias, subject]) => ({ alias, subject })),
  };
  const digest = crypto.createHash('sha256').update(canonicalize(payload)).digest('hex');
  // The marker follows the content identity handed in: a design identity
  // gives the current gate algorithm, an earlier-reading design identity the
  // earlier design gate's, a full-content one the previous.
  const algorithm = content.algorithm === DESIGN_CONTENT_ALGORITHM ? GATE_ALGORITHM
    : content.algorithm === EARLIER_DESIGN_CONTENT_ALGORITHM ? EARLIER_DESIGN_GATE_ALGORITHM
      : CONTENT_GATE_ALGORITHM;
  return { algorithm, digest };
}

/**
 * gate_identity.analyzer — the digest of the code analyzer's doctrine: the
 * built-in rules that judge code (name, codes, default severities) with the
 * project's code-conformance tuning — rules.conformance and the sddRuleSeverity
 * overrides of those rules' codes. Exactly the half compute leaves out, so this
 * digest moves when the analyzer's rule set or tuning does, and the gate
 * identity does not.
 */
export function analyzerDigest(builtinRules: SddRule[], gate: GateConfig): string {
  const codeCodes = codeJudgedCodes(builtinRules);
  const overrides = Object.entries(gate.rules?.sddRuleSeverity ?? {}).filter(([code]) => codeCodes.has(code));
  const payload = {
    rules: ruleIdentities(builtinRules.filter(judgesCode)),
    conformance: gate.rules?.conformance ?? null,
    severities: byKey(overrides, ([code]) => code).map(([code, severity]) => ({ code, severity })),
  };
  return crypto.createHash('sha256').update(canonicalize(payload)).digest('hex');
}
