import { describe, it, expect } from 'vitest';
import { computeGateIdentity, type GateConfig } from '../../src/core/rules/gate-identity.js';
import { SDD_RULES } from '../../src/core/rules/repository.js';
import { emptyExtensions, type LoadedExtensions } from '../../src/core/extensions.js';
import { stateIdEquals, type StateId } from '../../src/core/statehash.js';
import type { SddRule } from '../../src/core/rules/types.js';

// ---------------------------------------------------------------------------
// gate_identity.compute — the pure gate identity: the content identity digested
// together with the governing doctrine and the consumed contract inputs. These
// tests pin the projection directly, with every input in hand: what moves the
// identity (a rule code, a default severity, the gate config, a pack, the
// content, the inputs) and what never does (agent-facing prose, input order,
// rule registration order).
// ---------------------------------------------------------------------------

const CONTENT: StateId = { algorithm: 'sha256', digest: 'a'.repeat(64) };
const INPUTS = ['{"projectName":"billing"}', '{"projectName":"crm"}'];
const GATE: GateConfig = { projectType: 'backend', rules: { noOverlappingOwnership: true, requireOwnedPaths: true, metaAgentTags: [], enforceReproducibility: true } };

/** A deep-enough copy of the built-in rule identities that a test may edit freely. */
function builtinRules(): SddRule[] {
  return SDD_RULES.map((r) => ({ ...r, codes: r.codes.map((c) => ({ ...c })) }));
}

const identity = (over: {
  content?: StateId;
  doctrine?: LoadedExtensions;
  rules?: SddRule[];
  inputs?: string[];
  gate?: GateConfig;
} = {}): StateId =>
  computeGateIdentity(
    over.content ?? CONTENT,
    over.doctrine ?? emptyExtensions(),
    over.rules ?? builtinRules(),
    over.inputs ?? INPUTS,
    over.gate ?? GATE,
  );

describe('computeGateIdentity', () => {
  it('is deterministic: the same inputs always give the same identity', () => {
    expect(stateIdEquals(identity(), identity())).toBe(true);
  });

  it('marks its composition, so a content identity or an earlier gate identity never compares equal', () => {
    const gate = identity();
    expect(gate.algorithm).toBe('sha256+content+doctrine+inputs');
    expect(gate.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(stateIdEquals(gate, CONTENT)).toBe(false);
    expect(stateIdEquals(gate, { algorithm: 'sha256+doctrine+inputs', digest: gate.digest })).toBe(false);
  });

  it('changes with the content identity', () => {
    expect(stateIdEquals(identity({ content: { algorithm: 'sha256', digest: 'b'.repeat(64) } }), identity())).toBe(false);
  });

  it('changes when a built-in rule gains a code', () => {
    const rules = builtinRules();
    rules[0].codes.push({ code: 'A_NEWLY_SHIPPED_CODE', defaultSeverity: 'warning', summary: 'added by a release' });
    expect(stateIdEquals(identity({ rules }), identity())).toBe(false);
  });

  it('changes when a built-in code is re-graded', () => {
    const rules = builtinRules();
    const code = rules[0].codes[0];
    code.defaultSeverity = code.defaultSeverity === 'error' ? 'warning' : 'error';
    expect(stateIdEquals(identity({ rules }), identity())).toBe(false);
  });

  it('does not change with the order the rules were registered in', () => {
    expect(stateIdEquals(identity({ rules: builtinRules().reverse() }), identity())).toBe(true);
  });

  it('does not change with the order the inputs were gathered in', () => {
    expect(stateIdEquals(identity({ inputs: [...INPUTS].reverse() }), identity())).toBe(true);
  });

  it('changes when a consumed contract input changes', () => {
    expect(stateIdEquals(identity({ inputs: [INPUTS[0], '{"projectName":"crm","v":2}'] }), identity())).toBe(false);
  });

  it('changes with the gate config: the project type and the rule tuning', () => {
    expect(stateIdEquals(identity({ gate: { ...GATE, projectType: 'frontend-reactive' } }), identity())).toBe(false);
    expect(stateIdEquals(identity({ gate: { ...GATE, rules: { ...GATE.rules!, sddRuleSeverity: { UNKNOWN_PROFILE: 'off' } } } }), identity())).toBe(false);
  });

  it('changes when a governing pack changes version', () => {
    const v1 = { ...emptyExtensions(), packs: [{ name: 'clinic-doctrine', ref: 'packs/clinic', scope: 'project' as const, version: '1.0.0' }] };
    const v2 = { ...emptyExtensions(), packs: [{ name: 'clinic-doctrine', ref: 'packs/clinic', scope: 'project' as const, version: '1.1.0' }] };
    expect(stateIdEquals(identity({ doctrine: v1 }), identity({ doctrine: v2 }))).toBe(false);
  });

  it('leaves out skills and instructions: agent-facing prose never invalidates a lock', () => {
    const withProse: LoadedExtensions = {
      ...emptyExtensions(),
      skills: [{ id: 'implementer', pack: 'clinic-doctrine', source: 'skills/implementer/SKILL.md' }] as unknown as LoadedExtensions['skills'],
      instructions: [{ pack: 'clinic-doctrine', text: 'Prefer small Repositories.' }] as unknown as LoadedExtensions['instructions'],
    };
    expect(stateIdEquals(identity({ doctrine: withProse }), identity())).toBe(true);
  });
});
