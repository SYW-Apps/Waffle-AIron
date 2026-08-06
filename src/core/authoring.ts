import type { ComponentSpec } from '../models/specs.js';
import type { RulesConfig } from '../models/project.js';
import { saveComponentSpec, updateSpec, type SpecWriteHooks } from './specs.js';
import {
  validateComponentCandidate,
  formatCandidateRefusal,
  type CandidateVerdict,
} from './rules/candidate.js';
import { loadProjectConfig } from '../config/loader.js';

// ---------------------------------------------------------------------------
// The AUTHORING seam — gated spec writes, shared by every access path.
//
// wairon is one backend behind four doors: the local CLI, the local stdio MCP
// server, the hosted web interface, and the hosted MCP/API. Which door you came
// through decides authentication and transport, never behaviour. So a rule about
// what may be written belongs HERE, above the store and above the rule engine,
// where every door reuses it — not in a transport handler, where the next door
// would have to reimplement it and would eventually reimplement it differently.
//
// Layering, and why it is this way round:
//
//   access paths (cli / mcp / hosted http)  ->  authoring  ->  specs + rules
//
// `core/specs.ts` stays a dumb store: rules/coupling.ts and rules/namespace.ts
// already read it, so a store that imported the rule engine would close an
// import cycle. This module sits above both and owns the composition, injecting
// the gate through SpecWriteHooks. That also keeps MECHANICAL writes ungated by
// construction — status promotion, layout normalization, and migrations call the
// store directly and are unaffected, which is what lets a spec authored before a
// rule existed still load and still be repaired.
// ---------------------------------------------------------------------------

/** The project's severity overrides, so `sddRuleSeverity` disarms a gate exactly as it disarms validate. */
function candidateOptions(): { rules?: RulesConfig; projectType?: string } {
  try {
    const config = loadProjectConfig();
    return { rules: config.rules, projectType: config.projectType };
  } catch {
    // An uninitialized or unreadable project gets default severities. A config
    // read must never be the thing that fails a write closed.
    return {};
  }
}

/** Intrinsic warnings, as the notice strings the authoring surfaces already return. */
function noticesFrom(verdict: CandidateVerdict): string[] {
  return verdict.warnings.map(w => `${w.code}: ${w.message}`);
}

/**
 * The write-boundary gate for components, as an injectable hook.
 *
 * Judges the MERGED spec, because that is the only form in which the spec the
 * caller will actually get exists — a delta on its own cannot tell you the
 * resulting componentType, and it is the resulting componentType that decides
 * whether a field belongs.
 */
export function componentCandidateGate(): SpecWriteHooks {
  return {
    gate: (kind, merged) => {
      if (kind !== 'component') return;
      const verdict = validateComponentCandidate(merged as ComponentSpec, candidateOptions());
      if (verdict.errors.length) throw new Error(formatCandidateRefusal(verdict));
      return noticesFrom(verdict);
    },
  };
}

/**
 * Author a NEW L2 component: gate the candidate, then persist it.
 *
 * Throws on an intrinsic violation, before anything touches disk — so the remedy
 * really is "fix the arguments and call again", not "repair a saved spec".
 * Returns the store's notices plus any intrinsic warnings.
 */
export function addComponent(candidate: ComponentSpec): string[] {
  const verdict = validateComponentCandidate(candidate, candidateOptions());
  if (verdict.errors.length) throw new Error(formatCandidateRefusal(verdict));
  return [...noticesFrom(verdict), ...saveComponentSpec(candidate)];
}

/**
 * Patch an existing spec through the same gate. An update can introduce a
 * misplaced field just as easily as a create can — and unlike a create, it can
 * also change the componentType out from under fields that were legal before.
 */
export function updateSpecGated(
  kind: 'system' | 'subsystem' | 'component' | 'interface' | 'implementation' | 'type',
  id: string,
  delta: Record<string, any>,
): string[] {
  return updateSpec(kind, id, delta, componentCandidateGate());
}
