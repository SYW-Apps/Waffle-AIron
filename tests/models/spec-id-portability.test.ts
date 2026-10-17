import { describe, it, expect } from 'vitest';
import { SpecIdSchema, MAX_SPEC_ID_LENGTH, isWindowsReservedName } from '../../src/models/specs.js';
import { EXTERNAL_ALIAS_RE, aliasGrammarProblem, declaredExternals } from '../../src/models/project.js';

// ---------------------------------------------------------------------------
// Round-4 trial (tinkerer, BLOCKER on Windows): component ids `aux`, `con`,
// `nul`, `com1` were accepted, written and validated — and then `git add -A`
// failed for the whole repository, because Windows reserves those names for
// devices. A 270-character id died on a raw ENOENT. The spec-id grammar now
// refuses both on every platform: a tree written on Linux is checked out on
// Windows.
// ---------------------------------------------------------------------------

const refusal = (id: string): string | undefined => {
  const r = SpecIdSchema.safeParse(id);
  return r.success ? undefined : r.error.issues.map((i) => i.message).join('; ');
};

describe('the spec-id grammar refuses ids no Windows checkout can hold', () => {
  it('refuses every reserved device name', () => {
    for (const id of ['con', 'prn', 'aux', 'nul', 'com0', 'com1', 'com9', 'lpt0', 'lpt1', 'lpt9']) {
      expect(refusal(id), id).toMatch(/reserves for a device/);
    }
  });

  it('keeps the near misses legal', () => {
    for (const id of ['aux_store', 'console', 'auxiliary', 'com10', 'lpt', 'nul-sink', 'connection', 'icon']) {
      expect(refusal(id), id).toBeUndefined();
    }
  });

  it(`refuses an id over ${MAX_SPEC_ID_LENGTH} characters with the reason, and keeps one at the bound`, () => {
    expect(refusal('a'.repeat(MAX_SPEC_ID_LENGTH))).toBeUndefined();
    expect(refusal('a'.repeat(MAX_SPEC_ID_LENGTH + 1))).toMatch(/longer than 64 characters/);
    expect(refusal(`a_very_long_${'x'.repeat(258)}`)).toMatch(/longer than 64 characters/);
  });

  it('isWindowsReservedName matches any case and an extension-like suffix (aux.yaml is the device too)', () => {
    for (const name of ['AUX', 'Con', 'nul.txt', 'com1.yaml', 'LPT3.tar.gz']) expect(isWindowsReservedName(name), name).toBe(true);
    for (const name of ['auxiliary', 'console.txt', 'com10', 'my-aux']) expect(isWindowsReservedName(name), name).toBe(false);
  });
});

describe('an external alias names its pin file, so the same names are refused there', () => {
  it('EXTERNAL_ALIAS_RE refuses a device name and says why', () => {
    expect(EXTERNAL_ALIAS_RE.test('aux')).toBe(false);
    expect(EXTERNAL_ALIAS_RE.test('aux_api')).toBe(true);
    expect(aliasGrammarProblem('aux')).toMatch(/reserves for a device/);
    expect(aliasGrammarProblem('Not An Alias')).toMatch(/breaks \[a-z0-9-_\]\+/);
  });

  it('a declaration under such an alias carries the problem (EXTERNAL_UNRESOLVED reads it)', () => {
    const [declared] = declaredExternals({ externals: { con: { project: 'consoles' } } } as never);
    expect(declared.problem).toMatch(/reserves for a device/);
  });
});
