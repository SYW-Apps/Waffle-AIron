import { describe, it, expect } from 'vitest';
import { analyzerDigest, computeGateIdentity, type GateConfig } from '../../src/core/rules/gate-identity.js';
import { SDD_RULES } from '../../src/core/rules/repository.js';
import { emptyExtensions, type LoadedExtensions } from '../../src/core/extensions.js';
import { stateIdEquals, type StateId } from '../../src/core/statehash.js';
import type { SddRule } from '../../src/core/rules/types.js';

// ---------------------------------------------------------------------------
// gate_identity.compute — the pure gate identity: the own content identity
// digested together with the design doctrine, the own consumed contract
// inputs, the composition block and the direct members' subjects. These tests
// pin the projection directly, with every input in hand: what moves the
// identity (a design rule code, a default severity, the gate config, a pack,
// the content, the inputs, composition, a member's subject) and what never
// does (agent-facing prose, input order, rule registration order, anything
// the code analyzer judges — analyzer-upgrade-keeps-approval).
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
  members?: Record<string, string>;
} = {}): StateId =>
  computeGateIdentity(
    over.content ?? CONTENT,
    over.doctrine ?? emptyExtensions(),
    over.rules ?? builtinRules(),
    over.inputs ?? INPUTS,
    over.gate ?? GATE,
    over.members ?? MEMBERS,
  );

const MEMBERS: Record<string, string> = { core: `sha256+content+doctrine+inputs+members:${'c'.repeat(64)}`, shared: 'never' };

/** The first built-in rule that judges code, in a copy a test may edit. */
const codeRule = (rules: SddRule[]): SddRule => rules.find((r) => r.judges === 'code')!;

describe('computeGateIdentity', () => {
  it('is deterministic: the same inputs always give the same identity', () => {
    expect(stateIdEquals(identity(), identity())).toBe(true);
  });

  it('marks its composition, so a content identity or an earlier gate identity never compares equal', () => {
    const gate = identity();
    expect(gate.algorithm).toBe('sha256+content+doctrine+inputs+members');
    expect(gate.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(stateIdEquals(gate, CONTENT)).toBe(false);
    expect(stateIdEquals(gate, { algorithm: 'sha256+doctrine+inputs', digest: gate.digest })).toBe(false);
    expect(stateIdEquals(gate, { algorithm: 'sha256+content+doctrine+inputs', digest: gate.digest })).toBe(false);
  });

  it('changes with the content identity', () => {
    expect(stateIdEquals(identity({ content: { algorithm: 'sha256', digest: 'b'.repeat(64) } }), identity())).toBe(false);
  });

  it('changes when a direct member\'s recorded subject moves, or a member is added', () => {
    expect(stateIdEquals(identity({ members: { ...MEMBERS, core: `sha256+content+doctrine+inputs+members:${'d'.repeat(64)}` } }), identity())).toBe(false);
    expect(stateIdEquals(identity({ members: { ...MEMBERS, shared: `sha256+content+doctrine+inputs+members:${'e'.repeat(64)}` } }), identity())).toBe(false);
    expect(stateIdEquals(identity({ members: { ...MEMBERS, ledger: 'never' } }), identity())).toBe(false);
  });

  it('does not change with the order the members were gathered in', () => {
    const reversed = Object.fromEntries(Object.entries(MEMBERS).reverse());
    expect(stateIdEquals(identity({ members: reversed }), identity())).toBe(true);
  });

  it('changes with the composition block: a changed requirement stales the requiring project', () => {
    expect(stateIdEquals(identity({ gate: { ...GATE, composition: { requireApprovedMembers: true } } }), identity())).toBe(false);
    expect(stateIdEquals(
      identity({ gate: { ...GATE, composition: { requirePolicies: [{ pack: 'clinic-doctrine', version: '^1.0.0' }] } } }),
      identity({ gate: { ...GATE, composition: { requirePolicies: [{ pack: 'clinic-doctrine', version: '^2.0.0' }] } } }),
    )).toBe(false);
  });

  describe('analyzer-upgrade-keeps-approval: what judges code is never part of it', () => {
    it('a code-judging rule gaining a code, or re-grading one, leaves the identity alone and moves the analyzer digest', () => {
      const gained = builtinRules();
      codeRule(gained).codes.push({ code: 'A_STRICTER_BODY_CHECK', defaultSeverity: 'error', summary: 'a better parser' });
      expect(stateIdEquals(identity({ rules: gained }), identity())).toBe(true);
      expect(analyzerDigest(gained, GATE)).not.toBe(analyzerDigest(builtinRules(), GATE));

      const regraded = builtinRules();
      const code = codeRule(regraded).codes[0];
      code.defaultSeverity = code.defaultSeverity === 'error' ? 'warning' : 'error';
      expect(stateIdEquals(identity({ rules: regraded }), identity())).toBe(true);
      expect(analyzerDigest(regraded, GATE)).not.toBe(analyzerDigest(builtinRules(), GATE));
    });

    it('a new code-judging rule leaves the identity alone', () => {
      const rules = [...builtinRules(), { ...codeRule(builtinRules()), name: 'a-new-analyzer' }];
      expect(stateIdEquals(identity({ rules }), identity())).toBe(true);
    });

    it('an sddRuleSeverity override of a code-judging code, or rules.conformance, moves only the analyzer digest', () => {
      const codeCode = codeRule(builtinRules()).codes[0].code;
      const severity: GateConfig = { ...GATE, rules: { ...GATE.rules!, sddRuleSeverity: { [codeCode]: 'off' } } };
      expect(stateIdEquals(identity({ gate: severity }), identity())).toBe(true);
      expect(analyzerDigest(builtinRules(), severity)).not.toBe(analyzerDigest(builtinRules(), GATE));

      const conformance = { ...GATE, rules: { ...GATE.rules!, conformance: { sourceRoots: ['src'] } } } as GateConfig;
      expect(stateIdEquals(identity({ gate: conformance }), identity())).toBe(true);
      expect(analyzerDigest(builtinRules(), conformance)).not.toBe(analyzerDigest(builtinRules(), GATE));
    });

    it('a design override still moves the identity and leaves the analyzer digest alone', () => {
      const design: GateConfig = { ...GATE, rules: { ...GATE.rules!, sddRuleSeverity: { UNKNOWN_PROFILE: 'off' } } };
      expect(stateIdEquals(identity({ gate: design }), identity())).toBe(false);
      expect(analyzerDigest(builtinRules(), design)).toBe(analyzerDigest(builtinRules(), GATE));
    });

    it('every built-in rule declares what it judges', () => {
      expect(builtinRules().filter((r) => r.judges !== 'design' && r.judges !== 'code').map((r) => r.name)).toEqual([]);
      expect(builtinRules().some((r) => r.judges === 'code')).toBe(true);
    });
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
