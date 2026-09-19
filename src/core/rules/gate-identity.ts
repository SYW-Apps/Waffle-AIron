import * as crypto from 'crypto';
import { canonicalize, compareOrdinal } from '../../utils/canonical-json.js';
import type { RulesConfig } from '../../models/project.js';
import type { LoadedExtensions } from '../extensions.js';
import type { StateId } from '../statehash.js';
import type { SddRule } from './types.js';

// ---------------------------------------------------------------------------
// Gate identity (sdd_validator)
//
// The identity a lock records and every staleness check compares: the spec
// tree's content identity digested together with the doctrine that governs it
// and the consumed contract inputs a verdict can consult. A lock asserts "these
// specs pass THIS gate", so changing a pack, the project's rule tuning or a
// pinned contract invalidates it by identity mismatch exactly as a spec edit
// does — nobody has to remember to invalidate it.
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
}

/**
 * Algorithm marker for the gate identity. It names the composition — the content
 * digest, the doctrine and the inputs — so a record written under an earlier one
 * (sha256+doctrine+inputs digested the tree itself) never matches and reads stale
 * once, and a content identity (sha256) never compares equal to a gate identity.
 */
const GATE_ALGORITHM = 'sha256+content+doctrine+inputs';

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
  // Ordinal, never localeCompare: collation is locale- and ICU-dependent, and it
  // re-weights exactly the characters rule names are full of (hyphens,
  // underscores), so the same rule set could digest differently on two machines.
  const byKey = <T>(items: T[], key: (item: T) => string): T[] =>
    [...items].sort((a, b) => compareOrdinal(key(a), key(b)));

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
      builtinRules.map((r) => ({
        name: r.name,
        codes: byKey(r.codes.map((c) => ({ code: c.code, severity: c.defaultSeverity })), (c) => c.code),
      })),
      (r) => r.name,
    ),
    /**
     * Which profile GOVERNS, and the project's own rule tuning. Both decide
     * verdicts — a projectType switch changes the doctrine family outright, and
     * `rules` carries severity overrides, complexity caps, and designDepth.
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
 * gate_identity.compute — the gate identity of a spec tree: its content identity
 * digested together with the governing doctrine and the consumed contract
 * inputs. The same inputs always give the same identity.
 *
 * `inputs` are sorted here: callers gather them from the bound root and every
 * chained mount in no particular order, so this is the one place that fixes one.
 */
export function computeGateIdentity(
  content: StateId,
  doctrine: LoadedExtensions,
  builtinRules: SddRule[],
  inputs: string[],
  gate: GateConfig,
): StateId {
  const payload = {
    content: content.digest,
    doctrine: doctrineIdentity(doctrine, builtinRules, gate),
    inputs: [...inputs].sort(),
  };
  const digest = crypto.createHash('sha256').update(canonicalize(payload)).digest('hex');
  return { algorithm: GATE_ALGORITHM, digest };
}
