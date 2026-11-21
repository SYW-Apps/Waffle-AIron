import { describe, it, expect } from 'vitest';
import { analyzerDigest, approvalParts, computeApprovalIdentity, packContents, type GateConfig } from '../../src/core/rules/approval-identity.js';
import { SDD_RULES } from '../../src/core/rules/repository.js';
import { emptyExtensions } from '../../src/core/extensions.js';
import { stateIdEquals, type StateId } from '../../src/core/statehash.js';
import type { SddRule } from '../../src/core/rules/types.js';

// ---------------------------------------------------------------------------
// approval_identity.compute — the pure approval identity: the own design
// identity digested together with the policy. These tests pin the projection
// directly: what moves it (the design, the project type, the design rule
// tuning, composition, network, the pack selections) and what never does (the
// built-in rules themselves, code tuning, selection order).
// ---------------------------------------------------------------------------

const DESIGN: StateId = { algorithm: 'sha256-design-2', digest: 'a'.repeat(64) };
const GATE: GateConfig = { projectType: 'backend', rules: { noOverlappingOwnership: true, requireOwnedPaths: true, metaAgentTags: [], enforceReproducibility: true } };

/** A deep-enough copy of the built-in rule identities that a test may edit freely. */
function builtinRules(): SddRule[] {
  return SDD_RULES.map((r) => ({ ...r, codes: r.codes.map((c) => ({ ...c })) }));
}

const identity = (over: { design?: StateId; rules?: SddRule[]; gate?: GateConfig } = {}): StateId =>
  computeApprovalIdentity(over.design ?? DESIGN, over.rules ?? builtinRules(), over.gate ?? GATE);

/** The first built-in rule that judges code, in a copy a test may edit. */
const codeRule = (rules: SddRule[]): SddRule => rules.find((r) => r.judges === 'code')!;

describe('computeApprovalIdentity', () => {
  it('is deterministic and marks its composition', () => {
    expect(stateIdEquals(identity(), identity())).toBe(true);
    expect(identity().algorithm).toBe('sha256+design+policy');
    expect(identity().digest).toMatch(/^[0-9a-f]{64}$/);
    expect(stateIdEquals(identity(), DESIGN)).toBe(false);
  });

  it('changes with the design identity', () => {
    expect(stateIdEquals(identity({ design: { algorithm: 'sha256-design-2', digest: 'b'.repeat(64) } }), identity())).toBe(false);
  });

  it('changes with the project type, the design rule tuning, composition and the network declaration', () => {
    const base = identity();
    expect(stateIdEquals(identity({ gate: { ...GATE, projectType: 'frontend' } }), base)).toBe(false);
    expect(stateIdEquals(identity({ gate: { ...GATE, rules: { ...GATE.rules!, requireOwnedPaths: false } } }), base)).toBe(false);
    expect(stateIdEquals(identity({ gate: { ...GATE, composition: { requireApprovedMembers: true } } }), base)).toBe(false);
    expect(stateIdEquals(identity({ gate: { ...GATE, network: { name: 'mesh' } as never } }), base)).toBe(false);
  });

  it('leaves the network out when none is declared, never writing null', () => {
    expect(stateIdEquals(identity({ gate: { ...GATE, network: null } }), identity())).toBe(true);
  });

  it('changes with the pack selections (name, declared version), never with their order', () => {
    const one = identity({ gate: { ...GATE, selections: [{ name: 'a', version: '1.0.0', scope: 'project' }, { name: 'b', scope: 'project' }] } });
    const swapped = identity({ gate: { ...GATE, selections: [{ name: 'b', scope: 'project' }, { name: 'a', version: '1.0.0', scope: 'project' }] } });
    const bumped = identity({ gate: { ...GATE, selections: [{ name: 'a', version: '1.1.0', scope: 'project' }, { name: 'b', scope: 'project' }] } });
    expect(stateIdEquals(one, swapped)).toBe(true);
    expect(stateIdEquals(one, bumped)).toBe(false);
    expect(stateIdEquals(one, identity())).toBe(false);
  });

  it('never changes with the built-in rule set: a release is no input of the approval', () => {
    const rules = builtinRules();
    const design = rules.find((r) => r.judges !== 'code')!;
    design.codes = [...design.codes, { code: 'BRAND_NEW_CODE', defaultSeverity: 'error', summary: 'x' } as never];
    design.codes[0] = { ...design.codes[0], defaultSeverity: design.codes[0].defaultSeverity === 'error' ? 'warning' : 'error' };
    expect(stateIdEquals(identity({ rules }), identity())).toBe(true);
  });

  it('never changes with the code-conformance tuning', () => {
    const code = codeRule(builtinRules()).codes[0].code;
    const tuned = identity({ gate: { ...GATE, rules: { ...GATE.rules!, conformance: { level: 'off' } as never, sddRuleSeverity: { [code]: 'off' } } } });
    expect(stateIdEquals(tuned, identity())).toBe(true);
  });
});

describe('approvalParts', () => {
  it('names each half of the identity on its own', () => {
    const parts = approvalParts(DESIGN, builtinRules(), GATE);
    expect(Object.keys(parts).sort()).toEqual(['composition', 'design', 'rules', 'selections']);
    expect(parts.design).toBe(DESIGN.digest);
  });

  it('adds network only when one is declared, and moves only the part that changed', () => {
    const before = approvalParts(DESIGN, builtinRules(), GATE);
    const after = approvalParts(DESIGN, builtinRules(), { ...GATE, composition: { requireApprovedMembers: true }, network: { name: 'mesh' } as never });
    expect(Object.keys(after).sort()).toEqual(['composition', 'design', 'network', 'rules', 'selections']);
    expect(after.rules).toBe(before.rules);
    expect(after.composition).not.toBe(before.composition);
  });
});

describe('analyzerDigest', () => {
  it('moves with the code rules and code tuning, apart from the identity', () => {
    const rules = builtinRules();
    const base = analyzerDigest(rules, GATE);
    codeRule(rules).codes[0].defaultSeverity = codeRule(rules).codes[0].defaultSeverity === 'error' ? 'warning' : 'error';
    expect(analyzerDigest(rules, GATE)).not.toBe(base);
    expect(stateIdEquals(identity({ rules }), identity())).toBe(true);
  });
});

describe('packContents', () => {
  it('digests each loaded pack by name, and is empty with none', () => {
    expect(packContents(emptyExtensions())).toEqual({});
    const loaded = {
      ...emptyExtensions(),
      packs: [{ name: 'p', ref: 'x', scope: 'project' as const }],
      contributions: { p: { profiles: {}, languages: {}, guarantees: ['g'], rules: [] } },
    };
    const a = packContents(loaded);
    const b = packContents({ ...loaded, contributions: { p: { profiles: {}, languages: {}, guarantees: ['g', 'h'], rules: [] } } });
    expect(Object.keys(a)).toEqual(['p']);
    expect(a.p).not.toBe(b.p);
  });

  it('covers only what each pack contributed by itself', () => {
    const two = {
      ...emptyExtensions(),
      packs: [
        { name: 'one', ref: 'a', scope: 'project' as const },
        { name: 'two', ref: 'b', scope: 'project' as const },
      ],
      contributions: {
        one: { profiles: {}, languages: {}, guarantees: ['g'], rules: [] },
        two: { profiles: {}, languages: {}, guarantees: ['x'], rules: [] },
      },
    };
    const before = packContents(two);
    const after = packContents({ ...two, contributions: { ...two.contributions, two: { ...two.contributions.two, guarantees: ['x', 'y'] } } });
    expect(after.one).toBe(before.one);
    expect(after.two).not.toBe(before.two);
  });
});
